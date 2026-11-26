/**
 * Bundled `video-*` skill provider.
 *
 * Nine skills ship with the plugin and are registered through `ctx.skills`.
 * They are an optional dependency: the tools must work without them, so the
 * provider is mounted only when the `skills` service exists in the composition
 * (see `registerSkills`). The bodies live in `assets/skills/*.md` (plus the
 * per-model references under `assets/skills/prompting/`), packaged via
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
      'dsh-video-forge 插件的工作区布局和 video-project.yaml 清单：成片落在哪、素材放哪（catalog.yaml、保留名、立绘与首尾帧）、清单怎么写怎么读、目录映射、版本编号。在创建或解释视频项目结构、或清单含义存疑时使用。',
    file: 'video-project.md',
    userInvocable: true,
  },
  {
    name: 'video-prompting',
    description:
      '如何为 dsh-video-forge 撰写和修改视频生成提示词（主体、动作、镜头、光线、风格），以及挑选时长/分辨率/画幅（含供应商差异）；目标模型是 MiniMax H3 时按官方格式改写（三段字段、[Shot N] 时间轴、图生固定指令行）。在撰写或修改 video_generate 的提示词、或生成效果不对且提示词可能是原因时使用；也可以用 /video-prompting 把一段需求改写成提示词。',
    file: 'video-prompting.md',
    userInvocable: true,
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
    name: 'video-teach-storyboard',
    description:
      '教学视频的分镜怎么写：两种旁白契约（deepseek 逐句 / volcengine 一条母带 + 每段一次连续录制，各自的返工单位不同）、storyboard.yaml 的结构、页内节拍怎么算（按每页变化次数铺开、换页算一次变化）、一页承载多句（page / enter）、跨句转场（meta.transition 只写时长与开不开、只对逐句契约生效、逐句 transition: none 回硬切）、页尾停留与宣传片结构、字数与 id 规则、封面页（meta.cover，16:9 与 4:3 同一页），以及多幕并行时怎么把稿本拆成一幕一份。在规划旁白驱动的教学视频（3b1b 式动画 + 幻灯片讲解）时使用。',
    file: 'video-teach-storyboard.md',
    userInvocable: true,
  },
  {
    name: 'video-teach-slides',
    description:
      '教学视频里 reveal.js 幻灯片那一段的约定：teachCue/teachReady 契约、fragment 排版与每页节拍数、共享页的 deck 怎么写（teachPage 幂等、进页拍由录制器先打到位）、母带契约下页在句首就翻（页切换动画会被录进画面）、动效怎么选（dim / fade-up / zoom-in / draw / count / bar 的食谱、只改时长不覆盖 transition、data-teach-stage 页内连续变形、fragment custom 依次聚焦、禁用清单）、跨句转场的形态归 deck（页切换动画、Auto-Animate 的 autoAnimateDuration 要与稿件时长对齐、转场落点那一页 enter 状态不能是空页）、静态资源（图标内联、位图外链、只有「往上两层」一种路径）、最后一屏的完整构图、字号与字体、为什么公式不该走 shell。写 engine: slides 的 deck 或给它加动效时使用。',
    file: 'video-teach-slides.md',
    userInvocable: false,
  },
  {
    name: 'video-teach-manim',
    description:
      '教学视频里 Manim 段怎么写：一句一个场景文件、单 Scene 类、run_time 配平、LaTeX 与 dvisvgm 依赖、风格约定。写 engine: manim 的场景时使用。',
    file: 'video-teach-manim.md',
    userInvocable: false,
  },
  {
    name: 'video-teach-iterate',
    description:
      '教学视频的返工规程：先分清两条契约（deepseek 逐句、volcengine 母带 + 每段连续录制）；改台词 / 改 cues / 改版面 / 换音色 / 换封面 / 加页尾停留各自要重跑什么，母带契约下为什么返工单位是「段」而不是一句、迟到的节拍为什么要整段重录、只重录一句为什么在逐句契约下成立、开了跨句转场之后重录的边界是「一句 + 它的尾转场」（改后一句的版面要连带重录前一句，seam_findings 只报不自动重录）、尾停留补静音与 timings.json 的硬约束，为什么只跑 export 会让画面里的字幕与外部 SRT 分叉，以及多幕并行时怎么逐幕验收再合并。在修改已生成的讲解视频、追查音画错位、或合并多幕成片时使用。',
    file: 'video-teach-iterate.md',
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
