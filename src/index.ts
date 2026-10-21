/**
 * Host half of dsh-video-forge.
 *
 * Wiring, in order: read the config snapshot, open the ledger, register the
 * three tools, the media route, the panel API and the Range-capable stream
 * route, then reconcile whatever the previous process left open and tell
 * sessions about tasks that finished meanwhile. The last step is why the ledger
 * exists at all — a generation is paid work owned by a vendor, and a restart must
 * reattach to it rather than lose it.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, snapshot, type Config as VideoForgeConfig } from './config.ts'
import { deliverArtifact } from './destination.ts'
import { LedgerCorruptError, sharedLedger } from './ledger.ts'
import { deliverNotices, quietOnKill, setNoticeHost, type NoticeHost } from './notify.ts'
import { mediaHandler } from './media-route.ts'
import { PANEL_ROUTE_PREFIX, panelHandler } from './panel-api.ts'
import { PriceSource, priceCachePath } from './price-source.ts'
import { registerStreamRoute, type StreamScope, type StreamSessions } from './stream-route.ts'
import { adapterFor, type AdapterContext } from './providers/index.ts'
import { artifactUrl, jobTableFor, pluginHome, watchTableFor, type VideoForgeRuntime } from './runtime.ts'
import { reconcile, retryOrphans, scheduleReconciliation, settleBilling } from './reconcile.ts'
import { HOME_DIRECTORY, MEDIA_ROUTE_PREFIX } from './settings.ts'
import { requireLedger } from './operations.ts'
import { sharedSelections } from './selection.ts'
import { registerSkills } from './skills.ts'
import { registerTools } from './tools.ts'
import type { TaskBilling, VideoArtifact, VideoTask } from './types.ts'
import { startInProcessWatch, startWatch, type WatchLogger } from './watch.ts'
import { workspaceFsOf } from './workspace-fs.ts'

export const name = 'dsh-video-forge'

/**
 * `tools` and `webServer` are required: without them the plugin has no surface.
 * `profileContext` supplies `$DSH_HOME`; when it is absent (a bare composition)
 * the ledger falls back to the environment and then to `~/.dsh`.
 */
export const inject = ['tools', 'webServer']

export { Config }
export type { VideoForgeConfig }

export function apply(ctx: Context, config: VideoForgeConfig): void {
  const logger: WatchLogger = {
    info: message => ctx.logger.info(message),
    warn: message => ctx.logger.warn(message),
    error: message => ctx.logger.error(message),
  }

  const home = resolveHome(ctx)
  // One ledger object per file for the whole process; see `sharedLedger`.
  const ledger = sharedLedger({
    path: join(pluginHome(home), 'tasks.json'),
    maxTasks: config.maxTasks.get(),
    maxGiB: config.maxGiB.get(),
  })

  /** The job watching each task, while it lives; only a kill through the registry is told apart by it. */
  const jobTasks = jobTableFor(ledger.path)

  // The composer chip's per-conversation choice. Also shared per file: two
  // instances on one document would each flush their own copy.
  const selections = sharedSelections({ path: join(pluginHome(home), 'selections.json') })

  /**
   * Prices (DESIGN §21). The cache is read synchronously here so the first
   * `video_status cost` after a restart already has prices; the fetch itself is
   * started below and never awaited, because a price refresh must not delay
   * anything. No tool path touches the network: they all read `effective()`.
   */
  const prices = new PriceSource({
    path: priceCachePath(pluginHome(home)),
    url: config.priceSourceUrl.get().trim(),
    refreshHours: config.priceRefreshHours.get(),
    // A feed that prices none of the configured models is a mismatch (an
    // upstream rename, a relay's own ids), not a table worth installing.
    configuredModelIds: () => snapshot(config).providers.flatMap(provider => provider.models.map(model => model.id)),
    logger,
  })
  prices.loadCacheSync()

  const runtime: VideoForgeRuntime = {
    ctx,
    ledger,
    selections,
    logger,
    settings: () => {
      const value = snapshot(config)
      const effective = prices.effective(value.priceTable)
      // `retain` is read straight from the live config so a limit change applies
      // to the very next write rather than only after a remount.
      return {
        ...value,
        maxTasks: config.maxTasks.get(),
        maxGiB: config.maxGiB.get(),
        priceTable: effective.table,
        priceSource: {
          url: config.priceSourceUrl.get().trim(),
          refreshHours: config.priceRefreshHours.get(),
          info: effective.info,
        },
      }
    },
    outputRoot: () => {
      const configured = config.outputDir.get().trim()
      return configured === '' ? join(pluginHome(home), 'outputs') : configured
    },
    outputDirectory: localId => join(
      config.outputDir.get().trim() === '' ? join(pluginHome(home), 'outputs') : config.outputDir.get().trim(),
      localId,
    ),
    watchTask: input => {
      const adapter = adapterFor(input.provider, input.model)
      const context: AdapterContext = {
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        fetch,
        signal: undefined,
      }
      const common = {
        ledger,
        adapter,
        context,
        task: input.task,
        pollIntervalMs: input.model.pollIntervalMs,
        outputDirectory: runtime.outputDirectory(input.task.localId),
        deliver: (task: VideoTask, artifact: VideoArtifact, billing: TaskBilling | null) => deliverArtifact(runtime, task, artifact, billing),
        logger,
        onExit: () => { runtime.watching.delete(input.task.localId) },
        onUpdate: (task: VideoTask) => {
          if (task.status === 'succeeded') {
            const artifact = task.artifacts[0]
            if (artifact !== undefined) logger.info(`video-forge: ${task.localId} finished → ${artifact.path} (play: ${artifactUrl(task, artifact)})`)
          } else if (task.status === 'failed' || task.status === 'cancelled') {
            logger.warn(`video-forge: ${task.localId} ${task.status}: ${task.error?.message ?? 'no detail'}`)
          }
        },
      }

      runtime.watching.add(input.task.localId)
      const jobs = ctx.get('jobs')
      // A job is worth having — the model reads it with `job_output` and is woken
      // when it settles — but the registry only starts one for an owner whose
      // scope reaches a controller. Without that, drive the same loop from a timer
      // rather than leaving a paid task unwatched.
      if (jobs !== undefined && input.owner !== undefined) {
        const jobId = startWatch({
          ...common,
          jobs,
          owner: input.owner,
          onCancelReady: (localId, cancel) => {
            runtime.cancels.set(localId, cancel)
            return () => runtime.cancels.delete(localId)
          },
        })
        if (jobId !== null) {
          jobTasks.set(jobId, input.task.localId)
          return jobId
        }
      } else if (jobs === undefined) {
        logger.warn('video-forge: the jobs service is not loaded; tasks are watched in-process and reported through video_status')
      }

      const fallback = startInProcessWatch({
        ...common,
        onExit: () => {
          common.onExit()
          runtime.cancels.delete(input.task.localId)
        },
      })
      runtime.cancels.set(input.task.localId, async () => {
        fallback.cancel()
        return true
      })
      return null
    },
    cancels: new Map(),
    watching: watchTableFor(ledger.path),
  }

  /**
   * Whether the Range-capable stream route is mounted (M5). The panel API
   * reports it so the browser half knows what it may rely on; it is written only
   * here, and only from the connection effect below.
   */
  let streamRegistered = false

  // The media route is registered through an effect because (unlike
  // `tools.register`) `webServer.register` returns a bare disposer that the
  // plugin fiber does not own.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: MEDIA_ROUTE_PREFIX,
    handler: mediaHandler(ledger),
  }), `video-forge: GET ${MEDIA_ROUTE_PREFIX}/<task>/<token>/<name>`)

  // The browser surfaces' API: a chat card's live task state and cancel, the
  // badge's count, the configuration card's overview. Nothing here submits.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PANEL_ROUTE_PREFIX,
    handler: panelHandler(runtime, () => ({ stream: streamRegistered })),
  }), `video-forge: ${PANEL_ROUTE_PREFIX}/<action>`)

  // The Range-capable stream route (M5) hangs off the harness's own
  // authenticated `/api` channel instead of this plugin's trust-gated prefix:
  // the connection is the seam that carries a browser session's credentials,
  // answers 403 to every peer that is not the owner, and can stream a 206 body.
  // The service may arrive after us, and its absence (a reduced composition) is
  // an off state rather than an error — the browser half falls back to the
  // harness's `/api/file`, which is bounded and not seekable.
  //
  // The reader of a service owns its effects (cordis rebinds a service's `ctx`
  // to the context that read it), so the route lives exactly as long as this
  // inject scope — see `registerStreamRoute`.
  ctx.inject(['connection'], (scope) => {
    registerStreamRoute(scope as unknown as StreamScope, {
      // Never the host-local stand-in: an absolute path the browser holds came
      // from a `stat` in this workspace's execution world, which an SSH
      // workspace does not share with this machine. A missing service is a 503,
      // not a wrong file.
      fs: () => workspaceFsOf(ctx, true),
      sessions: () => scope.get('sessions') as unknown as StreamSessions | undefined,
      setRegistered: (registered) => { streamRegistered = registered },
      warn: message => { logger.warn(`video-forge: ${message}`) },
    })
  })

  registerTools(runtime)
  // The five `video-*` skills are an optional dependency: they mount only when
  // the composition carries the `skills` service, and the tools never rely on
  // one having been loaded.
  registerSkills(ctx)

  // Notices travel through the session controller, which may come up after
  // boot reconciliation has already settled a task: wait for it, then deliver
  // whatever is owed.
  ctx.inject(['sessionController', 'agents', 'sessions'], (scope) => {
    const host = {
      sessionController: scope.get('sessionController'),
      agents: scope.get('agents'),
      sessions: scope.get('sessions'),
    } as unknown as NoticeHost
    setNoticeHost(runtime, host)
    scope.effect(() => () => { setNoticeHost(runtime, undefined) }, 'video-forge: notice services')
    void deliverNotices(runtime)
  })

  // A watch that was killed — the model's `job_kill`, the user stopping it, the
  // session being archived — was let go on purpose: the provider keeps working
  // and the orphan retry still fetches what was paid for, but its session is not
  // told (see `quietOnKill`). A teardown (a restart) is not a choice, and is
  // announced when the task is taken over and finishes.
  ctx.inject(['jobs'], (scope) => {
    const jobs = scope.get('jobs')
    if (jobs === undefined) return
    scope.effect(() => jobs.events.subscribe({ owners: 'all' }, quietOnKill(ledger, jobTasks, logger)), 'video-forge: watches stopped with job_kill')
  })

  // Reading the cache must not depend on an effect having run, and the timer
  // must not outlive this instance.
  ctx.effect(() => () => { prices.dispose() }, 'video-forge: price refresh timer')
  prices.start()

  // A live config edit reaches us here. Nothing needs re-registering: the tools
  // and the route read `runtime.settings()` per operation, so the only work is
  // to tell the operator what changed — plus, for the price source, to act on it:
  // a corrected URL or interval takes effect at once instead of at the next tick.
  ctx.on('loader/volatile-update', (paths) => {
    logger.info(`video-forge: configuration updated (${paths.map(path => path.join('.')).join(', ')})`)
    const touchesPrices = paths.some(path => path[0] === 'priceSourceUrl' || path[0] === 'priceRefreshHours')
    if (touchesPrices) {
      prices.reconfigure({ url: config.priceSourceUrl.get().trim(), refreshHours: config.priceRefreshHours.get() })
    }
  })

  // The rows a previous process left are exactly those on disk at load time. A
  // row submitted while boot waits for the credential store has a watch of its
  // own and must not be "reconciled" into a second one.
  const inherited = ledger.ensureLoaded()
    .catch((error: unknown) => {
      if (error instanceof LedgerCorruptError) {
        logger.warn(`video-forge: ${error.message}; starting from an empty ledger`)
        return
      }
      throw error
    })
    .then(() => new Set(ledger.list().map(task => task.localId)))
  // Handled at once: boot awaits this only later, and an unhandled rejection in
  // the meantime would take the whole host down. Boot still sees the failure.
  inherited.catch(() => undefined)

  // Reconciliation needs every provider's key, and the credential store
  // publishes its service only once it has read its file; see
  // `scheduleReconciliation` for why this waits rather than starting here.
  // Whether the rows a previous process left have been reconciled. A boot read
  // that failed leaves this false, and the timer pass then retries the read and
  // runs the reconciliation boot missed — otherwise those tasks would wait for
  // the next restart while their artifact URLs expire.
  let inheritedReconciled = false
  scheduleReconciliation(
    ctx,
    async () => {
      await reconcile(runtime, await inherited)
      inheritedReconciled = true
      // Not awaited: resuming sessions must never hold back the orphan retry.
      void deliverNotices(runtime)
      // Settling usage can take a while on the first boot after an upgrade; it
      // must not hold the orphan timer back, so it runs on its own.
      void settleBilling(runtime).catch((error: unknown) => {
        logger.error(`video-forge: usage settlement failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    },
    async () => {
      try {
        await requireLedger(runtime)
      } catch (error: unknown) {
        logger.warn(`video-forge: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (!inheritedReconciled) {
        await reconcile(runtime)
        inheritedReconciled = true
      }
      await retryOrphans(runtime)
      await settleBilling(runtime)
      // Also the retry for notices a session could not take last time.
      await deliverNotices(runtime)
    },
    (error: unknown) => {
      logger.error(`video-forge: reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

/** `$DSH_HOME`, from the profile context, the environment, or the account home. */
function resolveHome(ctx: Context): string {
  const profile = ctx.get('profileContext') as { home?: string } | undefined
  if (typeof profile?.home === 'string' && profile.home !== '') return profile.home
  const ambient = process.env.DSH_HOME
  if (ambient !== undefined && ambient !== '') return ambient
  return join(homedir(), '.dsh')
}

export { HOME_DIRECTORY }
