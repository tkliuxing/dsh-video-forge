/**
 * The browser cards: one row per wire tool name, rendered inside the tool-call
 * block.
 *
 * The frozen props the framework hands over say what the call returned; the
 * generate card then follows its task live through the injected
 * {@link LiveTasks} (DESIGN §16.4): progress, the finished player, where the
 * video is, and a cancel button while the provider may still stop it. The media
 * URL is *resolved* from the document-relative path the host produced, and it is
 * the only place this plugin builds a `src` for `<video>`.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { LiveSnapshot, LiveSource, LiveTasks } from './live-tasks.ts'
import {
  blockFacts,
  formatBytes,
  generateMeta,
  resolveMediaUrl,
  resultText,
  startFacts,
  statusKey,
  statusMeta,
  statusStartFacts,
  parseArgs,
  type StatusRow,
} from './video-card-model.ts'

/** The seat the framework injects when a registration declares `locale:`. */
import type { Translate } from './locales.ts'

/** Re-exported for the surfaces composed from this module's cards. */
export type { Translate }

/** Props this card reads. Deliberately a subset of the composed slot props. */
export interface VideoCardProps {
  phase: 'preparing' | 'start' | 'result'
  block: unknown
  t: Translate
  /** Injected by this plugin's registration; absent where nothing is injected (tests, replays elsewhere). */
  liveTasks?: LiveTasks | undefined
}

const STYLE_BAR_TRACK: CSSProperties = {
  width: '100%',
  maxWidth: '480px',
  height: '4px',
  borderRadius: '2px',
  background: 'var(--dsw-alias-border-l2, #e5e5e5)',
  overflow: 'hidden',
}

const STYLE_BUTTON: CSSProperties = {
  alignSelf: 'flex-start',
  padding: '2px 10px',
  borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: '0.85em',
}

/** A source that never changes, for a card with no task to follow. */
const IDLE: LiveSource = {
  getSnapshot: () => IDLE_SNAPSHOT,
  subscribe: () => () => undefined,
}
const IDLE_SNAPSHOT: LiveSnapshot = { task: null, error: null, loaded: false, stopped: false }

/** Statuses the provider may still be talked out of. */
const CANCELLABLE = new Set(['queued', 'running'])

const STYLE_ROW: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
}

const STYLE_TITLE: CSSProperties = {
  fontWeight: 600,
  opacity: 0.9,
}

const STYLE_META: CSSProperties = {
  fontSize: '0.85em',
  opacity: 0.75,
}

const STYLE_PLAYER: CSSProperties = {
  width: '100%',
  maxWidth: '480px',
  borderRadius: '8px',
  background: '#000',
}

const STYLE_ERROR: CSSProperties = {
  fontSize: '0.9em',
  color: 'var(--dsw-color-danger, #d4380d)',
}

const STYLE_LIST: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontSize: '0.9em',
}

/** `video_generate`. */
export function VideoGenerateRow(props: VideoCardProps): ReactNode {
  const { t } = props
  const facts = blockFacts(props.block)
  const meta = facts.phase === 'result' && !facts.isError ? generateMeta(facts.meta) : null
  // Hooks run on every render, whatever is shown: the live source is chosen
  // from the frozen result, and a card without one follows nothing.
  const source = meta !== null && props.liveTasks !== undefined ? props.liveTasks.source(meta.taskId) : IDLE
  const live = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const [cancel, setCancel] = useState<{ busy: boolean; accepted: boolean; message: string | null }>({ busy: false, accepted: false, message: null })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  if (facts.phase !== 'result') {
    const start = startFacts(facts.argsRaw)
    return (
      <div style={STYLE_ROW}>
        <div style={STYLE_TITLE}>{facts.phase === 'preparing' ? t('generate.pending') : t('generate.title')}</div>
        {start.prompt === null ? null : <div style={STYLE_META}>{start.prompt}</div>}
      </div>
    )
  }

  if (facts.isError) {
    const text = resultText(facts.content) ?? ''
    // A submission whose outcome is unknown is not a failure: it may be billing.
    const unconfirmed = /may already have created and billed/.test(text)
    return (
      <div style={STYLE_ROW}>
        <div style={STYLE_TITLE}>{unconfirmed ? t('generate.unconfirmed') : t('generate.failed')}</div>
        <div style={STYLE_ERROR}>{text}</div>
        {unconfirmed ? <div style={STYLE_META}>{t('status.unconfirmedHint')}</div> : null}
      </div>
    )
  }

  if (meta === null) {
    // No persisted facts (a nested Code dispatch, or an older log): show the
    // model-facing text rather than inventing a player.
    return <div style={STYLE_ROW}>{resultText(facts.content) ?? null}</div>
  }

  // The live row wins over the frozen one once it has arrived.
  const row = live.task
  const status = row?.status ?? meta.status
  const progress = row === null ? meta.progress : row.progress
  const playUrl = row !== null ? row.playUrl : meta.artifact?.url ?? null
  const missing = row?.artifactState === 'missing'
  const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI
  const url = playUrl === null || missing ? null : resolveMediaUrl(playUrl, base)
  const percent = progress === null ? null : Math.round(progress * 100)
  const where = row?.artifactLocation ?? meta.artifact?.path ?? null
  const bytes = row?.artifactBytes ?? meta.artifact?.bytes ?? null

  const onCancel = (): void => {
    if (props.liveTasks === undefined || cancel.busy || cancel.accepted) return
    setCancel({ busy: true, accepted: false, message: null })
    void props.liveTasks.cancel(meta.taskId).then(
      (outcome) => { if (mounted.current) setCancel({ busy: false, accepted: outcome.ok, message: outcome.message }) },
      (error: unknown) => { if (mounted.current) setCancel({ busy: false, accepted: false, message: error instanceof Error ? error.message : String(error) }) },
    )
  }
  // Offered only once the live state confirms the task can still be stopped,
  // never on the frozen result alone, and not again after it was accepted.
  const cancellable = props.liveTasks !== undefined && live.loaded && !live.stopped && row !== null && row.cancelable !== false && CANCELLABLE.has(status)

  return (
    <div style={STYLE_ROW}>
      <div aria-live="polite" style={STYLE_ROW}>
        <div style={STYLE_TITLE}>{status === 'succeeded' ? t('generate.succeeded') : t(statusKey(status))}</div>
        <div style={STYLE_META}>
          {t('generate.meta', { provider: meta.provider, model: meta.model, status })}
          {percent === null || status === 'succeeded' ? '' : ` · ${t('generate.progress', { percent })}`}
        </div>
      </div>
      {percent !== null && CANCELLABLE.has(status)
        ? (
            <div style={STYLE_BAR_TRACK} role="progressbar" aria-label={t('generate.progress', { percent })} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${percent}%`, height: '100%', background: 'var(--dsw-color-primary, #1677ff)' }} />
            </div>
          )
        : null}
      {url === null
        ? null
        : (
            <video
              controls
              playsInline
              preload="metadata"
              src={url}
              style={STYLE_PLAYER}
            />
          )}
      {missing ? <div style={STYLE_ERROR}>{t('generate.missing')}</div> : null}
      {where === null || missing
        ? null
        : <div style={STYLE_META}>{bytes === null ? where : `${where} · ${formatBytes(bytes)}`}</div>}
      {row?.error === null || row?.error === undefined || status === 'succeeded' ? null : <div style={STYLE_ERROR}>{row.error}</div>}
      {live.error === null ? null : <div style={STYLE_META}>{t('generate.liveError', { error: live.error })}</div>}
      {cancellable
        ? (
            <button type="button" style={STYLE_BUTTON} disabled={cancel.busy || cancel.accepted} onClick={onCancel}>
              {cancel.busy || cancel.accepted ? t('generate.cancelling') : t('generate.cancel')}
            </button>
          )
        : null}
      {cancel.message === null ? null : <div aria-live="polite" style={STYLE_META}>{cancel.message}</div>}
    </div>
  )
}

/** `video_status`: the task list as a compact row. */
export function VideoStatusRow(props: VideoCardProps): ReactNode {
  const { t } = props
  const facts = blockFacts(props.block)

  if (facts.phase !== 'result') {
    const start = statusStartFacts(facts.argsRaw)
    return (
      <div style={STYLE_ROW}>
        <div style={STYLE_TITLE}>{t('status.title')}</div>
        {start.taskId === null ? null : <div style={STYLE_META}>{start.taskId}</div>}
      </div>
    )
  }

  if (facts.isError) {
    return (
      <div style={STYLE_ROW}>
        <div style={STYLE_TITLE}>{t('status.error')}</div>
        <div style={STYLE_ERROR}>{resultText(facts.content) ?? ''}</div>
      </div>
    )
  }

  const rows = statusMeta(facts.meta)
  if (rows === null) {
    return <div style={STYLE_ROW}>{resultText(facts.content) ?? null}</div>
  }
  if (rows.length === 0) {
    return <div style={STYLE_ROW}>{t('status.empty')}</div>
  }

  const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI
  // A single finished take plays inline; a list stays a list (one player per
  // row would be too heavy). This is the way the model shows a video: call
  // `video_status` for one task and the card plays it — no markdown `<video>`
  // (the DSH front end does not render it), no GIF, no frame sheets.
  if (rows.length === 1) {
    const only = rows[0]!
    const url = only.playUrl === null ? null : resolveMediaUrl(only.playUrl, base)
    if (url !== null) {
      return (
        <div style={STYLE_ROW}>
          <div style={STYLE_TITLE}>{`${t('status.title')} · ${only.taskId}`}</div>
          <div style={STYLE_META}>{`${only.status} · ${only.provider}/${only.model}`}</div>
          <video controls playsInline preload="metadata" src={url} style={STYLE_PLAYER} />
          {only.error === null ? null : <div style={STYLE_ERROR}>{only.error}</div>}
          {only.status === 'unconfirmed' ? <div style={STYLE_ERROR}>{t('status.unconfirmedHint')}</div> : null}
        </div>
      )
    }
  }
  return (
    <div style={STYLE_ROW}>
      <div style={STYLE_TITLE}>{`${t('status.title')} · ${t('status.count', { count: rows.length })}`}</div>
      <div style={STYLE_LIST}>
        {rows.map(row => <StatusLine key={row.taskId} row={row} base={base} t={t} />)}
      </div>
    </div>
  )
}

/** A non-status tool of this plugin (`video_cancel`, `video_export`). */
export function VideoActionRow(props: VideoCardProps): ReactNode {
  const { t } = props
  const facts = blockFacts(props.block)
  const args = parseArgs(facts.argsRaw)
  const taskId = args === null || typeof args['task_id'] !== 'string' ? '' : args['task_id']
  const isExport = args !== null && typeof args['target_path'] === 'string'

  if (facts.phase !== 'result') {
    return (
      <div style={STYLE_ROW}>
        <div style={STYLE_TITLE}>{isExport ? t('export.title') : t('cancel.title')}</div>
        {taskId === '' ? null : <div style={STYLE_META}>{taskId}</div>}
      </div>
    )
  }
  if (facts.isError) {
    return (
      <div style={STYLE_ROW}>
        <div style={STYLE_TITLE}>{isExport ? t('export.failed') : t('cancel.failed')}</div>
        <div style={STYLE_ERROR}>{resultText(facts.content) ?? ''}</div>
      </div>
    )
  }
  return (
    <div style={STYLE_ROW}>
      <div style={STYLE_TITLE}>{isExport ? t('export.done', { path: '' }) : t('cancel.done')}</div>
      <div style={STYLE_META}>{resultText(facts.content) ?? ''}</div>
    </div>
  )
}

function StatusLine({ row, base, t }: { row: StatusRow; base: string; t: Translate }): ReactNode {
  const url = row.playUrl === null ? null : resolveMediaUrl(row.playUrl, base)
  const percent = row.progress === null ? '' : ` ${Math.round(row.progress * 100)}%`
  return (
    <div>
      <span style={STYLE_META}>{`${row.taskId} · ${row.status}${percent} · ${row.provider}/${row.model}`}</span>
      {row.error === null ? null : <span style={STYLE_ERROR}>{` · ${row.error}`}</span>}
      {url === null
        ? null
        : (
            <span>
              {' · '}
              <a href={url} target="_blank" rel="noreferrer">{t('status.play')}</a>
            </span>
          )}
      {row.status === 'unconfirmed' ? <div style={STYLE_ERROR}>{t('status.unconfirmedHint')}</div> : null}
    </div>
  )
}
