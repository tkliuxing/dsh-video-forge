/**
 * The price table on top of settled usage (DESIGN §16.5), and the one rule that
 * turns a public price feed into rows of it (DESIGN §21).
 *
 * Usage (tokens / output seconds) is what the provider reported and is exact.
 * Money is never exact: it is usage times a per-unit price, and the price is now
 * taken from a public file rather than typed into this source — the numbers used
 * to ship here were wrong the day they were written (DESIGN §21). The real bill
 * still lives only in the provider's console.
 *
 * Everything in this file is pure: no network, no disk, no clock beyond what a
 * caller passes in. That is what lets the whole normalization table be tested
 * against a frozen upstream sample.
 */

import type { ProviderUsage } from './types.ts'

/** What one price row charges for. ARK bills by token, MiniMax by second. */
export type PriceUnit = 'token' | 'second'

export interface PriceRow {
  /** Provider id as configured; empty string matches any provider. */
  providerId: string
  /** Model id as configured; empty string matches any model of the provider. */
  modelId: string
  /**
   * Output resolution tier this row prices, compared ignoring case; absent means
   * "any tier". Upstream's bare price equals its 720p (ARK) or 768p (MiniMax)
   * tier, so a tier-less row would misprice the other tiers by up to 39%.
   */
  resolution?: string
  /** Price of one unit, in the table's `currency`. */
  pricePerUnit: number
  /** The unit being priced. */
  unit: PriceUnit
}

export interface PriceTable {
  /** ISO 4217 currency code, e.g. `CNY`. */
  currency: string
  /** When the prices were last taken (ISO date); shown with every estimate. */
  pricedAt: string
  /** Where the prices came from, including provenance; shown with every estimate. */
  source: string
  /** Per-model prices; the most specific matching row wins. */
  rows: readonly PriceRow[]
}

/** The tier a query is priced against when it names no resolution. */
export const BASE_TIER: Record<PriceUnit, string> = { token: '720p', second: '768p' }

/**
 * CNY per USD, used to turn the upstream feed's dollar figures into the currency
 * the table reports. Never fetched at runtime: upstream's own metadata says its
 * USD numbers are CNY list prices divided by exactly 7.0, so dividing back
 * reproduces the published CNY price to the yuan (DESIGN §21.1).
 */
export const FX_CNY_PER_USD = 7

/** Match specificity: a resolver row outranks a provider-wide one, outranks a global one, at equal resolution specificity. */
function specificity(row: PriceRow, providerId: string, modelId: string, tier: string): number {
  let score = 0
  if (row.providerId === providerId) score += 2
  else if (row.providerId !== '') return -1
  if (row.modelId === modelId) score += 1
  else if (row.modelId !== '') return -1
  const rowTier = row.resolution
  // An empty string is what schemastery writes for an untouched field; treat it
  // as "no tier" so a hand-edited row cannot silently match nothing.
  if (rowTier === undefined || rowTier.trim() === '') return score
  if (rowTier.toLowerCase() !== tier) return -1
  return score + 1
}

/**
 * The per-unit price for a provider/model/unit/resolution, or null when no row
 * prices it.
 *
 * A missing resolution is priced as {@link BASE_TIER}, never as "the cheapest
 * row": a task that did not record its resolution was most likely run at the
 * provider's default tier, and falling through to another tier's price would be
 * a guess dressed as a number. Ties (user row vs fetched row for the same
 * provider/model/tier) are broken by list order, and the effective table puts
 * the operator's own rows first.
 */
export function unitPrice(
  table: PriceTable,
  providerId: string,
  modelId: string,
  unit: PriceUnit,
  resolution?: string | null,
): number | null {
  const named = resolution === null || resolution === undefined ? '' : resolution.trim()
  const tier = named === '' ? BASE_TIER[unit] : named.toLowerCase()
  let best: PriceRow | null = null
  let bestScore = -1
  for (const row of table.rows) {
    if (row.unit !== unit || row.pricePerUnit <= 0) continue
    const score = specificity(row, providerId, modelId, tier)
    if (score > bestScore) {
      best = row
      bestScore = score
    }
  }
  return best?.pricePerUnit ?? null
}

/** One settled task's estimated cost, or null when it cannot be priced. */
export interface CostEstimate {
  amount: number
  unit: PriceUnit
  /** The usage the estimate multiplied, in the unit's own terms. */
  usage: number
}

/** Estimate money from settled usage. Both amounts null means nothing to price (failed/cancelled, or an unpriced unit). */
export function estimateCost(
  table: PriceTable,
  usage: ProviderUsage | null | undefined,
  providerId: string,
  modelId: string,
  resolution?: string | null,
): CostEstimate | null {
  if (usage === null || usage === undefined) return null
  if (usage.tokens !== null && usage.tokens !== undefined) {
    const price = unitPrice(table, providerId, modelId, 'token', resolution)
    if (price !== null) return { amount: usage.tokens * price, unit: 'token', usage: usage.tokens }
  }
  if (usage.outputSeconds !== null && usage.outputSeconds !== undefined) {
    const price = unitPrice(table, providerId, modelId, 'second', resolution)
    if (price !== null) return { amount: usage.outputSeconds * price, unit: 'second', usage: usage.outputSeconds }
  }
  return null
}

/** Whether a finished task's usage is still unknown and therefore excluded from a total. */
export function usageUnknown(state: string | undefined): boolean {
  return state === 'unknown'
}

/**
 * ARK's 16:9 frame per tier (DESIGN §7.1 / §16.5 / §21.3). The 480p entry is
 * Seedance 2.0's — verified with ffprobe upstream and pinned by the existing
 * token-estimate reference point — and 2.5 renders a different frame, so that one
 * model overrides it below. Using one geometry for both is what made a naive
 * back-calculation report 66.96 CNY/million instead of 70.00.
 */
const ARK_TIER_FRAMES: Record<string, readonly [number, number]> = {
  '480p': [864, 496],
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '4k': [3840, 2160],
}

/** Models whose frame differs from {@link ARK_TIER_FRAMES} at a tier (upstream `volcengine_video_frames`). */
const ARK_MODEL_FRAMES: Record<string, Record<string, readonly [number, number]>> = {
  'doubao-seedance-2-5-260628': { '480p': [854, 480] },
}

/**
 * ARK's 16:9 frame for one model at one tier. Upstream's per-model frame wins
 * (it is the source), then this build's per-model override, then the tier's
 * nominal frame. Null when the tier is not one ARK publishes.
 */
function arkFrame16x9(modelId: string | null, tier: string, upstreamFrames?: unknown): readonly [number, number] | null {
  const lower = tier.toLowerCase()
  if (upstreamFrames !== undefined && upstreamFrames !== null && typeof upstreamFrames === 'object') {
    const perTier = (upstreamFrames as Record<string, unknown>)[lower]
    if (perTier !== undefined && perTier !== null && typeof perTier === 'object') {
      const literal = (perTier as Record<string, unknown>)['16:9']
      if (typeof literal === 'string') {
        const match = /^(\d+)x(\d+)$/.exec(literal.trim())
        if (match !== null) {
          const width = Number(match[1])
          const height = Number(match[2])
          if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return [width, height]
        }
      }
    }
  }
  if (modelId !== null) {
    const override = ARK_MODEL_FRAMES[modelId]?.[lower]
    if (override !== undefined) return override
  }
  return ARK_TIER_FRAMES[lower] ?? null
}

/** Frame size for a ratio, from ARK's 16:9 frame; null when the ratio is not estimated. */
function ratioDims(frame: readonly [number, number], aspectRatio: string): readonly [number, number] | null {
  const [w, h] = frame
  if (aspectRatio === '16:9') return [w, h]
  if (aspectRatio === '9:16') return [h, w]
  if (aspectRatio === '1:1') return [Math.min(w, h), Math.min(w, h)]
  return null
}

/**
 * Estimated ARK billable tokens for a request, from the reverse-engineered
 * formula "width × height × frames ÷ 1024" (frames = seconds × 24 + 1, floor).
 * Input images do not count (§7.1). Returns null when the geometry is not one
 * the formula covers — never a fake number.
 *
 * `modelId` selects the model's own frame (2.5 renders 854×480 at 480p, the 2.0
 * family 864×496). It must be the same frame the price row was derived from, or
 * a "seconds × per-second price" estimate stops agreeing with the token figure
 * reported beside it.
 */
export function estimateArkTokens(
  resolution: string | null,
  aspectRatio: string | null,
  durationSeconds: number | null,
  modelId?: string | null,
): number | null {
  if (resolution === null || aspectRatio === null || durationSeconds === null) return null
  const frame = arkFrame16x9(modelId ?? null, resolution)
  if (frame === null) return null
  const dims = ratioDims(frame, aspectRatio)
  if (dims === null) return null
  const [w, h] = dims
  const frames = Math.round(durationSeconds * 24) + 1
  return Math.floor((w * h * frames) / 1024)
}

// ---------------------------------------------------------------------------
// Upstream feed → price rows (DESIGN §21.3 / §21.5)
// ---------------------------------------------------------------------------

/** Knobs for one normalization. */
export interface NormalizeOptions {
  /** CNY per USD; defaults to {@link FX_CNY_PER_USD}. */
  fx?: number
}

/** What {@link normalizeLitellm} made of one feed: rows, plus every reason something was left out. */
export interface NormalizedPrices {
  rows: PriceRow[]
  /** One line per entry or row that was looked at and not used; the caller logs or reports these. */
  skipped: string[]
  /** Rows dropped by the unit guard — the "a field changed units" accident the guard exists for. */
  dropped: number
}

/** Rows beyond this mean the feed is not what this parser understands (a normal normalization is ~40 rows). */
export const MAX_PRICE_ROWS = 500

/** Longest model id / resolution a row may carry. */
const MAX_MODEL_ID = 120
const MAX_RESOLUTION = 16

/** Ceilings that catch a field that changed units rather than a real price. */
const MAX_PRICE_PER_TOKEN = 0.01
const MAX_PRICE_PER_SECOND = 100

/** How one upstream namespace is priced. Namespaces are mapped by protocol, never by guessing from a model id. */
interface NamespaceRule {
  unit: PriceUnit
  /** Which tier the bare `output_cost_per_second` figure equals; null when tiers are all we trust. */
  baseTier: string | null
}

/**
 * The two namespaces our protocols can bill against. Every other namespace (a
 * gateway's own resale price) is only usable through `generic-openai-videos`,
 * where one model id appearing at two different prices is a refusal rather than
 * a coin flip.
 */
const NAMESPACE_RULES: Record<string, NamespaceRule> = {
  volcengine: { unit: 'token', baseTier: '720p' },
  minimax: { unit: 'second', baseTier: '768p' },
}

/** The unit a namespace we do not pin prices in: an OpenAI-Videos-shaped gateway bills per output second. */
const GENERIC_RULE: NamespaceRule = { unit: 'second', baseTier: null }

function positiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value
}

/**
 * Trim a derived price to eight significant digits.
 *
 * Upstream publishes dollars rounded to a few decimals (0.141942857), so the
 * CNY figure back-calculated from it carries noise around the tenth digit
 * (0.000046000000298685786). That value would otherwise be quoted verbatim in
 * every estimate; eight significant digits is far more precision than any list
 * price has, and removes the noise.
 */
function roundPrice(value: number): number {
  return Number(value.toPrecision(8))
}

/** Whether an id is short enough and free of control characters to be worth carrying into a row. */
function safeId(value: string): boolean {
  if (value === '' || value.length > MAX_MODEL_ID) return false
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value)
}

/** Billable tokens per second of output for one ARK frame: `width × height × 24 ÷ 1024` (DESIGN §7.1). */
export function arkTokensPerSecond(width: number, height: number): number {
  return (width * height * 24) / 1024
}

/**
 * Turn a LiteLLM-shaped price feed into rows of a {@link PriceTable}.
 *
 * The payload is **data**: an unrecognized shape is refused as a whole (null),
 * a single unusable entry is skipped and named in `skipped`, and a price outside
 * the guard rails drops its row rather than poisoning the table. Nothing here
 * reads the network or the clock, so the whole rule set is table-testable.
 *
 * Returns null when the feed cannot be used at all — not an object, no
 * `video_generation` entries, no usable row, or more rows than this parser was
 * built for.
 */
export function normalizeLitellm(payload: unknown, options: NormalizeOptions = {}): NormalizedPrices | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const fx = options.fx ?? FX_CNY_PER_USD
  if (!Number.isFinite(fx) || fx <= 0) return null

  const rows: PriceRow[] = []
  const skipped: string[] = []
  /** Rows per model id that came from an unpinned namespace; ambiguous ones are dropped below. */
  const generic = new Map<string, PriceRow[]>()
  let videoEntries = 0
  let dropped = 0

  for (const [key, raw] of Object.entries(payload as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    if (entry['mode'] !== 'video_generation') continue
    videoEntries++

    const slash = key.indexOf('/')
    const namespace = slash < 0 ? '' : key.slice(0, slash)
    const modelId = slash < 0 ? key : key.slice(slash + 1)
    if (!safeId(modelId)) {
      skipped.push(`${key}: unusable model id`)
      continue
    }
    // `hasOwn`, not `in`: the namespace comes from a third-party file, and a key
    // like `toString` must not resolve to Object.prototype.
    const pinned = Object.hasOwn(NAMESPACE_RULES, namespace)
    const rule = pinned ? NAMESPACE_RULES[namespace] ?? GENERIC_RULE : GENERIC_RULE

    // Per-tier prices. The bare key is an alias pair: `openai/sora-2` spells it
    // `output_cost_per_video_per_second` (one extra `per_`), same meaning.
    const tiers = new Map<string, number>()
    for (const [field, value] of Object.entries(entry)) {
      const match = /^output_cost_per_(?:video_)?second_(.+)$/.exec(field)
      if (match === null) continue
      const tier = (match[1] ?? '').trim()
      if (tier === '' || tier.length > MAX_RESOLUTION) continue
      const price = positiveNumber(value)
      if (price === null) continue
      tiers.set(tier.toLowerCase(), price)
    }
    const bare = positiveNumber(entry['output_cost_per_second']) ?? positiveNumber(entry['output_cost_per_video_per_second'])

    // Which prices to emit. A tiered entry is emitted tier by tier only: its
    // bare figure duplicates the top tier, and emitting both would let a
    // tier-less row shadow the real per-tier rows.
    const priced: [string | null, number][] = tiers.size > 0
      ? [...tiers.entries()].map(([tier, usd]) => [tier, usd] as [string, number])
      : bare === null ? [] : [[null, bare]]

    if (priced.length === 0) {
      skipped.push(`${key}: no per-second price`)
      continue
    }

    const produced: PriceRow[] = []
    for (const [tier, usd] of priced) {
      const cnyPerSecond = usd * fx
      let row: PriceRow
      if (rule.unit === 'token') {
        const frame = tier === null ? null : arkFrame16x9(modelId, tier, entry['provider_specific_entry'] !== null && typeof entry['provider_specific_entry'] === 'object'
          ? (entry['provider_specific_entry'] as Record<string, unknown>)['volcengine_video_frames']
          : undefined)
        if (frame === null) {
          skipped.push(`${key}${tier === null ? '' : `@${tier}`}: no frame geometry for a token price`)
          continue
        }
        const perToken = cnyPerSecond / arkTokensPerSecond(frame[0], frame[1])
        if (perToken > MAX_PRICE_PER_TOKEN) {
          dropped++
          continue
        }
        row = { providerId: '', modelId, pricePerUnit: roundPrice(perToken), unit: 'token', ...(tier === null ? {} : { resolution: tier }) }
      } else {
        if (cnyPerSecond > MAX_PRICE_PER_SECOND) {
          dropped++
          continue
        }
        // An unpinned namespace keeps its bare figure only when it has no tiers;
        // when it does, the tiers are the whole story.
        if (tier === null && rule.baseTier !== null) {
          row = { providerId: '', modelId, pricePerUnit: roundPrice(cnyPerSecond), unit: 'second', resolution: rule.baseTier }
        } else {
          row = { providerId: '', modelId, pricePerUnit: roundPrice(cnyPerSecond), unit: 'second', ...(tier === null ? {} : { resolution: tier }) }
        }
      }
      produced.push(row)
    }

    if (produced.length === 0) continue
    if (pinned) rows.push(...produced)
    else generic.set(modelId, [...(generic.get(modelId) ?? []), ...produced])
  }

  // A gateway model id may be reached through several namespaces at once (a
  // relay and its upstream). Same tier, same price: one row. Different price:
  // no row — picking one would be inventing a contract.
  for (const [modelId, candidates] of generic) {
    const byTier = new Map<string, number>()
    let ambiguous = false
    for (const row of candidates) {
      const tier = row.resolution ?? ''
      const seen = byTier.get(tier)
      if (seen === undefined) byTier.set(tier, row.pricePerUnit)
      else if (Math.abs(seen - row.pricePerUnit) > 1e-9) ambiguous = true
    }
    if (ambiguous) {
      skipped.push(`${modelId}: ambiguous price across namespaces`)
      continue
    }
    const seen = new Set<string>()
    for (const row of candidates) {
      const tier = row.resolution ?? ''
      if (seen.has(tier)) continue
      seen.add(tier)
      rows.push(row)
    }
  }

  if (videoEntries === 0 || rows.length === 0) return null
  if (rows.length > MAX_PRICE_ROWS) return null

  return { rows, skipped, dropped }
}

// ---------------------------------------------------------------------------
// The bundled snapshot (DESIGN §21.3)
// ---------------------------------------------------------------------------

/**
 * The rows this build ships, used when no fetched or cached table is available.
 * They are the same normalization as {@link normalizeLitellm} applied to the
 * 2026-10-21 upstream sample, restricted to the preset model ids — and a test
 * holds the two to each other, so a change in the normalization cannot silently
 * leave this snapshot behind.
 *
 * Still an estimate, and still not a bill: `pricedAt` says how old it is.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  currency: 'CNY',
  pricedAt: '2026-10-21',
  source: 'litellm main etag:d3ac3440 fetched 2026-10-21 · international list price ×7.0 · no video input',
  rows: [
    // doubao-seedance-2-5-260628 — 70 CNY/million at 480p and 720p, 77 at 1080p.
    { providerId: '', modelId: 'doubao-seedance-2-5-260628', unit: 'token', resolution: '480p', pricePerUnit: 0.00007 },
    { providerId: '', modelId: 'doubao-seedance-2-5-260628', unit: 'token', resolution: '720p', pricePerUnit: 0.00007 },
    { providerId: '', modelId: 'doubao-seedance-2-5-260628', unit: 'token', resolution: '1080p', pricePerUnit: 0.000077 },
    // doubao-seedance-2-0-260128 — 46 / 46 / 51 / 26.
    { providerId: '', modelId: 'doubao-seedance-2-0-260128', unit: 'token', resolution: '480p', pricePerUnit: 0.000046 },
    { providerId: '', modelId: 'doubao-seedance-2-0-260128', unit: 'token', resolution: '720p', pricePerUnit: 0.000046 },
    { providerId: '', modelId: 'doubao-seedance-2-0-260128', unit: 'token', resolution: '1080p', pricePerUnit: 0.000051 },
    { providerId: '', modelId: 'doubao-seedance-2-0-260128', unit: 'token', resolution: '4k', pricePerUnit: 0.000026 },
    // doubao-seedance-2-0-fast-260128 / -mini-260615 — 37 / 23 at 480p and 720p.
    { providerId: '', modelId: 'doubao-seedance-2-0-fast-260128', unit: 'token', resolution: '480p', pricePerUnit: 0.000037 },
    { providerId: '', modelId: 'doubao-seedance-2-0-fast-260128', unit: 'token', resolution: '720p', pricePerUnit: 0.000037 },
    { providerId: '', modelId: 'doubao-seedance-2-0-mini-260615', unit: 'token', resolution: '480p', pricePerUnit: 0.000023 },
    { providerId: '', modelId: 'doubao-seedance-2-0-mini-260615', unit: 'token', resolution: '720p', pricePerUnit: 0.000023 },
    // MiniMax-H3 — $0.08/s at 768P, $0.13/s at 2K, times 7.0.
    { providerId: '', modelId: 'MiniMax-H3', unit: 'second', resolution: '768p', pricePerUnit: 0.56 },
    { providerId: '', modelId: 'MiniMax-H3', unit: 'second', resolution: '2k', pricePerUnit: 0.91 },
    // MiniMax-H3-Max — $0.05/s at 480P, $0.08/s at 768P.
    { providerId: '', modelId: 'MiniMax-H3-Max', unit: 'second', resolution: '480p', pricePerUnit: 0.35 },
    { providerId: '', modelId: 'MiniMax-H3-Max', unit: 'second', resolution: '768p', pricePerUnit: 0.56 },
    // openai/sora-2 — $0.10/s, no resolution tiers, deprecated upstream but still priced.
    { providerId: '', modelId: 'sora-2', unit: 'second', pricePerUnit: 0.7 },
  ],
}

// ---------------------------------------------------------------------------
// Where the effective table came from (DESIGN §21.6)
// ---------------------------------------------------------------------------

/**
 * How a price table was obtained. Shown with every amount, because "82 元" from
 * a table fetched this morning and "82 元" from a three-week-old cache are not
 * the same claim.
 */
export type PriceSourceKind = 'remote' | 'cache' | 'bundled' | 'none'

export interface PriceSourceInfo {
  kind: PriceSourceKind
  /** The feed address; null when no remote source is configured. */
  url: string | null
  /** When the prices in effect were fetched (ISO); null for the built-in snapshot. */
  fetchedAt: string | null
  /** Whole days since `fetchedAt`; 0 for a fresh fetch, null when there is nothing to age. */
  ageDays: number | null
  /** The last failure, one line, so "the network is down" and "that URL is wrong" stay distinguishable. */
  lastError: string | null
  /** Anything the reader needs to know about this table, e.g. that it is an ageing snapshot. */
  note: string | null
}
