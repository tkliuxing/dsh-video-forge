/**
 * The video panel's pure model (M5): merging the ledger with the `renders/`
 * scan, scoping, grouping and ordering, and the two URLs a row can play from.
 *
 * These are the rules the panel has no other copy of, so they are tested here
 * rather than through a rendered list: a wrong scope, a duplicate row, or a
 * file-only row sorted into the wrong place is a real defect that a snapshot of
 * the DOM would only describe.
 */

import { describe, expect, it } from 'vitest'
import type { PanelTask } from '../src/client/panel-api.ts'
import {
  buildPanelView,
  directoryOf,
  fileAddress,
  formatDuration,
  harnessFileUrl,
  mergeRows,
  panelStatusKey,
  rowFacts,
  rowName,
  rowProgress,
  rowVideoUrl,
  streamUrl,
  taskRow,
  toneOf,
  versionOf,
  type PanelFile,
} from '../src/client/video-panel-model.ts'

/** A finished ledger row with everything the panel reads. */
function task(overrides: Partial<PanelTask> = {}): PanelTask {
  return {
    taskId: 'v-20261019-0001',
    provider: 'ark',
    model: 'seedance',
    status: 'succeeded',
    progress: 1,
    mode: 't2v',
    prompt: 'a rainy street',
    submittedAt: '2026-10-19T08:00:00.000Z',
    updatedAt: '2026-10-19T08:01:00.000Z',
    playUrl: '/video-forge/media/v-20261019-0001/tok/v001.mp4',
    artifactPath: '/work/renders/hero/v001.mp4',
    artifactLocation: 'renders/hero/v001.mp4',
    artifactBytes: 1_600_000,
    error: null,
    sessionId: 'session-a',
    workspacePath: 'renders/hero/v001.mp4',
    shot: 'hero',
    durationSeconds: 5.17,
    width: 1344,
    height: 768,
    resolution: '1080p',
    aspectRatio: '16:9',
    ...overrides,
  }
}

const file = (path: string, bytes: number | null = null): PanelFile => ({ path, bytes })

describe('paths and names', () => {
  it('reads the directory a row sits in, without assuming where it lives', () => {
    expect(directoryOf('renders/hero/v003.mp4')).toBe('renders/hero')
    expect(directoryOf('renders/v003.mp4')).toBe('renders')
    // A file outside renders/ states its real directory: the group header must
    // not claim a path the file is not under.
    expect(directoryOf('media/exported.mp4')).toBe('media')
    expect(directoryOf('clip.mp4')).toBe('')
  })

  it('reads vNNN, and refuses names this plugin did not choose', () => {
    expect(versionOf('renders/hero/v003.mp4')).toBe(3)
    expect(versionOf('renders/hero/v0012-copy.mp4')).toBe(12)
    expect(versionOf('renders/hero/final.mp4')).toBeNull()
    expect(versionOf('renders/hero/v.mp4')).toBeNull()
  })

  it('shows the file name as the row name', () => {
    expect(rowName(taskRow(task()))).toBe('v001.mp4')
  })
})

describe('tone and labels', () => {
  it('separates a finished video from work in flight and from a failure', () => {
    expect(toneOf('succeeded')).toBe('ready')
    for (const status of ['submitting', 'unconfirmed', 'queued', 'running', 'orphaned']) expect(toneOf(status)).toBe('active')
    for (const status of ['failed', 'cancelled']) expect(toneOf(status)).toBe('failed')
    expect(toneOf('something-foreign')).toBe('other')
  })

  it('labels a scanned file as a file, not as a success', () => {
    expect(panelStatusKey(taskRow(task()))).toBe('panel.status.ready')
    expect(panelStatusKey(taskRow(task({ status: 'running' })))).toBe('panel.status.running')
    expect(panelStatusKey(taskRow(task({ status: 'cancelled' })))).toBe('panel.status.cancelled')
    const scanned = mergeRows([], [file('renders/hero/v009.mp4')]).rows[0]!
    expect(panelStatusKey(scanned)).toBe('panel.status.file')
  })
})

describe('merging the ledger with the scan', () => {
  it('keeps the ledger row where both know the file, and adds the rest', () => {
    const { rows, scanned } = mergeRows(
      [task()],
      [file('renders/hero/v001.mp4', 1), file('renders/hero/v002.mp4', 2)],
    )
    expect(rows).toHaveLength(2)
    expect(scanned).toBe(true)
    const known = rows.find(row => row.workspacePath === 'renders/hero/v001.mp4')!
    // The ledger's row wins: it is the one with the prompt and the token URL.
    expect(known.kind).toBe('task')
    expect(known.playUrl).not.toBeNull()
    expect(known.prompt).toBe('a rainy street')
    const scannedRow = rows.find(row => row.workspacePath === 'renders/hero/v002.mp4')!
    expect(scannedRow.kind).toBe('file')
    expect(scannedRow.playUrl).toBeNull()
    expect(scannedRow.bytes).toBe(2)
  })

  it('reports no scan contribution when every file is already in the ledger', () => {
    const { rows, scanned } = mergeRows([task()], [file('renders/hero/v001.mp4', 1)])
    expect(rows).toHaveLength(1)
    expect(scanned).toBe(false)
  })

  it('keeps a task that never produced a video', () => {
    const row = taskRow(task({ status: 'failed', playUrl: null, workspacePath: null, artifactBytes: null, error: 'refused' }))
    expect(row.workspacePath).toBe('')
    expect(row.tone).toBe('failed')
    expect(row.status).toBe('failed')
  })
})

describe('scoping, grouping and ordering', () => {
  const tasks: PanelTask[] = [
    task({ taskId: 'v-1', workspacePath: 'renders/hero/v001.mp4', submittedAt: '2026-10-19T08:00:00.000Z' }),
    task({ taskId: 'v-2', workspacePath: 'renders/hero/v002.mp4', submittedAt: '2026-10-19T09:00:00.000Z' }),
    task({
      taskId: 'v-3',
      workspacePath: 'renders/ending/v001.mp4',
      shot: 'ending',
      submittedAt: '2026-10-18T08:00:00.000Z',
    }),
    task({
      taskId: 'v-4',
      sessionId: 'session-other',
      workspacePath: 'renders/other/v001.mp4',
      shot: 'other',
      submittedAt: '2026-10-19T10:00:00.000Z',
    }),
    task({ taskId: 'v-5', status: 'running', playUrl: null, workspacePath: null, submittedAt: '2026-10-19T11:00:00.000Z' }),
    task({ taskId: 'v-6', status: 'failed', playUrl: null, workspacePath: null, submittedAt: '2026-10-19T07:00:00.000Z' }),
  ]
  const files: PanelFile[] = [file('renders/hero/v000.mp4'), file('renders/scan-only/v001.mp4')]

  const view = (scope: 'workspace' | 'session' | 'all', workspaceSessionIds: string[] = ['session-a']) =>
    buildPanelView({ tasks, files, scope, sessionId: 'session-a', workspaceSessionIds })

  it('counts each scope for the chips', () => {
    const all = view('all')
    // The scan contributes two rows that no task knows.
    expect(all.counts.all).toBe(8)
    // This workspace: session-a's five rows plus the two scanned files.
    expect(all.counts.workspace).toBe(7)
    // This session has no attribution over a scanned file.
    expect(all.counts.session).toBe(5)
  })

  it('shows the whole workspace by default, other workspaces only under all', () => {
    expect(view('workspace').ready.flatMap(group => group.rows.map(row => row.taskId))).not.toContain('v-4')
    expect(view('all').ready.flatMap(group => group.rows.map(row => row.taskId))).toContain('v-4')
    expect(view('session').ready.flatMap(group => group.rows.map(row => row.taskId))).not.toContain('v-4')
  })

  it('sinks work in flight and failures to their own sections, newest first', () => {
    const workspace = view('workspace')
    expect(workspace.active.map(row => row.taskId)).toEqual(['v-5'])
    expect(workspace.failed.map(row => row.taskId)).toEqual(['v-6'])
    // Neither leaks into the grouped list.
    expect(workspace.ready.flatMap(group => group.rows.map(row => row.taskId))).not.toContain('v-5')
  })

  it('groups by directory, newest group first, and keeps versions descending inside a group', () => {
    const groups = view('workspace').ready
    // A group whose rows came only from the scan carries no timestamp at all, so
    // it sorts after the groups the ledger can date.
    expect(groups.map(group => group.directory)).toEqual(['renders/hero', 'renders/ending', 'renders/scan-only'])
    // The scanned v000 sits in the same directory group as the ledger's rows.
    expect(groups[0]?.rows.map(row => row.taskId)).toEqual(['v-2', 'v-1', null])
  })

  it('keeps the file-only rows in the scan group they came from', () => {
    const hero = view('workspace').ready.find(group => group.directory === 'renders/hero')!
    expect(hero.rows.map(row => row.kind)).toContain('file')
  })

  it('expands the newest finished video, not the highest version number', () => {
    expect(view('workspace').defaultKey).toBe('v-2')
    expect(view('session').defaultKey).toBe('v-2')
  })

  it('falls back to the unscoped list on a host without the projection fields', () => {
    // An older host sends neither field (it omits them rather than sending null),
    // so nothing is attributable: "workspace" must not come back empty, and a
    // finished row with no path still appears — grouped outside the workspace,
    // playable from its token URL.
    const legacy = tasks.map(({ sessionId: _session, workspacePath: _path, ...rest }) => rest)
    const unscoped = buildPanelView({ tasks: legacy, files, scope: 'workspace', sessionId: 'session-a', workspaceSessionIds: ['session-a'] })
    expect(unscoped.counts.workspace).toBe(8)
    expect(unscoped.active.map(row => row.taskId)).toEqual(['v-5'])
    const elsewhere = unscoped.ready.find(group => group.directory === '')!
    expect(elsewhere.rows.map(row => row.taskId)).toEqual(['v-4', 'v-2', 'v-1', 'v-3'])
    expect(elsewhere.rows.every(row => row.playUrl !== null)).toBe(true)
  })
})

describe('playback URLs', () => {
  it('plays a ledger row from its token URL', () => {
    const row = taskRow(task())
    expect(rowVideoUrl(row, 'http://127.0.0.1:3080/', 'session-a', true))
      .toBe('http://127.0.0.1:3080/video-forge/media/v-20261019-0001/tok/v001.mp4')
  })

  it('plays a scanned file through the stream route, with its session', () => {
    const scanned = mergeRows([], [file('renders/hero/v009.mp4')]).rows[0]!
    const url = rowVideoUrl(scanned, 'http://127.0.0.1:3080/app/', 'session-a', true)
    expect(url).toBe('http://127.0.0.1:3080/app/api/video-forge/stream?path=renders%2Fhero%2Fv009.mp4&sessionId=session-a')
  })

  it("resolves a row's path in that row's own session, not the one on screen", () => {
    const row = taskRow(task({ sessionId: 'session-other', playUrl: null }))
    const url = rowVideoUrl(row, 'http://127.0.0.1:3080/', 'session-a', true)
    expect(url).toContain('sessionId=session-other')
  })

  it('has nothing to play when the host has no stream route', () => {
    const scanned = mergeRows([], [file('renders/hero/v009.mp4')]).rows[0]!
    expect(rowVideoUrl(scanned, 'http://127.0.0.1:3080/', 'session-a', false)).toBeNull()
    // A ledger row still plays: its URL does not need the route.
    expect(rowVideoUrl(taskRow(task()), 'http://127.0.0.1:3080/', 'session-a', false)).toContain('/video-forge/media/')
  })

  it('keeps the sub-path and drops a non-http base', () => {
    expect(streamUrl('http://127.0.0.1:3080/app/', '/w/clip.mp4', 'v1'))
      .toBe('http://127.0.0.1:3080/app/api/video-forge/stream?path=%2Fw%2Fclip.mp4&v=v1')
    expect(streamUrl('file:///tmp/', '/w/clip.mp4')).toBeNull()
    expect(harnessFileUrl('http://127.0.0.1:3080/', '/w/clip.mp4'))
      .toBe('http://127.0.0.1:3080/api/file?path=%2Fw%2Fclip.mp4')
    // The fallback carries the version too, so the harness's own reload refetches.
    expect(harnessFileUrl('http://127.0.0.1:3080/', '/w/clip.mp4', 'v9'))
      .toBe('http://127.0.0.1:3080/api/file?path=%2Fw%2Fclip.mp4&v=v9')
  })

  it('addresses a workspace file through its session, encoding every segment', () => {
    expect(fileAddress('session-a', 'renders/hero/v001.mp4'))
      .toBe('dsh-resource://file/session/session-a/renders/hero/v001.mp4')
    expect(fileAddress('session a', './renders/a b/v001 #2.mp4'))
      .toBe('dsh-resource://file/session/session%20a/renders/a%20b/v001%20%232.mp4')
    expect(fileAddress('s', 'C:/videos/clip.mp4')).toBe('dsh-resource://file/session/s/C:/videos/clip.mp4')
  })
})

describe('formatting', () => {
  it('writes a duration like a player does', () => {
    expect(formatDuration(5.17)).toBe('0:05')
    expect(formatDuration(72)).toBe('1:12')
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration(-1)).toBeNull()
  })

  it('prefers what came back over what was requested, and skips what is unknown', () => {
    const row = taskRow(task())
    expect(rowFacts(row, bytes => `${bytes} B`)).toBe('1344×768 · 0:05 · 1600000 B')
    const requestedOnly = taskRow(task({ width: null, height: null, durationSeconds: null, artifactBytes: null }))
    expect(rowFacts(requestedOnly, String)).toBe('1080p')
  })

  it('clamps progress into 0..1 and reports nothing when unknown', () => {
    expect(rowProgress(taskRow(task({ status: 'running', progress: 0.62 })))).toBe(0.62)
    expect(rowProgress(taskRow(task({ status: 'running', progress: 4 })))).toBe(1)
    expect(rowProgress(taskRow(task({ status: 'running', progress: null })))).toBeNull()
  })
})
