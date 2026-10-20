/**
 * The video panel: a right-Sidebar page that lists the videos this project has,
 * so a finished video does not have to be dug out of a folded tool card.
 *
 * The layout is an accordion (DESIGN §19.2): every row is one line, the newest
 * finished video opens expanded on first render, one row is open at a time, and
 * closing it gives the whole pane back to the list. A row plays in place; the
 * file viewer is one click away for watching in a wider pane, and that is also
 * the only recourse when this host has no stream route.
 *
 * What the panel does NOT do: it never submits a generation, never writes or
 * deletes a file, and holds no cancel button — those belong to the chat card
 * that started the task.
 *
 * This is the one client file that ships a stylesheet instead of `CSSProperties`
 * constants: the panel needs `:hover`, `:focus-visible` and a scroll container,
 * none of which an inline style can express. Everything else in this half stays
 * on style objects.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// The composed props are assembled from every declaring package's augmentation:
// the tab seats come from the Sidebar, `sessionId`/`useSessions` from the Session
// UI. Without these type imports the props resolve to an incomplete intersection.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { PanelLoad, ScanProblem } from './panel-data.ts'
import { NS, type Translate } from './locales.ts'
import { formatBytes } from './video-card-model.ts'
import {
  buildPanelView,
  panelStatusKey,
  rowFacts,
  rowName,
  rowProgress,
  rowVideoUrl,
  fileAddress,
  type PanelRow,
  type PanelScope,
  type PanelView,
} from './video-panel-model.ts'

/** What the tab's inject factory hands over: data loading, resolved per render. */
export interface VideoPanelInjected {
  loadPanel: (signal: AbortSignal) => Promise<PanelLoad>
}

/** Props this panel is composed with: the slot's runtime share, its injected face, and its copy. */
export type VideoPanelProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & InjectFace<VideoPanelInjected>
  & PropsLocale<typeof NS>

/** How often a panel showing work in flight re-reads the ledger. */
const POLL_MS = 4000

/** Returned by the session selector when the on-screen Session is not accounted to a workspace. */
const NO_SESSIONS: readonly string[] = []

/** The scope chips, in the order they show. */
const SCOPES: readonly PanelScope[] = ['workspace', 'session', 'all']

const STATUS_KEY_BY_SCOPE: Record<PanelScope, 'panel.scope.workspace' | 'panel.scope.session' | 'panel.scope.all'> = {
  workspace: 'panel.scope.workspace',
  session: 'panel.scope.session',
  all: 'panel.scope.all',
}

interface LoadState {
  status: 'loading' | 'ready' | 'failed'
  load: PanelLoad | null
  error: string | null
}

/**
 * The panel body.
 * @param props - composed slot props, narrowed.
 * @returns the list, or its empty, loading and failure states.
 */
export function VideoPanel(props: VideoPanelProps): ReactNode {
  const { t, sessionId, useTabInfo, useWorkspaces, loadPanel } = props
  const { tab } = useTabInfo()
  const [state, setState] = useState<LoadState>({ status: 'loading', load: null, error: null })
  const [scope, setScope] = useState<PanelScope>('workspace')
  // `undefined` means "nothing chosen yet": the first view that has a finished
  // video opens it once (below), and from then on this is the user's choice —
  // `null` is an explicit close. A later poll must not re-open or move the row
  // the user is watching, which is why the default is not read on every render.
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined)
  const [generation, setGeneration] = useState(0)
  // A poll tick must not restart a read that is still running: on a slow host
  // (up to 80 sequential directory listings over SSH) it would abort every read
  // before it could settle, and the list would never refresh at all. A manual
  // refresh still supersedes — that is a deliberate new request.
  const inFlight = useRef(false)

  // The Sessions this workspace accounts for: the harness's own accounting, so a
  // project is recognised however its paths are spelled, and "another Session of
  // this project" is told apart from "another project entirely".
  const workspaceSessionIds: readonly string[] = useWorkspaces((workspaces) => {
    const item = workspaces.items.find((candidate: { readonly sessionIds: readonly string[] }) => candidate.sessionIds.includes(sessionId))
    return item === undefined ? NO_SESSIONS : item.sessionIds
  })

  // One read per generation. The cleanup aborts it, so a refresh or a poll tick
  // while a read is still in flight replaces that read instead of racing it —
  // and a click can never be silently dropped by a "busy" guard.
  useEffect(() => {
    if (loadPanel === undefined) return undefined
    const controller = new AbortController()
    inFlight.current = true
    loadPanel(controller.signal).then(
      (load) => {
        if (controller.signal.aborted) return
        inFlight.current = false
        setState({ status: 'ready', load, error: null })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        inFlight.current = false
        // The rows already on screen are kept: they are the last thing the host
        // said, and they are still worth reading. The error sits above them.
        setState(previous => ({ status: 'failed', load: previous.load, error: messageOf(error) }))
      },
    )
    return () => { controller.abort() }
  }, [generation, loadPanel])

  const scanProblem = state.load?.scan ?? null
  const view = useMemo(() => {
    const load = state.load
    if (load === null) return null
    return buildPanelView({ tasks: load.tasks, files: load.files, scope, sessionId, workspaceSessionIds })
  }, [state.load, scope, sessionId, workspaceSessionIds])

  // While anything is in flight, and only while the tab is actually visible: a
  // hidden tab must not keep asking the host, and `loadPanel` is the whole cost.
  const activeCount = view?.active.length ?? 0
  useEffect(() => {
    if (!tab.visible || activeCount === 0) return undefined
    const timer = setInterval(() => {
      if (inFlight.current) return
      setGeneration(value => value + 1)
    }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [tab.visible, activeCount])

  const open = expanded ?? null
  useEffect(() => {
    if (expanded !== undefined || view === null) return
    setExpanded(view.defaultKey)
  }, [expanded, view])
  const toggle = useCallback((key: string) => {
    setExpanded(() => (open === key ? null : key))
  }, [open])

  const refresh = useCallback(() => { setGeneration(value => value + 1) }, [])

  const openInViewer = useCallback((row: PanelRow) => {
    if (row.workspacePath === '') return
    tab.actions.openResource(fileAddress(row.sessionId ?? sessionId, row.workspacePath))
  }, [tab.actions, sessionId])

  return (
    <div className="vf-panel">
      <style>{PANEL_CSS}</style>
      <div className="vf-head">
        <span className="vf-title">{t('panel.title')}</span>
        <span className="vf-grow" />
        <button type="button" className="vf-icon-btn" title={t('panel.refresh')} aria-label={t('panel.refresh')} onClick={refresh}>
          <RefreshGlyph />
        </button>
      </div>
      {/* Toggle buttons, not tabs: these filter one list rather than switch
          panels, so the honest role is a pressed button in a labelled group. */}
      <div className="vf-scopes" role="group" aria-label={t('panel.filter')}>
        {SCOPES.filter(candidate => candidate !== 'session' || view === null || view.attributable).map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={scope === candidate}
            className="vf-scope"
            data-on={scope === candidate ? 'true' : 'false'}
            onClick={() => { setScope(candidate) }}
          >
            {t(STATUS_KEY_BY_SCOPE[candidate])}
            {view === null ? null : <span className="vf-count">{view.counts[candidate]}</span>}
          </button>
        ))}
      </div>

      <div className="vf-list" tabIndex={0} role="region" aria-label={t('panel.title')}>
        {state.status === 'loading' && view === null ? <p className="vf-hint">{t('panel.loading')}</p> : null}
        {/* A failure keeps the rows it already has, and says so above them: silently
            showing yesterday's list is the one thing a stale panel must not do. */}
        {state.error === null ? null : <p className="vf-error" role="alert">{t('panel.error', { error: state.error })}</p>}
        {scanProblem === null ? null : <p className="vf-hint">{scanProblemText(scanProblem, t)}</p>}
        {/* The list is this project's videos only, so a film made somewhere else
            is not in it. Saying how many were held back beats an empty panel that
            looks like nothing was ever generated. */}
        {view === null || view.hidden.count === 0
          ? null
          : (
              <p className="vf-hint">
                {view.hidden.unmapped
                  ? t('panel.hiddenUnmapped', { count: view.hidden.count })
                  : t('panel.hidden', { count: view.hidden.count })}
              </p>
            )}
        {view !== null && isEmpty(view)
          ? (
              <div className="vf-empty">
                <p className="vf-empty-title">{t('panel.empty')}</p>
                <p className="vf-hint">{t('panel.emptyHint')}</p>
              </div>
            )
          : null}

        {view === null ? null : (
          <>
            {view.ready.map(group => (
              <div key={`dir:${group.directory}`} className="vf-group" role="group" aria-label={group.directory === '' ? t('panel.group.root') : group.directory}>
                <div className="vf-group-head">
                  <span className="vf-group-path">{group.directory === '' ? t('panel.group.root') : group.directory}</span>
                  <span className="vf-group-count">{t('panel.count', { count: group.rows.length })}</span>
                </div>
                {group.rows.map(row => (
                  <Row
                    key={row.key}
                    row={row}
                    t={t}
                    open={open === row.key}
                    stream={state.load?.stream === true}
                    sessionId={sessionId}
                    onToggle={toggle}
                    onOpenInViewer={openInViewer}
                  />
                ))}
              </div>
            ))}
            {view.active.length === 0 ? null : (
              <div className="vf-group">
                <div className="vf-group-head">
                  <span className="vf-group-path">{t('panel.group.active')}</span>
                  <span className="vf-group-count">{t('panel.count', { count: view.active.length })}</span>
                </div>
                {view.active.map(row => (
                  <Row
                    key={row.key}
                    row={row}
                    t={t}
                    open={open === row.key}
                    stream={state.load?.stream === true}
                    sessionId={sessionId}
                    onToggle={toggle}
                    onOpenInViewer={openInViewer}
                  />
                ))}
              </div>
            )}
            {view.failed.length === 0 ? null : (
              <div className="vf-group">
                <div className="vf-group-head">
                  <span className="vf-group-path">{t('panel.group.failed')}</span>
                  <span className="vf-group-count">{t('panel.count', { count: view.failed.length })}</span>
                </div>
                {view.failed.map(row => (
                  <Row
                    key={row.key}
                    row={row}
                    t={t}
                    open={open === row.key}
                    stream={state.load?.stream === true}
                    sessionId={sessionId}
                    onToggle={toggle}
                    onOpenInViewer={openInViewer}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Whether the panel has nothing to draw at all. */
function isEmpty(view: PanelView): boolean {
  return view.ready.length === 0 && view.active.length === 0 && view.failed.length === 0
}

/** One list row, expanded or not. */
function Row(props: {
  row: PanelRow
  t: Translate
  open: boolean
  stream: boolean
  sessionId: string
  onToggle: (key: string) => void
  onOpenInViewer: (row: PanelRow) => void
}): ReactNode {
  const { row, t, open, stream, sessionId, onToggle, onOpenInViewer } = props
  // The GUI is served with `<base href="./">`, so every URL is document-relative.
  const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI
  // A row's own Session resolves its paths; under "all" that may not be the
  // Session on screen.
  const owner = row.sessionId ?? sessionId
  const url = rowVideoUrl(row, base, sessionId, stream)
  const [broken, setBroken] = useState(false)
  // Only work in flight has progress to show; a finished row's `progress: 1` is
  // not a bar, it is just "done", which the status chip already says.
  const percent = row.tone === 'active' ? rowProgress(row) : null
  const facts = rowFacts(row, formatBytes)
  const viewer = row.workspacePath !== ''

  return (
    <div className="vf-row" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="vf-row-head"
        aria-expanded={open}
        onClick={() => { onToggle(row.key) }}
      >
        <span className="vf-chevron" data-open={open ? 'true' : 'false'}><ChevronGlyph /></span>
        <span className="vf-glyph" data-tone={row.tone}><FilmGlyph /></span>
        <span className="vf-row-body">
          <span className="vf-row-line">
            <span className="vf-row-name">{rowName(row)}</span>
            <span className="vf-dot" data-tone={row.tone} />
            <span className="vf-status">{t(panelStatusKey(row))}</span>
            {percent === null ? null : <span className="vf-status">{t('panel.progress', { percent: Math.round(percent * 100) })}</span>}
          </span>
          <span className="vf-row-facts">{facts}</span>
          {percent === null ? null : (
            // Presentational: the same number is already the row's text, and this
            // element lives inside the row's button, whose children are hidden
            // from assistive tech.
            <span className="vf-track" aria-hidden="true">
              <span className="vf-track-fill" style={{ width: `${Math.round(percent * 100)}%` }} />
            </span>
          )}
        </span>
      </button>

      {open
        ? (
            <div className="vf-row-open">
              {url === null || broken
                ? (
                    <div className="vf-nosource">
                      <p>{url === null ? t('panel.noSource') : t('panel.cannotPlay')}</p>
                      <p className="vf-hint">{url === null ? t('panel.noSourceHint') : t('panel.cannotPlayHint')}</p>
                    </div>
                  )
                : (
                    <video
                      key={`${row.key}:${url}`}
                      className="vf-player"
                      src={url}
                      controls
                      playsInline
                      preload="metadata"
                      // A deleted file or a stale token would otherwise be a silent
                      // black box.
                      onError={() => { setBroken(true) }}
                    />
                  )}
              {row.prompt === '' ? null : <p className="vf-prompt">{row.prompt}</p>}
              {row.error === null ? null : <p className="vf-error" role="alert">{row.error}</p>}
              {viewer
                ? (
                    <button type="button" className="vf-action" onClick={() => { onOpenInViewer(row) }}>
                      {t('panel.openInViewer')}
                    </button>
                  )
                : null}
            </div>
          )
        : null}
    </div>
  )
}

const ChevronGlyph = (): ReactNode => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M3.5 1.5L7 5l-3.5 3.5" />
  </svg>
)

const FilmGlyph = (): ReactNode => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <rect x="1.5" y="3.5" width="13" height="9" rx="2" />
    <path d="M6 6.5l4 1.5-4 1.5z" fill="currentColor" stroke="none" />
  </svg>
)

const RefreshGlyph = (): ReactNode => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13 2.8v3.4H9.6" />
  </svg>
)

/**
 * What to say about a scan that did not produce a full list.
 * @param problem - the structured reason from the loader.
 * @param t - the panel's translate.
 * @returns one line, or '' when there is nothing to say.
 */
function scanProblemText(problem: ScanProblem, t: Translate): string {
  switch (problem.kind) {
    case 'none': return ''
    case 'unavailable': return t('panel.scanUnavailable')
    case 'not-directory': return t('panel.scanNotDirectory')
    case 'outside': return t('panel.scanOutside')
    case 'truncated': return t('panel.scanTruncated')
    case 'refused': return t('panel.scanError', { error: problem.detail ?? '' })
  }
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Panel styles.
 *
 * A plugin bundle cannot ship a CSS module (the shell has no loader for it), so
 * the sheet travels with the component and every rule is namespaced. Values are
 * theme tokens first and literal fallbacks second, so the panel looks native in
 * both schemes instead of picking its own greys.
 */
const PANEL_CSS = `
.vf-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.vf-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 4px; flex: none; }
.vf-title { font-size: 14px; font-weight: 500; }
.vf-grow { flex: 1; }
.vf-icon-btn {
  width: 26px; height: 26px; display: inline-grid; place-items: center;
  border: 0; padding: 0; background: transparent; cursor: pointer;
  border-radius: var(--dsw-radius-sm, 8px);
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.vf-icon-btn:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); color: var(--dsw-alias-label-primary, #1f2329); }
.vf-scopes { display: flex; gap: 4px; padding: 0 12px 8px; flex: none; }
.vf-scope {
  height: 26px; padding: 0 9px; display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid transparent; border-radius: var(--dsw-radius-sm, 8px);
  background: transparent; cursor: pointer; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.vf-scope[data-on='true'] {
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05));
  border-color: var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  color: var(--dsw-alias-label-primary, #1f2329);
}
.vf-count { font-variant-numeric: tabular-nums; opacity: .7; }
.vf-list { flex: 1; min-height: 0; overflow: auto; padding: 0 8px 12px; }
.vf-group + .vf-group { margin-top: 6px; }
.vf-group-head {
  display: flex; align-items: baseline; gap: 8px;
  padding: 8px 4px 4px; font-size: 11px;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.vf-group-path { font-family: var(--ds-font-family-code, ui-monospace, monospace); }
.vf-group-count { margin-left: auto; font-variant-numeric: tabular-nums; opacity: .75; }
.vf-row { border-radius: var(--dsw-radius-sm, 8px); }
.vf-row[data-open='true'] { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04)); }
.vf-row-head {
  width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 6px; border: 0; background: transparent; cursor: pointer;
  font: inherit; color: inherit; text-align: left;
  border-radius: var(--dsw-radius-sm, 8px);
}
.vf-row-head:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); }
.vf-row-head:focus-visible { outline: 2px solid var(--dsw-alias-label-primary, #1f2329); outline-offset: -2px; }
.vf-chevron { flex: none; display: inline-grid; place-items: center; width: 10px; color: var(--dsw-alias-label-secondary, #6b7280); transition: transform .12s ease; }
.vf-chevron[data-open='true'] { transform: rotate(90deg); }
.vf-glyph {
  flex: none; width: 44px; height: 26px; display: grid; place-items: center;
  border-radius: var(--dsw-radius-xs, 4px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04));
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.vf-glyph[data-tone='active'] { color: var(--dsw-static-blue-500, #3b82f6); }
.vf-glyph[data-tone='failed'] { color: var(--dsw-static-red-600, #ef4444); }
.vf-row-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
.vf-row-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.vf-row-name {
  font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.vf-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-static-green-500, #22c55e); flex: none; }
.vf-dot[data-tone='active'] { background: var(--dsw-static-blue-500, #3b82f6); }
.vf-dot[data-tone='failed'] { background: var(--dsw-static-red-600, #ef4444); }
.vf-dot[data-tone='other'] { background: var(--dsw-alias-label-secondary, #9ca3af); }
.vf-status { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); white-space: nowrap; }
.vf-row-facts {
  font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280);
  font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.vf-track { margin-top: 3px; height: 3px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.08)); overflow: hidden; }
.vf-track-fill { display: block; height: 100%; background: var(--dsw-static-blue-500, #3b82f6); }
.vf-row-open { padding: 2px 6px 10px 30px; display: flex; flex-direction: column; gap: 6px; }
.vf-player { width: 100%; border-radius: var(--dsw-radius-md, 12px); background: #000; display: block; }
.vf-prompt { margin: 0; font-size: 12px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.vf-hint { margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); }
.vf-error { margin: 0; font-size: 12px; color: var(--dsw-alias-state-error-primary, #d4380d); }
.vf-nosource { padding: 10px; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.05)); display: flex; flex-direction: column; gap: 4px; }
.vf-nosource p { margin: 0; font-size: 12px; }
.vf-action {
  align-self: flex-start; height: 26px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: inherit; font: inherit; font-size: 12px; cursor: pointer;
}
.vf-action:hover { background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.06)); }
.vf-empty { padding: 18px 10px; display: flex; flex-direction: column; gap: 4px; }
.vf-empty-title { margin: 0; font-size: 13px; }
`
