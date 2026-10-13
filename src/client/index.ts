/**
 * Client half: register the browser cards.
 *
 * Two services only, both required:
 * - `locale` carries the card copy (both dictionaries), so no string is
 *   hardcoded in a component.
 * - `slots` registers one keyed `tool.call.toolview` entry per wire tool name.
 *   The key IS the tool name — a typo registers a view nothing dispatches to.
 *
 * The card components never see `ctx`; everything they need arrives as props, so
 * keeping state out of them is a property of the shape, not a discipline.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `SlotMap` / `LocaleNamespaceMap` augmentations for the
// keyed tool slot. A value import of a client UI package is forbidden by the
// bundle purity rule, and is unnecessary here anyway.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { VideoActionRow, VideoGenerateRow, VideoStatusRow } from './cards.tsx'
import { en, zh, type VideoForgeKey } from './locales.ts'

/** Locale namespace owned by this plugin. */
export const NS = 'tool.videoForge'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'tool.videoForge': VideoForgeKey
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'video-forge: dictionaries')

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'video_generate', locale: NS }, VideoGenerateRow))

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'video_status', locale: NS }, VideoStatusRow))

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'video_cancel', locale: NS }, VideoActionRow))

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'video_export', locale: NS }, VideoActionRow))
}
