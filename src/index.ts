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
import { resolveApiKey } from './credentials.ts'
import { downloadArtifact } from './download.ts'
import { Ledger, LedgerCorruptError } from './ledger.ts'
import { mediaHandler } from './media-route.ts'
import { PANEL_ROUTE_PREFIX, panelHandler } from './panel-api.ts'
import { adapterFor, type AdapterContext } from './providers/index.ts'
import { artifactUrl, pluginHome, type VideoForgeRuntime } from './runtime.ts'
import { resolveTarget, HOME_DIRECTORY, MEDIA_ROUTE_PREFIX, type ModelSetting, type ProviderSetting } from './settings.ts'
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
    activeCount: () => ledger.list().filter(task => task.status === 'queued' || task.status === 'running').length,
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

  void ledger.load()
    .catch((error: unknown) => {
      if (error instanceof LedgerCorruptError) {
        logger.warn(`video-forge: ${error.message}; starting from an empty ledger`)
        return
      }
      throw error
    })
    .then(() => reconcile(runtime))
    .catch((error: unknown) => {
      logger.error(`video-forge: startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
}

/**
 * Reattach to whatever the previous process left open.
 *
 * For each task the ledger still calls open, ask the provider what actually
 * happened. A finished task is settled (and its artifact fetched, if the URL is
 * still alive); a still-running task gets a fresh watch; a provider we cannot
 * reach at all leaves the task `orphaned` — never "probably still running", and
 * never a re-submission, because that would be a second charge for one intent.
 */
async function reconcile(runtime: VideoForgeRuntime): Promise<void> {
  const { ledger, logger } = runtime
  const open = ledger.open()
  if (open.length === 0) return

  const settings = runtime.settings()
  logger.info(`video-forge: reconciling ${open.length} task(s) left by a previous process`)

  for (const task of open) {
    let provider: ProviderSetting
    let model: ModelSetting
    try {
      const target = resolveTarget(settings, task.provider, task.model)
      provider = target.provider
      model = target.model
    } catch (error: unknown) {
      await markOrphaned(ledger, task, `no longer configured: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const adapter = adapterFor(provider, model)
    let apiKey: string | null
    try {
      apiKey = (await resolveApiKey(runtime.ctx, provider)).value
    } catch {
      await markOrphaned(ledger, task, 'the credential for its provider is not available')
      continue
    }

    const context: AdapterContext = { baseUrl: provider.baseUrl, apiKey, fetch, signal: AbortSignal.timeout(20_000) }
    try {
      const state = await adapter.query(context, task.providerTaskId ?? '')
      if (!state.terminal) {
        // Still alive: reattach a watch instead of pretending, and never
        // re-submit. There is no agent at boot, so this runs unowned — a job here
        // would be rejected by the registry, and that is a limitation of the watch
        // surface, not a reason to call a healthy task orphaned.
        await ledger.update(task.localId, current => ({
          ...current,
          status: state.status === 'queued' ? 'queued' : 'running',
          error: null,
          updatedAt: new Date().toISOString(),
        }))
        const fresh = ledger.byId(task.localId)
        if (fresh !== undefined) {
          startInProcessWatch({
            ledger,
            adapter,
            context: { ...context, signal: undefined },
            task: fresh,
            pollIntervalMs: model.pollIntervalMs,
            outputDirectory: runtime.outputDirectory(fresh.localId),
            logger,
          })
        }
        logger.info(`video-forge: ${task.localId} is still running at the provider; watching it in the background`)
        continue
      }
      if (state.status === 'succeeded' && state.videoUrl !== null) {
        const artifact = await fetchArtifact(runtime, task, state.videoUrl, apiKey, context)
        await ledger.update(task.localId, current => ({
          ...current,
          status: 'succeeded',
          progress: 1,
          artifacts: artifact === null ? current.artifacts : [artifact],
          error: artifact === null ? { message: 'generation succeeded but the artifact could not be retrieved after restart', code: null } : null,
          updatedAt: new Date().toISOString(),
        }))
        logger.info(`video-forge: ${task.localId} had already finished; recorded its artifact`)
        continue
      }
      await ledger.update(task.localId, current => ({
        ...current,
        status: state.status === 'cancelled' ? 'cancelled' : 'failed',
        error: state.error ?? { message: `the provider reported status "${state.status}" while reconciling`, code: null },
        updatedAt: new Date().toISOString(),
      }))
    } catch (error: unknown) {
      await markOrphaned(ledger, task, `the provider could not be reached (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

async function fetchArtifact(
  runtime: VideoForgeRuntime,
  task: VideoTask,
  url: string,
  apiKey: string | null,
  context: AdapterContext,
): Promise<VideoTask['artifacts'][number] | null> {
  try {
    return await downloadArtifact({
      url,
      apiKey,
      directory: runtime.outputDirectory(task.localId),
      localId: task.localId,
      fetch: context.fetch,
      signal: undefined,
      mimeHint: 'video/mp4',
    })
  } catch (error: unknown) {
    runtime.logger.warn(`video-forge: could not download ${task.localId}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function markOrphaned(ledger: Ledger, task: VideoTask, reason: string): Promise<void> {
  await ledger.update(task.localId, current => ({
    ...current,
    status: 'orphaned',
    error: { message: reason, code: null },
    updatedAt: new Date().toISOString(),
  }))
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
