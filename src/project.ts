/**
 * The workspace as a video project (DESIGN §16.2, §17).
 *
 * A workspace may carry `video-project.yaml` at its root: default generation
 * parameters, a project style, registered characters, and where each kind of
 * content lives. Without one the default layout applies, and the plugin writes
 * one next to the first artifact it delivers (DESIGN §17.5).
 *
 * The manifest is read through `ctx.fs`, like every workspace read, so it works
 * wherever the workspace lives. A manifest that does not parse is refused before
 * anything is submitted: a paid generation must not silently ignore the
 * defaults or the destination the user wrote down.
 */

import { parse as parseYaml, YAMLParseError } from 'yaml'
import { ConfigError } from './settings.ts'
import { fsErrorCode, type WorkspaceFs } from './workspace-fs.ts'

export const MANIFEST_FILE = 'video-project.yaml'

/** The shot folder for a request that names none and continues nothing. */
export const DEFAULT_SHOT = 'untitled'

/** A manifest is a few lines of YAML; anything near this size is not one. */
const MAX_MANIFEST_BYTES = 256 * 1024

/** Where each kind of project content lives, relative to the workspace root (POSIX separators). */
export interface ProjectPaths {
  script: string
  storyboard: string
  materials: string
  renders: string
  cache: string
}

export const DEFAULT_PATHS: ProjectPaths = {
  script: 'script',
  storyboard: 'storyboard',
  materials: 'materials',
  renders: 'renders',
  cache: '.dsh-video',
}

export interface ProjectDefaults {
  provider: string | null
  model: string | null
  resolution: string | null
  aspectRatio: string | null
  durationSeconds: number | null
}

export interface ProjectCharacter {
  /** Reference images, workspace-relative; `*`/`?` in the file name are expanded when used. */
  refs: string[]
  description: string | null
}

export interface ProjectManifest {
  version: 1
  defaults: ProjectDefaults
  /** Project-wide style text, added to every prompt `video_generate` sends. */
  style: string | null
  characters: Record<string, ProjectCharacter>
  paths: ProjectPaths
}

export const DEFAULT_MANIFEST: ProjectManifest = {
  version: 1,
  defaults: { provider: null, model: null, resolution: null, aspectRatio: null, durationSeconds: null },
  style: null,
  characters: {},
  paths: DEFAULT_PATHS,
}

/** A manifest the plugin cannot use; the message names the field and how to fix it. */
export class ManifestError extends ConfigError {
  /** `invalid`: the file says something unusable; `unreadable`: the file could not be read at all. */
  readonly kind: 'invalid' | 'unreadable'

  constructor(message: string, kind: 'invalid' | 'unreadable' = 'invalid') {
    super(`${MANIFEST_FILE}: ${message}`)
    this.name = 'ManifestError'
    this.kind = kind
  }
}

/** Parse and validate manifest text. Unknown top-level keys are ignored; unknown keys inside a section are refused. */
export function parseManifest(text: string): ProjectManifest {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error: unknown) {
    const detail = error instanceof YAMLParseError ? error.message.split('\n', 1)[0] : String(error)
    throw new ManifestError(`not valid YAML (${detail})`)
  }
  if (raw === null || raw === undefined) return DEFAULT_MANIFEST
  const root = record(raw, 'the document')

  const version = root.version ?? 1
  if (version !== 1) throw new ManifestError(`version ${JSON.stringify(version)} is not supported; this plugin reads version 1`)

  const defaultsRaw = root.defaults === undefined || root.defaults === null ? {} : record(root.defaults, 'defaults')
  knownKeys(defaultsRaw, 'defaults', ['provider', 'model', 'resolution', 'aspect_ratio', 'aspectRatio', 'duration_seconds', 'durationSeconds'])
  const defaults: ProjectDefaults = {
    provider: optionalString(defaultsRaw.provider, 'defaults.provider'),
    model: optionalString(defaultsRaw.model, 'defaults.model'),
    resolution: optionalString(defaultsRaw.resolution, 'defaults.resolution'),
    aspectRatio: optionalString(defaultsRaw.aspect_ratio ?? defaultsRaw.aspectRatio, 'defaults.aspect_ratio'),
    durationSeconds: optionalPositive(defaultsRaw.duration_seconds ?? defaultsRaw.durationSeconds, 'defaults.duration_seconds'),
  }

  const charactersRaw = root.characters === undefined || root.characters === null ? {} : record(root.characters, 'characters')
  const characters: Record<string, ProjectCharacter> = {}
  for (const [name, value] of Object.entries(charactersRaw)) {
    if (!SLUG.test(name)) throw new ManifestError(`character name "${name}" must be letters, digits, "-", "_" or "."`)
    const entry = value === null ? {} : record(value, `characters.${name}`)
    knownKeys(entry, `characters.${name}`, ['refs', 'description'])
    const refs = entry.refs === undefined || entry.refs === null ? [] : entry.refs
    if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string' || ref.trim() === '')) {
      throw new ManifestError(`characters.${name}.refs must be a list of workspace paths`)
    }
    characters[name] = {
      refs: (refs as string[]).map(ref => projectPath(ref, `characters.${name}.refs`)),
      description: optionalString(entry.description, `characters.${name}.description`),
    }
  }

  const pathsRaw = root.paths === undefined || root.paths === null ? {} : record(root.paths, 'paths')
  knownKeys(pathsRaw, 'paths', Object.keys(DEFAULT_PATHS))
  const paths = { ...DEFAULT_PATHS }
  for (const key of Object.keys(DEFAULT_PATHS) as (keyof ProjectPaths)[]) {
    const value = pathsRaw[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || value.trim() === '') throw new ManifestError(`paths.${key} must be a workspace-relative directory`)
    paths[key] = projectPath(value, `paths.${key}`)
  }

  return {
    version: 1,
    defaults,
    style: optionalString(root.style, 'style'),
    characters,
    paths,
  }
}

/** What a workspace says about itself: its manifest, and whether the file exists. */
export interface ProjectState {
  manifest: ProjectManifest
  /** False when the workspace has no manifest yet (the default layout applies). */
  exists: boolean
}

/** Read the manifest at the workspace root; a missing file is the default layout. */
export async function readProject(fs: WorkspaceFs, cwd: string, signal?: AbortSignal): Promise<ProjectState> {
  let text: string
  try {
    const target = await fs.resolve(MANIFEST_FILE, { cwd, ...(signal === undefined ? {} : { signal }) })
    const info = await fs.stat(target, signal)
    if (info === undefined) return { manifest: DEFAULT_MANIFEST, exists: false }
    if (info.type !== 'file') throw new ManifestError('exists but is not a regular file')
    const bytes = await fs.readBytes(target, signal, MAX_MANIFEST_BYTES)
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    if (error instanceof ManifestError) throw error
    if (fsErrorCode(error) === 'FS_NOT_FOUND') return { manifest: DEFAULT_MANIFEST, exists: false }
    if (fsErrorCode(error) === 'FS_TOO_LARGE') throw new ManifestError(`is larger than ${MAX_MANIFEST_BYTES / 1024} KiB`)
    if (error instanceof TypeError) throw new ManifestError('is not UTF-8 text')
    throw new ManifestError(`cannot be read (${error instanceof Error ? error.message : String(error)})`, 'unreadable')
  }
  return { manifest: parseManifest(text), exists: true }
}

/** The manifest written next to the first artifact in a workspace that has none. */
export function initialManifestText(): string {
  return [
    '# Video project manifest (dsh-video-forge). Edit freely; every key is optional.',
    'version: 1',
    '',
    '# Used when a request leaves them out.',
    'defaults: {}',
    '#  provider: ark',
    '#  model: doubao-seedance-2-0-fast-260128',
    '#  resolution: 720p',
    '#  aspect_ratio: "16:9"',
    '#  duration_seconds: 5',
    '',
    '# Project-wide look, kept here rather than in every prompt.',
    '# style: warm film grain, soft daylight',
    '',
    '# Characters to keep consistent across shots.',
    'characters: {}',
    '#  alice:',
    '#    refs: [materials/alice/front.png]',
    '#    description: red scarf, short black hair',
    '',
    '# Where each kind of content lives, relative to this file.',
    'paths:',
    ...Object.entries(DEFAULT_PATHS).map(([key, value]) => `  ${key}: ${value}`),
    '',
  ].join('\n')
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Whether a stored workspace-relative folder is one this plugin would have written (relative, no `..`). */
export function isProjectPath(value: string): boolean {
  try {
    return projectPath(value, 'path') === value
  } catch {
    return false
  }
}

/** Whether a string is usable as a shot (directory) name. */
export function isShotName(value: string): boolean {
  return SLUG.test(value) && !value.includes('..')
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ManifestError(`${where} must be a mapping`)
  return value as Record<string, unknown>
}

/**
 * Inside a section, an unknown key is almost always a typo — `render:` for
 * `renders:` — and ignoring it would send a paid video somewhere the user did
 * not ask for. Unknown top-level keys are left alone for newer manifests.
 */
function knownKeys(section: Record<string, unknown>, where: string, known: readonly string[]): void {
  const unknown = Object.keys(section).filter(key => !known.includes(key))
  if (unknown.length > 0) {
    throw new ManifestError(`${where} has unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map(key => `"${key}"`).join(', ')}; known keys are ${known.filter(key => !/[A-Z]/.test(key)).join(', ')}`)
  }
}

function optionalString(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') throw new ManifestError(`${where} must be text`)
  return value.trim() === '' ? null : value.trim()
}

function optionalPositive(value: unknown, where: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new ManifestError(`${where} must be a positive number`)
  return value
}

/**
 * A workspace-relative path as POSIX segments. Absolute paths and `..` are
 * refused outright: the manifest describes the project, and the project is the
 * workspace. Symlinks are a separate matter, checked where files are written.
 */
function projectPath(value: string, where: string): string {
  const trimmed = value.trim().replaceAll('\\', '/')
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('~')) {
    throw new ManifestError(`${where} must be relative to the workspace, got "${value}"`)
  }
  const segments = trimmed.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.includes('..')) throw new ManifestError(`${where} must stay inside the workspace, got "${value}"`)
  if (segments.length === 0) throw new ManifestError(`${where} must name a directory inside the workspace, got "${value}"`)
  return segments.join('/')
}
