/**
 * Bundled `video-*` skill provider.
 *
 * Five skills ship with the plugin and are registered through `ctx.skills`.
 * They are an optional dependency: the tools must work without them, so the
 * provider is mounted only when the `skills` service exists in the composition
 * (see `registerSkills`). The bodies live in `assets/skills/*.md`, packaged via
 * `package.json#files`, and are read at load time relative to `import.meta.url`.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'video-forge'
/** Directory holding the packaged skill bodies, beside `lib/` in the installed package. */
const ASSETS_DIR = fileURLToPath(new URL('../assets/skills/', import.meta.url))

interface BundledSkill {
  name: string
  description: string
  file: string
  /** Whether the skill is reachable as a user command (`/<name>`); the model sees every skill. */
  userInvocable: boolean
}

const SKILLS: readonly BundledSkill[] = [
  {
    name: 'video-project',
    description:
      'The workspace layout and video-project.yaml manifest for the dsh-video-forge plugin: where generated videos land, how to write and read the manifest, path mapping, and version numbering. Use when creating or explaining a video project structure, or when the meaning of the manifest is in question.',
    file: 'video-project.md',
    userInvocable: true,
  },
  {
    name: 'video-prompting',
    description:
      'How to write and revise video-generation prompts (subject, motion, camera, light, style) and pick duration, resolution and aspect ratio for dsh-video-forge, including provider differences. Use whenever composing or fixing a prompt for video_generate, or when a generation looks wrong and the prompt is the likely cause.',
    file: 'video-prompting.md',
    userInvocable: false,
  },
  {
    name: 'video-storyboard',
    description:
      'How to break a script into a shot list (storyboard/shots.yaml) and generate it one shot at a time with dsh-video-forge. Use when the user wants to plan a multi-shot video or turn a script into shots.',
    file: 'video-storyboard.md',
    userInvocable: true,
  },
  {
    name: 'video-iterate',
    description:
      'How to redo a take, continue a shot from its last frame (the from parameter), and keep a character consistent across shots with dsh-video-forge. Use when iterating on a video, continuing a shot, or keeping a character consistent.',
    file: 'video-iterate.md',
    userInvocable: false,
  },
  {
    name: 'video-guide',
    description:
      'How to use the dsh-video-forge plugin end to end: setup, what it can and cannot do, cost estimates, and where videos land. Use when the user asks how to use the video plugin or needs guidance on its workflow.',
    file: 'video-guide.md',
    userInvocable: true,
  },
]

const CANDIDATES: readonly SkillCandidate[] = SKILLS.map(skill => ({
  name: skill.name,
  description: skill.description,
  invocation: { modelInvocable: true, userInvocable: skill.userInvocable },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: ASSETS_DIR } as const,
  rank: BUNDLED_SKILL_RANK,
  locator: skill.file,
}))

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve(CANDIDATES),
  async get(candidate): Promise<SkillDefinition> {
    const file = candidate.locator as string
    const body = await readFile(join(ASSETS_DIR, file), 'utf8')
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: candidate.provider,
      source: candidate.source,
      ...(candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase }),
      content: body,
    }
  },
}

/**
 * Register the bundled skill provider when the composition carries the `skills`
 * service. Without it the plugin still works — the tools never depend on a
 * skill having been loaded — so this is a conditional mount, not `inject`.
 * Returns the injection fiber so a caller can await it (or dispose it).
 */
export function registerSkills(ctx: Context): ReturnType<Context['inject']> {
  return ctx.inject(['skills'], (scope) => {
    scope.skills.registerProvider(() => provider)
  })
}

export { PROVIDER_NAME }
