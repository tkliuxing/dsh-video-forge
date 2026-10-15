/**
 * The configuration card.
 *
 * It renders in the harness's own plugin-configuration seat (see
 * `config-card-seat.ts`), and it splits editing with the harness deliberately:
 *
 * - **The harness owns schema-driven field editing.** Every value here is written
 *   through the same settings form the harness generates, so validation, layering
 *   and revision conflict handling stay in one place.
 * - **This card owns what needs explaining**: which providers this build
 *   supports and how to add one, whether each credential actually resolves
 *   (masked, never the value), what each model can do, where artifacts land, and
 *   the cost-relevant limits.
 *
 * The provider list has two views onto one value: rows (`providers-editor.tsx`)
 * for the ordinary case, and a JSON textarea for the case rows cannot express.
 * Editing either one is editing the list — the text is the authority while it is
 * what the operator typed, the rows are the authority after a row edit, and no
 * save ever writes a mix of the two.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  authRefs,
  readProviders,
  serializeProvider,
  validateDrafts,
  type DraftProblem,
  type ProviderDraft,
} from '../provider-presets.ts'
import { fetchOverview, type PanelOverview, type PanelProvider } from './panel-api.ts'
import { ProvidersEditor, credentialSummary } from './providers-editor.tsx'
import type { Translate } from './locales.ts'

export type { Translate }

/** Persisted plugin config as the browser sees it. */
export interface ClientConfigShape {
  enabled: boolean
  providers: unknown[]
  defaultProvider: string
  defaultModel: string
  outputDir: string
  pollIntervalMs: number
  waitSecondsMax: number
  dedupeWindowSeconds: number
  maxConcurrent: number
  maxTasks: number
  maxGiB: number
  requestTimeoutMs: number
}

/** One settings-form op, matching `SettingsPathOpView`. */
export interface ConfigPatch {
  op: 'set'
  path: readonly (string | number)[]
  value: unknown
}

/** A reactive read of the host form. */
export interface ConfigSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: ClientConfigShape | undefined
  writable: boolean
}

/** Host-reported credential state for one reference; never carries a value. */
export interface CredentialState {
  configured: boolean
  source: string | null
  writable: boolean
  error: string | null
}

/** What `apply` hands the card; the component never sees `ctx`. */
export interface ConfigFace {
  useConfig(): ConfigSnapshot
  /** Resolves true when the host accepted the write. */
  save(ops: readonly ConfigPatch[]): Promise<boolean>
  /** Ask the host whether one reference resolves, and from where. */
  describeCredential(ref: string): Promise<CredentialState>
  /** Store a secret. Resolves null on success, else a message to show verbatim. */
  setCredential(ref: string, value: string): Promise<string | null>
  /** Remove a stored secret. Resolves null on success, else a message. */
  unsetCredential(ref: string): Promise<string | null>
}

export interface SettingsCardProps {
  t: Translate
  useConfig: ConfigFace['useConfig']
  save: ConfigFace['save']
  describeCredential: ConfigFace['describeCredential']
  setCredential: ConfigFace['setCredential']
  unsetCredential: ConfigFace['unsetCredential']
}

/**
 * How the provider list is currently being edited.
 *
 * `null` means "as stored". The other two variants are not two copies of the
 * list but two *sources* for it: a row edit produces drafts, a text edit
 * produces JSON, and each render derives the other view from whichever one is
 * live. That is what keeps the form and the textarea from disagreeing.
 */
type ProviderEdit =
  | { kind: 'form'; drafts: ProviderDraft[] }
  | { kind: 'json'; text: string }
  | null

const WRAP: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0' }
const SECTION: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '8px' }
const ROW: CSSProperties = { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }
const FIELD: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 160px', minWidth: '130px' }
const INPUT: CSSProperties = {
  padding: '6px 8px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
  background: 'var(--dsw-alias-bg-base, transparent)',
  color: 'inherit',
  font: 'inherit',
}
const MUTED: CSSProperties = { fontSize: '0.82em', opacity: 0.75 }
const ERROR: CSSProperties = { fontSize: '0.85em', color: 'var(--dsw-alias-danger, #d4380d)' }
const OK: CSSProperties = { fontSize: '0.85em', color: 'var(--dsw-alias-success, #237804)' }
const HEADING: CSSProperties = { margin: 0, fontSize: '0.95em' }
const BUTTON: CSSProperties = { ...INPUT, cursor: 'pointer', flex: '0 0 auto' }
const SUMMARY: CSSProperties = { cursor: 'pointer', fontSize: '0.85em', opacity: 0.8 }

/** The configuration card. */
export function SettingsCard(props: SettingsCardProps): ReactNode {
  const { t, useConfig, save, describeCredential, setCredential, unsetCredential } = props
  const snapshot = useConfig()
  const config = snapshot.value

  const [overview, setOverview] = useState<PanelOverview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [edit, setEdit] = useState<ProviderEdit>(null)
  const [jsonOpen, setJsonOpen] = useState(false)
  const [draft, setDraft] = useState<Partial<ClientConfigShape>>({})
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  // The row a refused save points at, so the editor can open it.
  const [problem, setProblem] = useState<DraftProblem | null>(null)
  const [credentials, setCredentials] = useState<Record<string, CredentialState>>({})
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [keyBusy, setKeyBusy] = useState<string | null>(null)
  const [keyNotice, setKeyNotice] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void fetchOverview().then(result => {
      if (!live) return
      if (result.ok) {
        setOverview(result.value)
        setOverviewError(null)
      } else {
        setOverviewError(result.error)
      }
    })
    return () => { live = false }
  }, [])

  // --- the provider list, in whichever view is live -------------------------

  const stored = useMemo(() => readProviders(config?.providers), [config?.providers])

  // A text edit parses to a raw value, which is what a save would write; the
  // rows are derived from the same text so both views show one list. The derived
  // rows are memoised on the parse result rather than on the render, because a
  // fresh array per render would re-run the credential effect forever.
  const jsonValue = useMemo(() => (edit?.kind === 'json' ? parseJson(edit.text) : null), [edit])
  const jsonBroken = edit?.kind === 'json' && (jsonValue === null || !jsonValue.ok)
  const jsonDrafts = useMemo(
    () => (jsonValue !== null && jsonValue.ok ? readProviders(jsonValue.value).drafts : []),
    [jsonValue],
  )

  const drafts: ProviderDraft[] = edit === null
    ? stored.drafts
    : edit.kind === 'form'
      ? edit.drafts
      : jsonDrafts

  const jsonText = useMemo(() => {
    if (edit?.kind === 'json') return edit.text
    if (stored.problem !== null) return JSON.stringify(config?.providers ?? [], null, 2)
    return JSON.stringify(drafts.map(serializeProvider), null, 2)
  }, [edit, stored.problem, config?.providers, drafts])

  const statusById = useCallback(
    (id: string): PanelProvider | undefined => overview?.providers.find(provider => provider.id === id),
    [overview],
  )

  // --- credentials ----------------------------------------------------------

  // Credential state comes from the host's own authority on the question, not
  // from the cached overview: only the host knows whether a key now exists.
  const refreshCredentials = useCallback(async (refs: readonly string[]) => {
    const entries = await Promise.all(refs.map(async ref => [ref, await describeCredential(ref)] as const))
    setCredentials(Object.fromEntries(entries))
  }, [describeCredential])

  // The key rows follow the *edited* list, so a provider that was just added
  // already offers its key. An empty reference means "no key needed", which is
  // why the refs are collected rather than rendered per row.
  const credentialRefs = useMemo(() => authRefs(drafts), [drafts])

  useEffect(() => {
    if (credentialRefs.length > 0) void refreshCredentials(credentialRefs)
  }, [credentialRefs, refreshCredentials])

  // --- derived values -------------------------------------------------------

  const effective = useMemo(() => ({ ...config, ...draft }) as Partial<ClientConfigShape>, [config, draft])
  const dirty = Object.keys(draft).length > 0 || edit !== null

  const defaultProviderId = (effective.defaultProvider ?? '') !== ''
    ? effective.defaultProvider ?? ''
    : drafts[0]?.id ?? ''
  const defaultModels = drafts.find(provider => provider.id === defaultProviderId)?.models ?? []

  const setField = useCallback((key: keyof ClientConfigShape, value: unknown) => {
    setState('idle')
    setDraft(current => ({ ...current, [key]: value }))
  }, [])

  const editProviders = useCallback((next: ProviderDraft[]) => {
    setState('idle')
    setError(null)
    setProblem(null)
    setEdit({ kind: 'form', drafts: next })
  }, [])

  const discard = useCallback(() => {
    setDraft({})
    setEdit(null)
    setError(null)
    setProblem(null)
    setState('idle')
  }, [])

  const commit = useCallback(async () => {
    const ops: ConfigPatch[] = Object.entries(draft).map(([key, value]) => ({ op: 'set', path: [key], value }))

    if (edit !== null) {
      if (edit.kind === 'form') {
        const problem = validateDrafts(edit.drafts)
        if (problem !== null) {
          setState('failed')
          setError(problemMessage(t, problem))
          setProblem(problem)
          return
        }
        ops.push({ op: 'set', path: ['providers'], value: edit.drafts.map(serializeProvider) })
      } else {
        const parsed = parseJson(edit.text)
        if (parsed === null) {
          setState('failed')
          setJsonOpen(true)
          setError(t('config.providersJsonEmpty'))
          return
        }
        if (!parsed.ok) {
          setState('failed')
          setJsonOpen(true)
          setError(t('config.providersJsonInvalid', { message: parsed.message }))
          return
        }
        if (!Array.isArray(parsed.value)) {
          setState('failed')
          setJsonOpen(true)
          setError(t('config.providersJsonNotArray'))
          return
        }
        // The text is written verbatim, but not blindly: a list the runtime could
        // not use — an entry that is not a provider, two rows under one id, a row
        // with no base URL — is refused here, where the sentence can name the row.
        const read = readProviders(parsed.value)
        if (read.problem !== null) {
          setState('failed')
          setJsonOpen(true)
          setError(t('config.providersJsonShape'))
          return
        }
        const problem = validateDrafts(read.drafts)
        if (problem !== null) {
          setState('failed')
          setJsonOpen(true)
          setError(problemMessage(t, problem))
          setProblem(problem)
          return
        }
        // What the operator typed is what gets written: the textarea is the
        // lower-level view, so it is not re-normalised on the way through.
        ops.push({ op: 'set', path: ['providers'], value: parsed.value })
      }
    }

    if (ops.length === 0) return

    setState('saving')
    setError(null)
    setProblem(null)
    const accepted = await save(ops)
    if (!accepted) {
      // A refusal carries no detail — the form's `mutate` answers true or false —
      // so the header's own "Save failed" is the whole message. A second copy of
      // the same sentence here would be noise, which is why the error line stays
      // reserved for problems the operator can act on.
      setState('failed')
      setError(null)
      return
    }
    setState('saved')
    setDraft({})
    setEdit(null)
  }, [draft, edit, save, t])

  if (snapshot.status === 'loading') return <div style={{ ...WRAP, ...MUTED }}>{t('config.loading')}</div>

  const readOnly = !snapshot.writable || snapshot.status === 'unavailable'

  return (
    <div style={WRAP}>
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' }}>
        <h3 style={HEADING}>{t('config.title')}</h3>
        <span style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {dirty ? <span style={MUTED}>{t('config.unsaved')}</span> : null}
          {state === 'saved' ? <span style={OK}>{t('config.saved')}</span> : null}
          {state === 'failed' ? <span style={ERROR}>{t('config.saveFailed')}</span> : null}
          <button
            type="button"
            style={{ ...INPUT, cursor: dirty && !readOnly ? 'pointer' : 'default' }}
            disabled={!dirty || readOnly}
            onClick={discard}
          >
            {t('config.discard')}
          </button>
          <button
            type="button"
            style={{ ...INPUT, cursor: dirty && !readOnly ? 'pointer' : 'default' }}
            disabled={!dirty || readOnly || state === 'saving'}
            onClick={() => { void commit() }}
          >
            {state === 'saving' ? t('config.saving') : t('config.save')}
          </button>
        </span>
      </header>

      {readOnly ? <div style={MUTED}>{t('config.readonly')}</div> : null}
      {error === null ? null : <div style={ERROR}>{error}</div>}
      {overviewError === null ? null : <div style={MUTED}>{`${t('config.overviewUnavailable')} ${overviewError}`}</div>}
      {keyNotice === null ? null : <div style={MUTED}>{keyNotice}</div>}

      <section style={SECTION}>
        <strong style={HEADING}>{t('config.providers')}</strong>
        {stored.problem !== null && edit === null
          ? <div style={MUTED}>{t('config.providersUnrepresentable')}</div>
          : (
              <ProvidersEditor
                t={t}
                providers={drafts}
                status={statusById}
                credential={ref => credentials[ref]}
                readOnly={readOnly}
                problem={problem}
                onChange={editProviders}
              />
            )}

        <details
          open={jsonOpen || jsonBroken}
          onToggle={event => { setJsonOpen(event.currentTarget.open) }}
        >
          <summary style={SUMMARY}>{t('config.providersJson')}</summary>
          <label style={{ ...FIELD, marginTop: '6px' }}>
            <span style={MUTED}>{`${t('config.providers')} (JSON)`}</span>
            <textarea
              style={{
                ...INPUT,
                minHeight: '140px',
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                fontSize: '0.85em',
                borderColor: jsonBroken ? 'var(--dsw-alias-danger, #d4380d)' : undefined,
              }}
              value={jsonText}
              disabled={readOnly}
              onChange={event => {
                setState('idle')
                setEdit({ kind: 'json', text: event.target.value })
              }}
            />
          </label>
          <div style={MUTED}>{t('config.providersJsonHint')}</div>
        </details>

        <div style={MUTED}>{t('config.credentialHint')}</div>
        {credentialRefs.length === 0
          ? null
          : (
              <button
                type="button"
                style={BUTTON}
                disabled={readOnly}
                onClick={() => { void refreshCredentials(credentialRefs) }}
              >
                {t('config.recheck')}
              </button>
            )}
        {credentialRefs.map(ref => (
          <CredentialRow
            key={ref}
            ref_={ref}
            t={t}
            state={credentials[ref]}
            draft={keyDraft[ref] ?? ''}
            busy={keyBusy === ref}
            onDraft={value => {
              setKeyNotice(null)
              setKeyDraft(current => ({ ...current, [ref]: value }))
            }}
            onSave={async () => {
              const value = (keyDraft[ref] ?? '').trim()
              if (value === '') {
                setKeyNotice(t('config.keyRequired'))
                return
              }
              setKeyBusy(ref)
              const failure = await setCredential(ref, value)
              setKeyBusy(null)
              if (failure !== null) {
                setKeyNotice(failure)
                return
              }
              // Never keep the secret in component state after it reached the host.
              setKeyDraft(current => ({ ...current, [ref]: '' }))
              setKeyNotice(t('config.keyStored'))
              await refreshCredentials([ref])
            }}
            onClear={async () => {
              setKeyBusy(ref)
              const failure = await unsetCredential(ref)
              setKeyBusy(null)
              if (failure !== null) {
                setKeyNotice(failure)
                return
              }
              setKeyNotice(t('config.keyRemoved'))
              await refreshCredentials([ref])
            }}
          />
        ))}
      </section>

      <section style={SECTION}>
        <strong style={HEADING}>{t('config.defaults')}</strong>
        <div style={ROW}>
          <label style={FIELD}>
            <span style={MUTED}>{t('config.enabled')}</span>
            <input
              type="checkbox"
              checked={effective.enabled === true}
              disabled={readOnly}
              onChange={event => { setField('enabled', event.target.checked) }}
            />
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('config.defaultProvider')}</span>
            <select
              style={INPUT}
              value={effective.defaultProvider ?? ''}
              disabled={readOnly || drafts.length === 0}
              onChange={event => {
                // A model id belongs to one provider: carrying a stale one across
                // a provider switch would make every default call fail the
                // "does not declare model" check, so it is dropped with the switch.
                setState('idle')
                setDraft(current => ({ ...current, defaultProvider: event.target.value, defaultModel: '' }))
              }}
            >
              <option value="">{t('config.defaultFirst')}</option>
              {/* Index keys: a duplicate provider id is exactly what the editor
                  refuses to save, so the option list must survive seeing one. */}
              {drafts.map((provider, index) => <option key={index} value={provider.id}>{provider.id}</option>)}
            </select>
            {drafts.length === 0 ? <span style={MUTED}>{t('config.noProvidersYet')}</span> : null}
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('config.defaultModel')}</span>
            <select
              style={INPUT}
              value={effective.defaultModel ?? ''}
              disabled={readOnly || defaultModels.length === 0}
              onChange={event => { setField('defaultModel', event.target.value) }}
            >
              <option value="">{t('config.defaultFirstModel')}</option>
              {defaultModels.map((model, index) => (
                <option key={index} value={model.id}>
                  {model.label === '' ? model.id : `${model.label} (${model.id})`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section style={SECTION}>
        <strong style={HEADING}>{t('config.limits')}</strong>
        <div style={ROW}>
          <label style={FIELD}>
            <span style={MUTED}>{t('config.maxConcurrent')}</span>
            <input
              style={INPUT}
              type="number"
              min={1}
              value={effective.maxConcurrent ?? 1}
              disabled={readOnly}
              onChange={event => { setField('maxConcurrent', Number(event.target.value)) }}
            />
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('config.pollInterval')}</span>
            <input
              style={INPUT}
              type="number"
              min={1000}
              value={effective.pollIntervalMs ?? 5000}
              disabled={readOnly}
              onChange={event => { setField('pollIntervalMs', Number(event.target.value)) }}
            />
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('config.dedupeWindow')}</span>
            <input
              style={INPUT}
              type="number"
              min={0}
              value={effective.dedupeWindowSeconds ?? 120}
              disabled={readOnly}
              onChange={event => { setField('dedupeWindowSeconds', Number(event.target.value)) }}
            />
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('config.waitSecondsMax')}</span>
            <input
              style={INPUT}
              type="number"
              min={0}
              value={effective.waitSecondsMax ?? 600}
              disabled={readOnly}
              onChange={event => { setField('waitSecondsMax', Number(event.target.value)) }}
            />
          </label>
        </div>
      </section>

      <section style={SECTION}>
        <strong style={HEADING}>{t('config.storage')}</strong>
        <div style={ROW}>
          <label style={FIELD}>
            <span style={MUTED}>{t('config.maxTasks')}</span>
            <input
              style={INPUT}
              type="number"
              min={1}
              value={effective.maxTasks ?? 200}
              disabled={readOnly}
              onChange={event => { setField('maxTasks', Number(event.target.value)) }}
            />
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('config.maxGiB')}</span>
            <input
              style={INPUT}
              type="number"
              min={0}
              value={effective.maxGiB ?? 20}
              disabled={readOnly}
              onChange={event => { setField('maxGiB', Number(event.target.value)) }}
            />
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('config.requestTimeout')}</span>
            <input
              style={INPUT}
              type="number"
              min={1000}
              value={effective.requestTimeoutMs ?? 120_000}
              disabled={readOnly}
              onChange={event => { setField('requestTimeoutMs', Number(event.target.value)) }}
            />
          </label>
          <label style={{ ...FIELD, flex: '2 1 260px' }}>
            <span style={MUTED}>{t('config.outputDir')}</span>
            <input
              style={INPUT}
              placeholder={overview?.settings.outputRoot ?? ''}
              value={effective.outputDir ?? ''}
              disabled={readOnly}
              onChange={event => { setField('outputDir', event.target.value) }}
            />
          </label>
        </div>
        <div style={MUTED}>
          {`${t('config.outputRoot')}: ${overview?.settings.outputRoot ?? t('config.outputRootUnknown')}`}
        </div>
      </section>
    </div>
  )
}

interface CredentialRowProps {
  ref_: string
  t: Translate
  state: CredentialState | undefined
  draft: string
  busy: boolean
  onDraft: (value: string) => void
  onSave: () => Promise<void>
  onClear: () => Promise<void>
}

/**
 * The key entry for one credential reference.
 *
 * The value is write-only by construction: it is typed into a password field, sent
 * to the host, and then dropped from component state. Nothing on this page can read
 * a secret back — the host credential service has no method that returns one — so
 * the only thing shown afterwards is whether the reference resolves and from where.
 */
function CredentialRow({ ref_, t, state, draft, busy, onDraft, onSave, onClear }: CredentialRowProps): ReactNode {
  const writable = state?.writable !== false
  return (
    <div style={{ ...ROW, alignItems: 'flex-end' }}>
      <label style={{ ...FIELD, flex: '1 1 220px' }}>
        <span style={MUTED}>{`${t('config.keyLabel')} · ${ref_}`}</span>
        <input
          style={INPUT}
          type="password"
          autoComplete="off"
          placeholder={t('config.keyPlaceholder')}
          value={draft}
          disabled={busy || !writable}
          onChange={event => { onDraft(event.target.value) }}
        />
        {state?.configured === true
          ? <span style={MUTED}>{credentialSummary(t, ref_, undefined, state).text}</span>
          : null}
        {state?.writable === false ? <span style={MUTED}>{t('config.keyReadOnly')}</span> : null}
        {state?.error === null || state?.error === undefined ? null : <span style={ERROR}>{state.error}</span>}
      </label>
      <button
        type="button"
        style={BUTTON}
        disabled={busy || !writable}
        onClick={() => { void onSave() }}
      >
        {busy ? t('config.keySaving') : t('config.keySave')}
      </button>
      <button
        type="button"
        style={BUTTON}
        disabled={busy || !writable || state?.configured !== true}
        onClick={() => { void onClear() }}
      >
        {t('config.keyClear')}
      </button>
    </div>
  )
}

/** Parse the JSON textarea; null when the text is empty, else the value or the reason. */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } | null {
  if (text.trim() === '') return null
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (parseError: unknown) {
    return { ok: false, message: parseError instanceof Error ? parseError.message : String(parseError) }
  }
}

/** Word a configuration mistake so the operator knows which row and field to fix. */
function problemMessage(t: Translate, problem: DraftProblem): string {
  switch (problem.code) {
    case 'providerIdEmpty':
      return t('config.problem.providerIdEmpty', { index: problem.index + 1 })
    case 'providerIdDuplicate':
      return t('config.problem.providerIdDuplicate', { index: problem.index + 1, id: problem.id })
    case 'baseUrlEmpty':
      return t('config.problem.baseUrlEmpty', { index: problem.index + 1 })
    case 'modelIdEmpty':
      return t('config.problem.modelIdEmpty', { index: problem.index + 1, model: problem.modelIndex + 1 })
    case 'modelIdDuplicate':
      return t('config.problem.modelIdDuplicate', { index: problem.index + 1, model: problem.modelIndex + 1, id: problem.id })
  }
}
