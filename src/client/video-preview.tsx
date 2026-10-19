/**
 * The mp4 previewer in the file viewer (M5).
 *
 * The harness's document preview dispatches on file suffix: `mp4` is in its
 * unviewable list today, and that list is consulted only when no renderer
 * claims the suffix — so registering one definition is enough to make an mp4
 * open in the same tab as text and images, with the shipped toolbar (including
 * the host's own "open in app") above it.
 *
 * The body loads nothing itself: the owner asks for a renderer-owned content
 * (`loading: 'renderer'`), hands over the resources' metadata, and the browser
 * fetches the bytes. That is why the source is a URL rather than a byte array —
 * a 1080p clip does not belong in memory, and the harness's `/api/file` cannot
 * seek. The plugin's stream route serves it with ranges; on a host that could
 * not register that route, the harness's bounded URL is the fallback and a large
 * file simply reports that it cannot play here.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
// The `useResource` standard prop is declared by the resource model's client half;
// without this type import the composed props do not carry it.
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { harnessFileUrl, streamUrl } from './video-panel-model.ts'
import type { Translate } from './locales.ts'

/** This renderer's identity: the registry entry's id is also its body's slot key. */
export const VIDEO_PREVIEW_ID = 'dsh-video-forge/mp4'

/** The suffix this renderer claims. One entry; widening it is this line plus the stream route's map. */
export const VIDEO_PREVIEW_EXTENSIONS = ['mp4'] as const

/**
 * The `file` metadata this body reads: `absolutePath` for the URL, `version` so a
 * reload can tell a fresh read from a cached one.
 *
 * Declared structurally rather than imported: pulling `useResource`'s real type
 * would mean depending on the resources package and on the workspace-files
 * protocol augmentation, for one hook whose runtime presence the slot already
 * guarantees ("the original file address, also readable through the standard
 * useResource hook" — `DocumentBodyOwner`).
 */
export interface FileResourceMeta {
  readonly status: 'none' | 'loading' | 'live' | 'failed'
  readonly value?: { readonly absolutePath?: string | undefined; readonly version?: string | undefined } | undefined
  readonly failure?: { readonly message?: string | undefined } | undefined
}

/** What this body is composed with; the slot supplies the rest. */
export type VideoPreviewProps = DocumentPreviewProps & { t: Translate }

const STYLE_FRAME: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  minHeight: '100%',
  padding: '8px',
}

const STYLE_PLAYER: CSSProperties = {
  display: 'block',
  maxWidth: '100%',
  maxHeight: '100%',
  borderRadius: 'var(--dsw-radius-md, 12px)',
  background: '#000',
}

const STYLE_STATUS: CSSProperties = {
  margin: 0,
  fontSize: '0.9em',
  opacity: 0.8,
}

/**
 * Render one mp4.
 * @param props - the document seat's content request, resource metadata hooks, and copy.
 * @returns the player, its loading line, or why it cannot play here.
 */
export function VideoPreview(props: VideoPreviewProps): ReactNode {
  const { content, resourceAddress, t } = props
  // Narrowed to the two fields read, so this file needs no dependency on the
  // `file` protocol's published type.
  const meta = (props.useResource as unknown as (address: string) => FileResourceMeta)(resourceAddress)
  const request = content.kind === 'renderer' ? content : undefined
  const revision = request?.revision ?? 0
  const absolutePath = meta.value?.absolutePath
  const version = meta.value?.version
  // Which route to ask: the plugin's ranged one first, the harness's bounded one
  // second. A host without the stream route answers 404 there, so switching on
  // the element's own error costs no extra probe.
  const [source, setSource] = useState<'stream' | 'harness'>('stream')
  const [broken, setBroken] = useState(false)
  const reported = useRef<string | null>(null)
  const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI
  const url = absolutePath === undefined
    ? null
    : source === 'stream'
      ? streamUrl(base, absolutePath, `${version ?? ''}-${revision}`)
      : harnessFileUrl(base, absolutePath)

  // The owner leaves its loading state only when the body says the content is
  // shown (`renderer` mode has no owner-side spinner). Reported once per
  // version+source, so a re-render cannot loop through the store.
  useEffect(() => {
    if (request === undefined || version === undefined || url === null || broken) return
    const mark = `${version}:${source}`
    if (reported.current === mark) return
    reported.current = mark
    request.loaded(version)
  }, [request, version, url, source, broken])

  if (meta.status === 'failed') {
    return <p style={STYLE_STATUS} role="alert">{meta.failure?.message ?? t('preview.unavailable')}</p>
  }
  if (url === null) return <p style={STYLE_STATUS}>{t('preview.loading')}</p>
  if (broken) return <p style={STYLE_STATUS} role="alert">{t('preview.cannotPlay')}</p>

  return (
    <div style={STYLE_FRAME}>
      <video
        // The revision is part of the identity so the toolbar's reload really
        // remounts the element instead of keeping the buffer.
        key={`${revision}:${source}`}
        src={url}
        controls
        playsInline
        preload="metadata"
        style={STYLE_PLAYER}
        onError={() => {
          if (source === 'stream') setSource('harness')
          else setBroken(true)
        }}
      />
    </div>
  )
}
