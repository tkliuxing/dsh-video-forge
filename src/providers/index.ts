/**
 * The protocol table: given a configured provider and one of its models, hand
 * back the adapter that speaks to it.
 *
 * This is the single place that maps a protocol name to an implementation, so
 * adding a vendor is one entry here plus one adapter file — no call site knows
 * a vendor's wire shape.
 */

import type { ModelSetting, ProviderSetting } from '../settings.ts'
import { SUPPORTED_PROTOCOLS } from '../provider-presets.ts'
import type { ProtocolAdapter } from './adapter.ts'
import { arkVideosAdapter } from './ark-seedance.ts'
import { openAiVideosAdapter } from './generic-openai-videos.ts'

export type ProtocolId = ProviderSetting['protocol']

/**
 * Protocols this build knows how to speak. Declared in `provider-presets.ts`
 * beside the vendor catalogue, because the configuration card offers the same
 * list as choices; re-exported here so the protocol table stays one import away
 * from its call sites.
 */
export { SUPPORTED_PROTOCOLS }

/** Build the adapter for one provider+model pair. */
export function adapterFor(provider: ProviderSetting, model: ModelSetting): ProtocolAdapter {
  switch (provider.protocol) {
    case 'ark-seedance':
      return arkVideosAdapter({
        roles: {
          first: model.frameRoleFirst,
          last: model.frameRoleLast,
          reference: model.frameRoleReference,
        },
        generateAudio: model.generateAudio,
        // ARK watermarks unless told otherwise; the plugin never adds one by default.
        watermark: false,
      })
    case 'generic-openai-videos':
      return openAiVideosAdapter({ endpoints: provider.endpoints, model })
    default: {
      // Exhaustiveness: a new protocol in the union without an adapter fails here.
      const unreachable: never = provider.protocol
      throw new Error(`unsupported protocol: ${String(unreachable)}`)
    }
  }
}

/** Whether a cancel request can be forwarded for this pair. */
export function cancelSupported(provider: ProviderSetting, model: ModelSetting, adapter: ProtocolAdapter): boolean {
  return model.cancelable && adapter.cancelable
}

export { arkVideosAdapter, openAiVideosAdapter }
export type { AdapterContext, ProtocolAdapter } from './adapter.ts'
