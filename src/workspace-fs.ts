/**
 * Reading workspace files (DESIGN §17.2).
 *
 * Reads go through the host's `ctx.fs` whenever it is mounted (every shipped
 * DSH bundle mounts it), so a sandboxed or remote (SSH) workspace is read where
 * it actually lives rather than on this machine. `ctx.fs` addresses files by an
 * opaque target that `resolve(path, { cwd })` returns; relative paths resolve
 * against the session's workspace.
 *
 * A call no session made (tests, a bare composition) in a composition without a
 * filesystem service has no workspace to respect; there the same interface is
 * served by Node's `fs` on the host. A session call never falls back that way
 * (see {@link workspaceFsOf}).
 */

import { mkdir, open, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
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
  /** Direct children of a directory, in stable name order. Optional only for test doubles. */
  listDir?(target: WorkspaceTarget, signal?: AbortSignal): Promise<{ name: string; type: 'file' | 'directory' | 'other' }[]>
  /**
   * The absolute path of a target in the filesystem's execution world.
   * Optional only because the slice is also implemented by test doubles; every
   * DSH backend has it.
   */
  processPath?(target: WorkspaceTarget): string
  /**
   * Map a path on this machine into the execution world, or undefined when that
   * world cannot see this machine's files (an SSH workspace).
   */
  processPathFromHostPath?(hostPath: string): string | undefined
  /**
   * Atomic UTF-8 write. `sandboxPolicy` fences it the way the host fences its
   * own tools; `createIfAbsent` refuses to replace an existing file
   * (`FS_NOT_OBSERVED`).
   */
  writeText?(
    target: WorkspaceTarget,
    content: string,
    expected?: { kind: 'createIfAbsent' },
    signal?: AbortSignal,
    sandboxPolicy?: { mode: string; workspaceRoot: string; sessionId?: string },
  ): Promise<unknown>
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
    const absolute = isAbsolute(path) ? resolvePath(path) : resolvePath(options.cwd ?? process.cwd(), path)
    // Like DSH's local backend: the identity is the real path of the deepest
    // existing ancestor plus the rest, so one file has one key.
    return { targetKey: await canonical(absolute), displayPath: absolute }
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
  async listDir(target) {
    const entries = await readdir(String(target.targetKey), { withFileTypes: true })
    return entries
      .map(entry => ({ name: entry.name, type: entry.isFile() ? 'file' as const : entry.isDirectory() ? 'directory' as const : 'other' as const }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  },
  processPath: target => String(target.targetKey),
  processPathFromHostPath: hostPath => (isAbsolute(hostPath) ? resolvePath(hostPath) : undefined),
  async writeText(target, content, expected, signal, sandboxPolicy) {
    signal?.throwIfAborted()
    const path = String(target.targetKey)
    if (sandboxPolicy?.mode === 'read-only') {
      throw Object.assign(new Error(`cannot write "${path}": file access denied under read-only mode`), { code: 'FS_SANDBOX_DENIED' })
    }
    await mkdir(dirname(path), { recursive: true })
    if (expected?.kind === 'createIfAbsent') {
      try {
        await writeFile(path, content, { flag: 'wx' })
      } catch (error: unknown) {
        if ((error as { code?: string }).code === 'EEXIST') {
          throw Object.assign(new Error(`cannot overwrite existing "${path}" without reading it first`), { code: 'FS_NOT_OBSERVED' })
        }
        throw error
      }
      return undefined
    }
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, content)
    await rename(temporary, path)
    return undefined
  },
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(await canonical(parent), basename(path))
  }
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
