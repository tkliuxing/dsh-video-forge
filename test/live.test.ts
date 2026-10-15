/**
 * Live checks against the real vendors (DESIGN §13). Skipped unless asked for,
 * because the paid tier spends money and every tier needs a real key.
 *
 *   VIDEO_FORGE_LIVE=free  — only requests that cannot create a billable task:
 *                            a submit ARK refuses at its door, a task-list read,
 *                            a query for a task that does not exist.
 *   VIDEO_FORGE_LIVE=paid  — the free checks, then one cheapest generation per
 *                            provider (ARK 480p 4 s ≈ 40 594 tokens; MiniMax 480P
 *                            5 s), polled to the end and downloaded.
 *
 * Keys come from the environment only — ARK_API_KEY, MINIMAX_API_KEY — and a
 * provider without one is skipped. Optional: ARK_BASE_URL, MINIMAX_BASE_URL,
 * VIDEO_FORGE_LIVE_ARK_MODEL (default doubao-seedance-2-0-fast-260128),
 * VIDEO_FORGE_LIVE_MINIMAX_MODEL (default MiniMax-H3-Max).
 *
 * What this pins is the shape the plugin depends on, as recorded on 2026-10-15;
 * a failure here means a vendor changed its answers, not that the fixture lied.
 *
 *   VIDEO_FORGE_LIVE=free ARK_API_KEY=… MINIMAX_API_KEY=… pnpm test:live
 */

import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { downloadArtifact } from '../src/download.ts'
import { ProviderRequestError, requestJson, type AdapterContext } from '../src/providers/adapter.ts'
import { arkVideosAdapter } from '../src/providers/ark-seedance.ts'
import { minimaxVideoAdapter } from '../src/providers/minimax-video.ts'
import type { GenerationRequest, ProviderTaskState } from '../src/types.ts'

const LIVE = process.env.VIDEO_FORGE_LIVE
const PAID = LIVE === 'paid'
const ARK_KEY = process.env.ARK_API_KEY ?? ''
const MINIMAX_KEY = process.env.MINIMAX_API_KEY ?? ''
const ARK_BASE = process.env.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3'
const MINIMAX_BASE = process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.cn'
const ARK_MODEL = process.env.VIDEO_FORGE_LIVE_ARK_MODEL ?? 'doubao-seedance-2-0-fast-260128'
const MINIMAX_MODEL = process.env.VIDEO_FORGE_LIVE_MINIMAX_MODEL ?? 'MiniMax-H3-Max'

const ROLES = { first: 'first_frame', last: 'last_frame', reference: 'reference_image' }
const PROMPT = '一只纸船在日出时平静的湖面上缓缓漂流，水面泛起细小波纹，镜头缓慢横移'
/** An address that answers 404: a reference the vendors cannot fetch. */
const MISSING_IMAGE = 'https://example.com/does-not-exist.png'

function request(over: Partial<GenerationRequest>): GenerationRequest {
  return {
    model: '', prompt: PROMPT, mode: 't2v', firstFrame: null, lastFrame: null, referenceImages: [],
    durationSeconds: null, resolution: null, aspectRatio: null, generateAudio: null, ...over,
  }
}

/** Poll until the provider settles the task; vendors took 7 s (MiniMax) to 108 s (ARK). */
async function settle(query: () => Promise<ProviderTaskState>, timeoutMs = 10 * 60_000): Promise<ProviderTaskState> {
  const deadline = Date.now() + timeoutMs
  let failures = 0
  for (;;) {
    try {
      const state = await query()
      failures = 0
      if (state.terminal) return state
    } catch (error: unknown) {
      // The real run saw transient ETIMEDOUTs from ARK; a handful is not a verdict.
      failures += 1
      if (failures >= 5) throw error
    }
    if (Date.now() > deadline) throw new Error('the provider did not settle the task in time')
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
}

describe.skipIf(LIVE === undefined || ARK_KEY === '')('live: ARK Seedance', () => {
  const adapter = arkVideosAdapter({ roles: ROLES, generateAudio: false, watermark: false })
  const context = (): AdapterContext => ({ baseUrl: ARK_BASE, apiKey: ARK_KEY, fetch, signal: AbortSignal.timeout(60_000) })

  it('refuses a missing reference image at submit, with its own code and parameter (free)', async () => {
    const error = await adapter.submit(context(), request({
      model: ARK_MODEL,
      mode: 'i2v',
      durationSeconds: 4,
      resolution: '480p',
      firstFrame: { url: MISSING_IMAGE, digest: 'url:live', bytes: null, mime: null },
    })).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderRequestError)
    const refused = error as ProviderRequestError
    expect(refused.status).toBe(400)
    expect(refused.providerCode).toBe('InvalidParameter')
    expect(refused.message).toMatch(/content\[1\]\.image_url/)
  })

  it('reads the task list the unconfirmed-submission recovery depends on (free)', async () => {
    expect(adapter.listCreated).toBeDefined()
    const now = Date.now()
    const listed = await adapter.listCreated?.(context(), { from: now - 24 * 60 * 60_000, to: now, model: ARK_MODEL })
    expect(Array.isArray(listed)).toBe(true)
    for (const entry of listed ?? []) {
      expect(entry.providerTaskId).toMatch(/^cgt-/)
      expect(Number.isFinite(entry.createdAt)).toBe(true)
    }
  })

  it.skipIf(!PAID)('generates the cheapest clip, bills the documented tokens, and serves the bytes (paid)', async () => {
    const submitted = await adapter.submit(context(), request({ model: ARK_MODEL, durationSeconds: 4, resolution: '480p', aspectRatio: '16:9' }))
    expect(submitted.providerTaskId).toMatch(/^cgt-/)
    const state = await settle(() => adapter.query(context(), submitted.providerTaskId))
    expect(state.status).toBe('succeeded')
    expect(state.progress).toBeNull()
    expect(state.videoUrl).toMatch(/^https:\/\//)
    // 480p 16:9 is 864×496; 4 s at 24 fps is 97 frames: ⌊864 × 496 × 97 / 1024⌋.
    expect(state.usage).toMatchObject({ tokens: 40594, fields: { completion_tokens: 40594, total_tokens: 40594 } })
    const artifact = await downloadArtifact({
      url: state.videoUrl ?? '', apiKey: ARK_KEY, directory: await mkdtemp(join(tmpdir(), 'video-forge-live-')),
      localId: 'live-ark', fetch, signal: undefined, mimeHint: 'video/mp4',
    })
    expect((await stat(artifact.path)).size).toBeGreaterThan(10_000)
  }, 15 * 60_000)
})

describe.skipIf(LIVE === undefined || MINIMAX_KEY === '')('live: MiniMax', () => {
  const adapter = minimaxVideoAdapter({ roles: ROLES, watermark: false })
  const context = (): AdapterContext => ({ baseUrl: MINIMAX_BASE, apiKey: MINIMAX_KEY, fetch, signal: AbortSignal.timeout(60_000) })

  it('answers a query for a task that does not exist without a credential error (free)', async () => {
    // Free, and it proves the key and the endpoint before anything is spent.
    const outcome = await requestJson(context(), `${MINIMAX_BASE}/v2/query/video_generation/0`, { method: 'GET' })
      .then(body => ({ body, error: null }), (error: unknown) => ({ body: null, error }))
    if (outcome.error !== null) {
      expect(outcome.error).toBeInstanceOf(ProviderRequestError)
      expect((outcome.error as ProviderRequestError).status).not.toBe(401)
    }
  })

  it.skipIf(!PAID)('generates the cheapest clip, reports billed seconds, and serves the bytes (paid)', async () => {
    const submitted = await adapter.submit(context(), request({ model: MINIMAX_MODEL, durationSeconds: 5, resolution: '480P', aspectRatio: '16:9' }))
    expect(submitted.providerTaskId).toMatch(/^\d+$/)
    // The first answer is already `running`: the real endpoint never said `queued`.
    const first = await adapter.query(context(), submitted.providerTaskId)
    expect(first.status === 'running' || first.terminal).toBe(true)
    const state = await settle(() => adapter.query(context(), submitted.providerTaskId))
    expect(state.status).toBe('succeeded')
    expect(state.usage).toMatchObject({ tokens: null, outputSeconds: 5 })
    expect(state.usage?.fields).toHaveProperty('input_image_count', 0)
    const artifact = await downloadArtifact({
      url: state.videoUrl ?? '', apiKey: MINIMAX_KEY, directory: await mkdtemp(join(tmpdir(), 'video-forge-live-')),
      localId: 'live-minimax', fetch, signal: undefined, mimeHint: 'video/mp4',
    })
    expect((await stat(artifact.path)).size).toBeGreaterThan(10_000)
  }, 15 * 60_000)
})
