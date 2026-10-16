/**
 * The editable price table on top of settled usage (DESIGN §16.5).
 *
 * Usage (tokens / output seconds) is what the provider reported and is exact.
 * Money is never exact: it is usage times a per-unit price the operator can
 * edit, and the numbers below are reference prices, not the vendor's bill. The
 * real bill lives only in the provider's console.
 */

import type { ProviderUsage } from './types.ts'

/** What one price row charges for. ARK bills by token, MiniMax by second. */
export type PriceUnit = 'token' | 'second'

export interface PriceRow {
  /** Provider id as configured; empty string matches any provider. */
  providerId: string
  /** Model id as configured; empty string matches any model of the provider. */
  modelId: string
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
  /** Where the prices came from; shown with every estimate. */
  source: string
  /** Per-model prices; the most specific matching row wins. */
  rows: readonly PriceRow[]
}

/**
 * Reference prices, deliberately not authoritative: they are third-party
 * figures that disagree with each other. The operator is expected to replace
 * them with their own numbers; every estimate still says "estimate, the
 * provider bill is authoritative".
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  currency: 'CNY',
  pricedAt: '2026-10-16',
  source: 'volcengine docs (ARK Seedance) and MiniMax Hailuo public pricing; third-party reference',
  rows: [
    // ARK bills by token: ~28 CNY per million tokens (Seedance 2.0, video input).
    { providerId: '', modelId: '', unit: 'token', pricePerUnit: 0.000028 },
    // MiniMax bills by output second: ~0.30 CNY/s at 768p (Hailuo-02).
    { providerId: '', modelId: '', unit: 'second', pricePerUnit: 0.3 },
  ],
}

/** Match specificity: an exact (provider, model) row outranks a provider-wide one, which outranks the global default. */
function specificity(row: PriceRow, providerId: string, modelId: string): number {
  let score = 0
  if (row.providerId === providerId) score += 2
  else if (row.providerId !== '') return -1
  if (row.modelId === modelId) score += 1
  else if (row.modelId !== '') return -1
  return score
}

/** The per-unit price for a provider/model/unit, or null when no row prices it. */
export function unitPrice(table: PriceTable, providerId: string, modelId: string, unit: PriceUnit): number | null {
  let best: PriceRow | null = null
  let bestScore = -1
  for (const row of table.rows) {
    if (row.unit !== unit || row.pricePerUnit <= 0) continue
    const score = specificity(row, providerId, modelId)
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
): CostEstimate | null {
  if (usage === null || usage === undefined) return null
  if (usage.tokens !== null && usage.tokens !== undefined) {
    const price = unitPrice(table, providerId, modelId, 'token')
    if (price !== null) return { amount: usage.tokens * price, unit: 'token', usage: usage.tokens }
  }
  if (usage.outputSeconds !== null && usage.outputSeconds !== undefined) {
    const price = unitPrice(table, providerId, modelId, 'second')
    if (price !== null) return { amount: usage.outputSeconds * price, unit: 'second', usage: usage.outputSeconds }
  }
  return null
}

/** Whether a finished task's usage is still unknown and therefore excluded from a total. */
export function usageUnknown(state: string | undefined): boolean {
  return state === 'unknown'
}

/** ARK's actual output pixels per 16:9 resolution (DESIGN §7.1 / §16.5). */
const ARK_PIXELS_16_9: Record<string, readonly [number, number]> = {
  '480p': [864, 496],
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '4k': [3840, 2160],
}

/** Width and height for a ratio, derived from ARK's 16:9 pixel budget; null when the ratio is not estimated. */
function arkDims(resolution: string, aspectRatio: string): readonly [number, number] | null {
  const base = ARK_PIXELS_16_9[resolution]
  if (base === undefined) return null
  const [w, h] = base
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
 */
export function estimateArkTokens(resolution: string | null, aspectRatio: string | null, durationSeconds: number | null): number | null {
  if (resolution === null || aspectRatio === null || durationSeconds === null) return null
  const dims = arkDims(resolution, aspectRatio)
  if (dims === null) return null
  const [w, h] = dims
  const frames = Math.round(durationSeconds * 24) + 1
  return Math.floor((w * h * frames) / 1024)
}
