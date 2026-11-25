/**
 * The four teaching tools (docs/TEACH-VIDEO.md §6, DESIGN §23).
 *
 * Same division as the generation tools: `src/teach/pipeline.ts` owns every side
 * effect, and these definitions own the schema, the model-facing prose and the
 * card metadata. A tool whose name starts with `video_teach_` is deliberate —
 * `test/guide-consistency.test.ts` scans skill bodies for `video_*` names and
 * requires each one to be a registered tool, and `teach_video_plan` would be
 * read as a tool called `video_plan`.
 *
 * The workspace is resolved the same way generation resolves it: the session's
 * `cwd`, checked to be a folder on this machine. A remote workspace is refused
 * rather than silently rendered into `$DSH_HOME` — the picture would land
 * somewhere the user never looks.
 *
 * A finished render is recorded in the ledger with `origin: 'local'`, which is
 * what makes it appear in the video panel: the panel lists the ledger, not the
 * folder. It has no `providerTaskId`, no billing and nothing to reconcile, so
 * every provider-shaped path (cancel, reconcile, cost) skips it
 * (TEACH-VIDEO.md §8, §23).
 */

import { copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { localRoot } from '../destination.ts'
import { recordLocalRender } from '../operations.ts'
import type { VideoForgeRuntime } from '../runtime.ts'
import { sessionContextOf } from '../session-context.ts'
import { ConfigError, DEFAULT_VOICE_AUTH_REF, teachSettings } from '../settings.ts'
import { workspaceFsOf } from '../workspace-fs.ts'
import { countFrameColors } from './ffmpeg.ts'
import { auditDecks, auditManuscript, countDeckFragments, deckPageFragments, judgeSamples, sampleTimes, type DeckInfo, type SuspectSegment } from './rules.ts'
import {
  DEFAULT_TEACH_PATHS,
  assembleVideo,
  narrateSentences,
  planSegments,
  planStoryboard,
  readTimings,
  renderSegments,
  type TeachPaths,
} from './pipeline.ts'
import { assessDependencies, installHint, isMissing, type DependencyProbe } from './rules.ts'
import { allSentences, DEFAULT_VOICE, DEFAULT_VOICE_SPEAKER, parseStoryboard, reconcileTimings, totalDurationMs, type Storyboard, type Timings, type VoiceSpec } from './storyboard.ts'
import { mediaTools, probeDependencies, teachPaths, voiceAuthRefFor } from './probe.ts'
import { buildSrt } from './subtitles.ts'

/** Default manuscript file, relative to the workspace. */
export const DEFAULT_STORYBOARD = 'storyboard.yaml'

/** The reference used when the settings name none (kept exported for callers that only report). */
export const VOICE_AUTH_REF = DEFAULT_VOICE_AUTH_REF

/** Where a finished teaching video goes when the caller names no shot. */
const DEFAULT_SHOT = 'teach'

/**
 * The credential reference a voice provider uses, from the settings.
 *
 * The manuscript chooses the provider and the settings page owns the name a key
 * is stored under — one name per provider, so the DeepSeek default route and the
 * volcengine route are each configurable on their own (`voiceAuthRefFor` in
 * `probe.ts`).
 */
function voiceRef(runtime: ToolRuntime, provider: string): string {
  return voiceAuthRefFor(teachSettings(runtime.settings()), provider)
}

/** The runtime the teaching tools share with the generation tools: the ledger lives there. */
type ToolRuntime = VideoForgeRuntime

/** A workspace this call may write into. */
interface Workspace {
  /** Absolute host path of the workspace root: where `renders/` lives. */
  root: string
  /**
   * Absolute host path of the teaching project: the directory holding
   * `storyboard.yaml`. Its `slides/`, `scenes/`, `audio/` and `timings.json` are
   * resolved here, not against the workspace root, so a manuscript in
   * `fixtures/teach/sample/` finds its own deck (docs/TEACH-VIDEO.md §5).
   */
  projectRoot: string
  /** The calling session, recorded with a finished render. */
  session: { id: string, cwd: string | null, mode: 'read-only' | 'workspace-write' | 'danger-full-access' | 'unknown' | null }
  /** Where the manuscript lives, absolute. */
  storyboardPath: string
  paths: TeachPaths
}

/**
 * Resolve the calling session's workspace and the teaching project inside it.
 *
 * Read-only and unknown permission modes are refused for the same reason the
 * generation tools refuse them: the plugin writes real files into the user's
 * project, and a mode that cannot confirm writes are allowed must not be read as
 * permission. A remote workspace is refused too: ffmpeg and Chromium run here.
 */
async function resolveWorkspace(runtime: ToolRuntime, args: { storyboard?: string | undefined }, exec: { agent?: unknown }): Promise<Workspace> {
  const session = sessionContextOf(runtime.ctx, exec.agent as Parameters<typeof sessionContextOf>[1])
  if (session === null) throw new ConfigError('the teaching tools need a workspace conversation; this call carried no session')
  if (session.mode === 'read-only') {
    throw new ConfigError('this conversation is in read-only mode, so no teaching video can be written into the workspace; switch it to workspace-write (or full access), then try again')
  }
  if (session.mode === 'unknown') {
    throw new ConfigError('the host could not say which permission mode this conversation runs in, so the plugin treats it as read-only; check the conversation\'s permission mode, then try again')
  }
  if (session.cwd === null) throw new ConfigError('this session has no workspace folder, and a teaching project lives in a workspace')

  const fs = workspaceFsOf(runtime.ctx, true)
  if (fs === null) throw new ConfigError('the host filesystem service is not available (a remote workspace may be reconnecting); try again in a moment')
  const root = await localRoot(fs, session.cwd)
  if (root.kind === 'missing') throw new ConfigError(`the workspace folder ${session.cwd} does not exist any more (moved or deleted?)`)
  if (root.kind === 'remote') throw new ConfigError(`the workspace ${session.cwd} is not on this machine (${root.detail}); teaching videos cannot be rendered into a remote workspace yet`)
  if (root.kind === 'unverifiable') throw new ConfigError(root.detail)

  const storyboard = (args.storyboard ?? DEFAULT_STORYBOARD).trim() || DEFAULT_STORYBOARD
  if (storyboard.startsWith('/') || storyboard.split('/').includes('..')) {
    throw new ConfigError(`storyboard must be a workspace-relative path, got "${storyboard}"`)
  }
  const storyboardPath = join(root.path, ...storyboard.split('/'))
  // The project root is the manuscript's own directory: a deck and a scene are
  // named relative to the storyboard, which is what lets a manuscript live in a
  // subfolder (docs/TEACH-VIDEO.md §5).
  const projectRoot = dirname(storyboardPath)
  return {
    root: root.path,
    projectRoot,
    session,
    storyboardPath,
    paths: { root: projectRoot, audio: DEFAULT_TEACH_PATHS.audio, timings: DEFAULT_TEACH_PATHS.timings, work: DEFAULT_TEACH_PATHS.work, segments: DEFAULT_TEACH_PATHS.segments },
  }
}

/** Read and validate the manuscript. */
async function readBoard(workspace: Workspace): Promise<Storyboard> {
  let text: string
  try {
    text = await readFile(workspace.storyboardPath, 'utf8')
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') {
      throw new ConfigError(`no ${workspace.storyboardPath} in this workspace; write the manuscript first (docs/TEACH-VIDEO.md §5 shows the shape)`)
    }
    throw new ConfigError(`could not read ${workspace.storyboardPath} (${error instanceof Error ? error.message : String(error)})`)
  }
  try {
    return parseStoryboard(text)
  } catch (error: unknown) {
    throw new ConfigError(`${workspace.storyboardPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The voice for this manuscript, plus a key that can actually be used.
 *
 * The credential is resolved through the credentials service first and the
 * environment second, exactly like the generation providers — and never from
 * another provider's reference. `ARK_API_KEY` is a different credential: the
 * speech endpoint answers it with a 401 that reads like "not activated".
 */
async function resolveVoice(runtime: ToolRuntime, board: Storyboard, speakerOverride?: string | undefined): Promise<{ voice: VoiceSpec, apiKey: string }> {
  // The manuscript chooses the provider; only the reference can be overridden on
  // the settings page. Empty means "the provider's own default reference", so
  // switching provider in the manuscript does not also require editing a setting.
  const provider = board.voice?.provider ?? DEFAULT_VOICE.provider
  const authRef = voiceRef(runtime, provider)
  const fallbackSpeaker = DEFAULT_VOICE_SPEAKER[provider] ?? ''
  const voice: VoiceSpec = {
    provider,
    speaker: (speakerOverride ?? board.voice?.speaker ?? fallbackSpeaker).trim(),
    speedRatio: board.voice?.speedRatio ?? null,
  }
  if (voice.speaker === '') {
    throw new ConfigError(`meta.voice.speaker is required for provider "${provider}": this provider has no default voice, so name its voice id (volcengine uses ids like zh_female_liuchangnv_uranus_bigtts)`)
  }

  let value: string | null = null
  const credentials = runtime.ctx.get('credentials' as never) as { resolve(ref: string): Promise<{ value: string, source: string } | undefined> } | undefined
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(authRef)
      if (resolved !== undefined && resolved.value !== '') value = resolved.value
    } catch {
      // Fall through to the environment: the service may not know this reference.
    }
  }
  if (value === null) {
    const ambient = process.env[authRef]
    if (ambient !== undefined && ambient !== '') value = ambient
  }
  if (value === null) {
    throw new ConfigError(`no voice credential: store ${authRef} through the credentials service (the Web settings page writes it) or export it in the launching environment. ARK_API_KEY cannot be used for speech`)
  }
  return { voice, apiKey: value }
}

/** Resolve `only` ids against the manuscript, refusing ids that do not exist. */
function selectedIds(board: Storyboard, only: readonly string[] | undefined): string[] | undefined {
  if (only === undefined || only.length === 0) return undefined
  const known = new Set(allSentences(board).map(({ sentence }) => sentence.id))
  const unknown = only.filter(id => !known.has(id))
  if (unknown.length > 0) throw new ConfigError(`no such sentence: ${unknown.map(id => `"${id}"`).join(', ')}; the manuscript has ${[...known].join(', ')}`)
  return [...only]
}

/**
 * Whether a voice credential resolves, for the dependency report.
 *
 * The reference is resolved the same way the narration resolves it, from the
 * provider in the manuscript. Reporting the settings' raw reference named
 * `ARK_VOICE_API_KEY` for a DeepSeek manuscript, which is the wrong credential
 * and reads as "configured" when the run would have failed (found 2026-11-20 by
 * the page-mode acceptance run).
 */
async function voiceState(runtime: ToolRuntime, provider: string): Promise<string> {
  const authRef = voiceRef(runtime, provider)
  const credentials = runtime.ctx.get('credentials' as never) as { resolve(ref: string): Promise<{ value?: string } | undefined> } | undefined
  if (credentials !== undefined) {
    // A service that answers `undefined` for a reference it does not hold is the
    // normal miss, not a success: counting the call itself as "configured"
    // reported a key that was not there (found 2026-11-20 by the page-mode
    // acceptance run, which was told ARK_VOICE_API_KEY was configured on a
    // DeepSeek manuscript that would have failed at narration).
    const resolved = await Promise.resolve(credentials.resolve(authRef)).catch(() => undefined)
    if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== '') return 'configured'
  }
  return (process.env[authRef] ?? '') !== '' ? 'configured (process-env)' : 'unresolved'
}

/**
 * Every file the manuscript names, checked to exist.
 *
 * Without this, a manuscript pointing at a deck that is not there survives
 * `plan`, and `narrate` pays for the whole script before `render` discovers the
 * typo. The message names each missing file and what it belongs to.
 */
async function missingAssets(board: Storyboard, projectRoot: string): Promise<string[]> {
  const missing: string[] = []
  const check = async (label: string, relative: string): Promise<void> => {
    try {
      const info = await stat(join(projectRoot, ...relative.split('/')))
      if (!info.isFile()) missing.push(`${label}: ${relative} exists but is not a file`)
    } catch {
      missing.push(`${label}: ${relative}`)
    }
  }
  for (const segment of board.segments) {
    const relative = segment.engine === 'slides' ? segment.deck : segment.scene
    if (relative === null) continue
    await check(`${segment.id} (${segment.engine})`, relative)
  }
  return missing
}

/**
 * What each slides deck provides, read from the deck itself.
 *
 * The manuscript cannot know this, and a cue that names fragment 9 of a deck
 * with 8 of them is a picture that will never appear, so the plan checks the
 * numbers against the files. The globals are checked here too: the page mode
 * needs `teachPage`, and discovering that at render time means the narration was
 * already paid for (docs/TEACH-VIDEO.md §23).
 */
async function inspectDecks(board: Storyboard, projectRoot: string): Promise<Map<string, DeckInfo>> {
  const decks = new Map<string, DeckInfo>()
  for (const segment of board.segments) {
    if (segment.engine !== 'slides' || segment.deck === null) continue
    const absolute = join(projectRoot, ...segment.deck.split('/'))
    const html = await readFile(absolute, 'utf8').catch(() => null)
    if (html === null) continue
    decks.set(segment.id, {
      path: segment.deck,
      fragments: countDeckFragments(html),
      pageFragments: deckPageFragments(html),
      // Assignment, not comparison: a deck that only *reads* teachReady (a guard
      // such as `teachReady === true`) is a deck that never sets it.
      hasCue: /(?:window\.)?teachCue\s*=(?!=)/.test(html),
      hasPage: /(?:window\.)?teachPage\s*=(?!=)/.test(html),
      hasReady: /(?:window\.)?teachReady\s*=(?!=)/.test(html),
    })
  }
  return decks
}

/**
 * Sample every freshly rendered segment and report the ones that look static.
 *
 * This is the check that would have caught the 2026-11-20 white deck and the
 * frozen deck tail. It reports rather than fails: the video is already rendered,
 * the author decides whether a sparse frame is deliberate.
 */
async function staticSegments(
  rendered: readonly { id: string, path: string }[],
  durationById: ReadonlyMap<string, number>,
  tools: { ffmpegPath?: string, ffprobePath?: string },
  signal?: AbortSignal,
): Promise<SuspectSegment[]> {
  const suspects: SuspectSegment[] = []
  for (const segment of rendered) {
    const durationMs = durationById.get(segment.id)
    if (durationMs === undefined) continue
    const samples: { atMs: number, colors: number }[] = []
    for (const atMs of sampleTimes(durationMs)) {
      try {
        const colors = await countFrameColors(segment.path, { atSeconds: atMs / 1000 }, tools, signal)
        samples.push({ atMs, colors })
      } catch {
        // A segment that cannot be decoded is a renderer problem the caller will
        // see when it probes the file; do not turn it into a self-check finding.
        break
      }
    }
    const suspect = judgeSamples(segment.id, samples)
    if (suspect !== null) suspects.push(suspect)
  }
  return suspects
}

/** The next free `vNNN` number in a shot folder. */
async function nextVersion(dir: string): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 1
  }
  let highest = 0
  for (const entry of entries) {
    const match = /^v(\d{3})\.mp4$/.exec(entry)
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

/** Whether these timings can drive a picture inside a sentence (see `deckDriveMode`). */
function timingsWordTimings(timings: Timings): boolean {
  return timings.voice.timestamps !== 'none'
}

/**
 * Register the four teaching tools.
 *
 * `overrides.probe` exists for tests: a machine cannot be made to lack ffmpeg or
 * dvisvgm on demand, and the decision this round is about is "does an absent
 * program block *this* manuscript", which must be provable without uninstalling
 * anything.
 */
export function registerTeachTools(runtime: ToolRuntime, overrides: { probe?: () => Promise<DependencyProbe> } = {}): void {
  // The probe reads the live settings per call, so a path edited on the settings
  // page takes effect on the next plan without re-registering the tool.
  const probe = overrides.probe ?? (() => probeDependencies(runtime.settings()))
  const { ctx } = runtime

  ctx.tools.register(defineTool({
    name: 'video_teach_plan',
    description: [
      'Validate a teaching-video manuscript (storyboard.yaml) without spending anything, and report what the machine is missing.',
      'A teaching video is narrated by TTS and drawn by reveal.js slides and/or Manim scenes, so its clock is the audio, not a model.',
      'Returns the sentence list in timeline order, the narration length estimate, content/timeline warnings, and the machine\'s dependencies sorted by what they are for: ffmpeg/ffprobe are always required, a Chromium is needed for slide segments, and Python with Manim plus a TeX with dvisvgm are needed ONLY when the manuscript has an engine: manim segment. A slides-only manuscript is reported as needing no Manim, and is never refused for the absence of a Python or a TeX.',
      'It also checks the content against the timeline and against the decks: a cue-driven manuscript must give every slides sentence at least one cue and keep the average gap between picture changes under 8 s, a sentence\'s length must sit between 2 and 8 s, and two sentences must not share one Manim scene. It reads each deck for the globals the recorder calls (teachReady, teachCue, teachPage) and, in page mode, for one <section> per sentence with the beats numbered inside their own page — a deck that cannot be driven is refused here rather than at render time, after the narration was paid for. Warnings name the sentence id; a cue that names a fragment the deck does not have is refused outright.',
      'Run this first: it names the line and the key of any manuscript mistake, and paying for narration or rendering a broken draft is the expensive way to learn the same thing.',
    ].join(' '),
    parameters: {
      storyboard: { type: 'string', description: `Workspace-relative path of the manuscript. Defaults to ${DEFAULT_STORYBOARD}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          sentences: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                segment: { type: 'string', required: true },
                engine: { type: 'string', required: true },
                chars: { type: 'number', required: true },
              },
            },
          },
          total_chars: { type: 'number', required: true },
          estimated_seconds: { type: 'number', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          needs_manim: { type: 'boolean', required: true },
          dependencies: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                state: { type: 'string', required: true },
                blocking: { type: 'boolean', required: true },
                install: { required: true, oneOf: [{ type: 'null' }, { type: 'string' }] },
              },
            },
          },
          narration: { type: 'string', required: true, description: 'none | current | stale, and why' },
          voice: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true },
              speaker: { type: 'string', required: true },
              word_timings: { type: 'boolean', required: true, description: 'false: the picture can only change between sentences (page mode)' },
            },
          },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
      presentationMeta: (_args, value) => ({ title: value.title, sentences: value.sentences.length, totalChars: value.total_chars }),
    },
    timeoutMs: 60_000,
    presentCall: () => ({ card: 'generic', title: 'Plan teaching video' }),
    presentResult: () => ({ card: 'generic', title: 'Teaching video plan' }),

    async execute(args, exec) {
      const workspace = await resolveWorkspace(runtime, { storyboard: args.storyboard }, exec)
      const board = await readBoard(workspace)
      const plan = planStoryboard(board)
      const missingFiles = await missingAssets(board, workspace.projectRoot)
      if (missingFiles.length > 0) {
        throw new ConfigError(
          `${workspace.storyboardPath} names files that are not there (resolved against ${workspace.projectRoot}): `
          + `${missingFiles.join('; ')}. Fix the paths or add the files; nothing was narrated or rendered.`,
        )
      }

      // Content and timeline rules (src/teach/rules.ts). Structural findings stop
      // here, before a single character is paid for; the rest are warnings.
      // The deck is read once and judged twice: `auditManuscript` against the cue
      // numbers, `auditDecks` against the globals and the page layout the drive
      // mode will need. Both findings are free to produce and expensive to
      // discover at render time.
      const decks = await inspectDecks(board, workspace.projectRoot)
      const fragmentCounts = new Map([...decks].flatMap(([id, info]) => (info.fragments === null ? [] : [[id, info.fragments] as const])))
      const audit = auditManuscript(board, { deckFragments: fragmentCounts })
      const deckAudit = auditDecks(board, decks)
      const structural = [...audit.structural, ...deckAudit.structural]
      if (structural.length > 0) {
        throw new ConfigError(`${workspace.storyboardPath}: ${structural.join('; ')}. Fix the cues or the deck; nothing was narrated or rendered.`)
      }

      let narration = 'none (no timings.json yet; run video_teach_narrate)'
      try {
        const timings = await readTimings(workspace.paths)
        const problems = reconcileTimings(board, timings)
        narration = problems.length === 0
          ? `current (${timings.sentences.length} sentences, ${totalDurationMs(timings)} ms of narration)`
          : `stale: ${problems.join('; ')}`
      } catch (error: unknown) {
        if ((error as { code?: string }).code !== 'ENOENT') narration = `unreadable: ${error instanceof Error ? error.message : String(error)}`
      }

      // Dependencies, sorted by what they are for (src/teach/rules.ts). A missing
      // Python, TeX or dvisvgm blocks only a manuscript that actually has a manim
      // segment; a slides-only project is told so instead of being told to install
      // a toolchain it will never run.
      const probed = await probe()
      const assessment = assessDependencies(board, probed)
      const manimBlocking = assessment.entries.filter(entry => entry.blocking && entry.scope === 'manim')
      if (manimBlocking.length > 0 && assessment.refusal !== null) throw new ConfigError(assessment.refusal)

      const provider = board.voice?.provider ?? DEFAULT_VOICE.provider
      const authRef = voiceRef(runtime, provider)
      const voice = await voiceState(runtime, provider)
      const dependencies = [
        ...assessment.entries.map(entry => ({ ...entry })),
        { name: authRef, scope: 'required' as const, state: voice, blocking: false, install: null },
      ]
      // Only what actually stops this manuscript counts as missing: a slides-only
      // project is not "missing" a Python it will never run (§19).
      const missing = dependencies.filter(entry => entry.blocking).map(entry => entry.name)
      // A build without libass does not stop the render, so it cannot be blocking —
      // but it silently costs the burned-in lines, which is exactly the kind of
      // absence this file exists to state rather than discover at the end.
      const subtitlesMissing = isMissing(probed.subtitles)
      const warnings = [
        ...plan.warnings,
        ...audit.warnings,
        ...deckAudit.warnings,
        ...(subtitlesMissing
          ? [`subtitles will not be burned into the picture: ${probed.subtitles}. ${installHint('subtitles') ?? ''}`.trim()]
          : []),
      ]
      const picture = plan.voice.wordTimings
        ? `picture: cue-driven (voice "${plan.voice.provider}" reports word timings, so a fragment can fire on a spoken word)`
        : `picture: page-driven — voice "${plan.voice.provider}" reports no word timings, so each sentence starts its own deck page and its beats fire on at_progress shares of the measured length (not word-aligned; cue-driven fragments need volcengine)`
      const beats = board.segments.flatMap(segment => segment.sentences).reduce((sum, sentence) => sum + sentence.cues.length, 0)
      const lines = [
        `${plan.title}: ${plan.sentences.length} sentence(s), ${plan.totalChars} characters, about ${plan.estimatedSeconds} s spoken.`,
        picture,
        ...plan.sentences.map(sentence => `- ${sentence.id} (${sentence.engine}, ${sentence.chars} chars) ${sentence.say}`),
        `narration: ${narration}`,
        `tools: ${assessment.summary}`,
        `required: ${dependencies.filter(entry => entry.scope === 'required').map(entry => `${entry.name} ${entry.state}`).join(', ')}`,
        `slides: ${dependencies.filter(entry => entry.scope === 'slides').map(entry => `chromium ${entry.state}`).join(', ')}`,
        `subtitles: ${probed.subtitles} — burned into the picture at assembly when the build has libass, and always written as an external .srt by video_teach_export`,
        assessment.needsManim
          ? `manim: ${dependencies.filter(entry => entry.scope === 'manim').map(entry => `${entry.name} ${entry.state}`).join(', ')}`
          : 'manim: not needed by this manuscript',
        missing.length === 0 ? '' : `blocking: ${missing.join(', ')} — see the install hint above`,
        !plan.voice.wordTimings
          ? `rhythm: page mode — ${board.segments.filter(segment => segment.engine === 'slides').reduce((sum, segment) => sum + segment.sentences.length, 0)} page(s), one per slides sentence, plus ${beats} at_progress beat(s) inside them`
          : audit.averageCueGapSeconds === null
            ? 'rhythm: no cues at all, the picture never changes'
            : `rhythm: one picture change every ${audit.averageCueGapSeconds.toFixed(1)} s on average (${audit.silent.length} silent sentence(s))`,
        ...warnings.map(warning => `warning: ${warning}`),
      ].filter(line => line !== '')

      return {
        title: plan.title,
        needs_manim: assessment.needsManim,
        sentences: plan.sentences.map(sentence => ({ id: sentence.id, segment: sentence.segment, engine: sentence.engine, chars: sentence.chars })),
        total_chars: plan.totalChars,
        estimated_seconds: plan.estimatedSeconds,
        warnings,
        dependencies,
        narration,
        voice: { provider: plan.voice.provider, speaker: plan.voice.speaker, word_timings: plan.voice.wordTimings },
        message: lines.join('\n'),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_teach_narrate',
    description: [
      'Synthesize the narration of a teaching manuscript, sentence by sentence, and write timings.json with word-level timestamps.',
      'This is the paid, network step: every sentence is one TTS request, and its audio length becomes the length of that sentence\'s share of the video. Word timings are what the recorder advances on, so the audio is the clock for everything that follows.',
      'Voice comes from meta.voice in the manuscript (speaker, optional speed_ratio). The credential follows the provider: DeepSeek (the default) uses DEEPSEEK_API_KEY as a bearer token, volcengine uses the reference named on the settings page (ARK_VOICE_API_KEY by default) as an X-Api-Key. Neither speech endpoint accepts ARK_API_KEY.',
      'sentences narrows the run to named ids; the other sentences keep the narration already in timings.json, which is how one bad line is retried without paying for the whole script.',
      'merge (default auto) sends one request per run of adjacent sentences, so the tone and energy carry across the joins instead of restarting at every sentence; merge none sends one request per sentence, for isolating a problem or A/B comparison.',
      'Every sentence file ends with a pause chosen by its own punctuation (。≈400 ms, ？！≈480 ms, ，、；≈170 ms) and the pause is only ever padded, never trimmed, so a sentence break sounds like a break.',
    ].join(' '),
    parameters: {
      storyboard: { type: 'string', description: `Workspace-relative path of the manuscript. Defaults to ${DEFAULT_STORYBOARD}.` },
      sentences: { type: 'array', items: { type: 'string' }, description: 'Only these sentence ids (default: every sentence).' },
      speaker: { type: 'string', description: 'Override the manuscript\'s voice id, e.g. zh_male_ruyayichen_uranus_bigtts.' },
      merge: { type: 'string', enum: ['auto', 'none'], description: 'auto (default) synthesizes adjacent sentences in one request so the prosody carries across; none sends one request per sentence.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          narrated: { type: 'array', required: true, items: { type: 'string' } },
          kept: { type: 'array', required: true, items: { type: 'string' } },
          word_timings: { type: 'boolean', required: true, description: 'false when the provider returns audio only: the picture will be page-driven' },
          total_ms: { type: 'number', required: true },
          requests: { type: 'number', required: true },
          timings_path: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
      presentationMeta: (_args, value) => ({ narrated: value.narrated, totalMs: value.total_ms }),
    },
    isConcurrencySafe: () => false,
    timeoutMs: 600_000,
    presentCall: () => ({ card: 'generic', title: 'Narrate teaching video' }),
    presentResult: () => ({ card: 'generic', title: 'Narration' }),

    async execute(args, exec) {
      const workspace = await resolveWorkspace(runtime, { storyboard: args.storyboard }, exec)
      const board = await readBoard(workspace)
      const only = selectedIds(board, args.sentences)
      const { voice, apiKey } = await resolveVoice(runtime, board, args.speaker)
      // A provider without word timings cannot be sliced, so it is never merged.
      const merge: 'auto' | 'none' = voice.provider === 'deepseek' ? 'none' : (args.merge ?? 'auto')
      const result = await narrateSentences({
        board,
        voice,
        apiKey,
        paths: workspace.paths,
        ...(only === undefined ? {} : { only }),
        merge,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        onSentence: (id, index, total) => runtime.logger.info(`video_teach_narrate: ${id} (${index + 1}/${total})`),
      })
      const kept = result.timings.sentences.map(sentence => sentence.id).filter(id => !result.narrated.includes(id))
      const wordTimings = timingsWordTimings(result.timings)
      const lines = [
        `narrated ${result.narrated.length} sentence(s) in ${voice.speaker}: ${result.narrated.join(', ')}`,
        wordTimings
          ? 'word timings recorded: cues can fire on spoken words'
          : `no word timings from "${voice.provider}": timings.json records voice.timestamps = none, so each sentence gets its own page and its beats fire on at_progress (a share of the measured length, not word-aligned). \`at_word\` cues are refused for this provider`,
        kept.length === 0 ? 'no earlier narration kept' : `kept ${kept.length} from timings.json: ${kept.join(', ')}`,
        `total narration ${result.durationMs} ms from ${result.requests} request(s); timings written to ${workspace.paths.timings}`,
        'next: video_teach_render (add sentences: [...] to re-record only some).',
      ]
      return {
        narrated: result.narrated,
        kept,
        word_timings: wordTimings,
        total_ms: result.durationMs,
        requests: result.requests,
        timings_path: workspace.paths.timings,
        message: lines.join('\n'),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_teach_render',
    description: [
      'Render the picture for a narrated teaching manuscript — one segment per sentence, from reveal.js slides and/or Manim scenes — and optionally assemble the finished mp4.',
      'The picture is driven by timings.json: each segment is cut to that sentence\'s real audio length. With a voice that reports word timings (volcengine) the deck advances fragments on the words the manuscript names. With one that reports none (deepseek, the default) the deck is in page mode: each sentence starts its own page, and its at_progress cues fire inside that page as shares of the measured length — not word-aligned, which is stated back rather than left implicit. Sentences not named in `sentences` keep the segment already on disk, so re-record one line without touching the others.',
      'Rendering needs ffmpeg/ffprobe (everything) plus a Chromium for the slides; Python with Manim and a TeX with dvisvgm are needed only for the manim sentences actually being rendered. When those are missing this call refuses BEFORE rendering anything and names each missing program with what to install, so a slides-only manuscript is unaffected and a broken one costs nothing.',
      'With assemble (default true) the segments are concatenated, the narration is mixed in, and the result lands at renders/<shot>/vNNN.mp4 with a JSON sidecar. Shot names the folder under renders/ and defaults to ' + DEFAULT_SHOT + '.',
      'After rendering, each fresh segment is sampled for distinct frame colours and any segment that looks static is reported by name; the report is a heuristic hint, not a refusal.',
      'The finished video is recorded in the ledger as a local render, so it appears in the video panel beside generated videos. Report the path it returns.',
    ].join(' '),
    parameters: {
      storyboard: { type: 'string', description: `Workspace-relative path of the manuscript. Defaults to ${DEFAULT_STORYBOARD}.` },
      sentences: { type: 'array', items: { type: 'string' }, description: 'Only these sentence ids (default: every sentence that has no segment yet, plus any named).' },
      assemble: { type: 'boolean', description: 'Concatenate and mux the finished video (default true).' },
      burn_subtitles: { type: 'boolean', description: 'Burn the narration into the picture at assembly (default true). Needs an ffmpeg built with libass; when this build has no `subtitles` filter the film is assembled without burned-in lines and the result says so. The external .srt from video_teach_export is written either way.' },
      shot: { type: 'string', description: `Folder under renders/ for the finished video. Defaults to ${DEFAULT_SHOT}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rendered: { type: 'array', required: true, items: { type: 'string' } },
          reused: { type: 'array', required: true, items: { type: 'string' } },
          ignored_cues: { type: 'array', required: true, items: { type: 'string' }, description: 'sentences whose cues could not fire; empty in both modes, because page mode honours at_progress beats' },
          output: { required: true, oneOf: [{ type: 'null' }, { type: 'string' }] },
          task_id: { required: true, oneOf: [{ type: 'null' }, { type: 'string' }] },
          duration_ms: { type: 'number', required: true },
          subtitles: { type: 'string', required: true, description: 'burned: the lines are in the picture; not burned: why, and what still has them' },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
      presentationMeta: (_args, value) => ({ rendered: value.rendered, reused: value.reused, output: value.output }),
    },
    isConcurrencySafe: () => false,
    timeoutMs: 1_800_000,
    presentCall: () => ({ card: 'generic', title: 'Render teaching video' }),
    presentResult: () => ({ card: 'generic', title: 'Teaching video' }),

    async execute(args, exec) {
      const workspace = await resolveWorkspace(runtime, { storyboard: args.storyboard }, exec)
      const board = await readBoard(workspace)
      const only = selectedIds(board, args.sentences)
      const timings = await readTimings(workspace.paths).catch((error: unknown) => {
        throw new ConfigError(`no usable ${workspace.paths.timings}: ${error instanceof Error ? error.message : String(error)}; run video_teach_narrate first`)
      })
      const problems = reconcileTimings(board, timings)
      if (problems.length > 0) throw new ConfigError(`the narration does not match the manuscript: ${problems.join('; ')}. Re-run video_teach_narrate`)

      // A cue is a claim about a moment, and a provider that reports no word
      // timings cannot support that claim. The picture is therefore driven by page
      // (one page per sentence). The render still runs — the narration is already
      // paid for, and refusing here would charge the user and deliver nothing —
      // but the degradation is stated in the result and in the closing message,
      // never applied silently.
      const pageMode = timings.voice.timestamps === 'none'
      // A page-mode manuscript must time its beats by progress; the parser already
      // refuses `at_word` there, so anything left is a `at_progress` cue and it
      // fires as written.
      const ignoredCues: string[] = []

      // Refuse before a single segment is rendered: a manim sentence with no
      // Manim would otherwise fail halfway through, after the slides were spent.
      const probed = await probe()
      const assessment = assessDependencies(board, probed, only)
      if (assessment.refusal !== null) throw new ConfigError(assessment.refusal)

      const paths = teachPaths(runtime.settings())
      const media = mediaTools(paths)
      const tools = {
        ...media,
        ...(paths.pythonPath === null ? {} : { pythonPath: paths.pythonPath }),
        ...(paths.texBinPath === null ? {} : { texBinPath: paths.texBinPath }),
      }
      const rendered = await renderSegments({
        board,
        timings,
        paths: workspace.paths,
        ...(only === undefined ? {} : { only }),
        chromiumPath: paths.chromiumPath,
        tools,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        onSegment: (id, path) => runtime.logger.info(`video_teach_render: ${id} → ${path}`),
      })

      // Self-check before assembly: a segment that drew nothing is worth knowing
      // about before the mux hides it inside a longer file.
      const durationById = new Map(timings.sentences.map(sentence => [sentence.id, sentence.durationMs]))
      const suspects = await staticSegments(rendered, durationById, media, exec.signal)

      // Assembly is the only step that needs every sentence: a narrowed render
      // that is not assembling yet is a normal way to split a long run, so the
      // remaining sentences are reported as pending instead of failing the call
      // after the work it was asked to do is already done.
      const plan = await planSegments(workspace.paths, timings, rendered, { requireAll: args.assemble !== false })
      let output: string | null = null
      let taskId: string | null = null
      let durationMs = totalDurationMs(timings)
      // Why the picture may not carry burned-in lines, in the words the result
      // uses. The decision is taken before assembly so the reason is the probe's,
      // not a filter error's.
      const wantBurn = args.burn_subtitles !== false
      const burnUnavailable = isMissing(probed.subtitles) ? `${probed.subtitles}; ${installHint('subtitles') ?? ''}`.trim() : null
      const burn = wantBurn && burnUnavailable === null
      const burnState = burn
        ? 'burned: the narration is in the picture; video_teach_export also writes the same cues as an external .srt'
        : `not burned: ${args.burn_subtitles === false ? 'burn_subtitles: false was requested' : burnUnavailable ?? 'unknown reason'}`
      if (args.assemble !== false) {
        const shot = (args.shot ?? DEFAULT_SHOT).trim() || DEFAULT_SHOT
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(shot)) throw new ConfigError(`shot must be letters, digits, "-", "_" or ".", got "${shot}"`)
        const dir = join(workspace.root, 'renders', shot)
        await mkdir(dir, { recursive: true })
        const version = await nextVersion(dir)
        const name = `v${String(version).padStart(3, '0')}`
        const target = join(dir, `${name}.mp4`)
        const staged = join(dir, `.${name}.staging.mp4`)
        const assembled = await assembleVideo({
          paths: workspace.paths,
          segments: plan.segments,
          video: board.video,
          output: staged,
          // The burned cues and the exported .srt are the same text from the same
          // function, so a platform that shows the file's subtitles and a viewer
          // reading the picture see one timeline (src/teach/subtitles.ts).
          ...(burn ? { subtitles: { srt: buildSrt(timings) } } : {}),
          tools: media,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
        await copyFile(staged, target)
        await writeFile(join(dir, `${name}.json`), `${JSON.stringify({
          kind: 'teach-video',
          title: board.title,
          storyboard: args.storyboard ?? DEFAULT_STORYBOARD,
          segments: plan.segments.map(segment => ({ id: segment.id, durationMs: segment.durationMs })),
          durationMs: assembled.durationMs,
          // The sidecar is what a later reader has: whether the picture carries
          // the lines is a fact about this file, not a setting anyone remembers.
          subtitles: burn ? 'burned' : 'none',
          createdAt: new Date().toISOString(),
        }, null, 2)}\n`, 'utf8')
        const { rm } = await import('node:fs/promises')
        await rm(staged, { force: true })
        output = `renders/${shot}/${name}.mp4`
        durationMs = assembled.durationMs ?? durationMs
        // The row is what puts the file in the video panel: the panel lists the
        // ledger, not the folder (TEACH-VIDEO.md §8).
        const info = await stat(target)
        const recorded = await recordLocalRender(runtime, {
          title: board.title,
          storyboard: args.storyboard ?? DEFAULT_STORYBOARD,
          session: workspace.session,
          relativePath: `renders/${shot}/${name}.mp4`,
          shot,
          version,
          absolutePath: target,
          bytes: info.size,
          durationMs: assembled.durationMs,
          width: board.video.width,
          height: board.video.height,
          sidecar: `renders/${shot}/${name}.json`,
        })
        taskId = recorded.localId
      }

      const subtitles = output === null ? 'nothing burned: no picture was assembled' : burnState
      const lines = [
        pageMode
          ? `picture: page mode with beats — voice "${timings.voice.provider}" reports no word timings, so each sentence starts on its own page and its beats fire on at_progress against the measured sentence length (not word-aligned)`
          : 'picture: cue-driven, fragments fire on the words the manuscript names',
        `rendered ${plan.fresh.length} segment(s)${plan.fresh.length === 0 ? '' : `: ${plan.fresh.join(', ')}`}`,
        plan.reused.length === 0 ? 'nothing reused' : `reused ${plan.reused.length}: ${plan.reused.join(', ')}`,
        suspects.length === 0
          ? 'self-check: every rendered segment drew something across its samples'
          : `self-check: ${suspects.length} segment(s) look static — ${suspects.map(suspect => `"${suspect.id}" (${suspect.reason}: ${suspect.detail})`).join('; ')}`,
        output === null
          ? `assembly skipped (assemble: false)${plan.pending.length === 0 ? '' : `; ${plan.pending.length} sentence(s) still have no picture: ${plan.pending.join(', ')} — render them, then assemble`}`
          : `video: ${output} (${durationMs} ms, task ${taskId ?? 'unrecorded'})`,
        output === null ? '' : `subtitles: ${subtitles}`,
        output === null ? '' : `still missing: SRT / timeline / decks (video_teach_export)`,
      ].filter(line => line !== '')
      return {
        rendered: plan.fresh,
        reused: plan.reused,
        ignored_cues: ignoredCues,
        output,
        task_id: taskId,
        duration_ms: durationMs,
        subtitles,
        message: lines.join('\n'),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_teach_export',
    description: [
      'Export the side products of a teaching video: an SRT next to the finished mp4 (timed by the word timings), a timeline.json, and the reveal.js decks copied into deck/ so the slides can be opened and presented on their own.',
      'The SRT is the same cue text that was burned into the picture at assembly, so a platform reading the file and a viewer reading the picture see one timeline.',
      'Run it after video_teach_render has produced the mp4 it should sit beside. Nothing here re-renders or re-narrates; a changed manuscript means re-running narrate and render first.',
    ].join(' '),
    parameters: {
      storyboard: { type: 'string', description: `Workspace-relative path of the manuscript. Defaults to ${DEFAULT_STORYBOARD}.` },
      shot: { type: 'string', description: `Folder under renders/ that holds the mp4. Defaults to ${DEFAULT_SHOT}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          srt: { type: 'string', required: true },
          timeline: { type: 'string', required: true },
          decks: { type: 'array', required: true, items: { type: 'string' } },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
      presentationMeta: (_args, value) => ({ srt: value.srt, timeline: value.timeline }),
    },
    timeoutMs: 120_000,
    presentCall: () => ({ card: 'generic', title: 'Export teaching video' }),
    presentResult: () => ({ card: 'generic', title: 'Teaching export' }),

    async execute(args, exec) {
      const workspace = await resolveWorkspace(runtime, { storyboard: args.storyboard }, exec)
      const board = await readBoard(workspace)
      const timings = await readTimings(workspace.paths)
      const problems = reconcileTimings(board, timings)
      if (problems.length > 0) throw new ConfigError(`the narration does not match the manuscript: ${problems.join('; ')}`)

      const shot = (args.shot ?? DEFAULT_SHOT).trim() || DEFAULT_SHOT
      const shotDir = join(workspace.root, 'renders', shot)
      const version = (await nextVersion(shotDir)) - 1
      const stem = version >= 1 ? `v${String(version).padStart(3, '0')}` : null
      if (stem === null) throw new ConfigError(`no finished video in renders/${shot}; run video_teach_render first`)

      const srt = join(shotDir, `${stem}.srt`)
      await writeFile(srt, buildSrt(timings), 'utf8')
      const timeline = join(shotDir, `${stem}.timeline.json`)
      await writeFile(timeline, `${JSON.stringify({
        voice: timings.voice,
        sentences: timings.sentences.map(sentence => ({ id: sentence.id, audio: sentence.audio, durationMs: sentence.durationMs, words: sentence.words })),
      }, null, 2)}\n`, 'utf8')

      const decks: string[] = []
      for (const segment of board.segments) {
        if (segment.engine !== 'slides' || segment.deck === null) continue
        const source = join(workspace.projectRoot, ...segment.deck.split('/'))
        const target = join(workspace.root, 'deck', segment.id)
        try {
          await cp(source, target, { recursive: true, force: true })
          decks.push(`deck/${segment.id}`)
        } catch (error: unknown) {
          throw new ConfigError(`could not copy ${segment.deck} into deck/${segment.id} (${error instanceof Error ? error.message : String(error)})`)
        }
      }

      return {
        srt: `renders/${shot}/${stem}.srt`,
        timeline: `renders/${shot}/${stem}.timeline.json`,
        decks,
        message: [
          // DeepSeek reports no word timings, so its SRT is one cue per sentence:
          // saying "word-timed" there was a claim the file did not support.
          `srt: renders/${shot}/${stem}.srt (${timings.sentences.length} sentence(s), ${timingsWordTimings(timings) ? 'word-timed' : 'one cue per sentence, no word timings'})`,
          `timeline: renders/${shot}/${stem}.timeline.json`,
          decks.length === 0 ? 'no reveal.js decks to export' : `decks: ${decks.join(', ')}`,
        ].join('\n'),
      }
    },
  }))
}
