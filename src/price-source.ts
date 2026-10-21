/**
 * Where the price table comes from (DESIGN §21): one public feed, fetched in the
 * background, validated before it is believed, cached, and composed with the
 * operator's own rows.
 *
 * Three rules shape this file:
 *
 * - **No tool path ever touches the network.** `video_status` reads a snapshot;
 *   an estimate must not fail because a CDN is slow. Fetching happens on `apply`
 *   and on a timer, never inside a call.
 * - **A bad feed is refused whole, and "good" is never assumed.** The payload is
 *   data from a third-party repository that commits many times a day; anything
 *   this parser does not understand leaves the previous table in place rather
 *   than producing half a table.
 * - **Old prices beat no prices, and unknown beats zero.** The ladder is
 *   operator rows > remote > cache > built-in snapshot. When every layer is
 *   empty the answer is "not priced", never 0.
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_PRICE_TABLE,
  FX_CNY_PER_USD,
  MAX_PRICE_ROWS,
  normalizeLitellm,
  type PriceRow,
  type PriceSourceInfo,
  type PriceSourceKind,
  type PriceTable,
} from './prices.ts'

/** The feed this build reads by default: LiteLLM's price database, raw from `main` (DESIGN §21.1). */
export const DEFAULT_PRICE_SOURCE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

/** Cache file name inside the plugin's home under `$DSH_HOME`. */
export const PRICE_CACHE_FILE = 'price-cache.json'

/** Version of the cache file's own shape; an unknown one is ignored, not migrated. */
const CACHE_VERSION = 1

/** How long to wait for the response headers, and for the whole body, in milliseconds. */
const HEADER_TIMEOUT_MS = 8000
const TOTAL_TIMEOUT_MS = 12_000

/** Response bodies beyond this are refused: the feed is ~3 MB today and grows. */
const MAX_BODY_BYTES = 8_000_000

/** Redirects followed, and only within one host. */
const MAX_REDIRECTS = 3

/**
 * Delays between retries after consecutive failures, in milliseconds: 5 min,
 * 30 min, 2 h, then 6 h for as long as it keeps failing. A corrected URL
 * therefore shows a result within minutes, and a dead feed is not hammered.
 */
const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000]

/** The minimum of the fetch API this file needs, so a test can inject a fake. */
export interface PriceFetchResponse {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type PriceFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'manual' },
) => Promise<PriceFetchResponse>

/** One cache file read: the normalized table plus the provenance needed for a conditional request. */
interface CacheEntry {
  url: string
  etag: string | null
  fetchedAt: string
  checkedAt: string
  table: PriceTable
}

/** The table a caller should price against, plus where it came from. */
export interface EffectivePrices {
  table: PriceTable
  info: PriceSourceInfo
}

export interface PriceSourceOptions {
  /** Absolute path of the cache file. */
  path: string
  /** The feed address; empty disables the remote layer entirely (DESIGN §21.1). */
  url: string
  /** Hours between refreshes; 0 fetches once on `start` and never again. */
  refreshHours: number
  /** CNY per USD for the conversion; defaults to {@link FX_CNY_PER_USD}. */
  fx?: number
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: PriceFetch
  /** Injectable clock, in milliseconds since the epoch. */
  now?: () => number
  /**
   * The model ids this installation is configured for. A fetched table that
   * prices none of them is treated as a mismatch (an upstream rename, a relay's
   * own ids) rather than silently installed; see DESIGN §21.5.
   */
  configuredModelIds?: () => readonly string[]
  logger?: { info(message: string): void; warn(message: string): void }
  /** Called when the effective table changed, so a live surface can re-read it. */
  onChange?: () => void
}

/** Days between an ISO instant and now, floored at 0; null when the instant is unreadable. */
function ageInDays(fetchedAt: string, now: number): number | null {
  const then = Date.parse(fetchedAt)
  if (!Number.isFinite(then)) return null
  return Math.max(0, Math.floor((now - then) / 86_400_000))
}

/**
 * Why a URL may not be used, or null when it may.
 *
 * The URL decides where price data comes from; a credential in it would be sent
 * to whoever is on the other end of a redirect, and this plugin has no business
 * transmitting one on a price refresh.
 */
export function priceSourceUrlProblem(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return 'priceSourceUrl is not a URL'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'priceSourceUrl must be http or https'
  if (parsed.username !== '' || parsed.password !== '') return 'priceSourceUrl carries credentials'
  for (const key of parsed.searchParams.keys()) {
    if (/^(token|access_token|api_?key|key|secret|sig|signature|password)$/i.test(key)) {
      return 'priceSourceUrl carries what looks like a credential'
    }
  }
  return null
}

/** The text of a cached row, or null when the cached table is not one this build can price from. */
function validRow(raw: unknown): PriceRow | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const providerId = row['providerId']
  const modelId = row['modelId']
  const pricePerUnit = row['pricePerUnit']
  const unit = row['unit']
  const resolution = row['resolution']
  if (typeof providerId !== 'string' || typeof modelId !== 'string') return null
  if (typeof pricePerUnit !== 'number' || !Number.isFinite(pricePerUnit) || pricePerUnit <= 0) return null
  if (unit !== 'token' && unit !== 'second') return null
  if (resolution !== undefined && typeof resolution !== 'string') return null
  if (modelId.length > 120) return null
  return {
    providerId,
    modelId,
    pricePerUnit,
    unit,
    ...(typeof resolution === 'string' && resolution !== '' ? { resolution } : {}),
  }
}

/** A parsed cache file, or null when it is not one this build understands (the caller decides what to say). */
function parseCache(raw: string, path: string): { entry: CacheEntry | null; problem: string | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { entry: null, problem: `cache corrupt (${path}): not JSON` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { entry: null, problem: `cache corrupt (${path}): not an object` }
  }
  const file = parsed as Record<string, unknown>
  if (file['version'] !== CACHE_VERSION) {
    return { entry: null, problem: `cache corrupt (${path}): unsupported version ${String(file['version'])}` }
  }
  const url = file['url']
  const fetchedAt = file['fetchedAt']
  const checkedAt = file['checkedAt']
  const table = file['table']
  if (typeof url !== 'string' || typeof fetchedAt !== 'string' || typeof checkedAt !== 'string') {
    return { entry: null, problem: `cache corrupt (${path}): missing provenance` }
  }
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    return { entry: null, problem: `cache corrupt (${path}): missing table` }
  }
  const rawTable = table as Record<string, unknown>
  if (!Array.isArray(rawTable['rows'])) return { entry: null, problem: `cache corrupt (${path}): missing rows` }
  const rows: PriceRow[] = []
  for (const candidate of rawTable['rows']) {
    const row = validRow(candidate)
    if (row === null) return { entry: null, problem: `cache corrupt (${path}): unusable row` }
    rows.push(row)
  }
  if (rows.length === 0 || rows.length > MAX_PRICE_ROWS) {
    return { entry: null, problem: `cache corrupt (${path}): ${rows.length} rows` }
  }
  const currency = typeof rawTable['currency'] === 'string' && rawTable['currency'].length > 0 ? rawTable['currency'] : 'CNY'
  const pricedAt = typeof rawTable['pricedAt'] === 'string' ? rawTable['pricedAt'] : ''
  const source = typeof rawTable['source'] === 'string' ? rawTable['source'] : ''
  const etag = typeof file['etag'] === 'string' ? file['etag'] : null
  return { entry: { url, etag, fetchedAt, checkedAt, table: { currency, pricedAt, source, rows } }, problem: null }
}

/**
 * The price table in effect: fetch, validate, cache, compose.
 *
 * One instance per plugin process. It holds a normalised table in memory (what
 * every tool path reads), a cache file it never deletes on its own, and the
 * retry schedule. It never throws: a refresh failure is recorded, reported, and
 * scheduled.
 */
export class PriceSource {
  readonly #options: PriceSourceOptions
  readonly #fetch: PriceFetch | null
  /** The table fetched in this process, if any; beats the cache. */
  #remote: PriceTable | null = null
  /** The last cache file read successfully. */
  #cache: CacheEntry | null = null
  #lastError: string | null = null
  #failures = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  #disposed = false
  /** Refresh bookkeeping for tests and diagnostics. */
  #refreshes = 0
  #notModified = 0

  constructor(options: PriceSourceOptions) {
    this.#options = options
    // No global fetch in an unusual host, and no fetch at all when the remote
    // layer is off: both are states, not errors.
    this.#fetch = options.fetch ?? (typeof globalThis.fetch === 'function' ? (globalThis.fetch as unknown as PriceFetch) : null)
  }

  /** The feed address currently in effect. */
  get url(): string {
    return this.#options.url
  }

  /** How many refreshes ran (successful or not); the tests watch this instead of the clock. */
  get refreshes(): number {
    return this.#refreshes
  }

  /** How many refreshes were answered `304 Not Modified`. */
  get notModified(): number {
    return this.#notModified
  }

  /** The last failure, if the last attempt failed. */
  get lastError(): string | null {
    return this.#lastError
  }

  /**
   * Read the cache file synchronously, before the first fetch.
   *
   * Deliberately synchronous and deliberately not awaited: it is a small file,
   * and it must already be in effect when the first tool call after a restart
   * asks what something cost. A corrupt file is reported and left on disk for
   * diagnosis, never deleted (DESIGN §21.6).
   */
  loadCacheSync(): void {
    let raw: string
    try {
      raw = readFileSync(this.#options.path, 'utf8')
    } catch (error: unknown) {
      const code = (error as { code?: string }).code
      // "No cache yet" is the normal first run, not a failure worth reporting.
      if (code !== 'ENOENT') this.#lastError = `cache unreadable: ${code ?? String(error)}`
      return
    }
    const { entry, problem } = parseCache(raw, this.#options.path)
    if (entry === null) {
      this.#lastError = problem ?? 'cache corrupt'
      return
    }
    if (entry.url !== this.#options.url) {
      // A cache from a different feed is not evidence about this one.
      this.#cache = null
      return
    }
    this.#cache = entry
  }

  /** Fetch now (async) and start the refresh timer. Never awaited by `apply`. */
  start(): void {
    if (this.#options.url === '') return
    void this.refresh()
  }

  /** Apply a config edit: a new URL or interval takes effect at once, and clears the backoff. */
  reconfigure(input: { url: string; refreshHours: number }): void {
    const urlChanged = input.url !== this.#options.url
    this.#options.url = input.url
    this.#options.refreshHours = input.refreshHours
    if (urlChanged) {
      this.#remote = null
      this.#cache = null
      this.#lastError = null
      this.#failures = 0
      this.loadCacheSync()
    }
    this.#clearTimer()
    if (this.#options.url === '') return
    void this.refresh()
  }

  /** Stop the timer. The plugin's disposer calls this; the cache file is left alone. */
  dispose(): void {
    this.#disposed = true
    this.#clearTimer()
  }

  /**
   * One refresh attempt: conditional GET, whole-file validation, cache write.
   * Resolves when the attempt is over — success, `304`, or failure — and always
   * schedules the next one.
   */
  async refresh(): Promise<void> {
    if (this.#disposed) return
    this.#clearTimer()
    if (this.#options.url === '') {
      this.#schedule()
      return
    }
    if (this.#fetch === null) {
      this.#fail('no fetch implementation in this host')
      this.#schedule()
      return
    }
    const problem = priceSourceUrlProblem(this.#options.url)
    if (problem !== null) {
      this.#fail(problem)
      this.#schedule()
      return
    }

    this.#refreshes++
    try {
      const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'dsh-video-forge' }
      const cached = this.#cache
      if (cached !== null && cached.etag !== null && cached.url === this.#options.url) headers['if-none-match'] = cached.etag

      const response = await this.#request(this.#options.url, headers)
      if (response.status === 304) {
        this.#notModified++
        this.#lastError = null
        this.#failures = 0
        if (cached !== null) {
          cached.checkedAt = new Date(this.now()).toISOString()
          await this.#writeCache(cached)
        }
        // A 304 with nothing cached means the conditional header was wrong;
        // keep the snapshot in place and try again next cycle.
        this.#schedule()
        return
      }
      if (response.status !== 200) {
        this.#fail(`HTTP ${response.status}`)
        this.#schedule()
        return
      }

      const normalized = normalizeLitellm(JSON.parse(response.body), { fx: this.#options.fx ?? FX_CNY_PER_USD })
      if (normalized === null) {
        this.#fail('not JSON / no usable price rows')
        this.#schedule()
        return
      }
      const wanted = this.#options.configuredModelIds?.() ?? []
      if (wanted.length > 0 && !normalized.rows.some(row => wanted.includes(row.modelId))) {
        this.#fail('0 rows matched the configured models')
        this.#schedule()
        return
      }

      const fetchedAt = new Date(this.now()).toISOString()
      const table: PriceTable = {
        currency: 'CNY',
        pricedAt: fetchedAt.slice(0, 10),
        source: describeSource(response.etag, fetchedAt, normalized.rows.length),
        rows: normalized.rows,
      }
      this.#remote = table
      this.#lastError = null
      this.#failures = 0
      const entry: CacheEntry = {
        url: this.#options.url,
        etag: response.etag,
        fetchedAt,
        checkedAt: fetchedAt,
        table,
      }
      this.#cache = entry
      await this.#writeCache(entry)
      this.#options.logger?.info(`video-forge: prices refreshed (${normalized.rows.length} rows${normalized.dropped === 0 ? '' : `, ${normalized.dropped} dropped by the unit guard`})`)
      this.#options.onChange?.()
    } catch (error: unknown) {
      this.#fail(describeFailure(error))
    }
    this.#schedule()
  }

  /**
   * The table every tool path prices against: the operator's rows first (so a
   * hand-written correction always wins a tie), then whichever layer of the
   * ladder answered. Cheap and synchronous by construction.
   */
  effective(user: PriceTable): EffectivePrices {
    const inner = this.#inner()
    const rows: readonly PriceRow[] = inner === null ? [...user.rows] : [...user.rows, ...inner.table.rows]
    const base = inner === null
      ? { currency: user.currency, pricedAt: user.pricedAt, source: '' }
      : { currency: inner.table.currency, pricedAt: inner.table.pricedAt, source: inner.table.source }
    const source = inner === null
      ? 'no price source configured'
      : user.rows.length === 0 ? base.source : `${base.source} · ${user.rows.length} operator row(s)`
    const table: PriceTable = { currency: base.currency === '' ? 'CNY' : base.currency, pricedAt: base.pricedAt, source, rows }
    return { table, info: this.#info(inner) }
  }

  /** The layer of the ladder that answers, or null when none does. */
  #inner(): { table: PriceTable; kind: PriceSourceKind; fetchedAt: string | null } | null {
    if (this.#remote !== null) return { table: this.#remote, kind: 'remote', fetchedAt: this.#remote.pricedAt }
    if (this.#cache !== null) return { table: this.#cache.table, kind: 'cache', fetchedAt: this.#cache.fetchedAt }
    // `priceSourceUrl === ''` means the operator refused a remote source; then a
    // built-in snapshot would be a price they did not ask for.
    if (this.#options.url === '') return null
    return { table: DEFAULT_PRICE_TABLE, kind: 'bundled', fetchedAt: null }
  }

  /** Provenance for the table {@link effective} just returned. */
  #info(inner: { kind: PriceSourceKind; fetchedAt: string | null } | null): PriceSourceInfo {
    const url = this.#options.url === '' ? null : this.#options.url
    if (inner === null) {
      return {
        kind: 'none',
        url,
        fetchedAt: null,
        ageDays: null,
        lastError: this.#lastError,
        note: 'no price source: priceSourceUrl is empty and nothing is cached, so usage is not priced',
      }
    }
    const ageDays = inner.fetchedAt === null ? null : ageInDays(inner.fetchedAt, this.now())
    const notes: string[] = []
    if (inner.kind === 'bundled') notes.push('built-in snapshot, may be out of date')
    if (ageDays !== null && ageDays >= 7) notes.push(`prices are ${ageDays} days old`)
    if (this.#lastError !== null && inner.kind !== 'remote') notes.push(`last refresh failed: ${this.#lastError}`)
    return {
      kind: inner.kind,
      url,
      fetchedAt: inner.fetchedAt,
      ageDays,
      lastError: this.#lastError,
      note: notes.length === 0 ? null : notes.join('; '),
    }
  }

  /** The clock the age and cache stamps use. */
  now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  /** GET with bounded waiting, a body cap and no cross-host redirect. */
  async #request(url: string, headers: Record<string, string>): Promise<{ status: number; body: string; etag: string | null }> {
    const fetchImpl = this.#fetch
    if (fetchImpl === null) throw new Error('no fetch implementation in this host')
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const controller = new AbortController()
      const headerTimer = setTimeout(() => controller.abort(new Error('timeout waiting for headers')), HEADER_TIMEOUT_MS)
      const totalTimer = setTimeout(() => controller.abort(new Error('timeout')), TOTAL_TIMEOUT_MS)
      try {
        const response = await fetchImpl(current, { headers, signal: controller.signal, redirect: 'manual' })
        clearTimeout(headerTimer)
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location !== null && location !== '') {
          const next = new URL(location, current)
          if (next.host !== new URL(current).host) throw new Error(`cross-host redirect refused (${next.host})`)
          current = next.toString()
          continue
        }
        if (response.status !== 200) return { status: response.status, body: '', etag: null }
        const declared = Number(response.headers.get('content-length') ?? '')
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error(`body too large (${declared} bytes)`)
        const body = await response.text()
        if (body.length > MAX_BODY_BYTES) throw new Error(`body too large (${body.length} bytes)`)
        return { status: 200, body, etag: response.headers.get('etag') }
      } finally {
        clearTimeout(headerTimer)
        clearTimeout(totalTimer)
      }
    }
    throw new Error('too many redirects')
  }

  /** Record a failure and count it, without touching the table in effect. */
  #fail(reason: string): void {
    this.#lastError = reason
    this.#failures++
    this.#options.logger?.warn(`video-forge: price refresh failed (${reason}); keeping the previous table`)
  }

  /** Persist the cache atomically: a torn price file must never be read as prices. */
  async #writeCache(entry: CacheEntry): Promise<void> {
    const path = this.#options.path
    const payload = `${JSON.stringify({
      version: CACHE_VERSION,
      url: entry.url,
      etag: entry.etag,
      fetchedAt: entry.fetchedAt,
      checkedAt: entry.checkedAt,
      table: entry.table,
    }, null, 2)}\n`
    try {
      await mkdir(dirname(path), { recursive: true })
      const temporary = join(dirname(path), `.${PRICE_CACHE_FILE}.${process.pid}.${Date.now()}.tmp`)
      await writeFile(temporary, payload, { mode: 0o600 })
      await rename(temporary, path)
    } catch (error: unknown) {
      // The table in memory is what prices use; a cache that cannot be written
      // costs the next restart a fetch, nothing more.
      this.#options.logger?.warn(`video-forge: could not write the price cache: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Arm the next refresh: the configured interval after success, a bounded backoff after failure. */
  #schedule(): void {
    if (this.#disposed) return
    this.#clearTimer()
    if (this.#options.url === '') return
    if (this.#options.refreshHours === 0) return
    const delay = this.#failures === 0
      ? this.#options.refreshHours * 3_600_000
      : BACKOFF_MS[Math.min(this.#failures, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 0
    const timer = setTimeout(() => { void this.refresh() }, delay)
    // A pending price refresh must not keep the host process alive.
    timer.unref?.()
    this.#timer = timer
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }
}

/** The provenance line every fetched table carries (DESIGN §21.3, sixth step). */
function describeSource(etag: string | null, fetchedAt: string, rows: number): string {
  const short = etag === null ? 'etag:none' : `etag:${etag.replace(/^W\//, '').replaceAll('"', '').slice(0, 8)}`
  return `litellm main ${short} fetched ${fetchedAt} · international list price ×${FX_CNY_PER_USD} · no video input · ${rows} rows`
}

/** One line for the operator: what failed, in words that separate the causes. */
function describeFailure(error: unknown): string {
  if (error instanceof SyntaxError) return 'not JSON'
  if (error instanceof Error) {
    if (error.message === 'timeout' || error.message.includes('timeout waiting for headers')) return 'timeout'
    if (error.name === 'AbortError') return 'timeout'
    if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|certificate/i.test(error.message)) return 'network error'
    return error.message
  }
  return String(error)
}

/** Absolute path of the cache file inside the plugin's home directory (`$DSH_HOME/dsh-video-forge`). */
export function priceCachePath(pluginHomeDir: string): string {
  return join(pluginHomeDir, PRICE_CACHE_FILE)
}

export type { PriceSourceInfo, PriceSourceKind }
