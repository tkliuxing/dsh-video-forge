/**
 * The configuration card.
 *
 * It renders in the harness's own plugin-configuration seat (see
 * `config-card-seat.ts`), and it splits editing with the harness deliberately:
 *
 * - **The harness owns schema-driven field editing.** Every value here is written
 *   through the same settings form the harness generates, so validation, layering
 *   and revision conflict handling stay in one place.
 * - **This card owns what needs explaining**: whether each provider's credential
 *   actually resolves (masked, never the value), what each model can do, what the
 *   artifact directory is, and the cost-relevant limits.
 *
 * Provider definitions themselves are a nested array, so they are edited as JSON
 * rather than as a hand-built matrix editor — full capability, no invented
 * widgets, and a parse error is reported instead of silently dropped.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { fetchOverview, type PanelProvider } from './panel-api.ts'
import type { VideoForgeKey } from './locales.ts'

export type Translate = (key: VideoForgeKey, params?: Record<string, unknown>) => string

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
const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '0.85em' }
const CELL: CSSProperties = { textAlign: 'left', padding: '4px 8px 4px 0', verticalAlign: 'top' }

/** The configuration card. */
export function SettingsCard(props: SettingsCardProps): ReactNode {
  const { t, useConfig, save, describeCredential, setCredential, unsetCredential } = props
  const snapshot = useConfig()
  const config = snapshot.value
  const [providers, setProviders] = useState<PanelProvider[] | null>(null)
  const [providersDraft, setProvidersDraft] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<ClientConfigShape>>({})
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [credentials, setCredentials] = useState<Record<string, CredentialState>>({})
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [keyBusy, setKeyBusy] = useState<string | null>(null)
  const [keyNotice, setKeyNotice] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void fetchOverview().then(result => {
      if (!live) return
      if (result.ok) setProviders(result.value.providers)
      else setError(result.error)
    })
    return () => { live = false }
  }, [])

  // Credential state comes from the host's own authority on the question, not from
  // the cached overview: only the host knows whether a key now exists.
  const refreshCredentials = useCallback(async (refs: readonly string[]) => {
    const entries = await Promise.all(refs.map(async ref => [ref, await describeCredential(ref)] as const))
    setCredentials(Object.fromEntries(entries))
  }, [describeCredential])

  // The key rows come from the configuration, not from the workbench API: the
  // credential channel is independent of it, and a provider whose status could not
  // be fetched is exactly the one whose key the operator may need to fix. Refs are
  // deduplicated because two providers may legitimately share one.
  const credentialRefs = useMemo(() => {
    const refs = new Set<string>()
    for (const provider of config?.providers ?? []) {
      const ref = (provider as { authRef?: unknown } | null)?.authRef
      if (typeof ref === 'string' && ref.trim() !== '') refs.add(ref.trim())
    }
    return [...refs]
  }, [config?.providers])

  useEffect(() => {
    if (credentialRefs.length > 0) void refreshCredentials(credentialRefs)
  }, [credentialRefs, refreshCredentials])

  const effective = useMemo(() => ({ ...config, ...draft }) as Partial<ClientConfigShape>, [config, draft])
  const dirty = Object.keys(draft).length > 0 || providersDraft !== null

  const setField = useCallback((key: keyof ClientConfigShape, value: unknown) => {
    setState('idle')
    setDraft(current => ({ ...current, [key]: value }))
  }, [])

  const commit = useCallback(async () => {
    const ops: ConfigPatch[] = Object.entries(draft).map(([key, value]) => ({ op: 'set', path: [key], value }))
    if (providersDraft !== null) {
      let parsed: unknown
      try {
        parsed = JSON.parse(providersDraft)
      } catch (parseError) {
        setState('failed')
        setError(`providers is not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
        return
      }
      if (!Array.isArray(parsed)) {
        setState('failed')
        setError('providers must be a JSON array')
        return
      }
      ops.push({ op: 'set', path: ['providers'], value: parsed })
    }
    if (ops.length === 0) return

    setState('saving')
    setError(null)
    const accepted = await save(ops)
    if (!accepted) {
      setState('failed')
      setError(t('config.saveFailed'))
      return
    }
    setState('saved')
    setDraft({})
    setProvidersDraft(null)
  }, [draft, providersDraft, save, t])

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
            disabled={!dirty || readOnly || state === 'saving'}
            onClick={() => { void commit() }}
          >
            {state === 'saving' ? t('config.saving') : t('config.save')}
          </button>
        </span>
      </header>

      {readOnly ? <div style={MUTED}>{t('config.readonly')}</div> : null}
      {error === null ? null : <div style={ERROR}>{error}</div>}
      {keyNotice === null ? null : <div style={MUTED}>{keyNotice}</div>}

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
            <input
              style={INPUT}
              value={effective.defaultProvider ?? ''}
              disabled={readOnly}
              onChange={event => { setField('defaultProvider', event.target.value) }}
            />
          </label>
          <label style={FIELD}>
            <span style={MUTED}>{t('config.defaultModel')}</span>
            <input
              style={INPUT}
              value={effective.defaultModel ?? ''}
              disabled={readOnly}
              onChange={event => { setField('defaultModel', event.target.value) }}
            />
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
        </div>
        <div style={MUTED}>{`${t('config.outputRoot')}: ${effective.outputDir === undefined || effective.outputDir === '' ? '(default)' : effective.outputDir}`}</div>
      </section>

      <section style={SECTION}>
        <strong style={HEADING}>{t('config.providers')}</strong>
        {providers === null
          ? <div style={MUTED}>{t('config.loading')}</div>
          : providers.length === 0
            ? <div style={MUTED}>{t('config.noProviders')}</div>
            : (
                <table style={TABLE}>
                  <tbody>
                    {providers.map(provider => (
                      <tr key={provider.id} style={{ borderTop: '1px solid var(--dsw-alias-border-l2, #eee)' }}>
                        <td style={CELL}>
                          <strong>{provider.id}</strong>
                          <div style={MUTED}>{provider.protocol}</div>
                          <div style={MUTED}>{provider.baseUrl}</div>
                        </td>
                        <td style={CELL}>
                          <div>{t('config.credential')}</div>
                          <div style={provider.credential.configured ? MUTED : ERROR}>
                            {credentialLabel(t, provider)}
                          </div>
                        </td>
                        <td style={CELL}>
                          <div>{t('config.models')}</div>
                          {provider.models.map(model => (
                            <div key={model.id} style={MUTED}>
                              {`${model.label}: ${model.modes.join('/')}`}
                              {model.durations.length === 0 ? '' : ` · ${model.durations.join('/')}s`}
                              {model.resolutions.length === 0 ? '' : ` · ${model.resolutions.join('/')}`}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
        <div style={MUTED}>{t('config.credentialHint')}</div>
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
        <label style={FIELD}>
          <span style={MUTED}>{`${t('config.providers')} (JSON)`}</span>
          <textarea
            style={{ ...INPUT, minHeight: '120px', fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: '0.85em' }}
            value={providersDraft ?? (config === undefined ? '' : JSON.stringify(config.providers, null, 2))}
            disabled={readOnly}
            onChange={event => {
              setState('idle')
              setProvidersDraft(event.target.value)
            }}
          />
        </label>
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
        {state?.configured === true ? <span style={MUTED}>{t('config.keyExists', { ref: ref_ })}</span> : null}
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

function credentialLabel(t: Translate, provider: PanelProvider): string {
  const { configured, masked, source, error } = provider.credential
  if (!configured) {
    return error === null ? t('config.credentialMissing') : `${t('config.credentialMissing')} — ${error}`
  }
  if (masked === null) return t('config.credentialKeyless')
  return t('config.credentialConfigured', { masked, source: source ?? '' })
}
