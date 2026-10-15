/**
 * Settled usage on a ledger row (DESIGN §16.5): what the provider says a task
 * consumed, recorded once the task has finished. Money is never computed here —
 * a price table is a separate, overridable estimate on top of these numbers.
 */

import type { ProviderStatus, ProviderUsage, TaskBilling, VideoTask } from './types.ts'

/**
 * The billing record for a task its provider has just settled. No usage on a
 * failed or cancelled task reads as "none reported" (MiniMax answers `{}` there);
 * no usage on a *succeeded* task is unknown — that generation was billed, and an
 * absent field must not read as free.
 */
export function settledBilling(usage: ProviderUsage | null, status: ProviderStatus, now = new Date()): TaskBilling {
  if (usage !== null) return { state: 'reported', ...usage, settledAt: now.toISOString() }
  return { state: status === 'succeeded' ? 'unknown' : 'none', tokens: null, outputSeconds: null, fields: {}, settledAt: now.toISOString() }
}

/** The provider's query window closed before anyone asked: unknown, never zero. */
export function unknownBilling(now = new Date()): TaskBilling {
  return { state: 'unknown', tokens: null, outputSeconds: null, fields: {}, settledAt: now.toISOString() }
}

/**
 * Whether a finished task still owes us its usage: the provider created it, it
 * has settled, and its usage has not been recorded. A task that was never
 * created (`not_submitted`) has no provider id and owes nothing.
 */
export function awaitingBilling(task: VideoTask): boolean {
  return (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled')
    && task.providerTaskId !== null
    && (task.billing === undefined || task.billing === null)
}
