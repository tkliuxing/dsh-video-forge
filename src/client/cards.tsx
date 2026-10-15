/**
 * The browser cards: one row per wire tool name, rendered inside the tool-call
 * block.
 *
 * Everything here is a pure function of the props the framework hands over. In
 * particular the media URL is *resolved* from the document-relative path the
 * host produced, and it is the only place this plugin builds a `src` for
 * `<video>` — no component reaches into session state to find bytes.
 */

import type { CSSProperties, ReactNode } from 'react'
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
}

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
    return (
      <div style={STYLE_ROW}>
        <div style={STYLE_TITLE}>{t('generate.failed')}</div>
        <div style={STYLE_ERROR}>{resultText(facts.content) ?? ''}</div>
      </div>
    )
  }

  const meta = generateMeta(facts.meta)
  if (meta === null) {
    // No persisted facts (a nested Code dispatch, or an older log): show the
    // model-facing text rather than inventing a player.
    return <div style={STYLE_ROW}>{resultText(facts.content) ?? null}</div>
  }

  const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI
  const url = meta.artifact === null ? null : resolveMediaUrl(meta.artifact.url, base)
  const percent = meta.progress === null ? null : Math.round(meta.progress * 100)

  return (
    <div style={STYLE_ROW}>
      <div style={STYLE_TITLE}>{t(statusKey(meta.status))}</div>
      <div style={STYLE_META}>
        {t('generate.meta', { provider: meta.provider, model: meta.model, status: meta.status })}
        {percent === null ? '' : ` · ${t('generate.progress', { percent })}`}
      </div>
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
      {url === null || meta.artifact === null
        ? null
        : <div style={STYLE_META}>{`${meta.artifact.path} · ${formatBytes(meta.artifact.bytes)}`}</div>}
    </div>
  )
}

/** `video_status` / `video_cancel` / `video_export` share a compact row. */
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
