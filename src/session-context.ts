/**
 * The calling session, as far as a tool can learn it (DESIGN §17.2): its id,
 * its workspace folder, and the permission mode it runs under.
 *
 * DSH does not confine plugin code — a host plugin runs in-process outside the
 * workspace sandbox — and has no way for a tool to declare that it writes files.
 * Built-in tools ask `ctx.sandboxPolicy` themselves; so does this plugin. The
 * mode is captured at submit time and stored with the task, because the task
 * outlives the call and the user can change the mode mid-session.
 *
 * The service shapes below are the slices this plugin uses, written against
 * DSH 0.2.0-rc.2 (`@deepseek-ai/dsh-sandbox`, `@deepseek-ai/dsh-sandbox-policy`,
 * `@deepseek-ai/dsh-fs`). They are read through `ctx.get` rather than imported,
 * so the plugin needs no further peer dependency and keeps working in a
 * composition that mounts none of them.
 */

import type { Context } from '@deepseek-ai/cordis'

/** `@deepseek-ai/dsh-sandbox` `SandboxMode`. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/** The slice of a DSH agent a tool's `exec.agent` carries that this plugin reads. */
export interface AgentLike {
  readonly id: string
  readonly session?: { readonly header?: { readonly cwd?: string | undefined } | undefined } | undefined
}

/** `ctx.sandboxPolicy` (SandboxPolicyService), the one method used. */
interface SandboxPolicyLike {
  resolve(request?: { session?: unknown }): { mode: SandboxMode; workspaceRoot: string }
}

/** What a task remembers about the session that submitted it. */
export interface TaskSession {
  /** Session id (DSH uses the agent id as the session id). */
  id: string
  /** The session's workspace folder, in the execution world's path syntax. */
  cwd: string | null
  /**
   * Permission mode at submit time; null when the composition mounts no
   * sandbox policy, which means writes are not fenced at all.
   */
  mode: SandboxMode | null
}

/** The calling session, or null for a call no session made (the workbench). */
export function sessionContextOf(ctx: Context, agent: AgentLike | undefined): TaskSession | null {
  if (agent === undefined) return null
  const header = agent.session?.header
  const cwd = typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : null
  const policy = ctx.get('sandboxPolicy' as never) as SandboxPolicyLike | undefined
  let mode: SandboxMode | null = null
  if (policy !== undefined && agent.session !== undefined) {
    const resolved = policy.resolve({ session: agent.session })
    mode = SANDBOX_MODES.includes(resolved.mode) ? resolved.mode : null
  }
  return { id: agent.id, cwd, mode }
}

/** A stored session record this build can trust, or null. */
export function taskSessionOf(value: unknown): TaskSession | null {
  if (typeof value !== 'object' || value === null) return null
  const session = value as Partial<TaskSession>
  if (typeof session.id !== 'string' || session.id === '') return null
  return {
    id: session.id,
    cwd: typeof session.cwd === 'string' && session.cwd !== '' ? session.cwd : null,
    mode: typeof session.mode === 'string' && SANDBOX_MODES.includes(session.mode) ? session.mode : null,
  }
}
