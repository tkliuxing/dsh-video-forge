/**
 * Plugin configuration: the schemastery `Config` the profile row edits, plus the
 * plain-value snapshot the runtime actually reads.
 *
 * Every field is volatile. DSH commits a volatile-only change straight into the
 * running fiber and then emits `loader/volatile-update` on this plugin's own
 * context, so a provider or a poll interval can be corrected without a restart.
 * Because a volatile field's parsed value is a reference (`{ get() }`) and not
 * the value itself, the runtime never reads the config object directly: it calls
 * {@link snapshot} once per operation, which is also what keeps a tool call from
 * seeing a half-updated mix of old and new fields.
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_PRICE_SOURCE_URL } from './price-source.ts'
import type { PriceTable } from './prices.ts'
import { SUPPORTED_PROTOCOLS } from './provider-presets.ts'
import type { ProviderSetting, VideoForgeSettings } from './settings.ts'
import { DEFAULT_ENDPOINTS } from './settings.ts'
import { VIDEO_MODES } from './types.ts'

/** The live reference-valued config DSH hands to `apply`. */
export interface Config {
  enabled: Volatile<boolean>
  providers: Volatile<ProviderSetting[]>
  defaultProvider: Volatile<string>
  defaultModel: Volatile<string>
  outputDir: Volatile<string>
  pollIntervalMs: Volatile<number>
  waitSecondsMax: Volatile<number>
  dedupeWindowSeconds: Volatile<number>
  maxConcurrent: Volatile<number>
  maxTasks: Volatile<number>
  maxGiB: Volatile<number>
  requestTimeoutMs: Volatile<number>
  priceTable: Volatile<PriceTable>
  priceSourceUrl: Volatile<string>
  priceRefreshHours: Volatile<number>
}

const model = z.object({
  id: z.string().description('Provider-side model id, e.g. doubao-seedance-1-0-pro-250528'),
  label: z.string().default('').description('Display name; falls back to the id'),
  modes: z.array(z.union([...VIDEO_MODES])).default(['t2v']),
  durations: z.array(z.number()).default([]).description('Allowed seconds; empty means provider default'),
  resolutions: z.array(z.string()).default([]),
  aspectRatios: z.array(z.string()).default([]),
  sizes: z.array(z.string()).default([]).description('`WxH` values for providers that take a literal size'),
  cancelable: z.boolean().default(true).description('Whether this model documents a cancel operation'),
  generateAudio: z.boolean().default(false).description('Ask the provider for a synchronized audio track'),
  pollIntervalMs: z.number().min(1000).default(5000),
  frameRoleFirst: z.string().default('first_frame'),
  frameRoleLast: z.string().default('last_frame'),
  frameRoleReference: z.string().default('reference_image'),
})

const endpoints = z.object({
  submit: z.string().default(DEFAULT_ENDPOINTS.submit),
  query: z.string().default(DEFAULT_ENDPOINTS.query),
  content: z.string().default(DEFAULT_ENDPOINTS.content),
  cancel: z.string().default(DEFAULT_ENDPOINTS.cancel),
  idPath: z.string().default(DEFAULT_ENDPOINTS.idPath),
  statusPath: z.string().default(DEFAULT_ENDPOINTS.statusPath),
  progressPath: z.string().default(DEFAULT_ENDPOINTS.progressPath),
  resultUrlPath: z.string().default(DEFAULT_ENDPOINTS.resultUrlPath),
  errorPath: z.string().default(DEFAULT_ENDPOINTS.errorPath),
  statusQueued: z.string().default(DEFAULT_ENDPOINTS.statusQueued),
  statusRunning: z.string().default(DEFAULT_ENDPOINTS.statusRunning),
  statusSucceeded: z.string().default(DEFAULT_ENDPOINTS.statusSucceeded),
  statusFailed: z.string().default(DEFAULT_ENDPOINTS.statusFailed),
  statusCancelled: z.string().default(DEFAULT_ENDPOINTS.statusCancelled),
})

const provider = z.object({
  id: z.string().description('Stable id referenced by providerId::modelId'),
  protocol: z.union([...SUPPORTED_PROTOCOLS]).default('generic-openai-videos'),
  baseUrl: z.string().description('API root, e.g. https://ark.cn-beijing.volces.com/api/v3'),
  authRef: z.string().default('').description('Credential reference name, e.g. ARK_API_KEY; empty for a keyless gateway'),
  models: z.array(model).default([]),
  endpoints: endpoints,
})

const priceRow = z.object({
  providerId: z.string().default('').description('Provider id; empty matches any provider'),
  modelId: z.string().default('').description('Model id; empty matches any model'),
  resolution: z.string().default('').description('Output tier this row prices (e.g. 720p, 2K); empty matches any tier'),
  unit: z.union(['token', 'second']).description('Billing unit: token for ARK, second for MiniMax'),
  pricePerUnit: z.number().min(0).description('Price of one unit, in the table currency'),
})

/**
 * The operator's own price rows (DESIGN §21.6).
 *
 * `rows` defaults to empty on purpose: they win over every fetched row, so a
 * non-empty default would mean the fetched table never takes effect. Empty means
 * "no override" and the effective table is remote > cache > built-in snapshot.
 * The three header fields are only meaningful while `rows` is what prices
 * something; a fetched table brings its own.
 */
const priceTable = z.object({
  currency: z.string().default('CNY'),
  pricedAt: z.string().default(''),
  source: z.string().default(''),
  rows: z.array(priceRow).default([]).description('Your own rows, which win over every fetched row'),
})

/**
 * The plugin schema. Annotated (rather than inferred) so the emitted declaration
 * names `Schema<Config>` instead of schemastery's internal object type, and cast
 * because schemastery's `volatile()` generics do not line up with
 * `exactOptionalPropertyTypes` — the two disagree about the shape of a defaulted
 * volatile field, while the runtime agrees with both.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  providers: z.array(provider).default([]).volatile(),
  defaultProvider: z.string().default('').volatile(),
  defaultModel: z.string().default('').volatile(),
  outputDir: z.string().default('').volatile()
    .description('Artifact root; empty means $DSH_HOME/dsh-video-forge/outputs'),
  pollIntervalMs: z.number().min(1000).default(5000).volatile(),
  waitSecondsMax: z.number().min(0).default(600).volatile()
    .description('Upper bound for the tool call\'s own bounded wait'),
  dedupeWindowSeconds: z.number().min(0).default(120).volatile(),
  maxConcurrent: z.number().min(1).default(1).volatile(),
  maxTasks: z.number().min(1).default(200).volatile(),
  maxGiB: z.number().min(0).default(20).volatile(),
  requestTimeoutMs: z.number().min(1000).default(120000).volatile(),
  priceTable: priceTable.volatile(),
  priceSourceUrl: z.string().default(DEFAULT_PRICE_SOURCE_URL).volatile()
    .description('Public price feed to read (DESIGN §21); empty disables the remote source'),
  priceRefreshHours: z.number().min(0).default(24).volatile()
    .description('Hours between price refreshes; 0 fetches once on start'),
}) as unknown as z<Config>

/** Read every volatile reference into one plain, stable value. */
export function snapshot(config: Config): VideoForgeSettings {
  return {
    enabled: config.enabled.get(),
    providers: config.providers.get().map(setting => ({
      ...setting,
      endpoints: { ...DEFAULT_ENDPOINTS, ...setting.endpoints },
    })),
    defaultProvider: config.defaultProvider.get(),
    defaultModel: config.defaultModel.get(),
    outputDir: config.outputDir.get(),
    pollIntervalMs: config.pollIntervalMs.get(),
    waitSecondsMax: config.waitSecondsMax.get(),
    dedupeWindowSeconds: config.dedupeWindowSeconds.get(),
    maxConcurrent: config.maxConcurrent.get(),
    maxTasks: config.maxTasks.get(),
    maxGiB: config.maxGiB.get(),
    requestTimeoutMs: config.requestTimeoutMs.get(),
    priceTable: userPriceTable(config.priceTable.get()),
  }
}

/**
 * Drop the empty strings schemastery writes into every defaulted field, so a row
 * with no resolution is a row that matches any tier rather than one that matches
 * the empty tier.
 */
function userPriceTable(raw: PriceTable): PriceTable {
  return {
    ...raw,
    rows: raw.rows.map(row => ({
      providerId: row.providerId,
      modelId: row.modelId,
      unit: row.unit,
      pricePerUnit: row.pricePerUnit,
      ...(row.resolution === undefined || row.resolution.trim() === '' ? {} : { resolution: row.resolution }),
    })),
  }
}
