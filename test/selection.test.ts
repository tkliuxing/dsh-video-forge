/**
 * The per-conversation choice on disk (M6, DESIGN §20).
 *
 * The store is a preference file, so its failure mode has to be "lose a choice",
 * never "block a generation": a missing or unparsable document is an empty store,
 * one unreadable row does not cost the others, and only a read that failed for a
 * real I/O reason refuses writing (overwriting a file we could not read would drop
 * the other conversations' choices).
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSessionId, parseSelectionInput, SelectionError, SelectionStore, sharedSelections } from '../src/selection.ts'

const EMPTY = { provider: null, model: null, durationSeconds: null, resolution: null, aspectRatio: null }

async function storeAt(path?: string, maxSessions?: number): Promise<{ store: SelectionStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'video-forge-selection-'))
  const file = path ?? join(directory, 'selections.json')
  return { store: new SelectionStore(maxSessions === undefined ? { path: file } : { path: file, maxSessions }), path: file }
}

describe('selection store', () => {
  it('round-trips a choice through the file', async () => {
    const { store, path } = await storeAt()
    expect(await store.get('session-a')).toBeNull()
    const saved = await store.set('session-a', { provider: 'ark', model: 'seedance', durationSeconds: 5, resolution: '720p', aspectRatio: '16:9' })
    expect(saved.updatedAt).toMatch(/^\d{4}-/)
    // A second process (a restarted host) reads the same document.
    const reopened = new SelectionStore({ path })
    const back = await reopened.get('session-a')
    expect(back).toEqual(saved)
    const document = JSON.parse(await readFile(path, 'utf8')) as { version: number; sessions: Record<string, unknown> }
    expect(document.version).toBe(1)
    expect(Object.keys(document.sessions)).toEqual(['session-a'])
  })

  it('forgets one conversation without touching the others', async () => {
    const { store } = await storeAt()
    await store.set('session-a', { ...EMPTY, provider: 'ark', model: 'seedance' })
    await store.set('session-b', { ...EMPTY, provider: 'ark', model: 'other' })
    expect(await store.clear('session-a')).toBe(true)
    expect(await store.clear('session-a')).toBe(false)
    expect(await store.get('session-a')).toBeNull()
    expect(await store.get('session-b')).toMatchObject({ model: 'other' })
  })

  it('treats a missing or unparsable document as empty, and writes over the broken one', async () => {
    const { store, path } = await storeAt()
    await writeFile(path, '{ this is not json')
    expect(await store.get('session-a')).toBeNull()
    expect(store.readProblem()).toBeNull()
    await store.set('session-a', { ...EMPTY, resolution: '1080p' })
    expect(await store.get('session-a')).toMatchObject({ resolution: '1080p' })
  })

  it('keeps the rows it can read when one row is not a selection', async () => {
    const { store, path } = await storeAt()
    await writeFile(path, JSON.stringify({
      version: 1,
      sessions: {
        'session-good': { provider: 'ark', model: 'seedance', durationSeconds: null, resolution: null, aspectRatio: null, updatedAt: '2026-10-20T00:00:00.000Z' },
        'session-bad': { provider: 'ark', model: 'seedance', durationSeconds: -1 },
        'session-worse': 'not an object',
      },
    }))
    expect(await store.get('session-good')).toMatchObject({ model: 'seedance' })
    expect(await store.get('session-bad')).toBeNull()
    expect(await store.get('session-worse')).toBeNull()
  })

  it('keeps the newest conversations and drops the oldest past the cap', async () => {
    const { store } = await storeAt(undefined, 2)
    await store.set('old', { ...EMPTY, resolution: '480p' })
    await new Promise(resolve => setTimeout(resolve, 5))
    await store.set('middle', { ...EMPTY, resolution: '720p' })
    await new Promise(resolve => setTimeout(resolve, 5))
    await store.set('new', { ...EMPTY, resolution: '1080p' })
    expect(await store.get('old')).toBeNull()
    expect(await store.get('middle')).toMatchObject({ resolution: '720p' })
    expect(await store.get('new')).toMatchObject({ resolution: '1080p' })
  })

  it('refuses to overwrite a document it could not read, but never blocks reading', async () => {
    // A directory in the place of the file: a real I/O failure, not a missing file.
    const blocked = await mkdtemp(join(tmpdir(), 'video-forge-selection-blocked-'))
    const store = new SelectionStore({ path: blocked })
    expect(await store.get('session-a')).toBeNull()
    expect(store.readProblem()).toMatch(/could not be read/)
    await expect(store.set('session-a', EMPTY)).rejects.toThrowError(/not overwriting it/)
  })

  it('shares one store per file, so two plugin instances cannot overwrite each other', async () => {
    const { path } = await storeAt()
    expect(sharedSelections({ path })).toBe(sharedSelections({ path }))
  })
})

describe('selection input', () => {
  it('trims ids and reads a blank as "not chosen"', () => {
    expect(parseSelectionInput({ provider: '  ark ', model: ' seedance ', resolution: ' ', aspectRatio: null })).toEqual({
      provider: 'ark',
      model: 'seedance',
      durationSeconds: null,
      resolution: null,
      aspectRatio: null,
    })
  })

  it('insists that provider and model travel together', () => {
    expect(() => parseSelectionInput({ model: 'seedance' })).toThrowError(SelectionError)
    expect(() => parseSelectionInput({ model: 'seedance' })).toThrowError(/send provider as well/)
    expect(parseSelectionInput({ provider: 'ark' })).toMatchObject({ provider: 'ark', model: null })
  })

  it('refuses a duration no provider could bill for', () => {
    for (const durationSeconds of [0, -5, 1e9, Number.NaN, '5']) {
      expect(() => parseSelectionInput({ durationSeconds })).toThrowError(/durationSeconds must be a positive number/)
    }
    expect(parseSelectionInput({ durationSeconds: 10 })).toMatchObject({ durationSeconds: 10 })
  })

  it('refuses what is not an object, and ids longer than a real one', () => {
    for (const value of [null, [], 'selection', 7]) {
      expect(() => parseSelectionInput(value)).toThrowError(/must be a JSON object/)
    }
    expect(() => parseSelectionInput({ provider: 'p'.repeat(201) })).toThrowError(/longer than 200 characters/)
  })

  it('accepts a session id the chip could carry, and nothing with whitespace', () => {
    expect(isSessionId('f3b3c0de-1a2b-4c5d-8e9f-0123456789ab')).toBe(true)
    expect(isSessionId('')).toBe(false)
    expect(isSessionId('has space')).toBe(false)
    expect(isSessionId('s'.repeat(201))).toBe(false)
  })
})
