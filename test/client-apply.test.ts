/**
 * Client wiring: what `apply` registers, against a recording stub.
 *
 * The registration *option shapes* are checked at compile time against the
 * published `SlotMap` declarations — that is what the type-only imports in
 * `src/client/index.ts` are for — so this file asserts the values and the
 * callbacks, not the types.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, BUNDLE_NAME, NS, PANEL_ID, SETTINGS_NAMESPACE, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

interface Registration {
  options: Record<string, unknown>
  component: unknown
}

function bench(declared: readonly string[], withConfigForms = true): {
  ctx: Context
  registrations: Registration[]
  injections: Map<string, unknown>
  awaits: string[]
  localeRegister: ReturnType<typeof vi.fn>
  effects: string[]
} {
  const registrations: Registration[] = []
  const injections = new Map<string, unknown>()
  const awaits: string[] = []
  const effects: string[] = []
  const echo = (key: string) => `t:${key}`

  const configForms = {
    get: () => ({
      getSnapshot: () => ({ status: 'ready' as const, value: { enabled: true, providers: [] }, writable: true }),
      subscribe: () => () => {},
      mutate: async () => true,
    }),
    whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
      awaits.push(namespaces.join(','))
      return register(new Set(namespaces))
    },
  }

  const ctx = {
    get: (name: string) => (withConfigForms && name === 'configForms' ? configForms : undefined),
    on: () => () => {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn: () => (() => void) | void, label?: string) => {
      effects.push(label ?? '')
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: { register: vi.fn(() => () => {}), bind: () => echo },
    slots: {
      inject: (slot: string, callback: () => unknown) => {
        if (!declared.includes(slot)) return () => {}
        const dispose = callback()
        injections.set(slot, dispose)
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        // The real registry refuses an undeclared seat, and that refusal is the
        // signal the card's seat policy falls back on — so the stub must refuse too.
        if (!declared.includes(String(options['name']))) {
          throw new Error(`slot "${String(options['name'])}" is not declared`)
        }
        registrations.push({ options, component })
        return () => {}
      },
    },
  } as unknown as Context

  return { ctx, registrations, injections, awaits, localeRegister: (ctx.locale as unknown as { register: ReturnType<typeof vi.fn> }).register, effects }
}

const ALL_SEATS = [
  'tool.call.toolview',
  'main',
  'sidebar.panellist',
  'shell.overlay',
  'plugins.bundle.config',
  'settings.plugins.tab',
]

describe('client apply', () => {
  it('registers the four tool cards under the shared locale namespace', () => {
    const b = bench(ALL_SEATS)
    apply(b.ctx)

    expect(b.localeRegister).toHaveBeenCalledWith(NS, { zh, en })
    expect(inject).toEqual(['slots', 'locale', 'configForms'])

    const keys = b.registrations
      .filter(entry => entry.options['name'] === 'tool.call.toolview')
      .map(entry => entry.options['key'])
      .sort()
    expect(keys).toEqual(['video_cancel', 'video_export', 'video_generate', 'video_status'])
    const cards = b.registrations.filter(entry => entry.options['name'] === 'tool.call.toolview')
    expect(cards.every(entry => entry.options['locale'] === NS)).toBe(true)
    expect(cards.every(entry => typeof entry.component === 'function')).toBe(true)
  })

  it('puts the workbench in main and its row in the sidebar under one id', () => {
    const b = bench(ALL_SEATS)
    apply(b.ctx)

    const main = b.registrations.find(entry => entry.options['name'] === 'main')
    const row = b.registrations.find(entry => entry.options['name'] === 'sidebar.panellist')
    expect(main?.options['key']).toBe(PANEL_ID)
    // The shell addresses the panel by the row id, so the two must agree.
    expect(row?.options['id']).toBe(PANEL_ID)
    expect(typeof row?.options['label']).toBe('function')
    // A thunk, so a language switch relabels without re-registering.
    expect((row?.options['label'] as () => string)()).toBe('t:panel.launch')
  })

  it('keeps the floating entry to a badge with no owner props', () => {
    const b = bench(ALL_SEATS)
    apply(b.ctx)
    const overlay = b.registrations.find(entry => entry.options['name'] === 'shell.overlay')
    expect(overlay?.options['id']).toBe('video-forge.badge')
    expect(typeof overlay?.options['label']).toBe('function')
    expect(typeof overlay?.options['inject']).toBe('function')
  })

  it('takes the official configuration seat, keyed by package name, and gates it on the served namespace', () => {
    const b = bench(ALL_SEATS)
    apply(b.ctx)

    const card = b.registrations.find(entry => entry.options['name'] === 'plugins.bundle.config')
    expect(card?.options['key']).toBe(BUNDLE_NAME)
    expect(card?.options['locale']).toBe(NS)
    // The card receives its face through inject, not through ctx.
    expect(typeof card?.options['inject']).toBe('function')
    expect(b.awaits).toContain(SETTINGS_NAMESPACE)
    expect(b.effects.some(label => label.includes('configuration card'))).toBe(true)
  })

  it('falls back to the Settings list when the official seat is undeclared', () => {
    const b = bench(['tool.call.toolview', 'settings.plugins.tab'])
    apply(b.ctx)

    expect(b.registrations.some(entry => entry.options['name'] === 'plugins.bundle.config')).toBe(false)
    const fallback = b.registrations.find(entry => entry.options['name'] === 'settings.plugins.tab')
    expect(fallback?.options['id']).toBe(NS)
    expect((fallback?.options['label'] as () => string)()).toBe('t:config.title')
  })

  it('still registers the card when the harness serves no config forms service', () => {
    const b = bench(['plugins.bundle.config'], false)
    apply(b.ctx)
    // No whileServed gate to wait on, so the card is offered directly rather than
    // silently never appearing.
    expect(b.registrations.some(entry => entry.options['name'] === 'plugins.bundle.config')).toBe(true)
  })

  it('survives a harness that declares none of the optional seats', () => {
    const b = bench([])
    expect(() => { apply(b.ctx) }).not.toThrow()
    expect(b.localeRegister).toHaveBeenCalledTimes(1)
  })
})
