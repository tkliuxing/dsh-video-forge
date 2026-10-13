/**
 * Credential resolution, in the order DESIGN §8 fixes:
 *
 *   1. the provider's configured `authRef`, through `ctx.credentials.resolve`
 *   2. the environment variable `<PROVIDER>_API_KEY`
 *
 * Never a cross-provider fallback: submitting a prompt to the wrong vendor with
 * the wrong key is worse than failing loudly. The resolve result is an object
 * (`{ value, source }`) — the shipped precedent of testing it against a string
 * silently never matched, which is exactly the bug this file exists to avoid.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { ConfigError, environmentFallbackName, isLoopback, type ProviderSetting } from './settings.ts'

/** Result of one credential lookup, including the source for diagnostics. */
export interface ApiKeyLookup {
  value: string | null
  source: string
}

/**
 * Resolve the credential one provider needs. A keyless loopback gateway is
 * legitimate; anything else without a key is a configuration error naming the
 * exact reference to set.
 */
export async function resolveApiKey(ctx: Context, provider: ProviderSetting): Promise<ApiKeyLookup> {
  const ref = provider.authRef.trim()
  if (ref !== '') {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(ref as Parameters<typeof credentials.resolve>[0])
      // Object destructuring is mandatory here; see the module doc.
      if (resolved !== undefined && resolved.value !== '') {
        return { value: resolved.value, source: resolved.source }
      }
    }
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient !== '') return { value: ambient, source: 'process-env' }
    throw new ConfigError(
      `provider "${provider.id}" needs the credential ${ref}: store it through the credentials service (the Web settings page writes it) or export ${ref} in the launching environment`,
    )
  }

  const fallbackName = environmentFallbackName(provider.id)
  const ambient = process.env[fallbackName]
  if (ambient !== undefined && ambient !== '') return { value: ambient, source: 'process-env' }

  if (isLoopback(provider.baseUrl)) return { value: null, source: 'none-loopback' }
  throw new ConfigError(
    `provider "${provider.id}" declares no authRef and its baseUrl (${provider.baseUrl}) is not loopback; set authRef to the credential reference name (for example ${fallbackName})`,
  )
}

/** The masked form shown to the browser: never the value. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return '…'
  return `${value.slice(0, 2)}…${value.slice(-4)}`
}
