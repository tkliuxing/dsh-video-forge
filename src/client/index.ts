/**
 * Client half: register the browser surfaces.
 *
 * Layout of the seams, each chosen because it is the seat the harness documents
 * for that job:
 *
 * - `tool.call.toolview` (keyed by wire tool name) — one card per tool.
 * - `main` + `sidebar.panellist`, same id — the workbench page and its sidebar
 *   row. This is the shape every shipped panel uses: `main` is the central panel
 *   and the shell owns the button, label and highlight for the row.
 * - `shell.overlay` — a progress badge, which is what that layer is for (badges,
 *   toasts, status pills; no owner props, and its children are clickable).
 * - `plugins.bundle.config` with `settings.plugins.tab` as the fallback — the
 *   configuration card, via `config-card-seat.ts`.
 *
 * `configForms` is how the card reads and writes the plugin's own settings: the
 * harness already owns schema validation, layering and revision fencing, and
 * duplicating that here would mean two sources of truth for one row. It is
 * resolved through `ctx.get` rather than the `ctx.configForms` property because
 * the settings package's cordis Context merge only applies when its types resolve
 * to the same cordis module identity, which an installed plugin cannot assume.
 */

import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Each of these pulls the SlotMap declaration for one seat this plugin occupies:
// without them a `register` call is typed against an incomplete slot map.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the keyed tool-slot declaration. A value import of a client UI
// package is forbidden by the bundle purity rule, and is unnecessary here.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { WorkbenchBadge } from './badge.tsx'
import { WorkbenchIcon } from './icons.tsx'
import { VideoActionRow, VideoGenerateRow, VideoStatusRow } from './cards.tsx'
import { BUNDLE_CONFIG_SEAT, SETTINGS_TAB_SEAT, installConfigCard } from './config-card-seat.ts'
import { en, zh, type VideoForgeKey } from './locales.ts'
import { WorkbenchPage } from './panel.tsx'
import { SettingsCard, type ClientConfigShape, type ConfigFace, type ConfigPatch } from './settings-card.tsx'

/** Locale namespace owned by this plugin. */
export const NS = 'tool.videoForge'

/** Package name: the key the plugin-configuration seat dispatches on. */
export const BUNDLE_NAME = 'dsh-video-forge'

/** Profile row id the bundle patch mounts this plugin under — also its settings namespace. */
export const SETTINGS_NAMESPACE = 'video-forge'

/** Shared id of the workbench `main` page and its `sidebar.panellist` row. */
export const PANEL_ID = 'video-forge.workbench'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'tool.videoForge': VideoForgeKey
  }
}

export const inject = ['slots', 'locale', 'configForms']

/** The slice of the settings form service this plugin uses. */
interface ConfigFormsService {
  get<T>(entryId: string): HostForm<T>
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

interface HostForm<T> {
  getSnapshot(): { status: 'loading' | 'ready' | 'unavailable'; value: T | undefined; writable: boolean }
  subscribe(listener: () => void): () => void
  mutate(ops: readonly ConfigPatch[]): Promise<boolean>
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'video-forge: dictionaries')

  const t = ctx.locale.bind(NS)
  const forms = ctx.get('configForms') as unknown as ConfigFormsService | undefined

  const face: ConfigFace = {
    useConfig: () => useHostConfig(forms),
    save: ops => saveConfig(forms, ops),
  }

  // --- tool cards ---------------------------------------------------------
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'video_generate', locale: NS }, VideoGenerateRow))

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'video_status', locale: NS }, VideoStatusRow))

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'video_cancel', locale: NS }, VideoActionRow))

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'video_export', locale: NS }, VideoActionRow))

  // --- workbench: the central panel plus its sidebar row -------------------
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, WorkbenchPage))

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 40,
      // A thunk: the shell re-reads the label per projection, so a language switch
      // relabels the row without re-registering.
      label: () => t('panel.launch'),
      locale: NS,
    }, WorkbenchIcon))

  // --- ambient progress badge ---------------------------------------------
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'video-forge.badge', order: 90, label: () => t('panel.active', { count: 0 }), locale: NS, inject: () => ({}) }, WorkbenchBadge))

  // --- configuration card, in the seat this harness renders ---------------
  const install = (): (() => void) => installConfigCard(ctx, {
    official: () => ctx.slots.register(
      { name: BUNDLE_CONFIG_SEAT, key: BUNDLE_NAME, locale: NS, inject: () => face },
      SettingsCard,
    ),
    settingsTab: () => ctx.slots.register(
      { name: SETTINGS_TAB_SEAT, id: NS, order: 30, label: () => t('config.title'), locale: NS, inject: () => face },
      SettingsCard,
    ),
    onRefused: (seat, error) => {
      ctx.logger.debug(`video-forge: the ${seat} seat is not declared here (${String(error)})`)
    },
  })

  // Only offer the card once this plugin's settings namespace is actually served:
  // a card for a row the harness does not expose would edit nothing.
  if (forms !== undefined && typeof forms.whileServed === 'function') {
    ctx.effect(() => forms.whileServed([SETTINGS_NAMESPACE], () => install()), 'video-forge: configuration card seat')
  } else {
    ctx.effect(() => install(), 'video-forge: configuration card seat')
  }
}

/**
 * Reactive read of the host form.
 *
 * `getSnapshot()` returns a fresh object per call, so it is sampled through
 * `useState` plus a subscription rather than handed to `useSyncExternalStore`,
 * which would re-render forever on an ever-new reference.
 */
function useHostConfig(forms: ConfigFormsService | undefined): ReturnType<ConfigFace['useConfig']> {
  const [snapshot, setSnapshot] = useState<{ status: 'loading' | 'ready' | 'unavailable'; value: ClientConfigShape | undefined; writable: boolean }>(
    () => forms?.get<ClientConfigShape>(SETTINGS_NAMESPACE).getSnapshot() ?? { status: 'unavailable', value: undefined, writable: false },
  )
  useEffect(() => {
    const form = forms?.get<ClientConfigShape>(SETTINGS_NAMESPACE)
    if (form === undefined) return undefined
    setSnapshot(form.getSnapshot())
    return form.subscribe(() => { setSnapshot(form.getSnapshot()) })
  }, [forms])
  return snapshot
}

async function saveConfig(forms: ConfigFormsService | undefined, ops: readonly ConfigPatch[]): Promise<boolean> {
  const form = forms?.get<ClientConfigShape>(SETTINGS_NAMESPACE)
  if (form === undefined) return false
  try {
    // A refusal resolves false; a transport failure rejects. Both are "not saved".
    return await form.mutate(ops)
  } catch {
    return false
  }
}
