/**
 * Reading workspace files (DESIGN §17.2).
 *
 * Reads go through the host's `ctx.fs` whenever it is mounted (every shipped
 * DSH bundle mounts it), so a sandboxed or remote (SSH) workspace is read where
 * it actually lives rather than on this machine. `ctx.fs` addresses files by an
 * opaque target that `resolve(path, { cwd })` returns; relative paths resolve
 * against the session's workspace.
 *
 * A call no session made (the workbench, tests) in a composition without a
 * filesystem service has no workspace to respect; there the same interface is
 * served by Node's `fs` on the host. A session call never falls back that way
 * (see {@link workspaceFsOf}).
 */

import { open, stat } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** `@deepseek-ai/dsh-fs` `FsTarget`: an opaque identity plus a path for messages. */
export interface WorkspaceTarget {
  readonly targetKey: unknown
  readonly displayPath: string
}

/** The slice of `ctx.fs` (`@deepseek-ai/dsh-fs` `FileSystem`) this plugin reads with. */
export interface WorkspaceFs {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<WorkspaceTarget>
  stat(target: WorkspaceTarget, signal?: AbortSignal): Promise<{ type: 'file' | 'directory' | 'other'; size?: number } | undefined>
  readBytes(target: WorkspaceTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  readByteRange(target: WorkspaceTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
}

/**
 * The host's filesystem service; for a call no session made, a host-local
 * stand-in when none is mounted; otherwise null.
 *
 * A session's workspace may live elsewhere: an SSH filesystem service exists
 * only while its connection does, so `ctx.fs` can be briefly absent in a remote
 * composition. Reading the same path on this machine then could upload a
 * different file — and pay for a generation on it. So a session call without
 * the service gets null, and the caller refuses.
 */
export function workspaceFsOf(ctx: Context, forSession: boolean): WorkspaceFs | null {
  const mounted = ctx.get('fs' as never) as WorkspaceFs | undefined
  if (mounted !== undefined) return mounted
  return forSession ? null : hostWorkspaceFs
}

/** `FsError` codes (`@deepseek-ai/dsh-fs`) read by string, so no class identity is needed. */
export function fsErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.startsWith('FS_') ? code : null
}

/** Host-local stand-in with `ctx.fs` semantics (also what tests mount as `fs`): missing → `stat` undefined, too large → `FS_TOO_LARGE`. */
export const hostWorkspaceFs: WorkspaceFs = {
  async resolve(path, options = {}) {
    const absolute = isAbsolute(path) ? path : resolvePath(options.cwd ?? process.cwd(), path)
    return { targetKey: absolute, displayPath: absolute }
  },
  async stat(target) {
    try {
      const info = await stat(String(target.targetKey))
      return { type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size }
    } catch {
      return undefined
    }
  },
  async readBytes(target, signal, maxBytes) {
    const info = await stat(String(target.targetKey))
    if (info.size > maxBytes) throw Object.assign(new Error(`${target.displayPath} exceeds ${maxBytes} bytes`), { code: 'FS_TOO_LARGE' })
    return readRange(String(target.targetKey), 0, info.size, signal)
  },
  async readByteRange(target, range, signal) {
    return readRange(String(target.targetKey), range.offset, range.length, signal)
  },
}

async function readRange(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted()
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
