# Skill 交叉审查：29 处互相矛盾的说法（2026-11-26）

一次对 `assets/skills/` 下 9 份正文的交叉审查，目标是**同一件事被两处写出不同结论**。skill 正文只留结论（干净、照做即可），为什么这么改、哪些候选被否掉，记在这里。

审查方法沿用 `docs/TEACH-MATERIALS.md` 那套「双向对齐」的做法：按主题切成四条轴（教学片主线、返工与工具面、通用生成路线、跨路线与元层）分别通读，每条候选冲突都要掏出**两侧逐字原文**，再用 `src/` 的代码判哪一侧是真的——文档之间谁对谁错常常两说，但代码只有一个答案。29 处里 12 处会直接让人做出错的东西。

行号是**审查当时**（改动前）的版本，改动后位置会漂，正文里引的原文仍然可 grep。

## 一、用户定的三个口径

| 口径 | 内容 | 影响 |
|---|---|---|
| 1 | 每页 fragment 上限 **5 → 6** | 只改文案：这条一直是约定，`rules.ts` 没有对应检查 |
| 2 | cue 模式（`volcengine`）**允许多页** | 改代码：录制器要按节拍翻页 |
| 3 | 改台词时 **TTS 只重录一句**，成片重新生成 | 改文案：返工矩阵那一行 |

## 二、口径 2 的实现：cue 模式的页从哪来

原状：cue 模式的稿件没有 `page`，录制器只调 `teachCue`，deck 永远停在第 0 页。多页 deck 的第 2 页起**永远录不到**，而 `rules.ts` 的越界检查按整份 deck 的 fragment 总数核对，所以多页 deck 里落在第 2 页的节拍被认为是合法的——不报错、不出画。

口径定成"允许多页"之后有三种做法：

1. **在稿件里写 `page`**——否掉。`page` / `enter` 是页模式的键，cue 模式下 `auditManuscript` 专门给一条 warning 说它们不生效；让它们两种模式都生效，等于把两套驱动模式并成一套，改动面远大于这次的问题。
2. **让 `teachCue` 跨页**（模板里循环到全局第 n 个 fragment）——否掉。它把"翻页"从录制器挪进 deck，而每个句子的 `teachPage` 前置状态就没人打；而且 `teachCue` 一旦可能翻页，"一个 cue 不会换页"这条模板契约（写在 TEACH-VIDEO §23，由模板的 `Math.min(…, available)` 实现着）就不成立了。
3. **录制器翻译**（采用）：稿件里的 fragment 号保持**全片递增**（这是 cue 模式本来的约定），录制器读 deck 每页的 fragment 数，把这个号翻成"第几页第几拍"（`cueLandings()`）。开录前先打到这一句第一个 cue 之前的状态；句内跨页的拍在那一拍翻页。

选 3 的理由：它不改稿件语法、不改 deck 契约，并且顺手修掉一个同源缺陷——每句都是一次新的 `page.goto`，旧行为下第 9 句的第一个 cue 会把前 8 个拍一次性点亮（`teachCue(k)` 在空白页上会点亮 1..k）。开录前预置"第一个 cue 之前"之后，那些拍本来就是亮着的。

配套：

- `auditDecks` 新增一条**结构性拒绝**：多页的 cue 模式 deck 必须定义 `teachPage`。不加的话要等到钱花完、录到跨页那一拍才失败。
- `meta.transition` 在 cue 模式下**仍然拒绝**。理由换成真的那个：页由节拍推出，`exitSlots` 在稿件层算不出转场要落到的初态。原来的文案说"没有页驱"，改完之后这句话不成立了。
- 录制器读的是**活页面**（`.slides > section`），不是 HTML 文本：只有活页面上一个 `<section>` 都找不到时 `cueLandings` 才返回 `null`，退回旧的单页行为。这与 plan 的静态计数器不是同一个 null 条件（`deckPageFragments` 按 HTML 切，页由 JS 生成的 deck 在 plan 侧数不出来），所以 plan 侧另加了一条"页数数不出来"的 warning。

## 三、逐条清单

### 高：照做会产出错误成片、白花钱或命令直接失败

| # | 两处原文（改动前） | 决定 | 落在哪 |
|---|---|---|---|
| 1 | `video-teach-storyboard.md` §页内节拍「换页是第 1 次（t = 0），第 k 个 fragment 是第 k+1 次」↔ 同节「**第 k 次变化**落在 k/(n+1) 处」 | 编号差一：第 78 行公式与第 81 行算例用的是 **fragment 序号**。按前一句的定义代数，n=2 时两拍会落到 2/3 与 3/3，正是同节批评的"念完了才动" | 改成「第 k 个 fragment 的这一次变化落在 k/(n+1)」。`video-teach-slides.md` 同一句复述一并改 |
| 2 | `video-teach-iterate.md` 返工矩阵「`say` → narrate **全量重录**」↔ 同文件「默认 `deepseek`…改一句只重合成那一句」+ `video-teach-storyboard.md`「想改一句话就只改那一句」 | 口径 3：未补页尾停留时只重合成那一句 | 矩阵那行改成条件式两段（未补停留 / 已补停留） |
| 3 | `video-teach-iterate.md`「某个 deck / scene 的排版 → **该段所有句子**的 render」↔ 同文件「同一个 deck 被多句共用时，改版面只影响它自己那句」 | 把范围拆开：单页或单场景只重录那一句，共享样式与跨句状态才整段 | 矩阵行补两种情形 |
| 4 | `video-teach-iterate.md` 逐幕验收「成片时长 = 该幕 timings 合计」↔ `video-teach-storyboard.md`「逐幕验收都按 `durationMs + exitMs` 算」 | 采纳后者（`docs/TEACH-PARALLEL-ACTS.md:116` 早有这句修正，skill 丢了） | 验收表那行补「每句按 `durationMs + exitMs` 累加」 |
| 5 | `video-teach-iterate.md`「`render` 只读 `timings.json`，不写它」↔ 同文件「它是由渲染回写的」 | 代码两边都只说对一半：`writeExitLedger` 只回写录到的 `exitMs`，`durationMs` 与 `text` 不动 | 两处都改成「不改时长与文案，只回写 `exitMs`」 |
| 6 | `video-teach-slides.md`「一页三句、每句两拍是这类页面的**常态规划**」↔ `video-teach-storyboard.md`「三句各两拍就是 6，超了说明不该挤在一页」 | 口径 1：上限 6，则 3×2 是**到顶**不是超限 | 两处都改成「两句各两拍是常态；三句两拍正好到顶」 |
| 7 | `video-teach-slides.md`「纯 cue 模式：全片一个或**少数几页**」↔ 同文件「纯 cue 模式下全片**只有一页**」 | 口径 2：允许多页 | 两处统一成「一页或多页都行，编号全片递增，录制器翻页」 |
| 8 | `video-guide.md`「项目级设置（默认模型…）在 `video-project.yaml`，**不在插件设置里**」↔ 同文件「`video_status` 读…默认供应商/模型」+ `video-project.md` 的优先级链最后一层 | 插件设置里确有 `defaultModel`（`src/config.ts:28`），只是优先级最低 | 改成「几何/风格/角色只在清单；供应商与模型清单里有一层，插件设置是兜底」 |
| 9 | `video-project.md`「插件**从不**拼接片段」+ `video-storyboard.md`「**不会**把镜头拼成一条成片」↔ `video-guide.md`「这一条只针对在线生成路线」 | 加限定，不删断言：教学路线确实拼整片 | 两处都补「在线生成路线」 |
| 10 | `video-project.md`「插件**只写** `renders/` 和 `.dsh-video/`」↔ 同文件「插件也会自动写一份 `video-project.yaml`」+ `video-guide.md`「中间产物在项目根下」 | 同一文件自述就打脸，教学路线还往根目录写 | 拆成「在线生成路线写 renders/、.dsh-video/（首次另加清单与 renders/.gitignore）；教学路线另写 audio/、timings.json、deck/」 |
| 11 | `video-teach-iterate.md` 合并第 3 步「再 `assemble-act --all --join`」 | 没有这个可执行文件：`grep -rn assemble-act .` 只命中 docs、`assets/teach/runs.py` 的 print 文案与 `TODO.md` 的一处既有提及，`runs.py` 的子命令只有 `prepare`/`drift`/`collect` | 改成 `python3 script/assemble-act.py --all --join`，并注明插件不随包发 |
| 12 | `video-teach-slides.md`「`teachTransition`：录制器**不读**它」↔ `video-teach-iterate.md` 把「`teachTransition` 声明得比实际动效短」列为 `motion_findings` 成因 | 代码里录制器读它（`slides.ts` 的 `finishedLayout`），决定末帧自检前等多久 | 改成「不决定节拍时刻；录制器用它等末帧截图，plan 用它校验余量」 |

### 中：会把读者引到错的做法

| # | 两处原文（改动前） | 决定 | 落在哪 |
|---|---|---|---|
| 13 | `slides`「画面长度**严格等于**该句音频长度」↔ `storyboard`「每句多出 `exitMs`」 | 有转场时不成立 | 两处都补「声明了 `meta.transition` 的那句多出 `exitMs`」 |
| 14 | `slides`「`teachPage(n)` → `teachCue(enter)` → **等 300 ms** 过场」↔ 同文件「缺省 300 ms，用 `fade` 要写 500」 | 等待值来自 deck 的 `teachPageTransition` | 改成「等 `teachPageTransition`（缺省 300 ms）」 |
| 15 | `slides`「每页 fragment 数与 cue 数**一一对应**」↔ 同文件「fragment 数 **≥** 该页用到的最大编号」+「一句至少一个 fragment」↔ `storyboard`「`deepseek` 下没写 `page` 时没 cue 不算缺陷」 | 以代码为准：页模式下无 cue 不报（`rules.ts` 的 silent 只对 cue 模式），多出的 fragment 只夹住 | 「一一对应」改成「不少于最大编号」；「一句至少一个 fragment」补页模式例外 |
| 16 | `slides`「**一页**只用一种画面语言」↔ 同文件「**一段**里混用 `dim` 与默认 `fade` 会 warn」 | 检查按整份 deck 数（`fragmentVariants`），所以口径取「一段」 | 两处统一成「一段」 |
| 17 | `slides`「公式优先用 HTML/CSS 或 **MathJax 独立脚本**」↔ `video-teach-manim.md`「公式排版目前**只有两条路**」+ `guide`「插件没有内置 MathJax/KaTeX」 | 包里确实没有（`assets/teach/deck/` 只有 reveal 三件），而 `slides` 又禁止外部网络依赖 | `slides` 改成「HTML/CSS；要 MathJax 就 vendored 进 deck，不能引 CDN」；`manim` 同一句补 vendored 这条 |
| 18 | `guide`「那是它**唯一不可替代**的能力」↔ 同页表格「调语速：deepseek 不支持 / volcengine 整数语速」 | 语速也是只有 volcengine 有 | 改成「词级时间戳与整数语速都只有它给得出」 |
| 19 | `video-project.md`「`paths` 把布局映射到你的目录」↔ `storyboard` / `guide` / `iterate` 三处写死 `renders/<镜头>/` | `paths.renders` 真生效（`destination.ts`），教学路线写死字面量 | `paths` 的说明改成「只有 `paths.renders` 生效，且只影响在线生成路线」；清单注释同步 |
| 20 | `video-storyboard.md`「调 `video_generate`，带 `shot` 和 prompt」↔ `video-prompting.md`「时长与画幅是参数」 | 分镜表声明了 `duration_seconds` / `aspect_ratio`，生成那步却没传，几何参数静默落到清单 `defaults` | 第 3 步写明把这两项作为参数传进去 |
| 21 | `slides`「三个全局是必需项」↔ 同文件「至少两个」+「检查 `teachCue`（有节拍时）」 | 代码是条件门（`rules.ts`：有 cue 或 `enter > 0` 才要 `teachCue`） | 改成「`teachReady` 永远要，`teachCue` 有节拍就要，`teachPage` 页模式与多页 cue 模式都要」 |
| 22 | `slides`「写在随包模板 deck 的 `<style>` 里，所以**新起的项目自动就有**」 | `writeDeck` 是唯一脚手架实现，但 `grep -rn writeDeck src/` 只有定义本身，没有工具调用；skill 也没写"新项目怎么拿到模板 deck" | 改成「从 `assets/teach/deck/index.html` 起的 deck 自动就有」 |
| 23 | `storyboard` 流程块「`narrate`（相邻句合并成一次请求）」↔ 同文件「`deepseek` 逐句请求、不合并」 | 默认 provider 上合并不适用 | 流程块补「deepseek 逐句，volcengine 合并」 |

### 低：措辞与归属漂移

| # | 两处原文（改动前） | 决定 | 落在哪 |
|---|---|---|---|
| 24 | `slides`「顺序不要依赖 DOM，加 `data-beat`」↔ 同文件「模板就是这么做的（按 DOM 顺序数）」 | 模板的 `teachCue` 走 `Reveal.nextFragment()`，要 `data-beat` 得自己写 `teachCue` | 两句合并成一条，说明模板认 DOM 顺序 |
| 25 | `guide` 把 `slides/`、`scenes/` 并进「中间产物」↔ `iterate` 把两者标成「要进版本库」 | 拆成「插件产物」与「手写稿」 | `guide` 那句改写 |
| 26 | `storyboard`「四件事」↔ `docs/TEACH-PARALLEL-ACTS.md`「五件事」 | `prepare` 还会生成幕稿本 | 改成「这些」并点明它顺带切稿本 |
| 27 | `iterate` 返工示例写两步 `render` | `assemble` 默认 true，第一条已经出片 | 示例删掉多余的一行 |
| 28 | `slides` 检查清单「检查 `teachCue`（稿件里有节拍时）」 | 漏掉 `enter > 0` 这个触发条件（同文件别处写过） | 补上 |
| 29 | `storyboard`「连续两句都没有变化会额外点名这一对」 | 该检查只在 cue 模式跑（`rules.ts`） | 补「`volcengine` 下」 |

## 四、顺带修掉的既有缺陷

- **cue 模式每句从空白重放前面的拍**：见第二节。旧行为是 `teachCue(k)` 在空白页上点亮 1..k，第 9 句的第一个 cue 会把前 8 拍一次性弹出。开录前预置"第一个 cue 之前"之后不再发生。
- **`rules.ts` 的一条消息拼接错了**：转场在 cue 模式被拒时，`structural.push` 的模板字符串里混进了一个 `'` 与 `+`，作者会读到 `… to turn to. ' + 'Either set …`。重写这条消息时一起修掉。
- **`src/skills.ts` 顶部注释写「Five skills」**，实际注册 9 个。

## 五、明确没做的

- **改台词后 `render` 不比对文案**。`reconcileTimings` 只比句子 id 集合与 `voice.speaker`，`timings.json` 里存着 `text` 却没人比。所以"改了 `say` 没重跑 narrate"不会被拒绝，画面与 SRT 都还是旧文案，而稿件写着新的一句——它能安静地错到验收。这次只把 skill 说反的因果改对（原来是"只跑 export 会分叉"，实际分叉发生在"narrate 了却没重渲"），**没有**加检查：加了会让所有"只改标点"的项目必须重新花钱合成，属于要单独定的口径。清单见 `TODO.md` 的 C 节。
- `docs/TEACH-VIDEO.md` 里有两个 `## 22.` 小节（编号重复，改动前就存在）。不在这次范围内，未动。

## 六、验证

- `npx tsc --noEmit`：0 错。
- `pnpm run check`（= `build` + `vitest run`）：**779 passed / 7 skipped（786）**，`tsdown` 产物正常。
- `test/teach-cue-pages.test.ts`：5 条换算 + 3 条开录状态 + 4 条真录制（首 cue 定页、句内跨页翻页且末帧自检为 `finished`、无 cue 句继承上一句的页面、单页 deck 不定义 `teachPage` 也能录）。真录制需要 Chromium + ffmpeg + ffprobe，三者缺一按既有约定跳过（AGENTS.md 硬规则 6：能力探测只认正向证据）。
- `test/teach-rules.test.ts`：新增"多页 cue deck 要 teachPage"（单页不要求、多页拒绝）。
- `test/teach-exit.test.ts`：转场在 cue 模式被拒的断言改成新理由，并补 page 模式的负对照（同一份稿本换 DeepSeek 声音，`structural` 必须为空）。
- 复核用的变异实验在 `/tmp` 的仓库副本上做（改坏实现看哪条测试红），未留在仓库里。

## 七、改动清单

| 文件 | 改了什么 |
|---|---|
| `assets/skills/*.md`（8 份） | 第二节到第三节的全部条目；`video-iterate.md` 未改（审查未发现冲突） |
| `src/teach/slides.ts` | `CueLanding` / `cueLandings()` / `cueOpening()` / `livePageFragments()` / `turnPage()` / `lightBeats()`；cue 模式开录前的状态由稿件的 `startFragment` 决定、跨页拍在那一拍翻页；`finishedLayout` 收页内拍号 |
| `src/teach/storyboard.ts` | `cueStartFragments()`（每句开录时已亮到第几拍）；`Timings` 保留 `sampleRate` / `merge` provenance，`parseTimings` 不再丢 |
| `src/teach/pipeline.ts` | cue 模式把 `startFragment` 传给录制器；`writeExitLedger` 回写时保留 provenance |
| `src/teach/rules.ts` | 多页 cue deck 缺 `teachPage` 的结构性拒绝；空页 / 页数数不出来 / 纵向栈三条 warning；D0 的两条检查从 `seamFindings` 挪出（原来不写 `meta.transition` 就一次都不跑）；`pageVariants()` 让"混用两种画面语言"按页判；转场拒绝理由重写（顺带修掉消息里混进的 `'` 与 `+`） |
| `src/skills.ts` | 顶部注释 `Five skills` → `Nine skills` |
| `test/teach-cue-pages.test.ts` | 新增：5 条换算 + `cueOpening` 3 条 + 4 条真录制（首 cue 定页、句内跨页翻页并断言末帧自检 `finished`、无 cue 句继承上一句的页面、单页 deck 不定义 `teachPage` 也能录） |
| `test/teach-rules.test.ts` · `test/teach-exit.test.ts` · `test/teach-narration.test.ts` | 新增用例 / 更新断言（含 page 模式不被 cue 模式拒绝的负对照、provenance 往返） |
| `docs/TEACH-VIDEO.md` | 新增 §27（三条口径与实现与复核后的第二轮修正）；§25.5 的 cue 模式编号一句、§25.6 的 page/enter 不生效一句改写，§25.7 的「上限仍是 5」加取代注 |
| `docs/TEACH-MOTION.md` | §7 检查表第 2 条与 §16.4 的 cue 模式无转场理由改写 |
| `TODO.md` | 新增 C16（改了 `say` 却不重跑 narrate 的显式检查） |


## 八、独立复核（同日，四个只读复核）

四路复核各自独立读代码/正文/文档/测试，不看我的结论表：

| 轴 | 结论 | 抓到的要害 |
|---|---|---|
| 代码 | FAIL（后经修复） | 两个 blocker：单页 cue deck（旧契约只需 `teachReady`+`teachCue`）从第二句起抛错，钱已花；cue 模式里"没有 cue 的句子"整句停在 deck 第一页。一个 major：所有页都没有 fragment 时钳到最后一页 |
| skill 正文 | PASS-WITH-NITS | `slides` 承诺的两条 deck 检查其实被"没写 `meta.transition`"早退挡住，默认项目一次都不跑；另外 `teachCue`/`teachPage` 的触发条件在四处不同步 |
| 文档/原因记录 | FAIL | `TEACH-VIDEO` §25.7 仍写"上限仍是 5"；`video-teach-iterate` 里"改 `say` 会 stale"与我记录的缺口相反；原因文档里两处小节号与一条 null 条件说法不准 |
| 测试 | PASS-WITH-NITS | 关键回退拦得住（变异验证：不翻页、不预置状态、换算差一页都会红），但"句内跨页拍"这条新路径完全没测，`finalStep` 与"越界钳位"也没有用例；`CAN_MEDIA` 少了 ffprobe |

### 复核后改的（都是真问题）

1. **单页 cue deck 不再要求 `teachPage`**：拆成 `turnPage()`（只在真要翻页时调用）与 `lightBeats()`。原来开录前的状态一律走"先切页再点灯"，把不改翻页的单页 deck 也拖下水。
2. **开录状态改由稿件算**：新增 `cueStartFragments(segment)`（每句开录时已亮到第几拍），`pipeline` 把它作为 `startFragment` 传下去；`cueOpening()` 据此决定"有 cue 的句子开在自己第一个 cue 之前、没有 cue 的句子开在故事走到的画面"。这是复核建议的"把稿件层可判的事留在稿件层"的一部分。
3. **`cueLandings` 的两处退化**：所有页都没有 fragment 时回第 0 页（原来钳到末页，整片只录最后一页）；越界钳到"最后一个有拍的页"。
4. **三条新 warning**（都在花钱前）：没有 fragment 的页在 cue 模式下永远走不到；页数数不出来（页在 JS 里生成）时 cue 模式的 `teachPage` 无从核对；纵向栈（`<section>` 套 `<section>`）让 plan 与录制器的页数算法不一致。
5. **D0 的两条检查从 `seamFindings` 挪进 `auditDecks`**：它们原来写在"稿件声明了 `meta.transition`"的早退之后，默认项目从不触发——而 `video-teach-slides` 一直承诺会查。挪出来之后 `fixtures/teach/motion` 立刻报了"混用两种画面语言"：它每页演示一种变体，说明按**整份 deck** 判是错的单位，于是补 `pageVariants()`，改回**按页**判（skill 的原文也是按页，是我先改错成按段，复核纠正）。
6. **`timings.json` 的 provenance 不再被回写吞掉**：`Timings` 带上 `sampleRate` / `merge`，`parseTimings` 保留，`writeExitLedger` 回写时一并写出。复核把它列在存疑里，但它正是"缺失被默认值伪装"那一类，顺手修掉。
7. **正文与文档的七处小修**：`teachCue` 的第二个触发条件（`enter > 0`）、`guide` 与 `storyboard` 里"页模式下的 `teachPage`"、共享页上 `data-teach-stage` 其实跨句接续、`narrate` 收窄时的真实机制（只重量选中的句子，其余沿用旧 `durationMs`）、教学路线 `deck/<段 id>` 落在工作区根、6 个 fragment 标注"约定，不由代码强制"、`video-teach-iterate` 里"改 `say` 会 stale"改成与 C16 一致。
8. **测试补强**：句内跨页（并断言 `settle` 为 `finished`，把 `finalStep` 钉住）、无 cue 句继承、单页无 `teachPage` 可录、`cueLandings([2,0], cue(3))` 钳位、page 模式转场不被拒（负对照）、`CAN_MEDIA` 同时探 ffmpeg 与 ffprobe、阈值改成相对判据（`light - 100`）而不是 140/100 两个绝对数。

### 复核提出但**没做**的（连理由一起记）

- **把落点整表放到稿件层**（复核建议的 `cueSlots`，与 `pageSlots` 并列）：只采纳了一半——"每句开录时已亮到第几拍"进了稿件层（`cueStartFragments`），"这个号落在第几页"仍在录制器（只有它读得到活 deck 的页分布）。剩下的已知缺口是跨页拍的页转场余量算不出来，记在 `TODO.md` C17。
- **cue 模式允许 `meta.transition`**：仍拒绝。落点由节拍推出、`exitSlots` 在稿件层算不出目标状态，这一版不开放。
- `video-guide.md` 关于 Homebrew ffmpeg 不带 libass 的环境断言、`video-project.md` 示例里的模型 id：复核指出未核实，**没动**（前者随机器变，后者要另核 presets）。
- `test/client-video-panel.test.tsx` 的一次偶发失败：既有 flake，与本次无关，没动。

## 九、第二轮审计：两条契约落地后的四路复核（2026-11-26 晚）

§八 之后又改了一轮大的：教学路线分出「逐句契约（`deepseek`）」与「母带契约（`volcengine`：一条母带 + 一个 slides 段一次连续录制）」，5 份教学 skill 跟着重写。用户要求确认这次改完有没有冲突，于是派了四个只读子 agent 分头审，**每条结论我都回代码逐条复核过**（子 agent 只读、不改文件；它们报的"冲突"里有一条是我上一轮自己写错的）。

### 分工

| 审计员 | 范围 | 对照物 |
|---|---|---|
| A | `video-teach-storyboard.md` | `storyboard.ts`（解析/拒绝）、`rules.ts`（warning 文案）、`pipeline.ts`（契约分流）、`tools.ts`（plan 输出） |
| B | `video-teach-iterate.md` | narrate 收窄、`renderSegments` 扩段与重录、`writeExitLedger`、`assembleVideo`、`buildSrt`、`planSegments` |
| C | `video-teach-slides.md` + `video-teach-manim.md` + `video-guide.md` | `slides.ts` 两个录制器、`beats.ts`、`rules.ts` 的 deck 审计、`tools.ts` 导出、`manim.ts`、`probe.ts`、模板 deck 与 `reveal.css` |
| D | 九份正文之间的互相矛盾（不查代码） | 按 10 条口径逐条 grep 并排比对 |

### 代码侧：审计抓到 4 个真问题（都修了）

审计最有价值的部分不是文案，是**代码在输出侧撒谎**：

| 问题 | 现象 | 修法 |
|---|---|---|
| `seamLine` 早返回 | 母带契约没写 `meta.transition` 时，plan 说「每句之间是硬切」——而这个契约没有切点，作者会去加一个不生效的配置 | 契约判断提到 `spec === null` 之前；母带下输出「无接缝」 |
| 接缝类 finding 照旧产生 | `seam_findings` 报"某句仍带着 520 ms 尾转场"，而该契约 `exitMs` 恒 0；`auditDecks` 还报"页切换只录到一半" | `DeckAuditOptions` / `seamLedger` 收 `continuous`，母带下跳过接缝类 finding |
| `picture:` 行分不出契约 | 同一 provider 的两条契约输出逐字相同，作者据此选错返工单位 | 追加 `narration: single master track … / per-sentence …` |
| manim 超长被吞 + 第三类 finding 未写 | `manimSegment` 算出 `overrunMs` 却丢弃，skill 却承诺"会报超长量"；"末帧自检没跑起来"（没检查）被当成检查不过 | `RenderedSegment` 加 `overrunMs` 并在 `motionFindings` 点名；skill 补这类语义 |

另修：`video_teach_render` 的 `sentences` 参数描述写「默认只录还没有段的那几句」，实际是**不传就全量重录**——模型会照它做错决定。

### 文本侧：约 50 处（分类，不逐条抄）

- **内部自相矛盾**：iterate 标题「改一句只重录一句」vs 正文"母带契约是段"；「契约由 provider 决定，没有单独开关」vs 下一段给出的 `merge: none` 开关；「`merge: none`…其余行为不变」vs 它换掉的是整条契约；slides「跨页 auto-animate 拍不到」vs「用跨页 Auto-Animate 做转场」；guide 一处"合成一次"、一处"480 字分块"。
- **跨文件矛盾**：母带契约有没有 `audio/<id>.mp3` 可补静音（只有 `merge: none` 有）；`at_progress` 是否 deepseek 专用（代码两个 provider 都认，是我上一轮写错）；页尾停留被 slides 检查清单写成通用步骤；`page`/`enter` 被 slides 写成"只与 engine 有关"（实际是页模式专属）；manim「重录代价锁在那一句」（台词在母带契约下要重合成整条母带）；「逐句分段拼成整片」。
- **与代码对不上**：`transitionSpeed: fast` 写成 0.2 s（`reveal.css` 实际 fast 0.4 / default 0.8 / slow 1.2，fade 固定 0.5）；依赖写成"三档"（代码是四档，字幕那档不阻塞）；「报超长」无实现；「`enter` 超出该页 fragment 数」的 warning 未写；「错误会指行号与键」（只有解析错误有行号）；`beginMs` 我上一轮写成"拒绝不**铺满**母带的区间"，代码只校验**首尾相接**；「音色改了 + 收窄重录会报 stale」（`reconcileTimings` 只比 `speaker`，而收窄的 narrate 会把 `voice` 改写成新音色，plan 看不出来）。

### 明确没做

- **不合并两个录制器**（`recordDeckSegment` 与 `recordDeckRun`）：用户明确要求保留。理由也写在代码注释里——page 模式与逐句 cue 契约各有自己的生命周期，不能被连续契约带回归。
- **不校验末段是否到达母带末尾**：需要探测母带真实长度（ffprobe），`parseTimings` 拿不到；只校验首尾相接，并在 skill 里写明这个边界。
- **`reconcileTimings` 仍只比 `speaker`**：要发现"混了两个音色"得逐句记 provider/speaker，属于结构改动，记在 `TODO.md`。

### 验证

- `pnpm run build` 通过；`pnpm test` **794 passed / 8 skipped**（含本轮新增：区间不铺满母带被拒、连续录制的边界换页、母带 schema 往返）。
- `test/guide-consistency.test.ts`：skill 里只出现真实工具名、不出现已移除的表面。
- 样片：`demo/showcase/`，火山版 `renders/showcase-ark/v013.mp4`（工具产物，91.99 s，段内接缝 0.01–2.93%、段间 4.03–6.76%），DeepSeek 版 `renders/showcase-deepseek/v003.mp4`。
- **未在活宿主验证的部分**：本轮代码修复在 `lib/` 里，而审计所用的宿主进程早于这次构建启动；`transitions:` / `picture:` / `overrun` 三处输出变更要下次重启后才在工具返回里看得到。

