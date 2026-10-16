/**
 * The trust fence for the panel API.
 *
 * The harness authenticates its own index and bundle requests, but it does **not**
 * gate a plugin's routes: whatever a plugin registers is reachable by anything
 * that can reach the port. The panel API reads task prompts and can cancel paid
 * tasks, so it must decide for itself — and the shipped family fence is the right
 * answer:
 *
 * - **loopback always passes** (the desktop case, which is how this is normally
 *   used);
 * - **a live paired-device cookie passes** when the remote-web-ui pairing service
 *   is loaded, so a paired phone or tablet keeps working;
 * - **everything else is refused**, so an unpaired LAN browser gets a 403.
 *
 * The socket address is authoritative here; `X-Forwarded-For` is never consulted,
 * because a header anyone can set is not a trust signal. The same-origin markers
 * are required as well, which costs the browser nothing and blocks a cross-site
 * page from driving the panel API through the operator's own browser.
 */

import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names loopback (127/8, ::1, IPv4-mapped ::ffff:127/8). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level fence: a loopback socket address **and** a loopback `Host`, plus
 * the browser's own same-origin markers.
 */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Structural shape of the optional pairing service; no package dependency. */
interface PairingAccess {
  isPairedDevice(request: IncomingMessage): boolean
}

/**
 * Whether this request may enter the panel API.
 *
 * `ctx.get` is read structurally rather than through `inject`, so the plugin keeps
 * working on a composition without the pairing service — the fence then stays
 * loopback-only, which is exactly the intent.
 */
export function isTrustedRequest(ctx: Context, request: IncomingMessage): boolean {
  if (isLoopbackRequest(request)) return true
  const service = ctx.get('remoteWebUiPairing' as never, false) as unknown
  if (service === undefined || service === null) return false
  const pairing = service as Partial<PairingAccess>
  return typeof pairing.isPairedDevice === 'function' && pairing.isPairedDevice(request) === true
}
