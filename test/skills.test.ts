import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { isUserInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import { registerSkills } from '../src/skills.ts'

describe('video-forge skills', () => {
  it('registers the bundled skills when the skills service is present', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = registerSkills(ctx)
    await fiber

    const summaries = await ctx.skills.list()
    expect(summaries.map(skill => skill.name)).toEqual([
      'video-guide',
      'video-iterate',
      'video-project',
      'video-prompting',
      'video-storyboard',
      'video-teach-iterate',
      'video-teach-manim',
      'video-teach-slides',
      'video-teach-storyboard',
    ])

    // Four are reachable as `/name` commands; one is model-only.
    const userInvocable = summaries.filter(skill => skill.invocation.userInvocable).map(skill => skill.name)
    expect(userInvocable.sort()).toEqual([
      'video-guide',
      'video-project',
      'video-prompting',
      'video-storyboard',
      'video-teach-storyboard',
    ])
    expect(summaries.every(skill => skill.invocation.modelInvocable)).toBe(true)

    // Each body loads, is non-trivial, and carries the packaged resource base.
    for (const summary of summaries) {
      const loaded = await ctx.skills.get(summary.name)
      expect(loaded?.content.length).toBeGreaterThan(200)
      expect(loaded?.resourceBase?.kind).toBe('directory')
    }

    // Disposing the registration removes the skills again.
    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('exposes /video-prompting as a usable command with a reachable reference', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = registerSkills(ctx)
    await fiber

    const skill = await ctx.skills.get('video-prompting')
    expect(skill?.invocation.userInvocable).toBe(true)
    expect(skill !== undefined && isUserInvocable(skill)).toBe(true)

    // The command name IS the skill name: dsh-tool-skill scans user text for
    // `/<name>` and looks the name up in the skill registry, so the body has to
    // address the command the user will actually type.
    expect(skill?.name).toBe('video-prompting')
    expect(skill?.content).toContain('/video-prompting')

    // The per-model reference is not a skill of its own: it is reached through
    // the base directory the renderer advertises, so the link has to resolve on
    // disk both in the repo and in the packed tarball (`files: ["assets"]`).
    const rendered = renderSkillContent(skill!)
    const base = rendered.match(/Base directory for this skill: (.+)/)?.[1]?.trim()
    expect(base).toBeDefined()
    expect(skill?.content).toContain('prompting/minimax-h3.md')
    const reference = await readFile(join(base!, 'prompting/minimax-h3.md'), 'utf8')
    expect(reference).toContain('integrated_multimodal_description')
    expect(reference).toContain('overall_soundscape')
    expect(reference).toContain('non_diegetic_music')

    await fiber.dispose()
  })

  it('does not fail when the skills service is absent (optional dependency)', () => {
    const ctx = new Context()
    expect(() => registerSkills(ctx)).not.toThrow()
  })
})
