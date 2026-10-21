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
import { apply, BUNDLE_NAME, NS, SETTINGS_NAMESPACE, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

interface Registration {
  options: Record<string, unknown>
  component: unknown
}

function bench(declared: readonly string[], withConfigForms = true, withSidebar = true): {
  ctx: Context
  registrations: Registration[]
  injections: Map<string, unknown>
  awaits: string[]
  localeRegister: ReturnType<typeof vi.fn>
  effects: string[]
  /** Tab types the panel contributed, in registration order. */
  tabTypes: Record<string, unknown>[]
  /** Document renderer definitions the mp4 previewer contributed. */
  previewDefinitions: Record<string, unknown>[]
  /** Dependency lists a `ctx.inject` asked to wait for. */
  injectRequests: string[][]
  /** What the panel's scan actually asked the Remote for. */
  workspaceFilesCalls: string[]
} {
  const registrations: Registration[] = []
  const injections = new Map<string, unknown>()
  const awaits: string[] = []
  const effects: string[] = []
  const tabTypes: Record<string, unknown>[] = []
  const previewDefinitions: Record<string, unknown>[] = []
  const injectRequests: string[][] = []
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

  const slots = {
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
  }

  /**
   * The right Sidebar's tab registry, as the panel's `ctx.inject` reads it.
   * Its absence is a real deployment shape (no right column), so the bench can
   * take it away.
   */
  const sidebarRightTabs = {
    register: (definition: Record<string, unknown>) => {
      tabTypes.push(definition)
      return () => {}
    },
  }

  /** The workspace-files Remote the panel's scan goes through (service key `remote.workspaceFiles`). */
  const workspaceFilesCalls: string[] = []
  const workspaceFiles = {
    list: async (sessionId: string, path: string) => {
      workspaceFilesCalls.push(`${sessionId}:${path}`)
      return { ok: true, value: { path, entries: [] as { name: string; type: string }[], truncated: false } }
    },
  }

  /** The file viewer's suffix registry, which the mp4 previewer registers into. */
  const documentPreviews = {
    register: (definition: Record<string, unknown>) => {
      previewDefinitions.push(definition)
      return () => {}
    },
  }

  const runEffect = (fn: () => (() => void) | void, label?: string): (() => void) => {
    effects.push(label ?? '')
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  }

  const ctx = {
    get: (name: string) => (withConfigForms && name === 'configForms' ? configForms : undefined),
    inject: (deps: readonly string[], callback: (scope: unknown) => void) => {
      injectRequests.push([...deps])
      if (!withSidebar) return
      callback({
        get: (name: string) => {
          if (name === 'sidebarRightTabs') return sidebarRightTabs
          if (name === 'documentPreviews') return documentPreviews
          if (name === 'remote.workspaceFiles') return workspaceFiles
          return undefined
        },
        effect: runEffect,
        slots,
      })
    },
    remote: { credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => ({ ok: true }), unset: async () => ({ ok: true }) } },
    on: () => () => {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    effect: runEffect,
    locale: { register: vi.fn(() => () => {}), bind: () => echo },
    slots,
  } as unknown as Context

  return {
    ctx,
    registrations,
    injections,
    awaits,
    localeRegister: (ctx.locale as unknown as { register: ReturnType<typeof vi.fn> }).register,
    effects,
    tabTypes,
    previewDefinitions,
    injectRequests,
    workspaceFilesCalls,
  }
}

const ALL_SEATS = [
  'tool.call.toolview',
  'conversation.input.right',
  'main',
  'sidebar.panellist',
  'shell.overlay',
  'plugins.bundle.config',
  'settings.plugins.tab',
  'sidebar.right.pane.tab',
  'sidebar.right.tab.document',
]

describe('client apply', () => {
  it('registers the four tool cards under the shared locale namespace', () => {
    const b = bench(ALL_SEATS)
    apply(b.ctx)

    expect(b.localeRegister).toHaveBeenCalledWith(NS, { zh, en })
    // `remote.credentials` is the official channel for writing a key from the
    // browser; the card is dead weight without it.
    expect(inject).toEqual(['slots', 'locale', 'configForms', 'remote', 'remote.credentials'])

    const keys = b.registrations
      .filter(entry => entry.options['name'] === 'tool.call.toolview')
      .map(entry => entry.options['key'])
      .sort()
    expect(keys).toEqual(['video_cancel', 'video_export', 'video_generate', 'video_status'])
    const cards = b.registrations.filter(entry => entry.options['name'] === 'tool.call.toolview')
    expect(cards.every(entry => entry.options['locale'] === NS)).toBe(true)
    expect(cards.every(entry => typeof entry.component === 'function')).toBe(true)
  })

  it('has no workbench page: nothing in main or the sidebar, and the generate card is given the live store', () => {
    const b = bench(ALL_SEATS)
    apply(b.ctx)
    expect(b.registrations.some(entry => entry.options['name'] === 'main' || entry.options['name'] === 'sidebar.panellist')).toBe(false)
    const generate = b.registrations.find(entry => entry.options['name'] === 'tool.call.toolview' && entry.options['key'] === 'video_generate')
    const injected = (generate?.options['inject'] as () => { liveTasks: { source: unknown; cancel: unknown } })()
    expect(typeof injected.liveTasks.source).toBe('function')
    expect(typeof injected.liveTasks.cancel).toBe('function')
    expect(b.effects).toContain('video-forge: live task store')
  })

  it('puts the conversation\'s video chip in the composer tool row, under this plugin\'s copy', () => {
    const b = bench(ALL_SEATS)
    apply(b.ctx)
    const chip = b.registrations.find(entry => entry.options['name'] === 'conversation.input.right')
    // A fresh id keeps us beside the shipped entries instead of taking one over.
    expect(chip?.options['id']).toBe('video-forge.model')
    expect(chip?.options['locale']).toBe(NS)
    expect(typeof chip?.options['order']).toBe('number')
    expect(typeof chip?.component).toBe('function')
    // One chip, not one per surface: nothing else claims that seat.
    expect(b.registrations.filter(entry => entry.options['name'] === 'conversation.input.right')).toHaveLength(1)
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

  it('contributes the video panel as a right-Sidebar page type, with a guide capsule', () => {
    const b = bench(ALL_SEATS)
    apply(b.ctx)

    // The registry is optional: a deployment without a right column simply has no
    // panel, rather than leaving the whole browser half pending.
    expect(b.injectRequests).toContainEqual(['sidebarRightTabs'])
    const type = b.tabTypes[0]
    expect(type?.['id']).toBe('dsh-video-forge')
    // A fresh kind: reusing a shipped one would take that tab over.
    expect(type?.['kind']).toBe('video-forge-videos')
    expect(type?.['keepMounted']).toBe(true)
    expect((type?.['title'] as () => string)()).toBe('t:panel.title')
    const guide = type?.['guide'] as { id: string; title: () => string; description: () => string }[]
    expect(guide).toHaveLength(1)
    expect((guide[0]?.title())).toBe('t:panel.guideTitle')
    expect((guide[0]?.description())).toBe('t:panel.guideDescription')

    // The body registers under the definition id, which is what the pane
    // dispatches on — not under the kind.
    const body = b.registrations.find(entry => entry.options['name'] === 'sidebar.right.pane.tab')
    expect(body?.options['key']).toBe('dsh-video-forge')
    expect(body?.options['locale']).toBe(NS)
    const injected = (body?.options['inject'] as (sessionId: string) => { loadPanel: unknown })('session-a')
    expect(typeof injected.loadPanel).toBe('function')
  })

  it('adds the mp4 renderer to the file viewer, binary and external on purpose', () => {
    const b = bench(ALL_SEATS)
    apply(b.ctx)

    const definition = b.previewDefinitions[0]
    expect(definition?.['id']).toBe('dsh-video-forge/mp4')
    expect(definition?.['extensions']).toEqual(['mp4'])
    // Without this the owner offers the plain-text body as a second viewer,
    // which then fails on the first NUL byte.
    expect(definition?.['binaryExtensions']).toEqual(['mp4'])
    expect(definition?.['priority']).toBe('extension')
    expect(definition?.['loading']).toBe('renderer')
    expect((definition?.['title'] as () => string)()).toBe('t:preview.title')

    const body = b.registrations.find(entry => entry.options['name'] === 'sidebar.right.tab.document')
    // The dispatch key is the definition id, not the kind.
    expect(body?.options['key']).toBe('dsh-video-forge/mp4')
    expect(body?.options['locale']).toBe(NS)
    expect(typeof body?.component).toBe('function')
  })

  it('hands the panel a loader that scans through the workspace-files Remote', async () => {
    const b = bench(ALL_SEATS)
    apply(b.ctx)
    const body = b.registrations.find(entry => entry.options['name'] === 'sidebar.right.pane.tab')
    const injected = (body?.options['inject'] as (sessionId: string) => { loadPanel: (signal: AbortSignal) => Promise<unknown> })('session-a')
    // The Remote is read inside its own `ctx.inject` — reading it off `ctx.get('remote')`
    // is what crashed the panel in the browser (fixed in ae85152), and this is the
    // regression test for it.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      ok: true, enabled: true, settings: {}, providers: [], tasks: [],
      usage: { tasks: 0, bytes: 0, overTaskLimit: false, overByteLimit: false },
      active: 0, features: { stream: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    try {
      const load = await injected.loadPanel(new AbortController().signal) as { files: unknown[]; stream: boolean }
      expect(load.stream).toBe(true)
      expect(load.files).toEqual([])
      expect(b.workspaceFilesCalls).toEqual(['session-a:renders'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('leaves the panel out when the harness has no tab registry', () => {
    const b = bench(ALL_SEATS, true, false)
    expect(() => { apply(b.ctx) }).not.toThrow()
    expect(b.tabTypes).toEqual([])
    expect(b.previewDefinitions).toEqual([])
    expect(b.registrations.some(entry => entry.options['name'] === 'sidebar.right.pane.tab')).toBe(false)
    // Everything else still mounts.
    expect(b.registrations.some(entry => entry.options['name'] === 'tool.call.toolview')).toBe(true)
  })

  it('survives a harness that declares none of the optional seats', () => {
    const b = bench([])
    expect(() => { apply(b.ctx) }).not.toThrow()
    expect(b.localeRegister).toHaveBeenCalledTimes(1)
  })
})
