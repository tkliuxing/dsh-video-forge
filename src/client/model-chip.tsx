/**
 * The composer chip (M6, DESIGN §20): the one control in the composer's tool row
 * that says which video model *this conversation* generates with, and with which
 * length, resolution and aspect ratio.
 *
 * Why a chip and not a settings field: the choice is per conversation. A new
 * conversation starts on `video-project.yaml` and the plugin settings, so a
 * choice made for one film does not silently follow the next one — and the tool
 * result names whatever the chip supplied, because a default nobody mentions is
 * how a 10-second shot quietly becomes 5 seconds.
 *
 * The seat (`conversation.input.right`) is a plain list entry, so an older host
 * without it never calls this and the argument → manifest → settings chain
 * stands unchanged. The control stays honest in the other direction too: a model
 * that has left the settings is shown as unavailable rather than swapped out,
 * and picking another model drops the parameters it does not declare and says
 * which ones.
 *
 * It owns no stylesheet framework: the popover is plain DOM with the `popover`
 * attribute (top layer, so the composer cannot clip it), and the styles are one
 * inline sheet in the plugin's own class prefix using the theme tokens.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Pulls the `conversation.input.right` declaration into this plugin's slot map.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type Translate } from './locales.ts'
import {
  clearChipSelection,
  fetchChip,
  saveChipSelection,
  type ChipOverview,
  type ChipSelection,
} from './panel-api.ts'
import {
  EMPTY_CHIP_SELECTION,
  PARAM_KEYS,
  chipLabel,
  geometrySummary,
  keyMissing,
  modelOptions,
  paramLabel,
  paramText,
  paramValues,
  pruneSelection,
  settingsTarget,
  targetOf,
  type ModelOption,
  type ParamKey,
  type ParamValue,
} from './model-chip.ts'

/** Props the chip is composed with: the composer's runtime share and this plugin's copy. */
export type ModelChipProps = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS>

interface LoadState {
  status: 'loading' | 'ready' | 'failed'
  data: ChipOverview | null
  error: string | null
}

/**
 * The chip.
 * @param props - the session it belongs to, and the translate for its copy.
 * @returns a trigger that opens the model and parameter menu.
 */
export function ModelChip({ sessionId, t }: ModelChipProps): ReactNode {
  const [state, setState] = useState<LoadState>({ status: 'loading', data: null, error: null })
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // A browser without the popover API gets the same menu, positioned inline; the
  // composer may clip it, but every control still works.
  const [popoverSupported] = useState(() => typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const result = await fetchChip(sessionId, signal)
    if (signal?.aborted === true) return
    if (result.ok) {
      setState({ status: 'ready', data: result.value, error: null })
      return
    }
    // A refresh that fails keeps the last matrix on screen and shows why inside
    // the panel: the chip is the only place this is visible.
    setState(previous => previous.data === null
      ? { status: 'failed', data: null, error: result.error }
      : { status: 'ready', data: previous.data, error: result.error })
  }, [sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [refresh])

  // The browser owns the open/closed state of a popover (Escape, a click
  // outside), so it is mirrored into React rather than fought with.
  useEffect(() => {
    const node = panel.current
    if (node === null || !popoverSupported) return undefined
    const sync = (): void => { setOpen(node.matches(':popover-open')) }
    const close = (): void => { if (node.matches(':popover-open')) node.hidePopover() }
    node.addEventListener('toggle', sync)
    window.addEventListener('resize', close)
    return () => {
      node.removeEventListener('toggle', sync)
      window.removeEventListener('resize', close)
    }
  }, [popoverSupported])

  const persist = useCallback(async (next: ChipSelection, note: string | null): Promise<void> => {
    setSaving(true)
    const result = await saveChipSelection(sessionId, next)
    setSaving(false)
    if (!result.ok) {
      setNotice(t('chip.saveFailed', { error: result.error }))
      return
    }
    const stored = result.value.selection ?? next
    setState(previous => previous.data === null
      ? previous
      : { status: 'ready', data: { ...previous.data, selection: stored }, error: null })
    setNotice(note)
  }, [sessionId, t])

  const reset = useCallback(async (): Promise<void> => {
    setSaving(true)
    const result = await clearChipSelection(sessionId)
    setSaving(false)
    if (!result.ok) {
      setNotice(t('chip.saveFailed', { error: result.error }))
      return
    }
    setState(previous => previous.data === null
      ? previous
      : { status: 'ready', data: { ...previous.data, selection: null }, error: null })
    setNotice(null)
  }, [sessionId, t])

  const data = state.data
  const selection = data?.selection ?? null
  const providers = useMemo(() => data?.providers ?? [], [data])
  const target = useMemo(() => targetOf(selection, providers), [selection, providers])
  const label = chipLabel(selection, target)
  const summary = geometrySummary(selection)
  const warning = label.warning ?? (state.status === 'failed' ? 'unavailable' : null)

  const toggle = (): void => {
    const node = panel.current
    const button = trigger.current
    if (node === null || button === null) return
    if (open) {
      if (popoverSupported) node.hidePopover()
      setOpen(false)
      return
    }
    void refresh()
    setNotice(null)
    setOpen(true)
    if (!popoverSupported) return
    // Position against the trigger, in the viewport: the popover lives in the top
    // layer, so no ancestor's `overflow` can clip it.
    const rect = button.getBoundingClientRect()
    const width = Math.min(300, window.innerWidth - 32)
    node.style.width = `${width}px`
    node.style.left = `${Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16))}px`
    const above = rect.top
    const below = window.innerHeight - rect.bottom
    node.style.top = above >= below ? 'auto' : `${rect.bottom + 8}px`
    node.style.bottom = above >= below ? `${window.innerHeight - rect.top + 8}px` : 'auto'
    node.style.maxHeight = `${Math.max(60, Math.min(440, Math.max(above, below) - 24))}px`
    node.showPopover()
  }

  const chooseModel = (option: ModelOption): void => {
    const picked = { ...(selection ?? EMPTY_CHIP_SELECTION), provider: option.provider.id, model: option.model.id }
    const pruned = pruneSelection(picked, option.model)
    const note = pruned.dropped.length === 0
      ? null
      : t('chip.cleared', { params: pruned.dropped.map(key => paramLabel(key, t)).join(', ') })
    void persist(pruned.selection, note)
  }

  const chooseParam = (key: ParamKey, value: ParamValue): void => {
    void persist({ ...(selection ?? EMPTY_CHIP_SELECTION), [key]: value }, null)
  }

  const clearParam = (key: ParamKey): void => {
    void persist({ ...(selection ?? EMPTY_CHIP_SELECTION), [key]: null }, null)
  }

  return (
    <div className="dvf-chip">
      <style>{CHIP_CSS}</style>
      <button
        ref={trigger}
        type="button"
        className="dvf-chip-trigger"
        aria-label={`${t('chip.title')}: ${label.text === '' ? t('chip.label') : label.text}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
      >
        <ChipIcon />
        <span className="dvf-chip-name">{label.text === '' ? t('chip.label') : label.text}</span>
        {summary === '' ? null : <span className="dvf-chip-geometry">{summary}</span>}
        {warning === null
          ? null
          : <span className="dvf-chip-warning" title={warning === 'unavailable' ? t('chip.unavailable') : t('chip.keyMissing')}>!</span>}
        <Chevron open={open} />
      </button>
      <div
        ref={panel}
        id={id}
        {...(popoverSupported ? POPOVER_ATTRIBUTE : {})}
        role="dialog"
        aria-label={t('chip.title')}
        className="dvf-chip-panel"
        style={popoverSupported || open ? undefined : { display: 'none' }}
      >
        {state.error === null ? null : <p className="dvf-chip-error">{t('chip.loadFailed', { error: state.error })}</p>}
        {data === null
          ? <p className="dvf-chip-hint">{t('chip.loading')}</p>
          : (
            <>
              {data.enabled ? null : <p className="dvf-chip-warn">{t('chip.disabled')}</p>}
              <ChipGroup label={t('chip.models')}>
                <ChipOption
                  label={t('chip.auto')}
                  meta={autoMeta(t, data)}
                  pressed={selection === null || selection.provider === null}
                  disabled={saving}
                  onClick={() => { void reset() }}
                />
                {modelOptions(providers).map(option => (
                  <ChipOption
                    key={`${option.provider.id}/${option.model.id}`}
                    label={option.model.label === '' ? option.model.id : option.model.label}
                    meta={[option.provider.id, keyMissing(option.provider) ? t('chip.keyMissing') : null].filter(part => part !== null).join(' · ')}
                    pressed={selection?.provider === option.provider.id && selection.model === option.model.id}
                    disabled={saving}
                    onClick={() => { chooseModel(option) }}
                  />
                ))}
                {providers.length === 0 ? <p className="dvf-chip-hint">{t('chip.noValues')}</p> : null}
              </ChipGroup>
              <ChipGroup label={t('chip.params')}>
                {target.missing === null ? null : <p className="dvf-chip-warn">{t('chip.unavailable')}</p>}
                {PARAM_KEYS.map(key => {
                  const { values, scope } = paramValues(providers, target, key)
                  const current = selection?.[key] ?? null
                  return (
                    <div key={key} className="dvf-chip-param">
                      <p className="dvf-chip-heading">{paramLabel(key, t)}</p>
                      {values.length === 0
                        ? <p className="dvf-chip-hint">{target.model === null ? t('chip.noValues') : t('chip.undeclared')}</p>
                        : (
                          <div className="dvf-chip-values">
                            <button
                              type="button"
                              className="dvf-chip-value"
                              aria-label={`${paramLabel(key, t)}: ${t('chip.notChosen')}`}
                              aria-pressed={current === null}
                              disabled={saving}
                              onClick={() => { clearParam(key) }}
                            >
                              {t('chip.notChosen')}
                            </button>
                            {values.map(value => (
                              <button
                                key={`${String(value)}`}
                                type="button"
                                className="dvf-chip-value"
                                aria-pressed={current !== null && String(current) === String(value)}
                                disabled={saving}
                                onClick={() => { chooseParam(key, value) }}
                              >
                                {paramText(key, value)}
                              </button>
                            ))}
                          </div>
                        )}
                      {scope === 'union' && values.length > 0 ? <p className="dvf-chip-hint">{t('chip.unionHint')}</p> : null}
                    </div>
                  )
                })}
              </ChipGroup>
              {notice === null ? null : <p className="dvf-chip-notice" role="status">{notice}</p>}
              {saving ? <p className="dvf-chip-hint">{t('chip.saving')}</p> : null}
            </>
          )}
      </div>
    </div>
  )
}

/** The "auto" row's subtitle: what the conversation falls back to when the chip chooses nothing. */
function autoMeta(t: Translate, data: ChipOverview): string {
  const named = settingsTarget(data.defaults, data.providers)
  return named === null
    ? t('chip.autoHint')
    : t('chip.settingsDefault', { target: `${named.provider.id}/${named.model.id}` })
}

/** One titled block of the menu. */
function ChipGroup({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="dvf-chip-group" role="group" aria-label={label}>
      <p className="dvf-chip-heading">{label}</p>
      {children}
    </div>
  )
}

/** One row of the model list. */
function ChipOption({ label, meta, pressed, disabled, onClick }: {
  label: string
  meta: string
  pressed: boolean
  disabled: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button type="button" className="dvf-chip-option" aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <span className="dvf-chip-option-label">{label}</span>
      {meta === '' ? null : <span className="dvf-chip-option-meta">{meta}</span>}
    </button>
  )
}

function ChipIcon(): ReactNode {
  return (
    <svg className="dvf-chip-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.7" y="3.2" width="12.6" height="9.6" rx="2.2" />
      <path d="M6.7 6.3 10.4 8l-3.7 1.7z" fill="currentColor" stroke="none" />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      className="dvf-chip-chevron"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      style={open ? { transform: 'rotate(180deg)' } : undefined}
    >
      <path d="m4 6.5 4 4 4-4" />
    </svg>
  )
}

/**
 * The `popover` attribute is not in React 18's DOM typings, and the attribute is
 * what puts the menu in the top layer. Spreading it keeps the element's own props
 * type-checked. It is only set where the API exists: a host without it gets the
 * same menu, positioned inline, and no `[popover]` stylesheet rule hiding it.
 */
const POPOVER_ATTRIBUTE: Record<string, string> = { popover: 'auto' }

/** The chip's stylesheet: metrics follow the harness ModelSelect trigger, colors are theme tokens. */
const CHIP_CSS = `
.dvf-chip { display:inline-flex; align-items:center; flex:none; min-width:0; font:inherit; }
.dvf-chip-trigger { display:flex; align-items:center; gap:4px; min-width:0; max-width:min(240px,45cqw); height:28px; padding:0 6px 0 8px; border:none; border-radius:24px; outline:none; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:13px; font-weight:500; line-height:20px; cursor:pointer; white-space:nowrap; }
.dvf-chip-trigger:hover,.dvf-chip-trigger[aria-expanded=true] { background:var(--dsw-alias-interactive-bg-hover); }
.dvf-chip-trigger:focus-visible { box-shadow:0 0 0 2px var(--dsw-alias-border-l3); }
.dvf-chip-trigger svg { flex:none; }
.dvf-chip-name,.dvf-chip-geometry { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.dvf-chip-geometry { flex-shrink:1000; color:var(--dsw-alias-label-caption); }
.dvf-chip-warning { flex:none; color:var(--dsw-alias-state-error-primary); font-weight:700; }
.dvf-chip-chevron { color:var(--dsw-alias-label-caption); transition:transform .12s; }
@media(prefers-reduced-motion:reduce) { .dvf-chip-chevron { transition:none; } }
@container(width<=460px) { .dvf-chip-geometry { display:none; } }
@container(width<=380px) { .dvf-chip-name { display:none; } }
.dvf-chip-panel { position:fixed; inset:auto; width:300px; margin:0; box-sizing:border-box; display:flex; flex-direction:column; gap:6px; max-width:calc(100vw - 32px); padding:6px; overflow:auto; overscroll-behavior:contain; border:0; border-radius:16px; background:var(--dsw-specific-menu); backdrop-filter:var(--dsw-menu-backdrop-filter); color:var(--dsw-alias-label-primary); --dsw-elevation-stroke-color:var(--dsw-alias-border-l1); box-shadow:var(--dsw-elevation-prominent); --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2); font-family:inherit; font-size:13px; line-height:20px; }
.dvf-chip-panel::backdrop { background:transparent; }
/* The UA rule that hides a closed popover is weak, so this sheet's own
   display:flex would beat it and the menu would stand open on load. Scoped to
   elements that carry the attribute, so the fallback path (no popover API) keeps
   its React-driven visibility. */
.dvf-chip-panel[popover]:not(:popover-open) { display:none; }
.dvf-chip-group { display:flex; flex-direction:column; gap:1px; padding:2px 0; }
.dvf-chip-heading { margin:0; padding:4px 7px 2px; font-size:11px; font-weight:500; line-height:16px; color:var(--dsw-alias-label-tertiary); }
.dvf-chip-option { box-sizing:border-box; width:100%; min-height:34px; display:flex; align-items:center; gap:6px; padding:5px 7px; color:inherit; background:transparent; border:none; border-radius:8px; outline:none; text-align:left; font:inherit; font-size:13px; font-weight:500; line-height:18px; cursor:pointer; }
.dvf-chip-option:hover,.dvf-chip-option:focus-visible { background:var(--dsw-alias-interactive-bg-hover); }
.dvf-chip-option[aria-pressed=true] { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-interactive-bg-active); }
.dvf-chip-option:disabled { opacity:.55; cursor:default; }
.dvf-chip-option-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dvf-chip-option-meta { margin-left:auto; padding-left:8px; flex:none; color:var(--dsw-alias-label-caption); font-size:12px; font-weight:400; }
.dvf-chip-param { display:flex; flex-direction:column; gap:2px; padding:2px 0 4px; }
.dvf-chip-values { display:flex; flex-wrap:wrap; gap:4px; padding:0 7px; }
.dvf-chip-value { min-height:26px; padding:2px 9px; border:1px solid var(--dsw-alias-border-l2); border-radius:999px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; font-weight:500; line-height:18px; cursor:pointer; }
.dvf-chip-value:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dvf-chip-value[aria-pressed=true] { border-color:transparent; background:var(--dsw-alias-interactive-bg-active); color:var(--dsw-alias-label-primary); }
.dvf-chip-value:disabled { opacity:.55; cursor:default; }
.dvf-chip-hint,.dvf-chip-warn,.dvf-chip-error,.dvf-chip-notice { margin:0; padding:2px 7px; font-size:12px; line-height:16px; color:var(--dsw-alias-label-tertiary); }
.dvf-chip-warn,.dvf-chip-error { color:var(--dsw-alias-state-error-primary); }
.dvf-chip-notice { color:var(--dsw-alias-label-secondary); }
`
