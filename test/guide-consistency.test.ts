import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The guide and the other bundled skills must stay in step with the tools: every
// `video_*` name they mention has to be a real tool, and the removed surface
// (video_export, the old page) must never come back (DESIGN §16.6). The scan
// descends into `prompting/`, where the per-model references live.
/** Every file that can register a tool: the generation tools and the teaching tools. */
const TOOLS_SOURCES = [
  fileURLToPath(new URL('../src/tools.ts', import.meta.url)),
  fileURLToPath(new URL('../src/teach/tools.ts', import.meta.url)),
]
const SKILLS_DIR = fileURLToPath(new URL('../assets/skills/', import.meta.url))

/** Every packaged skill body, including the per-model references under `prompting/`. */
const skillBodies = async (dir = SKILLS_DIR): Promise<readonly { file: string, body: string }[]> => {
  const bodies: { file: string, body: string }[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) bodies.push(...await skillBodies(path))
    else if (entry.name.endsWith('.md')) bodies.push({ file: path.slice(SKILLS_DIR.length), body: await readFile(path, 'utf8') })
  }
  return bodies
}

const REMOVED = ['video_export', '视频工坊', 'workbench', '工作台']

describe('bundled skills stay consistent with the tools', () => {
  it('only mentions tool names that actually exist', async () => {
    const realTools = new Set<string>()
    for (const source of TOOLS_SOURCES) {
      const text = await readFile(source, 'utf8')
      for (const match of text.matchAll(/name: '([a-z0-9_]+)'/g)) realTools.add(match[1] ?? '')
    }
    expect(realTools.has('video_generate')).toBe(true)
    expect(realTools.has('video_status')).toBe(true)
    expect(realTools.has('video_cancel')).toBe(true)
    // The teaching route registers its four tools in src/teach/tools.ts; a skill
    // naming one of them must find it there too.
    for (const name of ['video_teach_plan', 'video_teach_narrate', 'video_teach_render', 'video_teach_export']) {
      expect(realTools.has(name), `${name} must be a registered tool`).toBe(true)
    }

    for (const { file, body } of await skillBodies()) {
      const mentioned = [...body.matchAll(/video_[a-z_]+/g)].map(match => match[0])
      for (const name of mentioned) {
        expect(realTools.has(name), `${file} mentions ${name}, which is not a registered tool`).toBe(true)
      }
    }
  })

  it('never mentions the removed surface', async () => {
    for (const { file, body } of await skillBodies()) {
      for (const removed of REMOVED) {
        expect(body.includes(removed), `${file} mentions removed "${removed}"`).toBe(false)
      }
    }
  })
})
