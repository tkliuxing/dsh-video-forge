/**
 * The workbench page: the browser surface for people rather than models.
 *
 * It renders in `main`, the shell's central panel, selected by the sidebar row
 * registered under the same id — the shape every shipped panel uses. (The
 * frame-wide `shell.overlay` layer is for a badge or a toast; a docked workbench
 * belongs in allocated space, not on top of the conversation.)
 *
 * The page owns no generation logic: every action is a call to `/video-forge/api`,
 * which lands on the same `operations.ts` the model tools use. What it owns is the
 * operator's view — what is running, what it costs, what finished, and where the
 * artifact went.
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import {
  cancelGeneration,
  exportArtifact,
  fetchOverview,
  submitGeneration,
  type PanelOverview,
  type PanelTask,
  type SubmitInput,
} from './panel-api.ts'
import type { VideoMode } from '../types.ts'

import type { Translate } from './locales.ts'

/** Re-exported for the surfaces composed from this module's cards. */
export type { Translate }

/** Props this page reads: a subset of the composed `main`-slot props. */
export interface WorkbenchProps {
  t: Translate
}

const PAGE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '16px',
  overflowY: 'auto',
  height: '100%',
  boxSizing: 'border-box',
}

const PANEL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  maxWidth: '720px',
  width: '100%',
}

const ROW: CSSProperties = { display: 'flex', gap: '8px', flexWrap: 'wrap' }
const FIELD: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 140px', minWidth: '120px' }
const INPUT: CSSProperties = {
  padding: '6px 8px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
  background: 'var(--dsw-alias-bg-base, transparent)',
  color: 'inherit',
  font: 'inherit',
}
const BUTTON: CSSProperties = { ...INPUT, cursor: 'pointer', flex: '0 0 auto' }
const MUTED: CSSProperties = { fontSize: '0.82em', opacity: 0.75 }
const ERROR: CSSProperties = { fontSize: '0.85em', color: 'var(--dsw-alias-danger, #d4380d)' }
const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '8px 10px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l2, #eee)',
}

/** The workbench page. */
export function WorkbenchPage(props: WorkbenchProps): ReactNode {
  const { t } = props
  const [overview, setOverview] = useState<PanelOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(true)
  const [draft, setDraft] = useState<SubmitInput>({ prompt: '', mode: 't2v' })
  const [references, setReferences] = useState('')
  const [exportTarget, setExportTarget] = useState('')

  const refresh = useCallback(async () => {
    const result = await fetchOverview()
    if (result.ok) {
      setOverview(result.value)
      setError(null)
    } else {
      setError(result.error)
    }
  }, [])

  // Poll only while auto-refresh is on: a page nobody is watching must not keep
  // asking the host for state it is not showing.
  useEffect(() => {
    if (!auto) return undefined
    void refresh()
    const timer = setInterval(() => { void refresh() }, 4000)
    return () => { clearInterval(timer) }
  }, [auto, refresh])

  const submit = useCallback(async () => {
    setBusy(true)
    setNotice(null)
    const referencesList = references.split('\n').map(line => line.trim()).filter(line => line !== '')
    const input: SubmitInput = {
      ...draft,
      ...(referencesList.length === 0 ? {} : { referenceImages: referencesList }),
    }
    const result = await submitGeneration(input)
    setBusy(false)
    if (result.ok) {
      setDraft(current => ({ ...current, prompt: '' }))
      setNotice(t('panel.submitted', {
        task: result.value.task.taskId,
        provider: result.value.task.provider,
        model: result.value.task.model,
      }))
      await refresh()
      return
    }
    setError(result.error)
  }, [draft, references, refresh, t])

  const cancel = useCallback(async (taskId: string) => {
    const result = await cancelGeneration(taskId)
    if (result.ok) {
      setNotice(t('panel.cancelled', { task: taskId }))
      await refresh()
      return
    }
    setError(result.error)
  }, [refresh, t])

  const exportTask = useCallback(async (taskId: string, overwrite: boolean) => {
    const result = await exportArtifact(taskId, exportTarget, overwrite)
    if (result.ok) {
      setNotice(t('panel.exported', { path: result.value.path }))
      return
    }
    // A refused overwrite is the common case; retry once, explicitly.
    if (!overwrite && /already exists/.test(result.error)) {
      const confirmed = await exportArtifact(taskId, exportTarget, true)
      if (confirmed.ok) {
        setNotice(t('panel.exported', { path: confirmed.value.path }))
        return
      }
      setError(confirmed.error)
      return
    }
    setError(result.error)
  }, [exportTarget, t])

  const providers = overview?.providers ?? []
  const tasks = overview?.tasks ?? []

  // The selected target's declared capabilities drive the geometry controls: a
  // model that declares its lengths, resolutions or aspect ratios is a choice,
  // and one that declares none is free text. Offering a value the provider will
  // refuse — or hiding one it accepts — is how a workbench turns into a guessing
  // game, so each control follows the model rather than a house default.
  const selectedProvider = providers.find(provider => provider.id === draft.provider) ?? providers[0]
  const selectedModel = selectedProvider?.models.find(model => model.id === draft.model) ?? selectedProvider?.models[0]
  const durations = selectedModel?.durations ?? []
  const resolutions = selectedModel?.resolutions ?? []
  const aspectRatios = selectedModel?.aspectRatios ?? []

  return (
    <div style={PAGE}>
      <section style={PANEL} aria-label={t('panel.title')}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <strong>{t('panel.title')}</strong>
          <span style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <label style={MUTED}>
              <input type="checkbox" checked={auto} onChange={event => { setAuto(event.target.checked) }} />
              {' '}{t('panel.autoRefresh')}
            </label>
            <button type="button" style={BUTTON} onClick={() => { void refresh() }}>{t('panel.refresh')}</button>
          </span>
        </header>

        {error === null ? null : <div style={ERROR}>{error}</div>}
        {notice === null ? null : <div style={MUTED}>{notice}</div>}
        {overview !== null && !overview.enabled ? <div style={ERROR}>{t('config.enabled')}: false</div> : null}

        <div style={ROW}>
          <label style={{ ...FIELD, flex: '1 1 100%' }}>
            <span style={MUTED}>{t('panel.prompt')}</span>
            <textarea
              style={{ ...INPUT, minHeight: '56px', resize: 'vertical' }}
              placeholder={t('panel.promptPlaceholder')}
              value={draft.prompt}
              onChange={event => { setDraft(current => ({ ...current, prompt: event.target.value })) }}
            />
          </label>
        </div>

        <div style={ROW}>
          <label style={FIELD}>
            <span style={MUTED}>{t('panel.mode')}</span>
            <select
              style={INPUT}
              value={draft.mode ?? 't2v'}
              onChange={event => { setDraft(current => ({ ...current, mode: event.target.value as VideoMode })) }}
            >
              {(['t2v', 'i2v', 'flf2v', 's2v'] as const).map(mode => (
                <option key={mode} value={mode}>{t(`panel.mode.${mode}`)}</option>
              ))}
            </select>
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('panel.provider')}</span>
            <select
              style={INPUT}
              value={draft.provider ?? ''}
              onChange={event => { setDraft(current => ({ ...current, provider: event.target.value, model: '' })) }}
            >
              <option value="">{t('panel.default')}</option>
              {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.id}</option>)}
            </select>
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('panel.model')}</span>
            <select
              style={INPUT}
              value={draft.model ?? ''}
              onChange={event => { setDraft(current => ({ ...current, model: event.target.value })) }}
            >
              <option value="">{t('panel.default')}</option>
              {(providers.find(provider => provider.id === draft.provider) ?? providers[0])?.models
                .map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </label>
        </div>

        <div style={ROW}>
          <label style={FIELD}>
            <span style={MUTED}>{t('panel.duration')}</span>
            <select
              style={INPUT}
              value={draft.durationSeconds ?? ''}
              disabled={durations.length === 0}
              onChange={event => {
                const value = event.target.value
                setDraft(current => ({ ...current, durationSeconds: value === '' ? null : Number(value) }))
              }}
            >
              <option value="">{t('panel.duration.any')}</option>
              {durations.map(seconds => <option key={seconds} value={seconds}>{`${seconds}s`}</option>)}
            </select>
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('panel.resolution')}</span>
            {resolutions.length === 0
              ? (
                  <input
                    style={INPUT}
                    value={draft.resolution ?? ''}
                    placeholder={t('panel.undeclared')}
                    onChange={event => { setDraft(current => ({ ...current, resolution: event.target.value })) }}
                  />
                )
              : (
                  <select
                    style={INPUT}
                    value={draft.resolution ?? ''}
                    onChange={event => { setDraft(current => ({ ...current, resolution: event.target.value })) }}
                  >
                    <option value="">{t('panel.default')}</option>
                    {resolutions.map(value => <option key={value} value={value}>{value}</option>)}
                  </select>
                )}
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('panel.aspectRatio')}</span>
            {aspectRatios.length === 0
              ? (
                  <input
                    style={INPUT}
                    value={draft.aspectRatio ?? ''}
                    placeholder={t('panel.undeclared')}
                    onChange={event => { setDraft(current => ({ ...current, aspectRatio: event.target.value })) }}
                  />
                )
              : (
                  <select
                    style={INPUT}
                    value={draft.aspectRatio ?? ''}
                    onChange={event => { setDraft(current => ({ ...current, aspectRatio: event.target.value })) }}
                  >
                    <option value="">{t('panel.default')}</option>
                    {aspectRatios.map(value => <option key={value} value={value}>{value}</option>)}
                  </select>
                )}
          </label>
        </div>

        {draft.mode === 'i2v' || draft.mode === 'flf2v'
          ? (
              <div style={ROW}>
                <label style={FIELD}>
                  <span style={MUTED}>{t('panel.firstFrame')}</span>
                  <input
                    style={INPUT}
                    value={draft.firstFrame ?? ''}
                    onChange={event => { setDraft(current => ({ ...current, firstFrame: event.target.value })) }}
                  />
                </label>
                {draft.mode === 'flf2v'
                  ? (
                      <label style={FIELD}>
                        <span style={MUTED}>{t('panel.lastFrame')}</span>
                        <input
                          style={INPUT}
                          value={draft.lastFrame ?? ''}
                          onChange={event => { setDraft(current => ({ ...current, lastFrame: event.target.value })) }}
                        />
                      </label>
                    )
                  : null}
              </div>
            )
          : null}

        {draft.mode === 's2v'
          ? (
              <label style={FIELD}>
                <span style={MUTED}>{t('panel.referenceImages')}</span>
                <textarea
                  style={{ ...INPUT, minHeight: '48px' }}
                  value={references}
                  onChange={event => { setReferences(event.target.value) }}
                />
              </label>
            )
          : null}

        <div style={ROW}>
          <button
            type="button"
            style={{ ...BUTTON, fontWeight: 600 }}
            disabled={busy || draft.prompt.trim() === ''}
            onClick={() => { void submit() }}
          >
            {busy ? t('panel.submitting') : t('panel.submit')}
          </button>
          <span style={{ ...MUTED, flex: '1 1 200px' }}>{t('panel.costNote')}</span>
        </div>

        <div style={{ ...ROW, borderTop: '1px solid var(--dsw-alias-border-l2, #eee)', paddingTop: '10px' }}>
          <strong style={{ flex: '1 1 100%' }}>
            {t('panel.tasks')}
            {overview === null ? '' : ` · ${t('panel.active', { count: overview.active })} · ${t('panel.usage', { tasks: overview.usage.tasks, bytes: formatBytes(overview.usage.bytes) })}`}
          </strong>
        </div>

        {overview !== null && (overview.usage.overTaskLimit || overview.usage.overByteLimit)
          ? <div style={MUTED}>{t('panel.overLimit')}</div>
          : null}

        {overview === null
          ? <div style={MUTED}>{t('panel.loading')}</div>
          : tasks.length === 0
            ? <div style={MUTED}>{t('panel.empty')}</div>
            : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {tasks.map(task => (
                    <TaskCard
                      key={task.taskId}
                      task={task}
                      t={t}
                      exportTarget={exportTarget}
                      onExportTarget={setExportTarget}
                      onCancel={cancel}
                      onExport={exportTask}
                    />
                  ))}
                </div>
              )}
      </section>
    </div>
  )
}

interface TaskCardProps {
  task: PanelTask
  t: Translate
  exportTarget: string
  onExportTarget: (value: string) => void
  onCancel: (taskId: string) => Promise<void>
  onExport: (taskId: string, overwrite: boolean) => Promise<void>
}

function TaskCard({ task, t, exportTarget, onExportTarget, onCancel, onExport }: TaskCardProps): ReactNode {
  const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI
  const playable = task.playUrl === null ? null : safeUrl(task.playUrl, base)
  const percent = task.progress === null ? '' : ` ${Math.round(task.progress * 100)}%`
  return (
    <article style={CARD}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>{task.taskId}</strong>
        <span style={MUTED}>{`${task.status}${percent} · ${task.provider}/${task.model} · ${task.mode}`}</span>
      </div>
      <div style={MUTED}>{task.prompt}</div>
      {task.error === null ? null : <div style={ERROR}>{task.error}</div>}
      {playable === null
        ? null
        : <video controls playsInline preload="metadata" src={playable} style={{ width: '100%', maxWidth: '420px', borderRadius: '8px', background: '#000' }} />}
      {task.artifactPath === null
        ? null
        : <div style={MUTED}>{`${task.artifactPath}${task.artifactBytes === null ? '' : ` · ${formatBytes(task.artifactBytes)}`}`}</div>}
      <div style={ROW}>
        {task.status === 'queued' || task.status === 'running'
          ? (
              <button type="button" style={BUTTON} onClick={() => { void onCancel(task.taskId) }}>
                {t('panel.cancel')}
              </button>
            )
          : null}
        {task.artifactPath === null
          ? null
          : (
              <>
                <input
                  style={{ ...INPUT, flex: '1 1 200px' }}
                  placeholder={t('panel.exportPrompt')}
                  value={exportTarget}
                  onChange={event => { onExportTarget(event.target.value) }}
                />
                <button
                  type="button"
                  style={BUTTON}
                  disabled={exportTarget.trim() === ''}
                  onClick={() => { void onExport(task.taskId, false) }}
                >
                  {t('panel.export')}
                </button>
              </>
            )}
      </div>
    </article>
  )
}

/** Resolve a playable media URL; anything that is not http(s) is refused. */
export function safeUrl(url: string, base: string): string | null {
  try {
    const resolved = new URL(url, base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null
  } catch {
    return null
  }
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
