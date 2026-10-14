/**
 * The provider and model editor.
 *
 * This is the half of the configuration card that used to be a JSON textarea.
 * A textarea is a fine escape hatch and a poor primary control: it makes the
 * operator remember a schema, and it cannot say "this protocol takes these
 * frames" or "this model already has a key". So the list is edited as rows here
 * — one card per provider, one block per model — with every enumerable value
 * offered as a choice:
 *
 * - **Adding a provider picks from a catalogue** (`provider-presets.ts`), so the
 *   base URL, credential reference and starter model come from what this build
 *   actually supports rather than from memory.
 * - **The protocol is a select over `SUPPORTED_PROTOCOLS`**, and its label comes
 *   from the locale, never from the stored string.
 * - **Modes are checkboxes over `VIDEO_MODES`**, because a missing mode is a
 *   request the runtime refuses — better to show the four than to parse prose.
 * - **Capability lists stay empty by default.** Empty means "the provider
 *   decides" downstream (`assertGeometry`), so an empty field here is honest
 *   rather than unfinished.
 *
 * The component is presentational and holds one piece of state (which preset the
 * picker has selected): the provider list itself lives in the card, which owns
 * the save.
 */

import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  PROVIDER_PRESETS,
  SUPPORTED_PROTOCOLS,
  knownModelIds,
  newModel,
  parseNumberList,
  parseStringList,
  providerFromPreset,
  type ModelDraft,
  type ProviderDraft,
} from '../provider-presets.ts'
import { VIDEO_MODES, type VideoMode } from '../types.ts'
import type { PanelProvider } from './panel-api.ts'
import type { CredentialState } from './settings-card.ts'
import type { Translate, VideoForgeKey } from './locales.ts'

export interface ProvidersEditorProps {
  t: Translate
  providers: readonly ProviderDraft[]
  status: (id: string) => PanelProvider | undefined
  credential: (ref: string) => CredentialState | undefined
  readOnly: boolean
  onChange: (next: ProviderDraft[]) => void
}

const STACK: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '8px' }
const ROW: CSSProperties = { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }
const FIELD: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 160px', minWidth: '130px' }
const INPUT: CSSProperties = {
  padding: '6px 8px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
  background: 'var(--dsw-alias-bg-base, transparent)',
  color: 'inherit',
  font: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
}
const BUTTON: CSSProperties = { ...INPUT, cursor: 'pointer', flex: '0 0 auto', width: 'auto' }
const MUTED: CSSProperties = { fontSize: '0.82em', opacity: 0.75 }
const ERROR: CSSProperties = { fontSize: '0.82em', color: 'var(--dsw-alias-danger, #d4380d)' }
const OK: CSSProperties = { fontSize: '0.82em', color: 'var(--dsw-alias-success, #237804)' }
const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px 12px',
  borderRadius: '10px',
  border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
}
const MODEL_CARD: CSSProperties = { ...CARD, padding: '8px 10px', borderStyle: 'dashed' }
const MODES: CSSProperties = { display: 'flex', gap: '10px', flexWrap: 'wrap', border: 'none', margin: 0, padding: 0 }
const LEGEND: CSSProperties = { ...MUTED, padding: 0, marginBottom: '2px' }
const LINK: CSSProperties = { ...BUTTON, background: 'transparent', border: 'none', textDecoration: 'underline', padding: '2px 0' }

/** The provider list editor. */
export function ProvidersEditor(props: ProvidersEditorProps): ReactNode {
  const { t, providers, status, credential, readOnly, onChange } = props
  const [pick, setPick] = useState('')

  const patch = (index: number, change: Partial<ProviderDraft>): void => {
    onChange(providers.map((provider, at) => (at === index ? { ...provider, ...change } : provider)))
  }
  const remove = (index: number): void => {
    onChange(providers.filter((_provider, at) => at !== index))
  }
  const patchModel = (index: number, modelIndex: number, change: Partial<ModelDraft>): void => {
    onChange(providers.map((provider, at) => at !== index ? provider : {
      ...provider,
      models: provider.models.map((model, modelAt) => (modelAt === modelIndex ? { ...model, ...change } : model)),
    }))
  }
  const removeModel = (index: number, modelIndex: number): void => {
    onChange(providers.map((provider, at) => at !== index
      ? provider
      : { ...provider, models: provider.models.filter((_model, modelAt) => modelAt !== modelIndex) }))
  }
  const addModel = (index: number): void => {
    onChange(providers.map((provider, at) => at !== index
      ? provider
      : { ...provider, models: [...provider.models, newModel()] }))
  }

  const selected = PROVIDER_PRESETS.find(preset => preset.id === pick)

  return (
    <div style={STACK}>
      {providers.length === 0
        ? <div style={MUTED}>{t('config.noProviders')}</div>
        : providers.map((provider, index) => (
            // Index keys on purpose: these rows are positional and their ids are
            // typed into, so a value-derived key would remount the card on every
            // keystroke and drop the caret.
            <ProviderCard
              key={index}
              t={t}
              provider={provider}
              index={index}
              readOnly={readOnly}
              overview={status(provider.id)}
              credential={credential(provider.authRef.trim())}
              onPatch={change => { patch(index, change) }}
              onRemove={() => { remove(index) }}
              onPatchModel={(modelIndex, change) => { patchModel(index, modelIndex, change) }}
              onRemoveModel={modelIndex => { removeModel(index, modelIndex) }}
              onAddModel={() => { addModel(index) }}
            />
          ))}

      {/* Adding is two steps on purpose: the picker previews what the preset
          fills in — protocol, base URL, credential reference — before the row
          exists, so a mis-click is a glance rather than an undo. */}
      <div style={ROW}>
        <label style={{ ...FIELD, flex: '1 1 260px' }}>
          <span style={MUTED}>{t('config.addProvider')}</span>
          <select
            style={INPUT}
            value={pick}
            disabled={readOnly}
            onChange={event => { setPick(event.target.value) }}
          >
            <option value="">{t('config.addProviderPick')}</option>
            {PROVIDER_PRESETS.map(preset => (
              <option key={preset.id} value={preset.id}>{presetLabel(t, preset.id)}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          style={BUTTON}
          disabled={readOnly || selected === undefined}
          onClick={() => {
            if (selected === undefined) return
            onChange([...providers, providerFromPreset(selected, providers.map(entry => entry.id))])
            setPick('')
          }}
        >
          {t('config.add')}
        </button>
      </div>
      {selected === undefined
        ? <div style={MUTED}>{t('config.addProviderHint')}</div>
        : (
            <div style={MUTED}>
              {`${protocolLabel(t, selected.protocol)} · ${selected.baseUrl === '' ? t('config.baseUrlNeeded') : selected.baseUrl} · ${selected.authRef === '' ? t('config.credentialKeyless') : selected.authRef}`}
            </div>
          )}
    </div>
  )
}

interface ProviderCardProps {
  t: Translate
  provider: ProviderDraft
  index: number
  readOnly: boolean
  overview: PanelProvider | undefined
  credential: CredentialState | undefined
  onPatch: (change: Partial<ProviderDraft>) => void
  onRemove: () => void
  onPatchModel: (modelIndex: number, change: Partial<ModelDraft>) => void
  onRemoveModel: (modelIndex: number) => void
  onAddModel: () => void
}

function ProviderCard(props: ProviderCardProps): ReactNode {
  const { t, provider, index, readOnly, overview, credential, onPatch, onRemove, onPatchModel, onRemoveModel, onAddModel } = props
  const summary = credentialSummary(t, provider.authRef.trim(), overview, credential)
  const suggestions = knownModelIds(provider.protocol)
  const listId = `video-forge-models-${index}`

  return (
    <article style={CARD}>
      <div style={ROW}>
        <label style={FIELD}>
          <span style={MUTED}>{t('config.providerId')}</span>
          <input
            style={INPUT}
            value={provider.id}
            disabled={readOnly}
            onChange={event => { onPatch({ id: event.target.value }) }}
          />
        </label>
        <label style={FIELD}>
          <span style={MUTED}>{t('config.protocol')}</span>
          <select
            style={INPUT}
            value={provider.protocol}
            disabled={readOnly}
            onChange={event => { onPatch({ protocol: event.target.value as ProviderDraft['protocol'] }) }}
          >
            {SUPPORTED_PROTOCOLS.map(protocol => (
              <option key={protocol} value={protocol}>{protocolLabel(t, protocol)}</option>
            ))}
          </select>
        </label>
        <button type="button" style={BUTTON} disabled={readOnly} onClick={onRemove}>
          {t('config.removeProvider')}
        </button>
      </div>

      <div style={ROW}>
        <label style={{ ...FIELD, flex: '2 1 260px' }}>
          <span style={MUTED}>{t('config.baseUrl')}</span>
          <input
            style={INPUT}
            placeholder="https://…/v1"
            value={provider.baseUrl}
            disabled={readOnly}
            onChange={event => { onPatch({ baseUrl: event.target.value }) }}
          />
        </label>
        <label style={FIELD}>
          <span style={MUTED}>{t('config.authRef')}</span>
          <input
            style={INPUT}
            placeholder="PROVIDER_API_KEY"
            value={provider.authRef}
            disabled={readOnly}
            onChange={event => { onPatch({ authRef: event.target.value }) }}
          />
        </label>
      </div>
      <div style={MUTED}>{t('config.authRefHint')}</div>

      <div style={summary.tone === 'error' ? ERROR : summary.tone === 'ok' ? OK : MUTED}>
        {`${t('config.credential')}: ${summary.text}`}
      </div>

      <div style={STACK}>
        <div style={{ ...ROW, justifyContent: 'space-between' }}>
          <span style={MUTED}>{`${t('config.models')} · ${provider.models.length}`}</span>
          <button type="button" style={LINK} disabled={readOnly} onClick={onAddModel}>
            {`+ ${t('config.addModel')}`}
          </button>
        </div>
        {provider.models.length === 0
          ? <div style={MUTED}>{t('config.noModels')}</div>
          : provider.models.map((model, modelIndex) => (
              <ModelRow
                key={modelIndex}
                t={t}
                model={model}
                listId={listId}
                suggestions={suggestions}
                readOnly={readOnly}
                onPatch={change => { onPatchModel(modelIndex, change) }}
                onRemove={() => { onRemoveModel(modelIndex) }}
              />
            ))}
        <datalist id={listId}>
          {suggestions.map(id => <option key={id} value={id} />)}
        </datalist>
      </div>
    </article>
  )
}

interface ModelRowProps {
  t: Translate
  model: ModelDraft
  listId: string
  suggestions: readonly string[]
  readOnly: boolean
  onPatch: (change: Partial<ModelDraft>) => void
  onRemove: () => void
}

function ModelRow(props: ModelRowProps): ReactNode {
  const { t, model, listId, suggestions, readOnly, onPatch, onRemove } = props
  const toggleMode = (mode: VideoMode, on: boolean): void => {
    onPatch({ modes: on ? [...model.modes, mode] : model.modes.filter(entry => entry !== mode) })
  }

  return (
    <div style={MODEL_CARD}>
      <div style={ROW}>
        <label style={{ ...FIELD, flex: '2 1 200px' }}>
          <span style={MUTED}>{t('config.modelId')}</span>
          <input
            style={INPUT}
            {...(suggestions.length === 0 ? {} : { list: listId })}
            placeholder={suggestions[0] ?? 'model-id'}
            value={model.id}
            disabled={readOnly}
            onChange={event => { onPatch({ id: event.target.value }) }}
          />
        </label>
        <label style={FIELD}>
          <span style={MUTED}>{t('config.modelLabel')}</span>
          <input
            style={INPUT}
            value={model.label}
            disabled={readOnly}
            onChange={event => { onPatch({ label: event.target.value }) }}
          />
        </label>
        <button type="button" style={BUTTON} disabled={readOnly} onClick={onRemove}>
          {t('config.removeModel')}
        </button>
      </div>

      <div style={ROW}>
        <fieldset style={{ ...MODES, flex: '2 1 260px' }}>
          <legend style={LEGEND}>{t('config.modes')}</legend>
          {VIDEO_MODES.map(mode => (
            <label key={mode} style={{ ...MUTED, display: 'flex', gap: '4px', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={model.modes.includes(mode)}
                disabled={readOnly}
                onChange={event => { toggleMode(mode, event.target.checked) }}
              />
              {t(`panel.mode.${mode}` as VideoForgeKey)}
            </label>
          ))}
        </fieldset>
        <label style={{ ...MUTED, display: 'flex', gap: '4px', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={model.cancelable}
            disabled={readOnly}
            onChange={event => { onPatch({ cancelable: event.target.checked }) }}
          />
          {t('config.cancelable')}
        </label>
        <label style={{ ...MUTED, display: 'flex', gap: '4px', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={model.generateAudio}
            disabled={readOnly}
            onChange={event => { onPatch({ generateAudio: event.target.checked }) }}
          />
          {t('config.generateAudio')}
        </label>
      </div>

      <div style={ROW}>
        <ListField
          label={t('config.durations')}
          value={model.durations}
          readOnly={readOnly}
          placeholder="5, 10"
          format={values => values.join(', ')}
          parse={parseNumberList}
          onChange={durations => { onPatch({ durations }) }}
        />
        <ListField
          label={t('config.resolutions')}
          value={model.resolutions}
          readOnly={readOnly}
          placeholder="720p, 1080p"
          format={values => values.join(', ')}
          parse={parseStringList}
          onChange={resolutions => { onPatch({ resolutions }) }}
        />
        <ListField
          label={t('config.aspectRatios')}
          value={model.aspectRatios}
          readOnly={readOnly}
          placeholder="16:9, 9:16"
          format={values => values.join(', ')}
          parse={parseStringList}
          onChange={aspectRatios => { onPatch({ aspectRatios }) }}
        />
      </div>
    </div>
  )
}

interface ListFieldProps<T extends string | number> {
  label: string
  value: readonly T[]
  readOnly: boolean
  placeholder: string
  format: (values: readonly T[]) => string
  parse: (text: string) => T[]
  onChange: (values: T[]) => void
}

/**
 * A comma-separated list, edited as text.
 *
 * The draft is a list and the control is a string, and the two must not fight:
 * parsing on every keystroke is what keeps `5, 1` typeable (a strictly derived
 * value would rewrite it to `5` mid-word). So the local text wins while it still
 * parses to the value in hand, and is re-derived only when the value arrives
 * from elsewhere — a preset, a JSON edit, another row's change. The comparison
 * is by array identity, which is exactly the signal React gives us: this row's
 * array is replaced only when something actually replaced it.
 */
function ListField<T extends string | number>(props: ListFieldProps<T>): ReactNode {
  const { label, value, readOnly, placeholder, format, parse, onChange } = props
  const [text, setText] = useState(() => format(value))
  const [handled, setHandled] = useState<readonly T[]>(value)

  if (handled !== value) {
    setHandled(value)
    const current = parse(text)
    if (current.length !== value.length || current.some((entry, index) => entry !== value[index])) {
      setText(format(value))
    }
  }

  return (
    <label style={FIELD}>
      <span style={MUTED}>{label}</span>
      <input
        style={INPUT}
        placeholder={placeholder}
        value={text}
        disabled={readOnly}
        onChange={event => {
          const next = event.target.value
          setText(next)
          onChange(parse(next))
        }}
      />
    </label>
  )
}

/** Locale label for a protocol id. */
export function protocolLabel(t: Translate, protocol: string): string {
  return t(`config.protocol.${protocol}` as VideoForgeKey)
}

/** Locale label for a vendor or generic-relay preset. */
export function presetLabel(t: Translate, presetId: string): string {
  return t(`config.preset.${presetId}` as VideoForgeKey)
}

/** A one-line credential verdict for one provider row. */
export interface CredentialSummary {
  text: string
  tone: 'ok' | 'muted' | 'error'
}

/**
 * What to say about one provider's credential, and how loudly.
 *
 * Two sources answer different questions on purpose: the workbench API knows
 * whether the reference resolves and returns a masked tail, while the host
 * credential service knows whether the reference exists at all. An empty
 * reference is neither of those — it means the endpoint is meant to run without
 * a key. The most specific true statement wins, a reported error is shown
 * verbatim rather than paraphrased, and "not configured" is muted rather than
 * red: it is the normal state of a provider you have just added.
 */
export function credentialSummary(
  t: Translate,
  ref: string,
  overview: PanelProvider | undefined,
  state: CredentialState | undefined,
): CredentialSummary {
  if (ref === '') return { text: t('config.credentialKeyless'), tone: 'muted' }
  const status = overview !== undefined && overview.authRef === ref ? overview.credential : undefined
  if (status !== undefined && status.error !== null) {
    return { text: `${t('config.credentialMissing')} — ${status.error}`, tone: 'error' }
  }
  if (status?.configured === true) {
    if (status.masked === null) return { text: t('config.credentialKeyless'), tone: 'muted' }
    return { text: t('config.credentialConfigured', { masked: status.masked, source: status.source ?? '' }), tone: 'ok' }
  }
  if (state?.configured === true) return { text: t('config.keyExists', { ref }), tone: 'ok' }
  if (state !== undefined && state.error !== null) return { text: state.error, tone: 'error' }
  return { text: t('config.credentialMissing'), tone: 'muted' }
}
