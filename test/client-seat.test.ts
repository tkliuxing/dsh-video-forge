/**
 * The configuration-card seat policy.
 *
 * Exercised against a fake registry that reproduces exactly the three behaviours
 * the policy depends on: `register` **throws** for an undeclared seat,
 * `slots/changed` fires **synchronously** from inside `register` and from a
 * disposer, and entries are keyed by name plus id/key. The policy holds no
 * component and no client SDK import, which is what makes this possible.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  BUNDLE_CONFIG_SEAT,
  SETTINGS_TAB_SEAT,
  installConfigCard,
  type SeatHost,
} from '../src/client/config-card-seat.ts'

interface Entry {
  options: Record<string, unknown>
  dispose: () => void
}

/** The registry double is deliberately richer than the policy's own view of it. */
interface FakeSlots {
  register(options: Record<string, unknown>, component: unknown): () => void
  inject(key: string, callback: () => () => void): () => void
}

/** A registry double with the three behaviours the policy relies on. */
function fakeHost(declaredSeats: readonly string[]): {
  host: SeatHost
  slots: FakeSlots
  entries: Map<string, Entry>
  declare(seat: string): void
  changed: () => number
} {
  const declared = new Set(declaredSeats)
  const entries = new Map<string, Entry>()
  const listeners = new Set<(key: string) => void>()
  let changes = 0

  const keyOf = (options: Record<string, unknown>): string =>
    `${String(options['name'])}\u0000${String(options['key'] ?? options['id'])}`

  const emit = (key: string): void => {
    changes += 1
    for (const listener of [...listeners]) listener(key)
  }

  const slots: FakeSlots = {
    register(options: Record<string, unknown>, component: unknown): () => void {
          if (!declared.has(String(options['name']))) {
            throw new Error(`slot "${String(options['name'])}" is not declared`)
          }
          const id = keyOf(options)
          if (entries.has(id)) throw new Error(`slot "${String(options['name'])}" already has an entry for key "${String(options['key'] ?? options['id'])}"`)
          let live = true
          const dispose = (): void => {
            if (!live) return
            live = false
            entries.delete(id)
            emit(String(options['name']))
          }
      entries.set(id, { options, dispose })
      void component
      emit(String(options['name']))
      return dispose
    },
    inject(_key: string, callback: () => () => void): () => void {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }

  const host = {
    slots,
    on(_event: 'slots/changed', listener: (key: string) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as unknown as SeatHost

  return {
    host,
    slots,
    entries,
    declare: (seat: string) => { declared.add(seat); emit(seat) },
    changed: () => changes,
  }
}

describe('config card seat policy', () => {
  it('takes the official seat when the harness declares it', () => {
    const fake = fakeHost([BUNDLE_CONFIG_SEAT])
    const stop = installConfigCard(fake.host, {
      official: () => fake.slots.register({ name: BUNDLE_CONFIG_SEAT, key: 'dsh-video-forge' }, null),
      settingsTab: () => fake.slots.register({ name: SETTINGS_TAB_SEAT, id: 'video-forge' }, null),
    })
    expect([...fake.entries.keys()]).toEqual([`${BUNDLE_CONFIG_SEAT}\u0000dsh-video-forge`])
    stop()
    expect(fake.entries.size).toBe(0)
  })

  it('falls back to the Settings list when the official seat is absent, and migrates later', () => {
    const fake = fakeHost([SETTINGS_TAB_SEAT])
    const refused = vi.fn()
    const stop = installConfigCard(fake.host, {
      official: () => fake.slots.register({ name: BUNDLE_CONFIG_SEAT, key: 'dsh-video-forge' }, null),
      settingsTab: () => fake.slots.register({ name: SETTINGS_TAB_SEAT, id: 'video-forge' }, null),
      onRefused: refused,
    })

    // Occupies the fallback only, and says why once instead of on every retry.
    expect([...fake.entries.keys()]).toEqual([`${SETTINGS_TAB_SEAT}\u0000video-forge`])
    expect(refused).toHaveBeenCalledTimes(1)
    expect(refused.mock.calls[0]?.[0]).toBe(BUNDLE_CONFIG_SEAT)

    // The official seat appears later: the card moves, and never sits in both.
    fake.declare(BUNDLE_CONFIG_SEAT)
    expect([...fake.entries.keys()]).toEqual([`${BUNDLE_CONFIG_SEAT}\u0000dsh-video-forge`])
    expect(refused).toHaveBeenCalledTimes(1)

    stop()
    expect(fake.entries.size).toBe(0)
  })

  it('does not double-register while the registry is emitting change events', () => {
    // Re-entrancy is the failure this guards: `slots/changed` fires from inside
    // register, so an unguarded reconcile would register into the seat it is
    // leaving and throw "already has an entry for key".
    const fake = fakeHost([SETTINGS_TAB_SEAT])
    const stop = installConfigCard(fake.host, {
      official: () => fake.slots.register({ name: BUNDLE_CONFIG_SEAT, key: 'dsh-video-forge' }, null),
      settingsTab: () => fake.slots.register({ name: SETTINGS_TAB_SEAT, id: 'video-forge' }, null),
    })
    expect(() => { fake.declare(BUNDLE_CONFIG_SEAT) }).not.toThrow()
    expect(fake.entries.size).toBe(1)
    expect(fake.changed()).toBeGreaterThan(0)
    stop()
  })

  it('reports each refusal once and keeps working when both seats are absent', () => {
    const fake = fakeHost([])
    const stop = installConfigCard(fake.host, {
      official: () => fake.slots.register({ name: BUNDLE_CONFIG_SEAT, key: 'dsh-video-forge' }, null),
      settingsTab: () => fake.slots.register({ name: SETTINGS_TAB_SEAT, id: 'video-forge' }, null),
    })
    expect(fake.entries.size).toBe(0)
    expect(() => { stop() }).not.toThrow()
  })

  it('stops reconciling after disposal', () => {
    const fake = fakeHost([])
    const stop = installConfigCard(fake.host, {
      official: () => fake.slots.register({ name: BUNDLE_CONFIG_SEAT, key: 'dsh-video-forge' }, null),
      settingsTab: () => fake.slots.register({ name: SETTINGS_TAB_SEAT, id: 'video-forge' }, null),
    })
    stop()
    fake.declare(BUNDLE_CONFIG_SEAT)
    expect(fake.entries.size).toBe(0)
  })
})
