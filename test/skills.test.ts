import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import { registerSkills } from '../src/skills.ts'

describe('video-forge skills', () => {
  it('registers the five bundled skills when the skills service is present', async () => {
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
    ])

    // Three are reachable as `/name` commands; two are model-only.
    const userInvocable = summaries.filter(skill => skill.invocation.userInvocable).map(skill => skill.name)
    expect(userInvocable.sort()).toEqual(['video-guide', 'video-project', 'video-storyboard'])
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

  it('does not fail when the skills service is absent (optional dependency)', () => {
    const ctx = new Context()
    expect(() => registerSkills(ctx)).not.toThrow()
  })
})
