/**
 * The progress badge: the frame-wide floating entry.
 *
 * `shell.overlay` is documented as the seat for "a badge, a toast stack or a
 * status pill" — the seat does **not** carry owner props and its direct children
 * are automatically clickable (the layer is click-through, `> *` is not), so a
 * full-bleed wrapper here would block the whole app. This entry therefore renders
 * `null` whenever there is nothing to say, and its visible surface is a small
 * fixed box in the corner.
 *
 * The workbench itself lives in `main`; this badge is only the ambient "something
 * is running" signal while the operator is looking at the conversation.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { fetchOverview } from './panel-api.ts'
import type { Translate } from './panel.tsx'

/** Props this badge reads; the overlay seat supplies a `t` seat via `locale`. */
export interface BadgeProps {
  t: Translate
}

const BOX: CSSProperties = {
  position: 'fixed',
  right: '16px',
  bottom: '16px',
  zIndex: 30,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 11px',
  borderRadius: '999px',
  border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
  background: 'var(--dsw-alias-bg-elevated, #fff)',
  color: 'inherit',
  fontSize: '0.85em',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
}

/** How often the badge asks the host, while it has something to show. */
const POLL_MS = 5000

/** The overlay badge. */
export function WorkbenchBadge(props: BadgeProps): ReactNode {
  const { t } = props
  const [active, setActive] = useState(0)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      const result = await fetchOverview()
      if (!live) return
      // A failed poll shows nothing rather than a stale count: a wrong number is
      // worse than no number.
      setActive(result.ok ? result.value.active : 0)
      // Only keep polling while there is work in flight; an idle badge is free.
      if (result.ok && result.value.active > 0) timer = setTimeout(() => { void tick() }, POLL_MS)
    }

    void tick()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  if (active === 0) return null
  return <div style={BOX}>{t('panel.active', { count: active })}</div>
}
