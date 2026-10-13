/**
 * The sidebar glyph.
 *
 * It carries no navigation state: the shell owns the click and the highlight, and
 * a glyph that decided its own appearance would disagree with the shell.
 */

import type { ReactNode } from 'react'

/** The workbench row's icon. */
export function WorkbenchIcon(): ReactNode {
  return (
    <svg viewBox="0 0 64 64" width="20" height="20" aria-hidden="true" focusable="false">
      <rect x="6" y="10" width="52" height="44" rx="8" fill="none" stroke="currentColor" strokeWidth="4" />
      <path d="M26 24v16l14-8z" fill="currentColor" />
    </svg>
  )
}
