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
      'dsh-video-forge 插件的工作区布局和 video-project.yaml 清单：成片落在哪、清单怎么写怎么读、目录映射、版本编号。在创建或解释视频项目结构、或清单含义存疑时使用。',
    file: 'video-project.md',
    userInvocable: true,
  },
  {
    name: 'video-prompting',
    description:
      '如何为 dsh-video-forge 撰写和修改视频生成提示词（主体、动作、镜头、光线、风格），以及挑选时长/分辨率/画幅（含供应商差异）。在撰写或修改 video_generate 的提示词、或生成效果不对且提示词可能是原因时使用。',
    file: 'video-prompting.md',
    userInvocable: false,
  },
  {
    name: 'video-storyboard',
    description:
      '如何把剧本拆成分镜表（storyboard/shots.yaml），并用 dsh-video-forge 一次一个镜头地生成。在用户想规划多镜头视频或把剧本拆成分镜时使用。',
    file: 'video-storyboard.md',
    userInvocable: true,
  },
  {
    name: 'video-iterate',
    description:
      '如何重拍成片、用 from 从尾帧续拍、让角色跨镜头保持一致（dsh-video-forge）。在迭代视频、续拍镜头、或保持角色一致时使用。',
    file: 'video-iterate.md',
    userInvocable: false,
  },
  {
    name: 'video-guide',
    description:
      'dsh-video-forge 插件端到端使用：配置、能做什么不能做什么、费用估算、成片落在哪。在用户问怎么用视频插件、或需要工作流指导时使用。',
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
