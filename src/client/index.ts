/**
 * Client half: register the browser surfaces.
 *
 * Layout of the seams, each chosen because it is the seat the harness documents
 * for that job:
 *
 * - `tool.call.toolview` (keyed by wire tool name) — one card per tool. The
 *   generate card is the working surface (DESIGN §16.4): it is injected the
 *   plugin's live task store, so it follows its task after the result froze —
 *   progress, the finished player, where the video is, and cancel. There is no
 *   separate workbench page: the conversation is where videos are made.
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
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the keyed tool-slot declaration. A value import of a client UI
// package is forbidden by the bundle purity rule, and is unnecessary here.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// The right Sidebar's tab-type registry and its pane seats are declared by this
// package; the type import is what makes `register` calls below typecheck.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { ProgressBadge } from './badge.tsx'
import { VideoActionRow, VideoGenerateRow, VideoStatusRow } from './cards.tsx'
import { BUNDLE_CONFIG_SEAT, SETTINGS_TAB_SEAT, installConfigCard } from './config-card-seat.ts'
import { createLiveTasks } from './live-tasks.ts'
import { loadPanel, type WorkspaceFilesRemoteLike } from './panel-data.ts'
import { en, zh, type VideoForgeKey } from './locales.ts'
import { VideoPanel } from './video-panel.tsx'
import { VIDEO_PREVIEW_EXTENSIONS, VIDEO_PREVIEW_ID, VideoPreview } from './video-preview.tsx'
import {
  SettingsCard,
  type ClientConfigShape,
  type ConfigFace,
  type ConfigPatch,
  type CredentialState,
} from './settings-card.tsx'

/** Locale namespace owned by this plugin. */
export const NS = 'tool.videoForge'

/** Package name: the key the plugin-configuration seat dispatches on. */
export const BUNDLE_NAME = 'dsh-video-forge'

/** Profile row id the bundle patch mounts this plugin under — also its settings namespace. */
export const SETTINGS_NAMESPACE = 'video-forge'

/**
 * The video panel's identity in the tab system (M5): its `kind` is a new one, so
 * nothing shipped is taken over, and the same string is the key its body
 * registers under — the Sidebar dispatches on the definition id.
 */
export const VIDEO_PANEL_KIND = 'video-forge-videos'
export const VIDEO_PANEL_ID = 'dsh-video-forge'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'tool.videoForge': VideoForgeKey
  }
}

export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

/**
 * The credential Remote namespace, as this plugin needs it.
 *
 * Declared structurally: the generated remote contribution belongs to the
 * settings-controller package, and an installed plugin cannot assume its types
 * resolve to the same module identity as the host's. Every method that reads a
 * credential returns state only — the seam has no method that returns a value.
 */
interface CredentialRemote {
  describe(refs: readonly string[]): Promise<unknown>
  set(ref: string, value: string): Promise<unknown>
  unset(ref: string): Promise<unknown>
}

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
  installVideoPanel(ctx, t)
  installVideoPreview(ctx, t)
  const forms = ctx.get('configForms') as unknown as ConfigFormsService | undefined

  const credentials = (): CredentialRemote | undefined => {
    const remote = ctx.get('remote') as unknown as { credentials?: CredentialRemote } | undefined
    const direct = remote?.credentials
    return direct !== undefined && typeof direct.describe === 'function' ? direct : undefined
  }

  const face: ConfigFace = {
    useConfig: () => useHostConfig(forms),
    save: ops => saveConfig(forms, ops),
    describeCredential: ref => describeCredential(credentials(), ref),
    setCredential: (ref, value) => writeCredential(credentials(), ref, value, 'set'),
    unsetCredential: ref => writeCredential(credentials(), ref, '', 'unset'),
  }

  // --- tool cards ---------------------------------------------------------
  // One live store for every generate card in this window; polling is per task
  // and only while a card for it is mounted.
  const liveTasks = createLiveTasks()
  ctx.effect(() => () => { liveTasks.dispose() }, 'video-forge: live task store')
  /** Open the video panel. Absent when the deployment has no right Sidebar. */
  const openPanel = (): void => {
    const right = ctx.get('sidebarRight') as unknown as { openTab?: (kind: string) => void } | undefined
    try {
      right?.openTab?.(VIDEO_PANEL_KIND)
    } catch (error: unknown) {
      // `openTab` throws when nothing is on screen or no type claims the kind.
      // A button that does nothing is better than one that takes the pane down,
      // and the state is transient (the Session is being switched).
      ctx.logger.debug(`video-forge: the video panel could not be opened (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'video_generate',
      locale: NS,
      inject: () => ({ liveTasks, openPanel }),
    }, VideoGenerateRow))

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'video_status',
      locale: NS,
      inject: () => ({ openPanel }),
    }, VideoStatusRow))

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'video_cancel', locale: NS }, VideoActionRow))

  // The tool is gone (M3.3), but conversations that called it still render.
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'video_export', locale: NS }, VideoActionRow))

  // --- ambient progress badge ---------------------------------------------
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'video-forge.badge', order: 90, label: () => t('panel.active', { count: 0 }), locale: NS, inject: () => ({}) }, ProgressBadge))

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
 * The tab-type registry, as this plugin needs it.
 *
 * Structural on purpose: another package's Context augmentation only applies when
 * cordis resolves to the same module identity, which an installed plugin cannot
 * assume — the same reason the host form and credential services are read through
 * `ctx.get` here.
 */
interface SidebarRightTabsLike {
  register(definition: {
    id: string
    kind: string
    keepMounted?: boolean
    title: () => string
    guide?: readonly { id: string; order: number; title: () => string; description?: () => string }[]
  }): () => void
}

/**
 * Mount the video panel (M5): a right-Sidebar page type plus its body.
 *
 * The whole thing hangs off `sidebarRightTabs`, so it is registered through
 * `ctx.inject` rather than the module's `inject` array: a deployment without the
 * right Sidebar keeps the tool cards and the configuration card and simply has no
 * panel, while a hard dependency would leave the browser half's entry audit
 * pending and fail the whole web boot. The type is discovered in the pane's own
 * guide page — that is the only zero-code entry the Sidebar offers, because its
 * "+" opens the guide and there is no plugin-extensible tab menu.
 *
 * @param ctx - the client context.
 * @param t - the plugin's namespace-bound translate, read on every projection.
 */
function installVideoPanel(ctx: Context, t: (key: VideoForgeKey, params?: Record<string, unknown>) => string): void {
  const remote = (): WorkspaceFilesRemoteLike | undefined => {
    const aggregate = ctx.get('remote') as unknown as { workspaceFiles?: WorkspaceFilesRemoteLike } | undefined
    return aggregate?.workspaceFiles
  }
  ctx.inject(['sidebarRightTabs'], (scope) => {
    const tabs = scope.get('sidebarRightTabs') as unknown as SidebarRightTabsLike | undefined
    if (tabs === undefined || typeof tabs.register !== 'function') return
    scope.effect(() => tabs.register({
      id: VIDEO_PANEL_ID,
      kind: VIDEO_PANEL_KIND,
      // A hidden panel keeps its selection, and the video it was playing; the
      // poll stops by itself because the body reads `tab.visible`.
      keepMounted: true,
      title: () => t('panel.title'),
      guide: [{
        id: 'videos',
        order: 40,
        title: () => t('panel.guideTitle'),
        description: () => t('panel.guideDescription'),
      }],
    }), 'video-forge: video panel tab type')
    scope.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: VIDEO_PANEL_ID,
        locale: NS,
        inject: (sessionId: string) => ({
          loadPanel: (signal: AbortSignal) => loadPanel({ sessionId, remote: remote() }, signal),
        }),
      },
      VideoPanel,
    )), 'video-forge: video panel body')
  })
}

/** The document preview registry, as this plugin needs it (see `installVideoPreview`). */
interface DocumentPreviewsLike {
  register(definition: {
    id: string
    extensions: readonly string[]
    binaryExtensions?: readonly string[]
    priority?: 'builtin' | 'extension'
    title: () => string
    loading: 'text-pages' | 'bytes-complete' | 'renderer'
    wrap?: boolean
  }): () => void
}

/**
 * Mount the mp4 renderer into the harness's file viewer (M5).
 *
 * Two registrations, both keyed by the same id: the definition tells the suffix
 * registry which files this implementation claims, and the keyed body draws one.
 * `binaryExtensions` is not optional in spirit — without it the owner appends its
 * plain-text body as a *second* viewer for the same file, which then fails on the
 * first NUL byte.
 *
 * The registry service is optional: a deployment without the document preview has
 * no file viewer to add to, and an mp4 opens there as "not previewable" exactly as
 * before. `ctx.inject` waits for the service instead of probing once at apply
 * time, which would lose the race against a plugin that loads after this one.
 *
 * @param ctx - the client context.
 * @param t - the plugin's translate, read when the viewer's menu is drawn.
 */
function installVideoPreview(ctx: Context, t: (key: VideoForgeKey, params?: Record<string, unknown>) => string): void {
  ctx.inject(['documentPreviews'], (scope) => {
    const previews = scope.get('documentPreviews') as unknown as DocumentPreviewsLike | undefined
    if (previews === undefined || typeof previews.register !== 'function') return
    scope.effect(() => previews.register({
      id: VIDEO_PREVIEW_ID,
      extensions: [...VIDEO_PREVIEW_EXTENSIONS],
      binaryExtensions: [...VIDEO_PREVIEW_EXTENSIONS],
      // The band that outranks a builtin for the same suffix; `extension` is also
      // what the registry documents as the default for a type from outside.
      priority: 'extension',
      title: () => t('preview.title'),
      loading: 'renderer',
      wrap: false,
    }), 'video-forge: mp4 document renderer')
    scope.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
      name: 'sidebar.right.tab.document',
      key: VIDEO_PREVIEW_ID,
      locale: NS,
    }, VideoPreview)), 'video-forge: mp4 document body')
  })
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

/**
 * Read one credential's state from the host.
 *
 * A missing service is reported as "unavailable" rather than as "not configured":
 * those are different facts, and conflating them would tell the operator to set a
 * key that may already exist.
 */
async function describeCredential(remote: CredentialRemote | undefined, ref: string): Promise<CredentialState> {
  if (remote === undefined) {
    return { configured: false, source: null, writable: false, error: 'the host credential service is not loaded' }
  }
  try {
    const response = unwrap<Record<string, { configured?: boolean; source?: string; writable?: boolean }>>(
      await remote.describe([ref]),
    )
    if (!response.ok) return { configured: false, source: null, writable: true, error: response.error }
    const view = response.value?.[ref]
    return {
      configured: view?.configured === true,
      source: typeof view?.source === 'string' ? view.source : null,
      // An unknown reference is treated as writable: the host is what refuses, and
      // guessing a refusal here would disable a control that works.
      writable: view?.writable !== false,
      error: null,
    }
  } catch (error: unknown) {
    return { configured: false, source: null, writable: true, error: messageOf(error) }
  }
}

/** Store or remove one secret. Resolves null on success, else a message to show. */
async function writeCredential(
  remote: CredentialRemote | undefined,
  ref: string,
  value: string,
  action: 'set' | 'unset',
): Promise<string | null> {
  if (remote === undefined) return 'the host credential service is not loaded'
  try {
    const response = action === 'set' ? await remote.set(ref, value) : await remote.unset(ref)
    const result = unwrap<unknown>(response)
    return result.ok ? null : result.error
  } catch (error: unknown) {
    // A refusal arrives as a RemoteError; its message is the seam's own wording and
    // is more useful than anything this side could invent.
    return messageOf(error)
  }
}

/** Accept either a result envelope or a bare value, which is what remotes vary on. */
function unwrap<T>(response: unknown): { ok: true; value: T } | { ok: false; error: string } {
  if (typeof response === 'object' && response !== null && 'ok' in response) {
    const envelope = response as { ok: unknown; value?: unknown; error?: unknown }
    if (envelope.ok === true) return { ok: true, value: envelope.value as T }
    return { ok: false, error: messageOf(envelope.error) }
  }
  return { ok: true, value: response as T }
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  if (error instanceof Error) return error.message
  return String(error)
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
