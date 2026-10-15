/**
 * Host half of dsh-video-forge.
 *
 * Wiring, in order: read the config snapshot, open the ledger, register the four
 * tools and the media route, then reconcile whatever the previous process left
 * open. The last step is why the ledger exists at all — a generation is paid
 * work owned by a vendor, and a restart must reattach to it rather than lose it.
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
import { Ledger, LedgerCorruptError } from './ledger.ts'
import { mediaHandler } from './media-route.ts'
import { PANEL_ROUTE_PREFIX, panelHandler } from './panel-api.ts'
import { adapterFor, type AdapterContext } from './providers/index.ts'
import { artifactUrl, pluginHome, type VideoForgeRuntime } from './runtime.ts'
import { reconcile, retryOrphans, scheduleReconciliation, settleBilling } from './reconcile.ts'
import { HOME_DIRECTORY, MEDIA_ROUTE_PREFIX } from './settings.ts'
import { registerTools } from './tools.ts'
import type { VideoTask } from './types.ts'
import { startInProcessWatch, startWatch, type WatchLogger } from './watch.ts'

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
  const ledger = new Ledger({
    path: join(pluginHome(home), 'tasks.json'),
    maxTasks: config.maxTasks.get(),
    maxGiB: config.maxGiB.get(),
  })

  const runtime: VideoForgeRuntime = {
    ctx,
    ledger,
    logger,
    settings: () => {
      const value = snapshot(config)
      // `retain` is read straight from the live config so a limit change applies
      // to the very next write rather than only after a remount.
      return { ...value, maxTasks: config.maxTasks.get(), maxGiB: config.maxGiB.get() }
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
        logger,
        onUpdate: (task: VideoTask) => {
          if (task.status === 'succeeded') {
            const artifact = task.artifacts[0]
            if (artifact !== undefined) logger.info(`video-forge: ${task.localId} finished → ${artifact.path} (play: ${artifactUrl(task, artifact)})`)
          } else if (task.status === 'failed' || task.status === 'cancelled') {
            logger.warn(`video-forge: ${task.localId} ${task.status}: ${task.error?.message ?? 'no detail'}`)
          }
        },
      }

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
        if (jobId !== null) return jobId
      } else if (jobs === undefined) {
        logger.warn('video-forge: the jobs service is not loaded; tasks are watched in-process and reported through video_status')
      }

      const fallback = startInProcessWatch(common)
      runtime.cancels.set(input.task.localId, async () => {
        fallback.cancel()
        return false
      })
      return null
    },
    cancels: new Map(),
    activeCount: () => ledger.list().filter(task => task.status === 'submitting' || task.status === 'queued' || task.status === 'running').length,
  }

  // The media route is registered through an effect because (unlike
  // `tools.register`) `webServer.register` returns a bare disposer that the
  // plugin fiber does not own.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: MEDIA_ROUTE_PREFIX,
    handler: mediaHandler(ledger),
  }), `video-forge: GET ${MEDIA_ROUTE_PREFIX}/<task>/<token>/<name>`)

  // The workbench's own surface. The panel cannot call a host tool — a tool call
  // belongs to an agent turn — so browser submissions go through this family and
  // land on exactly the same operations the tools use.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PANEL_ROUTE_PREFIX,
    handler: panelHandler(runtime),
  }), `video-forge: ${PANEL_ROUTE_PREFIX}/<action>`)

  registerTools(runtime)

  // A live config edit reaches us here. Nothing needs re-registering: the tools
  // and the route read `runtime.settings()` per operation, so the only work is
  // to tell the operator what changed.
  ctx.on('loader/volatile-update', (paths) => {
    logger.info(`video-forge: configuration updated (${paths.map(path => path.join('.')).join(', ')})`)
  })

  const loaded = ledger.load()
    .catch((error: unknown) => {
      if (error instanceof LedgerCorruptError) {
        logger.warn(`video-forge: ${error.message}; starting from an empty ledger`)
        return
      }
      throw error
    })

  // Reconciliation needs every provider's key, and the credential store
  // publishes its service only once it has read its file; see
  // `scheduleReconciliation` for why this waits rather than starting here.
  scheduleReconciliation(
    ctx,
    async () => {
      await loaded
      await reconcile(runtime)
      await settleBilling(runtime)
    },
    async () => {
      await retryOrphans(runtime)
      await settleBilling(runtime)
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
