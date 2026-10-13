/**
 * Which seat the configuration card occupies on the harness that is running.
 *
 * dsh 0.1.7 moved a bundle's own configuration out of Settings: the sidebar's
 * Plugins page owns it now, and `plugins.bundle.config` — keyed by the bundle's
 * package name — is the seat that page renders on the bundle's own page. The
 * Settings list still declares `settings.plugins.tab`, and it is the only seat
 * available on a deployment that does not mount the plugin manager page.
 *
 * Three facts about the slot registry shape this module:
 *
 * - The harness declares the official seat before an external plugin's `apply()`
 *   runs, so the first attempt normally succeeds — but on the older line it does
 *   not exist at all. `register` **throws** for an undeclared seat, and that
 *   refusal is the signal; nothing is predicted or feature-detected.
 * - `slots/changed` is emitted synchronously from inside both `register` and a
 *   disposer, so an unguarded reconcile re-enters itself mid-move and registers
 *   the card twice into the seat it is leaving. The latch below prevents that.
 * - The card is therefore in exactly **one** seat at any moment: the official one
 *   when the harness renders it, the Settings list otherwise, and the fallback is
 *   disposed before the official one is taken.
 *
 * This module holds the policy and no component, so the moves are unit-tested
 * against a fake registry.
 */

/** The official keyed seat on the sidebar Plugins page, keyed by package name. */
export const BUNDLE_CONFIG_SEAT = 'plugins.bundle.config'

/** The list seat inside Settings → Plugins, declared by the settings section. */
export const SETTINGS_TAB_SEAT = 'settings.plugins.tab'

/** The slice of the client slot registry this module uses. */
export interface SeatRegistry {
  /**
   * Contribute one entry, or throw when the seat is not declared.
   * @param key - declared slot key to inject into.
   * @param callback - runs while that declaration is live; returns its disposer.
   */
  inject(key: string, callback: () => () => void): () => void
}

/** The slice of the browser plugin context this module uses. */
export interface SeatHost {
  readonly slots: SeatRegistry
  /** Subscribe to the registry's change event; absent on a host with no event bus. */
  on?(event: 'slots/changed', listener: (key: string) => void): (() => void) | undefined
}

/** How to install the card into each seat; each throws when that seat is undeclared. */
export interface CardSeats {
  /** The official keyed seat; the caller keys it by bundle package name. */
  readonly official: () => (() => void) | undefined
  /** The Settings list seat; the caller supplies its id, label and locale. */
  readonly settingsTab: () => (() => void) | undefined
  /** Called once per seat that refused a registration, for a diagnostic. */
  readonly onRefused?: (seat: string, error: unknown) => void
}

/**
 * Install the card into the seat this harness renders, and follow the harness if
 * that seat only becomes available later.
 *
 * @param host - the client context's registry and event bus.
 * @param seats - the two contributions plus an optional refusal diagnostic.
 * @returns one disposer that removes the card and stops watching.
 */
export function installConfigCard(host: SeatHost, seats: CardSeats): () => void {
  /** The live official registration, while the card occupies that seat. */
  let official: (() => void) | undefined
  /** The live fallback registration, while the card occupies that seat instead. */
  let fallback: (() => void) | undefined
  /** Set by the returned disposer: every later reconcile is a no-op. */
  let stopped = false
  /** Re-entrancy latch: the registry emits `slots/changed` from inside register and dispose. */
  let reconciling = false
  const refused = new Set<string>()

  /** One attempt, reporting a refusal once instead of on every retry. */
  const attempt = (seat: string, register: () => (() => void) | undefined): (() => void) | undefined => {
    try {
      return register()
    } catch (error) {
      if (!refused.has(seat)) {
        refused.add(seat)
        seats.onRefused?.(seat, error)
      }
      return undefined
    }
  }

  /** Take the official seat when it is declared, retiring the fallback first. */
  const reconcile = (): void => {
    if (stopped || reconciling || official !== undefined) return
    reconciling = true
    try {
      const dispose = attempt(BUNDLE_CONFIG_SEAT, seats.official)
      if (dispose === undefined) return
      official = dispose
      const previous = fallback
      fallback = undefined
      previous?.()
    } finally {
      reconciling = false
    }
  }

  reconcile()

  // The fallback claims the Settings list only while the official seat is absent.
  // Its declaration arrives when the settings section mounts, which is after the
  // shell declares the official seats — so on a harness that renders the Plugins
  // page this callback finds `official` already live and contributes nothing.
  const stopWaiting = host.slots.inject(SETTINGS_TAB_SEAT, () => {
    if (stopped || official !== undefined || fallback !== undefined) return () => {}
    const dispose = attempt(SETTINGS_TAB_SEAT, seats.settingsTab)
    if (dispose === undefined) return () => {}
    fallback = dispose
    // The registration above emits `slots/changed`, so a reconcile may have taken
    // the official seat before this assignment: the card would then sit in two
    // seats. Re-check rather than assume which ran first.
    if (official !== undefined) {
      fallback = undefined
      dispose()
      return () => {}
    }
    return () => {
      const current = fallback
      fallback = undefined
      current?.()
    }
  })

  const stopWatching = host.on?.('slots/changed', () => { reconcile() })

  return () => {
    stopped = true
    stopWatching?.()
    stopWaiting()
    const dropOfficial = official
    official = undefined
    dropOfficial?.()
    const dropFallback = fallback
    fallback = undefined
    dropFallback?.()
  }
}
