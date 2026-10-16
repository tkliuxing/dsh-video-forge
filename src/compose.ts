/**
 * Turning a `video_generate` request into what is sent, deterministically
 * (DESIGN §16.2, §16.3, §17.3 M3.3). The tool does this itself rather than
 * trusting the model to remember: a project's style, a character's reference
 * images, and the frame a continuation starts from must be the same every
 * time, whether or not the model loaded a skill.
 *
 * - `from`: continue an earlier take. Its last frame (ARK `return_last_frame`)
 *   becomes this request's first frame, and the shot carries over.
 * - `characters`: registered in `video-project.yaml`. Their descriptions are
 *   added to the prompt; their reference images are sent where the mode takes
 *   reference images (and make the mode `s2v` when the request named none).
 * - `style`: the manifest's project style, added to every prompt.
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, normalize, posix, resolve as resolvePath } from 'node:path'
import type { GenerateInput } from './operations.ts'
import type { ProjectState } from './project.ts'
import { returnsLastFrame } from './providers/index.ts'
import type { VideoForgeRuntime } from './runtime.ts'
import type { TaskSession } from './session-context.ts'
import { ConfigError } from './settings.ts'
import type { VideoTask } from './types.ts'
import { workspaceFsOf, type WorkspaceFs } from './workspace-fs.ts'

export interface Composition {
  /** The request with the frame from `from` and the characters' references filled in. */
  input: GenerateInput
  /** The prompt as it goes to the provider. */
  sentPrompt: string
  style: string | null
  characters: string[]
  /** The task this one continues, by local id. */
  from: string | null
  /** The shot of the continued take, for a request that named none. */
  inheritedShot: string | null
  /** The mode became `s2v` only because characters brought reference images. */
  impliedS2v: boolean
  /** What the model should be told about how the request was shaped. */
  notes: string[]
}

/**
 * A conservative ceiling on reference images characters may add. Providers
 * refuse more than a handful (ARK takes up to 9), and a glob makes it easy to
 * match a whole folder by accident; the refusal names the cause before anything
 * is sent, instead of a provider error after the intent row.
 */
const MAX_CHARACTER_REFS = 9

/** Shape the request; throws ConfigError for anything that cannot be honoured, before anything is paid. */
export async function compose(
  runtime: VideoForgeRuntime,
  input: GenerateInput,
  project: ProjectState | null,
  session: TaskSession | null,
  signal?: AbortSignal,
): Promise<Composition> {
  // Checked on the user's own words: the style and character text added below
  // must never turn an empty request into a paid one.
  if (input.prompt.trim() === '') throw new ConfigError('prompt must not be empty')
  const next: GenerateInput = { ...input }
  const notes: string[] = []
  let from: string | null = null
  let inheritedShot: string | null = null

  const fromValue = input.from?.trim() ?? ''
  if (fromValue !== '') {
    const source = await resolveSource(runtime, fromValue, session)
    const frame = continuationFrame(source)
    if ((input.firstFrame ?? '').trim() !== '') {
      throw new ConfigError('from already supplies the first frame (the last frame of the take it continues); do not also pass first_frame')
    }
    if (input.mode === 't2v' || input.mode === 's2v') {
      throw new ConfigError(`from continues a take from its last frame, so it needs mode i2v (or flf2v with last_frame), not ${input.mode}`)
    }
    next.firstFrame = frame
    next.mode = input.mode ?? ((input.lastFrame ?? '').trim() === '' ? 'i2v' : 'flf2v')
    from = source.localId
    inheritedShot = shotOf(source)
    if (source.session?.cwd !== undefined && source.session.cwd !== null && session?.cwd !== undefined && session.cwd !== null && source.session.cwd !== session.cwd) {
      notes.push(`${source.localId} was made in another workspace (${source.session.cwd}); its last frame was read from there`)
    }
  }

  const names = [...new Set((input.characters ?? []).map(name => name.trim()).filter(name => name !== ''))]
  const descriptions: string[] = []
  let impliedS2v = false
  if (names.length > 0) {
    if (project === null || session?.cwd === null || session === null) {
      throw new ConfigError('characters are registered in the workspace\'s video-project.yaml, and this call has no workspace')
    }
    const registered = project.manifest.characters
    const known = Object.keys(registered)
    const refs: string[] = []
    for (const name of names) {
      const character = Object.hasOwn(registered, name) ? registered[name] : undefined
      if (character === undefined) {
        throw new ConfigError(known.length === 0
          ? `no characters are registered; add "${name}" under characters: in video-project.yaml (refs and description)`
          : `no character "${name}" in video-project.yaml; registered: ${known.join(', ')}`)
      }
      descriptions.push(character.description === null ? `- ${name}` : `- ${name}: ${character.description}`)
      for (const pattern of character.refs) refs.push(...await expandRef(runtime, session.cwd, pattern, `characters.${name}.refs`, signal))
    }

    if (refs.length > 0) {
      const ownFrames = (next.firstFrame ?? '').trim() !== '' || (next.lastFrame ?? '').trim() !== ''
      if (next.mode === undefined && !ownFrames) {
        next.mode = 's2v'
        impliedS2v = true
      }
      if (next.mode === 's2v') {
        const merged = [...new Set([...(next.referenceImages ?? []), ...refs])]
        // Counted as sent: after merging with the request's own references, and only in s2v.
        if (merged.length > MAX_CHARACTER_REFS) {
          throw new ConfigError(`with characters ${names.join(', ')} the request would send ${merged.length} reference images; providers take only a few (at most ${MAX_CHARACTER_REFS}), so narrow their refs in video-project.yaml`)
        }
        next.referenceImages = merged
      } else {
        notes.push(`the reference images of ${names.join(', ')} were not sent: mode ${next.mode ?? 't2v'} takes no reference images, so only their descriptions went into the prompt`)
      }
    }
  }

  const style = project?.manifest.style ?? null
  const sections = [input.prompt]
  if (descriptions.length > 0) sections.push(`Characters:\n${descriptions.join('\n')}`)
  if (style !== null) sections.push(`Style: ${style}`)
  const sentPrompt = sections.join('\n\n')
  next.prompt = sentPrompt

  return { input: next, sentPrompt, style, characters: names, from, inheritedShot, impliedS2v, notes }
}

/** The take `from` names: a task id, or the path of a delivered video. */
async function resolveSource(runtime: VideoForgeRuntime, value: string, session: TaskSession | null): Promise<VideoTask> {
  const byId = runtime.ledger.byId(value)
  if (byId !== undefined) return byId

  const cwd = session?.cwd ?? null
  if (cwd !== null || isAbsolute(value)) {
    const candidate = isAbsolute(value) ? normalize(value) : resolvePath(cwd ?? '/', value)
    const real = await realpath(candidate).catch(() => candidate)
    const relative = posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '')
    for (const task of runtime.ledger.list()) {
      for (const artifact of task.artifacts) {
        if (artifact.path === real || artifact.path === candidate) return task
        if (artifact.location?.kind === 'workspace' && artifact.location.root === cwd && artifact.location.relativePath === relative) return task
      }
    }
  }
  throw new ConfigError(`from must name an earlier take: a task id from video_status (like v-20261016-0003) or the path of a video under renders/ — "${value}" is neither`)
}

/** The last frame `from` continues from, or a refusal that says why there is none. */
function continuationFrame(source: VideoTask): string {
  const artifact = source.artifacts[0]
  if (source.status !== 'succeeded' || artifact === undefined) {
    throw new ConfigError(`${source.localId} is ${source.status}${artifact === undefined ? ' with no video' : ''}; only a finished take can be continued`)
  }
  if (!returnsLastFrame(source.protocol)) {
    throw new ConfigError(`${source.localId} was made by ${source.provider} (${source.protocol}), which does not return the video's last frame, so it cannot be continued with from; pass an image of the moment to continue from as first_frame instead`)
  }
  if (artifact.lastFrame === undefined) {
    throw new ConfigError(`${source.localId} has no recorded last frame (made before last frames were kept, by a model that does not return one, or the frame could not be downloaded), so it cannot be continued with from; pass an image as first_frame instead`)
  }
  return artifact.lastFrame.path
}

function shotOf(task: VideoTask): string | null {
  const location = task.artifacts[0]?.location
  if (location?.kind === 'workspace') return location.shot
  return task.destination?.kind === 'workspace' ? task.destination.shot : null
}

/**
 * A character reference as workspace-relative paths. `*` and `?` are allowed
 * in the last segment only (`materials/alice/*.png`); a pattern that matches
 * nothing is an error, because a character sent without its look is exactly
 * the inconsistency registering it was meant to prevent.
 */
async function expandRef(runtime: VideoForgeRuntime, cwd: string, pattern: string, where: string, signal?: AbortSignal): Promise<string[]> {
  const segments = pattern.split('/')
  const last = segments.pop() ?? ''
  if (!/[*?]/.test(last)) return [pattern]
  if (segments.some(segment => /[*?]/.test(segment))) {
    throw new ConfigError(`${where}: "${pattern}" may use * or ? only in the file name, not in folder names`)
  }
  const fs = workspaceFsOf(runtime.ctx, true)
  if (fs === null || fs.listDir === undefined) {
    throw new ConfigError(`${where}: "${pattern}" cannot be expanded because the host filesystem service cannot list folders right now`)
  }
  const folder = segments.join('/')
  const matcher = globMatcher(last)
  const names = await listNames(fs, cwd, folder === '' ? '.' : folder, signal)
  // Hidden files are never a reference: `.DS_Store`, or the AppleDouble `._front.png`
  // an exFAT/SMB copy leaves beside every image.
  const matches = names.filter(entry => entry.type === 'file' && !entry.name.startsWith('.') && matcher.test(entry.name)).map(entry => (folder === '' ? entry.name : `${folder}/${entry.name}`))
  if (matches.length === 0) throw new ConfigError(`${where}: "${pattern}" matches no file in the workspace`)
  return matches
}

/** A folder's entries; a folder that does not exist has none, any other failure is reported as such. */
async function listNames(fs: WorkspaceFs, cwd: string, folder: string, signal?: AbortSignal): Promise<{ name: string; type: string }[]> {
  let info: Awaited<ReturnType<WorkspaceFs['stat']>>
  let target: Awaited<ReturnType<WorkspaceFs['resolve']>>
  try {
    target = await fs.resolve(folder, { cwd, ...(signal === undefined ? {} : { signal }) })
    info = await fs.stat(target, signal)
  } catch (error: unknown) {
    signal?.throwIfAborted()
    throw new ConfigError(`${folder} could not be read (${error instanceof Error ? error.message : String(error)})`)
  }
  if (info === undefined) return []
  if (info.type !== 'directory') throw new ConfigError(`${folder} is not a folder`)
  try {
    return await (fs.listDir as NonNullable<WorkspaceFs['listDir']>)(target, signal)
  } catch (error: unknown) {
    signal?.throwIfAborted()
    throw new ConfigError(`${folder} could not be listed (${error instanceof Error ? error.message : String(error)})`)
  }
}

function globMatcher(glob: string): RegExp {
  const source = glob.split('').map(char => (char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')
  // Case-insensitive, as the filesystems most users keep media on are.
  return new RegExp(`^${source}$`, 'i')
}

