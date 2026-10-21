import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PRICE_TABLE, estimateArkTokens, estimateCost, normalizeLitellm, unitPrice, type PriceRow, type PriceTable } from '../src/prices.ts'
import { knownModelIds } from '../src/provider-presets.ts'

/** The frozen upstream sample (`fixtures/litellm-video-sample.json`), never the network. */
function upstreamSample(): unknown {
  return JSON.parse(readFileSync(new URL('../fixtures/litellm-video-sample.json', import.meta.url), 'utf8'))
}

/** Every model id this build's presets know, which is what the bundled snapshot may carry. */
function presetModelIds(): string[] {
  return ['ark-seedance', 'minimax-video', 'generic-openai-videos'].flatMap(protocol => knownModelIds(protocol as never))
}

/** One row of a normalized feed, or a failure that names the model/tier instead of a bare `undefined`. */
function rowOf(rows: readonly PriceRow[], modelId: string, resolution: string | null): PriceRow {
  const row = rows.find(candidate => candidate.modelId === modelId && (candidate.resolution ?? null) === resolution)
  if (row === undefined) throw new Error(`no row for ${modelId}@${resolution ?? '(any)'}`)
  return row
}

/** A tier's price expressed the way the vendor publishes it: CNY per million tokens. */
function perMillion(row: PriceRow): number {
  return row.pricePerUnit * 1_000_000
}

const table: PriceTable = {
  currency: 'CNY',
  pricedAt: '2026-10-16',
  source: 'test',
  rows: [
    { providerId: 'ark', modelId: 'm1', unit: 'token', pricePerUnit: 0.1 },
    { providerId: 'ark', modelId: '', unit: 'token', pricePerUnit: 0.01 },
    { providerId: '', modelId: '', unit: 'token', pricePerUnit: 0.001 },
    { providerId: '', modelId: '', unit: 'second', pricePerUnit: 0.5 },
  ],
}

describe('unitPrice', () => {
  it('prefers an exact provider/model row, then provider-wide, then the global default', () => {
    expect(unitPrice(table, 'ark', 'm1', 'token')).toBe(0.1)
    expect(unitPrice(table, 'ark', 'm2', 'token')).toBe(0.01)
    expect(unitPrice(table, 'mm', 'm', 'token')).toBe(0.001)
  })

  it('matches by unit, so a token row never prices seconds', () => {
    expect(unitPrice(table, 'ark', 'm1', 'second')).toBe(0.5)
  })

  it('returns null when no row prices the unit, and skips non-positive rows', () => {
    const none: PriceTable = { currency: 'CNY', pricedAt: '', source: '', rows: [{ providerId: '', modelId: '', unit: 'second', pricePerUnit: 0 }] }
    expect(unitPrice(none, 'a', 'b', 'second')).toBeNull()
  })
})

describe('estimateCost', () => {
  it('multiplies tokens by the token price', () => {
    expect(estimateCost(table, { tokens: 100, outputSeconds: null, fields: {} }, 'ark', 'm1')).toEqual({ amount: 10, unit: 'token', usage: 100 })
  })

  it('multiplies output seconds by the second price', () => {
    expect(estimateCost(table, { tokens: null, outputSeconds: 5, fields: {} }, 'mm', 'm')).toEqual({ amount: 2.5, unit: 'second', usage: 5 })
  })

  it('is null for absent usage, and null when the unit has no price row', () => {
    expect(estimateCost(table, null, 'ark', 'm1')).toBeNull()
    const noSecond: PriceTable = { currency: 'CNY', pricedAt: '', source: '', rows: [] }
    expect(estimateCost(noSecond, { tokens: null, outputSeconds: 5, fields: {} }, 'mm', 'm')).toBeNull()
  })
})

describe('estimateArkTokens', () => {
  it('matches the two reverse-engineered reference points', () => {
    // 480p 16:9, 4 s → 864×496×97÷1024 = 40594 (DESIGN §7.1)
    expect(estimateArkTokens('480p', '16:9', 4)).toBe(40594)
    // 720p 16:9, 5 s → 1280×720×121÷1024 = 108900 (DESIGN §16.5)
    expect(estimateArkTokens('720p', '16:9', 5)).toBe(108900)
  })

  it('swaps width/height for 9:16 and uses the short side for 1:1', () => {
    expect(estimateArkTokens('480p', '9:16', 4)).toBe(40594)
    expect(estimateArkTokens('720p', '1:1', 5)).toBe(Math.floor((720 * 720 * 121) / 1024))
  })

  it('refuses geometry it cannot estimate', () => {
    expect(estimateArkTokens('720p', '4:3', 5)).toBeNull()
    expect(estimateArkTokens(null, '16:9', 4)).toBeNull()
    expect(estimateArkTokens('720p', '16:9', null)).toBeNull()
  })
})

describe('the resolution dimension', () => {
  const tiered: PriceTable = {
    currency: 'CNY',
    pricedAt: '2026-10-21',
    source: 'test',
    rows: [
      { providerId: '', modelId: 'MiniMax-H3', unit: 'second', resolution: '768p', pricePerUnit: 0.56 },
      { providerId: '', modelId: 'MiniMax-H3', unit: 'second', resolution: '2k', pricePerUnit: 0.91 },
    ],
  }

  it('prices the tier it was asked for, ignoring case on both sides', () => {
    expect(unitPrice(tiered, 'mm', 'MiniMax-H3', 'second', '2K')).toBe(0.91)
    expect(unitPrice(tiered, 'mm', 'MiniMax-H3', 'second', '2k')).toBe(0.91)
  })

  it('prices a tier-less query at the base tier, and an unpublished tier as unknown rather than the nearest row', () => {
    // 768P is MiniMax's base tier; a task that recorded no resolution is assumed to be there.
    expect(unitPrice(tiered, 'mm', 'MiniMax-H3', 'second')).toBe(0.56)
    expect(unitPrice(tiered, 'mm', 'MiniMax-H3', 'second', '1080p')).toBeNull()
  })

  it('lets a tier-less row answer any tier, which is how a single-price model is expressed', () => {
    const flat: PriceTable = { currency: 'CNY', pricedAt: '', source: '', rows: [{ providerId: '', modelId: 'sora-2', unit: 'second', pricePerUnit: 0.7 }] }
    expect(unitPrice(flat, 'openai', 'sora-2', 'second', '1080p')).toBe(0.7)
    expect(unitPrice(flat, 'openai', 'sora-2', 'second')).toBe(0.7)
  })

  it('prices the tier over the model-wide row it belongs to', () => {
    const mixed: PriceTable = {
      currency: 'CNY',
      pricedAt: '',
      source: '',
      rows: [
        { providerId: '', modelId: 'MiniMax-H3', unit: 'second', pricePerUnit: 0.2 },
        { providerId: '', modelId: 'MiniMax-H3', unit: 'second', resolution: '2k', pricePerUnit: 0.91 },
      ],
    }
    expect(unitPrice(mixed, 'mm', 'MiniMax-H3', 'second', '2K')).toBe(0.91)
    // A row with no tier is not a fallback to another tier: it answers any tier.
    expect(unitPrice(mixed, 'mm', 'MiniMax-H3', 'second', '768P')).toBe(0.2)
  })

  it('breaks a tie by list order, which is how an operator row outranks a fetched one', () => {
    const tied: PriceTable = {
      currency: 'CNY',
      pricedAt: '',
      source: '',
      rows: [
        { providerId: 'mm', modelId: '', unit: 'second', pricePerUnit: 0.2 },
        { providerId: '', modelId: 'MiniMax-H3', unit: 'second', resolution: '768p', pricePerUnit: 0.56 },
      ],
    }
    // provider-wide (2) and tiered model (1+1) score the same; the operator's row is listed first.
    expect(unitPrice(tied, 'mm', 'MiniMax-H3', 'second')).toBe(0.2)
  })

  it('carries the resolution through estimateCost', () => {
    expect(estimateCost(tiered, { tokens: null, outputSeconds: 2, fields: {} }, 'mm', 'MiniMax-H3', '2K')?.amount).toBeCloseTo(1.82, 10)
    expect(estimateCost(tiered, { tokens: null, outputSeconds: 2, fields: {} }, 'mm', 'MiniMax-H3', null)?.amount).toBeCloseTo(1.12, 10)
  })
})

describe('normalizeLitellm', () => {
  const normalized = normalizeLitellm(upstreamSample())

  it('turns the video entries of the feed into rows, dropping everything else', () => {
    expect(normalized).not.toBeNull()
    // The sample also carries `chat` and `embedding` entries; neither prices a video.
    expect(normalized!.rows.some(row => row.modelId === 'gpt-4o')).toBe(false)
    expect(normalized!.skipped).toEqual([])
    expect(normalized!.dropped).toBe(0)
  })

  it('reproduces the vendors published CNY list prices from the dollar per-second figures', () => {
    const rows = normalized!.rows
    // DESIGN §21.3, checked against the official per-resolution tables.
    expect(perMillion(rowOf(rows, 'doubao-seedance-2-5-260628', '480p'))).toBeCloseTo(70, 6)
    expect(perMillion(rowOf(rows, 'doubao-seedance-2-5-260628', '720p'))).toBeCloseTo(70, 6)
    expect(perMillion(rowOf(rows, 'doubao-seedance-2-5-260628', '1080p'))).toBeCloseTo(77, 6)
    expect(perMillion(rowOf(rows, 'doubao-seedance-2-0-260128', '480p'))).toBeCloseTo(46, 6)
    expect(perMillion(rowOf(rows, 'doubao-seedance-2-0-260128', '720p'))).toBeCloseTo(46, 6)
    expect(perMillion(rowOf(rows, 'doubao-seedance-2-0-260128', '1080p'))).toBeCloseTo(51, 6)
    expect(perMillion(rowOf(rows, 'doubao-seedance-2-0-260128', '4k'))).toBeCloseTo(26, 6)
    expect(perMillion(rowOf(rows, 'doubao-seedance-2-0-fast-260128', '720p'))).toBeCloseTo(37, 6)
    expect(perMillion(rowOf(rows, 'doubao-seedance-2-0-mini-260615', '720p'))).toBeCloseTo(23, 6)
    // MiniMax is a native dollar list price: 0.08 × 7.0 and 0.13 × 7.0.
    expect(rowOf(rows, 'MiniMax-H3', '768p').pricePerUnit).toBeCloseTo(0.56, 9)
    expect(rowOf(rows, 'MiniMax-H3', '2k').pricePerUnit).toBeCloseTo(0.91, 9)
    expect(rowOf(rows, 'MiniMax-H3-Max', '480p').pricePerUnit).toBeCloseTo(0.35, 9)
    // The one entry that spells its field `output_cost_per_video_per_second`.
    expect(rowOf(rows, 'sora-2', null).pricePerUnit).toBeCloseTo(0.7, 9)
  })

  it('derives a token price from the frame the model actually renders, not from one shared frame', () => {
    // Both the 2.0 family and 2.5 publish 70/46 CNY per million at 480p, but they
    // render different frames there — so a single 480p frame would be wrong for one
    // of them by 4.4% (DESIGN §21.3).
    const seedance20 = estimateArkTokens('480p', '16:9', 4, 'doubao-seedance-2-0-260128')
    const seedance25 = estimateArkTokens('480p', '16:9', 4, 'doubao-seedance-2-5-260628')
    expect(seedance20).toBe(40594) // 864 × 496
    expect(seedance25).toBe(38830) // 854 × 480
    const rows = normalized!.rows
    // A token row and the token estimate agree on the same request: the money is
    // within the one extra frame the token formula counts.
    const seconds = 5
    const tokens = estimateArkTokens('720p', '16:9', seconds, 'doubao-seedance-2-5-260628')!
    const byToken = tokens * rowOf(rows, 'doubao-seedance-2-5-260628', '720p').pricePerUnit
    const bySecond = seconds * 0.216 * 7
    // The token formula counts one extra frame (24 × seconds + 1), so the two
    // routes agree to within that frame rather than exactly.
    expect(byToken / bySecond).toBeGreaterThan(1)
    expect(byToken / bySecond).toBeLessThan(1.02)
  })

  it('refuses a payload that is not a usable feed instead of returning half a table', () => {
    expect(normalizeLitellm(null)).toBeNull()
    expect(normalizeLitellm([])).toBeNull()
    expect(normalizeLitellm('{}')).toBeNull()
    expect(normalizeLitellm({ 'gpt-4o': { mode: 'chat' } })).toBeNull()
    expect(normalizeLitellm({ 'x/y': { mode: 'video_generation' } })).toBeNull()
    // More rows than the parser was built for.
    const huge: Record<string, unknown> = {}
    for (let index = 0; index < 600; index++) {
      huge[`minimax/m-${index}`] = { mode: 'video_generation', output_cost_per_second: 0.08 }
    }
    expect(normalizeLitellm(huge)).toBeNull()
  })

  it('drops a row whose number looks like a changed unit, and names what it skipped', () => {
    const result = normalizeLitellm({
      'minimax/ok': { mode: 'video_generation', output_cost_per_second: 0.08 },
      'minimax/absurd': { mode: 'video_generation', output_cost_per_second: 500 },
      'minimax/free': { mode: 'video_generation', output_cost_per_second: -1 },
      [`volcengine/${'x'.repeat(200)}`]: { mode: 'video_generation', output_cost_per_second_720p: 0.216 },
      'volcengine/tierless-token': { mode: 'video_generation', output_cost_per_second: 0.216 },
      // 100 USD/s at 720p is 0.032 CNY/token — far past any per-token price.
      'volcengine/absurd-token': { mode: 'video_generation', output_cost_per_second_720p: 100 },
    })
    expect(result).not.toBeNull()
    expect(result!.rows.map(row => row.modelId)).toEqual(['ok'])
    expect(result!.dropped).toBe(2)
    expect(result!.skipped.join('\n')).toContain('no per-second price')
    expect(result!.skipped.join('\n')).toContain('unusable model id')
    expect(result!.skipped.join('\n')).toContain('no frame geometry')
  })

  it('refuses a model id that two namespaces price differently, and collapses one they agree on', () => {
    const ambiguous = normalizeLitellm({
      'relay-a/sora-9': { mode: 'video_generation', output_cost_per_second: 0.1 },
      'relay-b/sora-9': { mode: 'video_generation', output_cost_per_second: 0.3 },
    })
    expect(ambiguous).toBeNull()

    const agreeing = normalizeLitellm({
      'relay-a/sora-9': { mode: 'video_generation', output_cost_per_second: 0.1 },
      'relay-b/sora-9': { mode: 'video_generation', output_cost_per_second: 0.1 },
      'sora-9': { mode: 'video_generation', output_cost_per_video_per_second: 0.1 },
    })
    expect(agreeing?.rows).toEqual([{ providerId: '', modelId: 'sora-9', unit: 'second', pricePerUnit: 0.7 }])
  })

  it('never emits a row the table would refuse to price', () => {
    const result = normalizeLitellm(upstreamSample())
    for (const row of result!.rows) {
      expect(row.pricePerUnit).toBeGreaterThan(0)
      expect(Number.isFinite(row.pricePerUnit)).toBe(true)
      expect(row.unit === 'token' ? row.pricePerUnit <= 0.01 : row.pricePerUnit <= 100).toBe(true)
      expect(row.modelId.length).toBeLessThanOrEqual(120)
    }
  })
})

describe('DEFAULT_PRICE_TABLE', () => {
  it('is the same normalization as the frozen sample, restricted to the preset models', () => {
    const normalized = normalizeLitellm(upstreamSample())!
    const ids = new Set(presetModelIds())
    // The equality is the point: the bundled snapshot cannot drift from the rule
    // that generates the fetched table.
    expect(DEFAULT_PRICE_TABLE.rows).toEqual(normalized.rows.filter(row => ids.has(row.modelId)))
  })

  it('carries a currency, a snapshot date and the provenance line', () => {
    expect(DEFAULT_PRICE_TABLE.currency).toBe('CNY')
    expect(DEFAULT_PRICE_TABLE.pricedAt).toBe('2026-10-21')
    expect(DEFAULT_PRICE_TABLE.source).toContain('etag:')
  })

  it('keeps no global fallback row: one blanket price would price 2.5 as 2.0', () => {
    expect(DEFAULT_PRICE_TABLE.rows.some(row => row.providerId === '' && row.modelId === '')).toBe(false)
    // A model upstream does not price stays unpriced rather than borrowing a number.
    expect(unitPrice(DEFAULT_PRICE_TABLE, 'ark', 'doubao-seedance-1-0-pro-250528', 'token', '720p')).toBeNull()
  })

  it('prices the preset models per tier', () => {
    expect(unitPrice(DEFAULT_PRICE_TABLE, 'ark', 'doubao-seedance-2-5-260628', 'token', '720p')).toBe(0.00007)
    expect(unitPrice(DEFAULT_PRICE_TABLE, 'ark', 'doubao-seedance-2-5-260628', 'token', '1080p')).toBe(0.000077)
    expect(unitPrice(DEFAULT_PRICE_TABLE, 'minimax', 'MiniMax-H3', 'second', '2K')).toBe(0.91)
    expect(unitPrice(DEFAULT_PRICE_TABLE, 'minimax', 'MiniMax-H3', 'second')).toBe(0.56)
    expect(unitPrice(DEFAULT_PRICE_TABLE, 'openai', 'sora-2', 'second', '720p')).toBe(0.7)
  })
})
