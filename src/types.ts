/**
 * Vocabulary shared by the ledger, the provider adapters, the tools and the
 * browser card. Nothing in here depends on a DSH service, so it is also the
 * boundary the fixture-backed tests exercise.
 */

/** Lifecycle of one generation task, as the ledger stores it. */
export type VideoTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  /** Submitted before this process started and not yet reconciled with the provider. */
  | 'orphaned'

/** Input shape of a generation, exactly one mutually exclusive scenario. */
export type VideoMode = 't2v' | 'i2v' | 'flf2v' | 's2v'

/**
 * Every mode, in the order a form should offer them. Declared once because the
 * request validator, the capability schema and the configuration card all have
 * to agree on the set — a mode that exists in one of them and not the others is
 * a value the UI cannot express and the runtime cannot validate.
 */
export const VIDEO_MODES: readonly VideoMode[] = ['t2v', 'i2v', 'flf2v', 's2v']

/** Where a piece of input material comes from. */
export type MaterialKind = 'path' | 'attachment' | 'url'

/** One input material as the model refers to it, before it is resolved to bytes or a URL. */
export interface MaterialRef {
  kind: MaterialKind
  /** Absolute workspace path, session attachment id, or an http(s) URL. */
  value: string
}

/** Material after resolution: something a provider can fetch. */
export interface ResolvedMaterial {
  /** http(s) URL, or a `data:` URL when the bytes were read locally. */
  url: string
  /** sha256 of the exact bytes, or of the URL when nothing was read. Used by the dedupe fingerprint. */
  digest: string
  bytes: number | null
  mime: string | null
}

/** A generation request in provider-neutral terms. */
export interface GenerationRequest {
  model: string
  prompt: string
  mode: VideoMode
  firstFrame: ResolvedMaterial | null
  lastFrame: ResolvedMaterial | null
  referenceImages: ResolvedMaterial[]
  durationSeconds: number | null
  resolution: string | null
  aspectRatio: string | null
  /** Whether the provider should produce a synchronized audio track, when it can. */
  generateAudio: boolean | null
}

/** Provider-reported state of one task. `unknown` means the body did not carry a recognizable status. */
export type ProviderStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'

/** One poll's worth of provider truth. */
export interface ProviderTaskState {
  status: ProviderStatus
  /** 0..1 when the provider reports progress, else null. */
  progress: number | null
  /** Downloadable artifact URL, present only once the provider reports success. */
  videoUrl: string | null
  error: { message: string; code: string | null } | null
  /** Whether the provider's own status vocabulary said the task is finished for good. */
  terminal: boolean
}

/** A produced artifact after it landed in `$DSH_HOME`. */
export interface VideoArtifact {
  path: string
  bytes: number
  mime: string
  width: number | null
  height: number | null
  durationSec: number | null
  /** 128-bit random hex, the only thing that authorizes media access besides the task id. */
  token: string
  createdAt: string
}

/** Stored, redacted request facts. Never carries material bytes. */
export interface VideoTaskParams {
  prompt: string
  mode: VideoMode
  durationSeconds: number | null
  resolution: string | null
  aspectRatio: string | null
  /** Descriptors such as `path:/tmp/a.png#sha256:ab12…`, never file contents. */
  firstFrame: string | null
  lastFrame: string | null
  referenceImages: string[]
}

export interface VideoTaskError {
  message: string
  code: string | null
}

/** One ledger row. */
export interface VideoTask {
  localId: string
  /** Configured provider id. */
  provider: string
  protocol: string
  model: string
  providerTaskId: string | null
  status: VideoTaskStatus
  progress: number | null
  submittedAt: string
  updatedAt: string
  paramsFingerprint: string
  params: VideoTaskParams
  artifacts: VideoArtifact[]
  error: VideoTaskError | null
}

/** On-disk ledger document. */
export interface LedgerDocument {
  version: 1
  tasks: VideoTask[]
}
