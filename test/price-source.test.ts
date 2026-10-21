import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PriceSource, priceSourceUrlProblem, type PriceFetch, type PriceFetchResponse } from '../src/price-source.ts'
import { DEFAULT_PRICE_TABLE, unitPrice, type PriceTable } from '../src/prices.ts'

const FEED_TEXT = readFileSync(new URL('../fixtures/litellm-video-sample.json', import.meta.url), 'utf8')
const URL_UNDER_TEST = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

/** A response in the shape the fetch adapter needs. */
function response(status: number, body = '', headers: Record<string, string> = {}): PriceFetchResponse {
  return {
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  }
}

/** A feed response: the frozen sample, with the `ETag` raw GitHub returns. */
function feed(etag = 'W/"d3ac34409c76b4377b3a6c858afb68432ec656cf44a56ed893685c208e0af02a"'): PriceFetchResponse {
  return response(200, FEED_TEXT, { etag })
}

/** A fetch that answers from a script and records what it was asked. */
function scripted(answers: (PriceFetchResponse | Error)[]): { fetch: PriceFetch; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch: PriceFetch = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
    if (answer === undefined) throw new Error('no scripted answer')
    if (answer instanceof Error) throw answer
    return answer
  }
  return { fetch, calls }
}

/** A price table with no rows: what a test passes when it only looks at the layers. */
const EMPTY_USER: PriceTable = { currency: 'CNY', pricedAt: '', source: '', rows: [] }

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  // A refresh launched by a timer may still be finishing its cache write when the
  // test ends; the retry keeps the cleanup from racing it.
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })))
})

async function tempPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'video-forge-prices-'))
  roots.push(root)
  return join(root, 'price-cache.json')
}

function sourceFor(path: string, over: Partial<ConstructorParameters<typeof PriceSource>[0]> = {}): PriceSource {
  return new PriceSource({
    path,
    url: URL_UNDER_TEST,
    refreshHours: 24,
    ...over,
  })
}

describe('PriceSource', () => {
  it('serves the built-in snapshot before anything is fetched, and says so', async () => {
    const { fetch } = scripted([feed()])
    const source = sourceFor(await tempPath(), { fetch })
    const { table, info } = source.effective(EMPTY_USER)
    expect(info.kind).toBe('bundled')
    expect(info.note).toContain('built-in snapshot')
    expect(info.url).toBe(URL_UNDER_TEST)
    expect(table.rows).toEqual(DEFAULT_PRICE_TABLE.rows)
    expect(info.ageDays).toBeNull()
    source.dispose()
  })

  it('installs a fetched table, writes the cache, and names the upstream version', async () => {
    const path = await tempPath()
    const { fetch, calls } = scripted([feed()])
    const source = sourceFor(path, { fetch })
    await source.refresh()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers['if-none-match']).toBeUndefined()
    const { table, info } = source.effective(EMPTY_USER)
    expect(info.kind).toBe('remote')
    expect(info.ageDays).toBe(0)
    expect(info.lastError).toBeNull()
    expect(info.fetchedAt).not.toBeNull()
    expect(table.source).toContain('etag:d3ac3440')
    expect(unitPrice(table, 'ark', 'doubao-seedance-2-5-260628', 'token', '1080p')).toBe(0.000077)

    const cached = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(cached['version']).toBe(1)
    expect(cached['url']).toBe(URL_UNDER_TEST)
    expect(cached['etag']).toBe('W/"d3ac34409c76b4377b3a6c858afb68432ec656cf44a56ed893685c208e0af02a"')
    source.dispose()
  })

  it('reads that cache back on a restart, so the first question after a boot has prices', async () => {
    const path = await tempPath()
    const first = sourceFor(path, { fetch: scripted([feed()]).fetch, now: () => Date.parse('2026-10-01T00:00:00Z') })
    await first.refresh()
    first.dispose()

    const { fetch } = scripted([feed()])
    const again = sourceFor(path, { fetch, now: () => Date.parse('2026-10-04T12:00:00Z') })
    again.loadCacheSync()
    const { info } = again.effective(EMPTY_USER)
    expect(info.kind).toBe('cache')
    expect(info.ageDays).toBe(3)
    expect(info.note).toBeNull()
    again.dispose()
  })

  it('sends a conditional request and treats 304 as "the table is still current"', async () => {
    const path = await tempPath()
    const fetch = scripted([feed(), response(304)])
    const source = sourceFor(path, { fetch: fetch.fetch, now: () => Date.parse('2026-10-01T00:00:00Z') })
    await source.refresh()
    const before = source.effective(EMPTY_USER)

    await source.refresh()
    expect(fetch.calls[1]!.headers['if-none-match']).toBe('W/"d3ac34409c76b4377b3a6c858afb68432ec656cf44a56ed893685c208e0af02a"')
    expect(source.notModified).toBe(1)
    const after = source.effective(EMPTY_USER)
    expect(after.info.kind).toBe('remote')
    expect(after.table.rows).toEqual(before.table.rows)
    source.dispose()
  })

  it('keeps the previous table when a refresh fails, and says why', async () => {
    const path = await tempPath()
    const { fetch } = scripted([feed(), response(503)])
    const source = sourceFor(path, { fetch })
    await source.refresh()
    await source.refresh()
    const { table, info } = source.effective(EMPTY_USER)
    expect(info.lastError).toBe('HTTP 503')
    expect(info.kind).toBe('remote')
    expect(table.rows.length).toBeGreaterThan(0)
    source.dispose()
  })

  it('falls back to the built-in snapshot on the first failure, and never throws', async () => {
    const { fetch } = scripted([new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com')])
    const source = sourceFor(await tempPath(), { fetch })
    await expect(source.refresh()).resolves.toBeUndefined()
    const { info } = source.effective(EMPTY_USER)
    expect(info.kind).toBe('bundled')
    expect(info.lastError).toBe('network error')
    source.dispose()
  })

  it('distinguishes a body that is not JSON from a network failure', async () => {
    const { fetch } = scripted([response(200, '<html>rate limited</html>')])
    const source = sourceFor(await tempPath(), { fetch })
    await source.refresh()
    expect(source.lastError).toBe('not JSON')
    source.dispose()
  })

  it('refuses a cross-host redirect instead of following this feed somewhere else', async () => {
    const { fetch } = scripted([response(302, '', { location: 'https://evil.example/prices.json' })])
    const source = sourceFor(await tempPath(), { fetch })
    await source.refresh()
    expect(source.lastError).toContain('cross-host redirect refused')
    source.dispose()
  })

  it('refuses an oversize body', async () => {
    const { fetch } = scripted([feed(), response(200, 'x'.repeat(8_000_001))])
    const source = sourceFor(await tempPath(), { fetch })
    await source.refresh()
    await source.refresh()
    expect(source.lastError).toContain('body too large')
    source.dispose()
  })

  it('refuses a feed that prices none of the configured models', async () => {
    const { fetch } = scripted([feed()])
    const source = sourceFor(await tempPath(), { fetch, configuredModelIds: () => ['my-relay-model'] })
    await source.refresh()
    expect(source.lastError).toBe('0 rows matched the configured models')
    expect(source.effective(EMPTY_USER).info.kind).toBe('bundled')
    source.dispose()
  })

  it('treats a corrupt cache as "no cache", leaves the file for diagnosis, and does not throw', async () => {
    const path = await tempPath()
    await writeFile(path, '{ not json', 'utf8')
    const { fetch } = scripted([feed()])
    const source = sourceFor(path, { fetch })
    source.loadCacheSync()
    const { info } = source.effective(EMPTY_USER)
    expect(info.kind).toBe('bundled')
    expect(info.lastError).toContain('cache corrupt')
    expect(await readFile(path, 'utf8')).toBe('{ not json')
    source.dispose()
  })

  it('ignores a cache written for a different feed', async () => {
    const path = await tempPath()
    const first = sourceFor(path, { fetch: scripted([feed()]).fetch })
    await first.refresh()
    first.dispose()

    const moved = sourceFor(path, { url: 'https://example.invalid/other.json', fetch: scripted([feed()]).fetch })
    moved.loadCacheSync()
    expect(moved.effective(EMPTY_USER).info.kind).toBe('bundled')
    moved.dispose()
  })

  it('prices nothing, and fetches nothing, when the remote source is turned off', async () => {
    const { fetch, calls } = scripted([feed()])
    const source = sourceFor(await tempPath(), { url: '', fetch })
    source.start()
    await source.refresh()
    const { table, info } = source.effective(EMPTY_USER)
    expect(calls).toHaveLength(0)
    expect(info.kind).toBe('none')
    expect(info.url).toBeNull()
    expect(info.note).toContain('no price source')
    expect(table.rows).toHaveLength(0)
    // An operator row still prices, even with no feed at all.
    const own: PriceTable = { currency: 'CNY', pricedAt: '2026-10-21', source: '', rows: [{ providerId: 'ark', modelId: 'm', unit: 'token', pricePerUnit: 0.00007 }] }
    expect(unitPrice(source.effective(own).table, 'ark', 'm', 'token')).toBe(0.00007)
    source.dispose()
  })

  it('lets an operator row win over the fetched one for the same provider and model', async () => {
    const source = sourceFor(await tempPath(), { fetch: scripted([feed()]).fetch })
    await source.refresh()
    const own: PriceTable = {
      currency: 'CNY',
      pricedAt: '2026-10-21',
      source: 'my relay',
      rows: [{ providerId: 'relay', modelId: 'MiniMax-H3', unit: 'second', resolution: '2K', pricePerUnit: 0.6 }],
    }
    const { table, info } = source.effective(own)
    expect(unitPrice(table, 'relay', 'MiniMax-H3', 'second', '2K')).toBe(0.6)
    // The fetched row still answers for another provider naming the same model.
    expect(unitPrice(table, 'minimax', 'MiniMax-H3', 'second', '2K')).toBe(0.91)
    expect(table.source).toContain('1 operator row(s)')
    expect(info.kind).toBe('remote')
    source.dispose()
  })

  it('marks a cache older than a week as old', async () => {
    const path = await tempPath()
    const first = sourceFor(path, { fetch: scripted([feed()]).fetch, now: () => Date.parse('2026-10-01T00:00:00Z') })
    await first.refresh()
    first.dispose()

    const later = sourceFor(path, { fetch: scripted([new Error('ETIMEDOUT')]).fetch, now: () => Date.parse('2026-10-21T00:00:00Z') })
    later.loadCacheSync()
    // Every refresh fails, so the cache is all there is — and it is kept.
    await later.refresh()
    const { info } = later.effective(EMPTY_USER)
    expect(info.kind).toBe('cache')
    expect(info.ageDays).toBe(20)
    expect(info.note).toContain('20 days old')
    expect(info.lastError).toBe('network error')
    later.dispose()
  })

  it('refuses a configured URL that carries credentials, without fetching it', async () => {
    const { fetch, calls } = scripted([feed()])
    const source = sourceFor(await tempPath(), { url: 'https://user:pass@example.com/prices.json', fetch })
    await source.refresh()
    expect(calls).toHaveLength(0)
    expect(source.lastError).toContain('credentials')
    source.dispose()
  })

  it('retries a failure on a short backoff, so a corrected URL shows a result quickly', async () => {
    vi.useFakeTimers()
    const { fetch, calls } = scripted([response(500), feed()])
    const source = sourceFor(await tempPath(), { fetch })
    await source.refresh()
    expect(calls).toHaveLength(1)
    // Failure is followed by the 5-minute step of the backoff ladder, not a day.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(calls).toHaveLength(2)
    expect(source.effective(EMPTY_USER).info.kind).toBe('remote')
    source.dispose()
  })
})

describe('priceSourceUrlProblem', () => {
  it('accepts the default feed and other plain https URLs', () => {
    expect(priceSourceUrlProblem(URL_UNDER_TEST)).toBeNull()
    expect(priceSourceUrlProblem('https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json')).toBeNull()
  })

  it('refuses what is not a URL, a non-http scheme, or anything carrying a credential', () => {
    expect(priceSourceUrlProblem('not a url')).toBe('priceSourceUrl is not a URL')
    expect(priceSourceUrlProblem('file:///etc/passwd')).toBe('priceSourceUrl must be http or https')
    expect(priceSourceUrlProblem('https://user:pass@example.com/p.json')).toBe('priceSourceUrl carries credentials')
    expect(priceSourceUrlProblem('https://example.com/p.json?token=abc')).toBe('priceSourceUrl carries what looks like a credential')
  })
})
