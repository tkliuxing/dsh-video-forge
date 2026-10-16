/**
 * Where an artifact goes, and getting it there (DESIGN §17.2, §17.5).
 *
 * Two moments, two functions:
 *
 * - {@link planDestination} runs before anything is paid for. A session that may
 *   not write its workspace (`read-only`, or a mode the policy could not name)
 *   and a workspace this machine cannot write (an SSH workspace) are refused
 *   there and then — the user would otherwise pay for a video that cannot land
 *   where they asked. A call no session made goes to `$DSH_HOME`.
 * - {@link deliverArtifact} runs once the bytes are downloaded (into
 *   `$DSH_HOME`, as before). It re-checks the session's mode — the user can
 *   tighten it after submitting — and moves the file to
 *   `<workspace>/<renders>/<shot>/vNNN.<ext>`, with a description file beside
 *   it. The money is spent by then, so it never fails: anything that stops the
 *   move leaves the artifact in `$DSH_HOME` with the reason recorded.
 *
 * `ctx.fs` writes text only, so the video itself is written with Node's `fs`
 * on this machine, after the same checks the host makes for its own tools:
 * the workspace must map to this machine, and under `workspace-write` the real
 * path of the target directory must lie inside the workspace (a symlinked
 * `renders/` pointing elsewhere is refused). Small text files go through
 * `ctx.fs.writeText` under the session's policy, so the host fences them itself.
 *
 * Versions are allocated by the filesystem: each candidate name is published
 * with `link(2)`, which never replaces an existing file, so two deliveries into
 * one shot — from two conversations, or two processes — cannot both get v003.
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, copyFile, link, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Ledger } from './ledger.ts'
import { initialManifestText, MANIFEST_FILE, type ProjectState } from './project.ts'
import { SANDBOX_MODES, type SandboxMode, type TaskSession } from './session-context.ts'
import { ConfigError } from './settings.ts'
import type { ArtifactDestination, ArtifactFrame, ArtifactLocation, TaskBilling, VideoArtifact, VideoTask } from './types.ts'
import { fsErrorCode, workspaceFsOf, type WorkspaceFs } from './workspace-fs.ts'
import type { WatchLogger } from './watch.ts'

/** Why a call with no session lands outside any workspace. */
export const NO_SESSION_REASON = 'it was not requested from a workspace conversation'

/**
 * Decide, before submitting, where the artifact will go — or refuse.
 *
 * @param project - the workspace's manifest state; null when there is no workspace to read.
 * @throws ConfigError when the session may not or cannot receive the artifact.
 */
export async function planDestination(
  ctx: Context,
  session: TaskSession | null,
  project: ProjectState | null,
  shot: string,
): Promise<ArtifactDestination> {
  if (session === null) return { kind: 'home', reason: NO_SESSION_REASON }
  if (session.cwd === null || project === null) return { kind: 'home', reason: 'the session has no workspace folder' }

  if (session.mode === 'read-only') {
    throw new ConfigError('this conversation is in read-only mode, so the video could not be saved into the workspace; nothing was submitted and nothing was charged. Ask the user to switch the conversation to workspace-write (or full access), then try again')
  }
  if (session.mode === 'unknown') {
    throw new ConfigError('the host could not say which permission mode this conversation runs in, so the plugin treats it as read-only; nothing was submitted and nothing was charged. Ask the user to check the conversation\'s permission mode, then try again')
  }

  const fs = workspaceFsOf(ctx, true)
  if (fs === null) {
    throw new ConfigError('the host filesystem service is not available (a remote workspace may be reconnecting); nothing was submitted — try again in a moment')
  }
  const root = await localRoot(fs, session.cwd)
  if (root.kind === 'missing') {
    throw new ConfigError(`the workspace folder ${session.cwd} does not exist any more (moved or deleted?); nothing was submitted and nothing was charged`)
  }
  if (root.kind === 'remote') {
    throw new ConfigError(`the workspace ${session.cwd} is not on this machine (${root.detail}); the plugin cannot save videos into a remote workspace yet, so nothing was submitted and nothing was charged`)
  }
  if (root.kind === 'unverifiable') return { kind: 'home', reason: root.detail }

  const relativeDir = `${project.manifest.paths.renders}/${shot}`
  const existing = await deepestExisting(join(root.path, ...relativeDir.split('/')))
  if (existing.dangling) {
    throw new ConfigError(`${existing.path} is a link to something that does not exist, in the way of ${relativeDir}; nothing was submitted. Fix or remove the link, or point paths.renders in ${MANIFEST_FILE} elsewhere`)
  }
  if (!existing.directory) {
    throw new ConfigError(`${existing.path} is in the way of ${relativeDir}: it exists but is not a folder; nothing was submitted. Move it, or point paths.renders in ${MANIFEST_FILE} elsewhere`)
  }
  if (!(await access(existing.path, constants.W_OK).then(() => true, () => false))) {
    throw new ConfigError(`${existing.path} is not writable, so ${relativeDir} cannot be created or written; nothing was submitted`)
  }
  if (session.mode === 'workspace-write' && !isInside(root.path, existing.real)) {
    throw new ConfigError(`${relativeDir} resolves outside the workspace (${existing.real}), which workspace-write mode does not allow; nothing was submitted. Point paths.renders in ${MANIFEST_FILE} at a folder inside the workspace`)
  }

  return { kind: 'workspace', root: session.cwd, renders: project.manifest.paths.renders, shot, writeManifest: !project.exists }
}

/** What delivery needs besides the downloaded file. */
export interface DeliveryContext {
  ctx: Context
  ledger: Ledger
  logger: WatchLogger
}

/**
 * Copy a downloaded artifact to its destination. Never throws: when the
 * workspace cannot take it, the `$DSH_HOME` copy is the artifact and the reason
 * is recorded in `location`. The `$DSH_HOME` copy is not removed here: the
 * caller does that with {@link discardStaging} once the ledger records where
 * the artifact went, so a failed ledger write never leaves it unrecorded.
 */
export async function deliverArtifact(
  context: DeliveryContext,
  task: VideoTask,
  artifact: VideoArtifact,
  billing: TaskBilling | null,
): Promise<VideoArtifact> {
  const destination = task.destination
  const keep = (reason: string | null): VideoArtifact => ({ ...artifact, location: { kind: 'home', reason } })
  if (destination === undefined) return keep(null)
  if (destination.kind === 'home') return keep(destination.reason)
  // A session record this build could not read was dropped from the row. Its
  // mode is then unknown, and an unknown mode never writes the workspace.
  if (task.session === undefined) return keep('the task\'s session record could not be read, so its permission mode is unknown')

  const mode = effectiveMode(context.ctx, task.session ?? null)
  if (mode === 'read-only' || mode === 'unknown') {
    return keep(`the conversation's permission mode became ${mode} after the task was submitted, so it was not written into the workspace`)
  }
  const fs = workspaceFsOf(context.ctx, true)
  if (fs === null) return keep('the host filesystem service was not available when the video arrived')

  let placed: { path: string; relativePath: string; version: number }
  try {
    const root = await localRoot(fs, destination.root)
    if (root.kind !== 'local') return keep(`the workspace cannot be written from here (${root.detail})`)
    placed = await placeVersion(context.ledger, root.path, destination, artifact, mode === 'workspace-write')
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    context.logger.warn(`video-forge: could not write ${task.localId} into ${destination.root}: ${message}`)
    return keep(`writing into the workspace failed (${message})`)
  }

  // The last frame goes beside its take under the same number, best-effort:
  // without it the take only cannot be continued with `from`.
  const lastFrame = artifact.lastFrame === undefined
    ? undefined
    : await placeFrame(artifact.lastFrame, placed.path).catch((error: unknown) => {
        context.logger.warn(`video-forge: could not place the last frame of ${task.localId}: ${messageOf(error)}`)
        return artifact.lastFrame
      })
  const delivered: VideoArtifact = { ...artifact, path: placed.path, ...(lastFrame === undefined ? {} : { lastFrame }) }

  const policy = mode === null ? undefined : { mode, workspaceRoot: destination.root, ...(task.session === undefined ? {} : { sessionId: task.session.id }) }
  const sidecarPath = placed.relativePath.replace(/\.[^./]+$/, '.json')
  // Create-only: a sidecar is never written over another take's.
  const sidecar = await writeText(fs, destination.root, sidecarPath, sidecarText(task, delivered, placed, billing), policy, true)
    .then(() => sidecarPath)
    .catch((error: unknown) => {
      context.logger.warn(`video-forge: could not write ${sidecarPath} for ${task.localId}: ${messageOf(error)}`)
      return null
    })
  if (destination.writeManifest) {
    // Written only if still absent: the user may have created either meanwhile.
    for (const [path, text] of [[MANIFEST_FILE, initialManifestText()], [`${destination.renders}/.gitignore`, '*\n']] as const) {
      await writeText(fs, destination.root, path, text, policy, true).catch((error: unknown) => {
        if (fsErrorCode(error) !== 'FS_NOT_OBSERVED') context.logger.warn(`video-forge: could not write ${path}: ${messageOf(error)}`)
      })
    }
  }

  const location: ArtifactLocation = {
    kind: 'workspace',
    root: destination.root,
    relativePath: placed.relativePath,
    shot: destination.shot,
    version: placed.version,
    sidecar,
  }
  return { ...delivered, location }
}

/** Copy a staged last frame beside the published video as `vNNN.last.<ext>`. */
async function placeFrame(frame: ArtifactFrame, videoPath: string): Promise<ArtifactFrame> {
  const extension = extname(frame.path) === '' ? '.jpg' : extname(frame.path)
  const target = join(dirname(videoPath), `${basename(videoPath, extname(videoPath))}.last${extension}`)
  // Exclusive: the take's number is ours, but never write over anything.
  await copyFile(frame.path, target, constants.COPYFILE_EXCL)
  // Placed is placed: a permission tweak that fails must not orphan the copy.
  await chmod(target, 0o666 & ~process.umask()).catch(() => undefined)
  return { ...frame, path: target }
}

/** Remove the downloaded copy once the ledger records a delivery elsewhere. */
export async function discardStaging(downloaded: VideoArtifact, delivered: VideoArtifact): Promise<void> {
  if (downloaded.path === delivered.path) return
  await unlink(downloaded.path).catch(() => undefined)
  if (downloaded.lastFrame !== undefined && downloaded.lastFrame.path !== delivered.lastFrame?.path) {
    await unlink(downloaded.lastFrame.path).catch(() => undefined)
  }
  await rmdir(dirname(downloaded.path)).catch(() => undefined)
}

/** One line for the model about where an artifact is. */
export function describeLocation(artifact: VideoArtifact): string {
  const location = artifact.location
  if (location === undefined) return artifact.path
  if (location.kind === 'workspace') return `${location.relativePath} in the workspace`
  return location.reason === null ? artifact.path : `${artifact.path} (kept outside the workspace: ${location.reason})`
}

/**
 * The session's mode now: the stricter of what was recorded at submit time and
 * what the policy says for the live session, if it is still loaded.
 */
function effectiveMode(ctx: Context, session: TaskSession | null): TaskSession['mode'] {
  const recorded = session?.mode ?? null
  if (session === null) return recorded
  const agents = ctx.get('agents' as never) as { get(id: string): { session?: unknown } | undefined } | undefined
  const policy = ctx.get('sandboxPolicy' as never) as { resolve(request: { session?: unknown }): { mode: SandboxMode } } | undefined
  let live: TaskSession['mode'] = null
  try {
    const agent = agents?.get(session.id)
    if (agent?.session !== undefined && policy !== undefined) {
      const resolved = policy.resolve({ session: agent.session }).mode
      live = SANDBOX_MODES.includes(resolved) ? resolved : 'unknown'
    }
  } catch {
    live = 'unknown'
  }
  return STRICTNESS[live ?? 'none'] > STRICTNESS[recorded ?? 'none'] ? live : recorded
}

const STRICTNESS: Record<SandboxMode | 'unknown' | 'none', number> = {
  'none': 0,
  'danger-full-access': 1,
  'workspace-write': 2,
  'unknown': 3,
  'read-only': 3,
}

type RootCheck =
  | { kind: 'local'; path: string }
  | { kind: 'missing'; detail: string }
  | { kind: 'remote'; detail: string }
  | { kind: 'unverifiable'; detail: string }

/**
 * Whether the workspace is a folder on this machine, and its real path here.
 * The same test the host's session controller makes: the host path must map
 * into the filesystem's world and resolve back to the same file.
 */
async function localRoot(fs: WorkspaceFs, cwd: string): Promise<RootCheck> {
  if (fs.processPathFromHostPath === undefined || fs.processPath === undefined) {
    return { kind: 'unverifiable', detail: 'this DSH version cannot say whether the workspace is on this machine' }
  }
  let real: string
  try {
    real = await realpath(cwd)
  } catch {
    // A local filesystem maps any absolute host path; then the folder is simply gone.
    return fs.processPathFromHostPath(resolve(cwd)) === undefined
      ? { kind: 'remote', detail: 'no such folder here' }
      : { kind: 'missing', detail: 'the workspace folder does not exist any more' }
  }
  const mapped = fs.processPathFromHostPath(real)
  if (mapped === undefined) return { kind: 'remote', detail: 'its filesystem does not see this machine' }
  const [here, there] = await Promise.all([fs.resolve(mapped), fs.resolve(cwd)])
  if (fs.processPath(here) !== fs.processPath(there)) return { kind: 'remote', detail: 'the same path names a different folder here' }
  return { kind: 'local', path: real }
}

/**
 * The deepest part of `target` that exists: its path, its real path, and
 * whether it is a folder (a file there means the rest cannot be created).
 */
async function deepestExisting(target: string): Promise<{ path: string; real: string; directory: boolean; dangling: boolean }> {
  const absent = (error: unknown): null => {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
  let probe = target
  for (;;) {
    const info = await stat(probe).catch(absent)
    if (info !== null) return { path: probe, real: await realpath(probe), directory: info.isDirectory(), dangling: false }
    // A link whose target is gone looks absent to stat; creating through it would fail later.
    if ((await lstat(probe).catch(absent))?.isSymbolicLink() === true) return { path: probe, real: probe, directory: false, dangling: true }
    const parent = dirname(probe)
    if (parent === probe) return { path: probe, real: probe, directory: false, dangling: false }
    probe = parent
  }
}

/** Null when `target` (or its deepest existing part) really lies inside `root`; otherwise where it points. */
async function escapesWorkspace(root: string, target: string): Promise<string | null> {
  const existing = await deepestExisting(target)
  return isInside(root, existing.real) ? null : existing.real
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const VERSIONED = /^v(\d{3,})\.[A-Za-z0-9]+$/

/** Copy the artifact into the shot directory under the next free version. */
async function placeVersion(
  ledger: Ledger,
  root: string,
  destination: Extract<ArtifactDestination, { kind: 'workspace' }>,
  artifact: VideoArtifact,
  contained: boolean,
): Promise<{ path: string; relativePath: string; version: number }> {
  const relativeDir = `${destination.renders}/${destination.shot}`
  const wanted = join(root, ...relativeDir.split('/'))
  const check = async (): Promise<void> => {
    if (!contained) return
    const escape = await escapesWorkspace(root, wanted)
    if (escape !== null) throw new Error(`${relativeDir} resolves outside the workspace (${escape})`)
  }
  await check()
  await mkdir(wanted, { recursive: true })
  await check()
  const directory = await realpath(wanted)

  // Above every version on disk and every version the ledger handed out here
  // (a deleted v002 must not be reissued while a task still names it).
  let highest = 0
  for (const name of await readdir(directory)) {
    const match = VERSIONED.exec(name)
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  for (const task of ledger.list()) {
    for (const entry of task.artifacts) {
      if (entry.location?.kind === 'workspace' && dirname(entry.path) === directory) highest = Math.max(highest, entry.location.version)
    }
  }

  const extension = extname(artifact.path) === '' ? '.mp4' : extname(artifact.path)
  const staging = join(directory, `.${basename(artifact.path)}.${randomBytes(4).toString('hex')}.part`)
  await copyFile(artifact.path, staging, constants.COPYFILE_EXCL)
  try {
    // An ordinary user file, as if the user had saved it: their umask applies.
    await chmod(staging, 0o666 & ~process.umask())
    for (let version = highest + 1; version <= highest + 100; version += 1) {
      const number = `v${String(version).padStart(3, '0')}`
      // A number is taken by a file of any extension (another take, its sidecar).
      if ((await readdir(directory)).some(entry => entry.startsWith(`${number}.`))) continue
      const name = `${number}${extension}`
      const final = join(directory, name)
      await check()
      if (await publish(staging, final)) return { path: final, relativePath: `${relativeDir}/${name}`, version }
    }
    throw new Error(`no free version name in ${relativeDir}`)
  } finally {
    await rm(staging, { force: true })
  }
}

/**
 * Publish without replacing: true when `final` now names the staged file,
 * false when the name was taken. `linker` is replaceable for tests.
 */
export async function publish(staging: string, final: string, linker: (from: string, to: string) => Promise<void> = link): Promise<boolean> {
  try {
    await linker(staging, final)
    return true
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'EEXIST') return false
    // Some filesystems (FAT/exFAT, some network mounts) have no hard links.
    // Claim the name with an exclusive create, which they do support, then
    // move the staged file onto our own placeholder.
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EXDEV') throw error
    let placeholder
    try {
      placeholder = await open(final, 'wx')
    } catch (claim: unknown) {
      if ((claim as { code?: string }).code === 'EEXIST') return false
      throw claim
    }
    await placeholder.close()
    try {
      await rename(staging, final)
    } catch (moved: unknown) {
      // Do not leave an empty take behind.
      await unlink(final).catch(() => undefined)
      throw moved
    }
    return true
  }
}

async function writeText(
  fs: WorkspaceFs,
  root: string,
  relativePath: string,
  text: string,
  policy: { mode: string; workspaceRoot: string; sessionId?: string } | undefined,
  createOnly: boolean,
): Promise<void> {
  if (fs.writeText === undefined) throw new Error('this DSH version has no text write in its filesystem service')
  const target = await fs.resolve(relativePath, { cwd: root })
  await fs.writeText(target, text, createOnly ? { kind: 'createIfAbsent' } : undefined, undefined, policy)
}

/** The description file: enough for the project to explain the artifact without the global ledger. */
function sidecarText(
  task: VideoTask,
  artifact: VideoArtifact,
  placed: { relativePath: string; version: number },
  billing: TaskBilling | null,
): string {
  const usage = billing === null || billing.state !== 'reported'
    ? null
    : { tokens: billing.tokens, outputSeconds: billing.outputSeconds, fields: billing.fields }
  const root = task.destination?.kind === 'workspace' ? task.destination.root : null
  const document = {
    generator: 'dsh-video-forge',
    version: 1,
    file: basename(placed.relativePath),
    lastFrame: artifact.lastFrame !== undefined && dirname(artifact.lastFrame.path) === dirname(artifact.path) ? basename(artifact.lastFrame.path) : null,
    shot: task.destination?.kind === 'workspace' ? task.destination.shot : null,
    take: placed.version,
    taskId: task.localId,
    provider: task.provider,
    model: task.model,
    providerTaskId: task.providerTaskId,
    prompt: task.params.prompt,
    // What was actually sent, when the project's style or characters were added to it.
    sentPrompt: task.params.sentPrompt ?? null,
    style: task.params.style ?? null,
    characters: task.params.characters ?? [],
    mode: task.params.mode,
    durationSeconds: task.params.durationSeconds,
    resolution: task.params.resolution,
    aspectRatio: task.params.aspectRatio,
    materials: {
      firstFrame: portable(task.params.firstFrame, root),
      lastFrame: portable(task.params.lastFrame, root),
      referenceImages: task.params.referenceImages.map(entry => portable(entry, root)),
    },
    from: task.params.from ?? null,
    submittedAt: task.submittedAt,
    deliveredAt: new Date().toISOString(),
    bytes: artifact.bytes,
    mime: artifact.mime,
    usage,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * A material descriptor fit for a file that may be committed: a path inside the
 * workspace becomes workspace-relative; one outside keeps only its name (with
 * the digest), so the user's home layout does not travel with the project.
 */
function portable(descriptor: string | null, root: string | null): string | null {
  const match = descriptor === null ? null : /^path:(.*)#(sha256:[0-9a-f]+)$/.exec(descriptor)
  if (match === null || root === null) return descriptor
  const [, location = '', digest = ''] = match
  const style = root.includes('\\') && !root.startsWith('/') ? win32 : posix
  const rel = style.relative(root, location)
  if (rel !== '' && rel !== '..' && !rel.startsWith(`..${style.sep}`) && !style.isAbsolute(rel)) {
    return `path:${rel.split(style.sep).join('/')}#${digest}`
  }
  return `path:…/${style.basename(location)}#${digest}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
