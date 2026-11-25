# 幻灯段动效与跨句转场（2026-11-25 方案）

本文回答一件事：**reveal.js 幻灯段怎么从"只会淡入"变成"有动效、有转场"，同时不破坏音频对轨、逐句重录与多幕并行。**

只管方案与判据，实现记录留到代码落地后回填。页内节拍的算法在 `docs/TEACH-VIDEO.md`「页内节拍：按变化次数算」与「一页承载多句：`page` / `enter`」两节；并行派发的目录契约在 [`TEACH-PARALLEL-ACTS.md`](TEACH-PARALLEL-ACTS.md)；deck 静态资源与素材落点在 [`TEACH-MATERIALS.md`](TEACH-MATERIALS.md)。

## 0. 主旨

**动效不是装饰，是"这句话讲到哪、画面动到哪"的可见证据。** 现在的幻灯段只有一种画面语言——元素淡入，然后就完全静止。实测一段 9.23 秒的句子只产生 23 个画面帧，其中 20 帧集中在两次 180 ms 的淡入里，其余 8 秒画面**一个像素都不变**。这就是"呆板"的物理来源。

四条决定，按代价从低到高排（D0 → D3）：

| 档 | 内容 | 改动面 |
|---|---|---|
| **D0** | 页内动效库：更多切换类型、正确时长、压暗点亮 | 模板 CSS + skill |
| **D1** | 页内手动 auto-animate：同一元素连续变形 | 模板 CSS + deck 内几行 JS |
| **D2** | 录制契约：deck 声明过渡时长，录制器与校验器读它 | `slides.ts` + `rules.ts` |
| **D3** | 跨句转场：把 reveal 的页转场与 Auto-Animate 录进成片 | `slides.ts` + `pipeline.ts` + `ffmpeg.ts` + 稿件 |

**不改变的三件事**：音频仍是时钟；一句仍是一个录制单元、重录只花一句；成片仍回 `renders/<shot>/`。D3 会动到这三件的**账本**（段长、时间轴、字幕），所以单独用第 6 节展开。

## 1. 基线：实测的四件事

全部在隔离实例里实测（仓库外，独立的 `DSH_HOME` 与端口），不是推断。

### 1.1 录制管线能拍到什么

录制用 CDP 的 `Page.startScreencast`，**页面重绘才发帧**，静止时不发。`ffmpeg.encodeFrames` 再把不规则到达的帧按时间戳铺成 30 fps 的 CFR 段。

| 场景 | 3 秒内的帧数 | 说明 |
|---|---|---|
| 页面完全静止 | **1 帧** | 这就是"整句画面不动"的物理形态 |
| 200 ms 的 CSS transition | 约 16 帧 | 采样稳定在 **60 fps**（每帧 16–17 ms） |
| 400 ms 的 CSS transition | 约 32 帧 | 时长直接决定可拍的中间帧数 |
| 700 ms 的 SVG 路径绘制（一次性 keyframes） | 约 60 帧 | 帧文件大小单调增长，绘制过程连续 |
| 永久循环动画（旋转 + 悬浮，transform） | **279 帧（93 fps）** | 7.8 MB；静态页同样 3 秒只有 27 KB |

**结论：管线不是瓶颈。** 位移（`translateY`）、缩放（`scale`）、颜色、圆角、SVG 描边全部被完整采样。呆板的原因是动效类型，不是录制能力。

### 1.2 三个成因

1. **跨页过渡在架构里被吃掉。** `slides.ts:184-207` 先 `teachPage(n)`、再等 `PAGE_TRANSITION_MS = 300`（`slides.ts:67`）、然后才开录；`concatSegments`（`ffmpeg.ts:191-195`）用 concat demuxer + `-c copy`。两处叠加的结果是**成片里页与页之间永远是硬切**，deck 写什么 `transition` 都没用。
2. **默认 fragment 只有 opacity。** reveal.css 里 `.reveal .fragment:not(.custom){opacity:0;visibility:hidden}`，模板与 skill 都只提"`fragment`"三个字，模型第一次写的 deck 必然是纯淡入。
3. **时长偏短。** `.fragment{transition:all .2s}`，200 ms 在 30 fps 输出里只有 6 帧左右，观感是"闪一下"而不是"动"。

### 1.3 一个已经踩过的坑（会杀掉内置变体）

某个 fixture deck 自己写了：

```css
.reveal .fragment { opacity: 0; transition: opacity 180ms ease; }
```

这条与 reveal 的 `.reveal .fragment{transition:all .2s}` **特异性相同、后加载**，于是胜出。`transition` 只作用于 `opacity`，**`fade-up` 的 transform、`grow` 的 scale 全部变成瞬间跳变**——作者即使知道有变体也用不出来。这条要写进 skill 的禁用清单。

### 1.4 官方 demo 的"炫"在哪

逐段看过 [revealjs.com/demo](https://revealjs.com/demo/) 的源码，它的运动类效果**全部是跨页**：

- **Auto-Animate**：相邻 `<section data-auto-animate>` + `data-id` 匹配，元素跨页连续补间（默认 `duration: 1` 秒、`easing: ease`、`unmatched: true`）；
- **Transition Styles / Background Transitions**：页间转场；
- 静态部分（主题、列表、表格、代码）比我们还朴素。

所以"像 demo 那样连续"绕不开跨页，这就是 D3 必须做的原因。同时 demo 也暴露了三个可直接拿的零件：`r-stack` / `r-hstack` / `r-vstack`（纯 CSS 布局）、`r-fit-text`、`data-background-gradient`。**包里没带任何插件**（`assets/teach/deck/` 只有 reveal.js / reveal.css / theme.css），所以 markdown、代码高亮、notes、zoom、search 都不可用，这一版不补。

## 2. 三种动画，三套判据

这是全套方案的地基。写 deck 的人和校验器都要按这张表判断。

| 类型 | 触发者 | 与播放时钟的关系 | 例子 | 允许 |
|---|---|---|---|---|
| **状态驱动** | `teachCue` 改 class | 起点由 cue 决定，终点由 CSS 时长决定 | 显隐、位移、缩放、颜色、路径绘制、数字滚动 | ✅ 主推 |
| **纯装饰循环** | 页面加载 | 完全无关 | 旋转、悬浮、光晕、渐变流动 | ✅ 但要接受帧数代价 |
| **混合** | 循环 + cue 叠加 | 循环部分无关，叠加部分有关 | "波形一直在动，说到某处变红" | ✅ 必须两层写 |

三条硬规则：

1. **状态驱动的动画时长必须固定**，写在 deck 里能被读到（D2 的 `teachTransition`）。
2. **循环动画只用 `transform` / `opacity`**（走合成器）。用 `width` / `top` / `left` 触发 layout，帧率与帧大小都更差。
3. **禁止无限循环的"信息型"动画**：循环的相位从 `page.goto` 开始计，到开录之间隔着截图自检等不确定耗时，所以"转到 45° 时正好说到某个词"做不到。纯装饰不受影响。

**循环动画的代价**（实测，写在这里因为它是判据的一部分）：只要有重绘就是 93 fps，与动画快慢无关——一个 20 秒周期的缓慢旋转和 1 秒一圈帧数完全一样。一段 6 秒的句子从约 25 帧涨到约 560 帧。本方案**不为此做优化**（用户 2026-11-25 明确"中间文件会很大先不考虑"），但 skill 里要提示"装饰循环别全片铺开"。

## 3. D0：页内动效库

### 3.1 不覆盖，只补时长

模板与 skill 的第一条规则：**不要写 `.reveal .fragment { transition: ... }`**。要改时长就只改 `transition-duration`：

```css
.reveal .slides .fragment { transition-duration: var(--teach-dur, 480ms); }
```

`transition-duration` 不覆盖 `transition-property`，所以 reveal 内置变体的 `transform` 仍然生效。模板里给 `--teach-dur: 480ms`，作者可按页覆盖。

**480 ms 的依据**：实测 400 ms 拍 32 帧、200 ms 拍 16 帧；480 ms 落在"足够顺滑、又不越过常见的一拍间隔"的区间。少于 300 ms 观感仍是"闪"。

### 3.2 可用的类清单

reveal 内置、直接可用（不需要写 CSS，但**必须不被 §3.1 的坑杀掉**）：

| 类别 | 类名 | 用途 |
|---|---|---|
| 出现型 | `fade`（默认）、`fade-up/down/left/right`、`zoom-in`、`fade-in-then-out` | 逐条出现；位移与缩放比纯 opacity 有明显"动"感 |
| 强调型 | `grow`、`shrink`、`strike`、`highlight-blue/red/green`、`semi-fade-out` | **默认可见**，点亮时改变样式 |

**强调型不能当"逐条出现"用**：`.reveal .fragment.grow{opacity:1;visibility:inherit}` 意味着它从一开始就在版面上。用在"逐条出现"的列表上，会让所有条目一开始全都在。这是最容易做错的一处。

模板额外提供四个（需要 `index.html` 里写 CSS）：

| 类 | 机制 | 用途 |
|---|---|---|
| `dim` | `opacity: .42 → 1`（**压暗→点亮**，不是从无到有） | 整页构图在句首就完整，节拍只做强调。另一个教学片项目已验证过这个模式 |
| `draw` | SVG `stroke-dashoffset` 一次性 keyframes | 曲线、路径、流程线逐笔画出 |
| `count` | `counter` + `steps()` 或 JS 递增 | 数字从 0 滚到目标值 |
| `bar` | `scaleX`/`height` transition | 条形图生长 |

`dim` 与默认 `fade` 是两种不同的画面语言，按内容选：要"整页完整、逐步强调"用 `dim`；要"一条一条蹦出来"用 `fade-up`。

### 3.3 缓动

`ease-out` 或 `cubic-bezier(.2,.7,.3,1)`。**不要用 demo 的 `cubic-bezier(0.77,0,0.175,1)`**：实测它前 77% 的时间几乎不动（600 ms 的变形，前 460 ms 只走了 5 px，最后 140 ms 走完 165 px），单元素变形会看起来"卡住然后突然变"。它是为多元素 auto-animate 的蓄力感设计的。

### 3.4 skill 的对应改动

`video-teach-slides` 加一节"动效食谱"（内容类型 → 用哪个类），并把"自定义 CSS 动画不可预测"的禁令**收窄**成第 2 节的三种类型判据。原文那条把状态驱动的 transition 也一起禁了，而它恰恰是唯一确定的类型。——**已落成（2026-11-25，§13）**：那一节叫「动效：先定画面语言，再选类」，包含类清单、时长怎么改、`data-teach-stage` 与禁用清单。

## 4. D1：页内手动 auto-animate

### 4.1 支点：`.fragment.custom`

reveal.css 里有一条之前没用上的规则：

```css
.reveal .fragment:not(.custom) { opacity: 0; visibility: hidden }
```

**`class="fragment custom"` 不会被 reveal 隐藏**。reveal 只负责数它、推进它（加 `.visible` / `.current-fragment`），样式完全交给作者。于是：

> 任何 CSS 动效都能挂在 `fragment` 上，同时仍被 `countDeckFragments` 数到、被 `teachCue` 驱动。

这是 D1 的技术支点，也是"页内做出 auto-animate 观感"的唯一零成本路径。

### 4.2 同一元素连续变形

demo 的 Auto-Animate 是"三页里同一组元素连续变形"。页内复刻靠一个容器 + `data-step`：

```html
<div class="stage r-stack" data-teach-stage data-step="1">
  <div class="mover"></div>
</div>
```
```css
.mover { width:90px; height:90px; background:#6b7280; border-radius:8px;
         transition: all 600ms cubic-bezier(.2,.7,.3,1); }
[data-step="2"] .mover { width:260px; height:140px; background:#22d3ee; border-radius:12px; }
[data-step="3"] .mover { width:300px; height:300px; background:#e879f9; border-radius:50%; }
```

模板的 `teachCue` 增加一段**可选**的同步：

```js
// 标了 data-teach-stage 的容器跟着 cue 走；deck 只写 CSS，不写 JS
for (const el of document.querySelectorAll('[data-teach-stage]')) {
  el.dataset.step = String(target + 1)      // 1 = 第一拍之前
}
```

**步号是 `target + 1`，不是 `target`**（实现时改的口径，见 §13）：一页开局所有拍都暗，markup 里写的是 `data-step="1"`，所以 1 必须表示"第一拍之前"。写成 `Math.max(1, target)` 会让第一拍落到 1 上，于是首拍期间形状不动、要到第二拍才变形——2 拍的页面只剩一次变形（实测：该页帧数从 25 降到 13）。

实测：尺寸、颜色、圆角全部被平滑补间并完整录取，与 reveal 原生 Auto-Animate 在页内的观感同源。

### 4.3 依次聚焦

`current-fragment` 由 reveal 自动维护，`custom` 元素可以直接用它做"当前项高亮、其余压暗"：

```css
.beat { color: #9ca3af; transition: color 400ms ease, transform 400ms ease; }
.beat.current-fragment { color: #ffd479; transform: translateX(16px); }
```

这比 `highlight-*` 更可控（可以同时改颜色、位移、字重、描边）。

### 4.4 边界

- `data-teach-stage` 只在**当前页**生效，跨页不接续（跨页是 D3 的职责）。
- 一个容器只能有一个 `data-step`，多个独立变形要拆成多个容器。
- 共享页（`page` / `enter`）下 `teachCue` 的编号跨句递增，`data-step` 会跟着从 1 数到 6；作者要么按整页编号写 CSS，要么用 `enter` 保证进页状态正确。

## 5. D2：录制契约

### 5.1 两个可选全局

```js
window.teachTransition     = 480   // ms，页内单步过渡时长
window.teachPageTransition = 500   // ms，切页过渡时长
```

- **录制器**：页切换后等 `teachPageTransition ?? 300`，替代硬编码的 300。
- **校验器**：`video_teach_plan` 对每个 cue 算 `剩余 = 下一个 cue（或句末）− 本 cue`，若 `< teachTransition` 给 **warning**（"这一拍只剩 340 ms，过渡 480 ms 会与下一拍重叠"）。重叠不一定是坏事（连续感常来自重叠），所以是 warning 不是拒绝。
- **不声明就不校验**，默认路径仍然可用。

这条同时修掉一个现存的不一致：`transition: 'fade'` 在 reveal.css 里是**固定 0.5 s**（`.reveal.fade .slides section{transition:opacity .5s}`），`transitionSpeed: 'fast'` 对它无效，而等待只有 300 ms——开录时还有约 200 ms 的转场在跑。现在靠前面的截图自检（1080p 截图 + 数颜色）耗掉了额外时间才没暴露。

**已落成（2026-11-25，§14）**，实现时定的三处口径：

1. 录制器读的是**活页面上的值**（`teachReady` 之后 `page.evaluate`），不是从 HTML 里正则抓的——deck 可以在初始化时算出来。非数字、非有限、≤ 0 的声明一律按"没声明"处理，否则 `= '500'` 这种手误会让等待归零、把转场本身录进去。
2. 校验器用的时钟**优先实测旁白**：`timings.json` 通过 `reconcileTimings` 就直接用它（`at_progress` 按实测时长换算、`at_word` 用词起点），否则退回"字数 ÷ 5"的估时，并在 message 里明说"这是估时"（未知不能用看起来合理的默认值冒充实测）。旁白对不上稿本时**完全不参考**它的时长。
3. 模板两个全局都声明了：`teachPageTransition = 500`（它的 `fade` 就是 0.5 s）与 `teachTransition = 480`（`--teach-dur`）。用了 `count` / `draw`（900 ms）的页面应当把 `teachTransition` 写成 900，否则校验看到的是 480。

### 5.2 不加 `teachEnter`

页入场动画看起来需要一个"开录后触发"的钩子，但 D3 的转场段已经覆盖了这个需求（转场落在上一段的尾部，见 6.2）。加第三个全局会让契约从三个变四个，而它解决的问题被 D3 吸收了。**这一版不加**；如果将来出现"每页都要独立入场动画且不接上一页"的需求，再单独提。

## 6. D3：跨句转场

这一节是全部衔接的所在，按"归属 → 录制 → 音频 → 对轨 → 并行 → 降级 → 重录"排。

### 6.1 归属：转场属于**前一段的尾部**

两个候选，选后者：

| | 前缀式（属于后一段的入口） | **后缀式（属于前一段的出口）** |
|---|---|---|
| 段结构 | `[转场 T][正文]` | `[正文][转场 T]` |
| 句首画面 | 还在转场，**违反"句首完整构图"** | 已是本页稳态 ✓ |
| 与"最后一屏停留" | 无冲突 | 转场在停留之后，停留仍完整 ✓ |
| 需要知道谁的状态 | 上一段的末态 | 下一段的初态（`pageSlots` 全量可算） ✓ |

**决定：段 N = `[正文 durationMs][转场 exitMs]`**，转场把画面从"第 N 页末态"补间到"第 N+1 页初态"。

这个选择顺带解决了 Auto-Animate：补间发生在同一段录制里（同一文档内先 `teachPage(N)` 再 `teachPage(N+1)`），所以 **Auto-Animate 被完整录进去**，不再需要改"一句一录"的架构。

### 6.2 录制流程

`recordDeckSegment` 增加 `exit: { page, enter, ms }`：

1. `goto` + 等 `teachReady`；
2. 截图自检（纯色拒绝）；
3. `teachPage(N)` + `teachCue(enter)`；
4. 等 `teachPageTransition`；
5. `startScreencast`，`t0`；
6. 按 cues 推进到 `t0 + durationMs`；
7. **若 `exit` 存在**：`teachPage(N+1)` + `teachCue(enterNext)`，再录 `exitMs`；
8. `stopScreencast`；
9. `encodeFrames` 的 `durationMs` = `durationMs + exitMs`。

第 7 步的 `teachCue(enterNext)` 必须与段 N+1 开头的状态完全一致，否则接缝会跳。两处都走 `pageSlots` 的同一份结果，所以天然一致。

### 6.3 音频

段 N 的音频 = `[句 N 音频][exitMs 静音]`。实现落在 `cutAudioSegment`（`ffmpeg.ts:413-429` 已经在用 `apad` 补标点停顿）或 assemble 时对每段 `apad=pad_dur`，二选一，**不能两处都补**。

`exitMs` 不进 `audio/<id>.wav`：那个文件是 TTS 产物、是重录单元，补静音只会让"重录一句"变成"重录一句加改音频"。

### 6.4 对轨：`timings.json` 加 `exitMs`

这是 D3 最容易出错的地方。并行的逐幕验收判据是"成片时长 = 该幕 timings 合计（容差一帧）"。转场让段变长，**任何一处账本没同步，验收就会挂**。

统一账本：

```
段 N 长 = durationMs + exitMs
成片长 = Σ(durationMs + exitMs)
SRT: start(N+1) = start(N) + durationMs(N) + exitMs(N)
```

`timings.json` 的每条记录加 `exitMs`（缺省 0），`assembleVideo`、`buildSrt`、`assemble-act.py` 全部按这一个字段累加。**不允许任何一处按"只有 durationMs"算。**

### 6.5 多幕并行

- 每幕独立 `projectRoot`（`runs/<act>/`），`pageSlots` 在幕内算。**幕内转场自动正确。**
- **幕的第一段没有 `exitMs`**：上一段在另一个项目里，拿不到末态。幕与幕的接缝仍按 `TEACH-PARALLEL-ACTS.md` §7 的做法（抽帧 + 转写）验收，**这一版不做幕间转场**。
- **转场参数归主线定**：`exitMs` 与转场类型都属于"观感一致性"（并行规程 §9.2 的视觉参数），写进 deck 与稿件，子任务只准用、不准调。
- `assemble: false`（只渲一句看看）时转场照录，因为它已经编在段里；不额外判断。

### 6.6 转场"长什么样"由 deck 决定

**稿件只声明"要不要 + 多久"，类型由 deck 决定**：

```yaml
meta:
  transition: { mode: deck, durationMs: 400 }   # mode: deck | none
sentences:
  - id: s01-3
    transition: none                             # 这一句回硬切（可选覆盖）
```

理由：类型（fade / slide / zoom / Auto-Animate）是视觉语言，属于 deck，与"压暗强度、字号、布局"同类，必须只有一个出处（并行规程 §9.2）。稿件管时长，deck 管形态。

deck 侧用 `data-transition="zoom"` 或 `data-auto-animate` 表达。Auto-Animate 的默认 `duration: 1` 秒比 400 ms 长，要么把 `exitMs` 提到 600–800 ms，要么在 deck 里 `Reveal.configure({ autoAnimateDuration: 0.4 })`。

### 6.7 跨 engine 降级

转场只在**相邻两段都是 slides** 时生效：

| 边界 | 做法 |
|---|---|
| slides → slides | deck 内转场（含 Auto-Animate） |
| slides → manim / manim → slides | 该段 `exitMs = 0`，保持硬切（Manim 场景在另一个进程、另一份文件里，拿不到"下一页初态"） |
| 段落 | 第 1 段无转场；最后一段无转场 |

不搞"淡出到黑"的伪转场：黑场在两段之间出现，观感比硬切更差，而且需要额外的黑帧段。

### 6.8 重录

`sentences: ['s01-3']` 重录第 3 段（含它尾部的转场）。需要第 4 段的 `{ page, enter }`——从 `pageSlots` 全量算得出，不依赖第 4 段实际录了什么。

**但改第 4 段的版面不会自动重录第 3 段的转场**：转场终点用的是第 4 段的初态，如果第 4 段的 deck 改了，第 3 段的尾部转场会停在旧版面。`video_teach_render` 的返回要把"哪些段的转场依赖了改动过的页"报出来，让作者知道要重录谁。**这一版先只报、不自动重录**（自动重录会让"只花一句的钱"变成两段）。

## 7. 校验：plan 阶段能判的

全部在花钱前，落在 `src/teach/rules.ts`。

| # | 检查 | 类型 |
|---|---|---|
| 1 | `transition.durationMs` 在 100–1200，`mode` 只允许 `deck` / `none` | 拒绝 |
| 2 | `meta.transition` 开了但 deck 没有 `teachPage`（纯 cue 模式） | 拒绝：纯 cue 模式全片一页，没有"下一页"可转 |
| 3 | `exitMs > 0` 且下一段不是 slides | warning 并自动降级为 0 |
| 4 | `exitMs` 超过下一句的时长（转场比整句还长） | warning |
| 5 | 某拍之后剩余时间 < `teachTransition` | warning（D2） |
| 6 | `exitMs` 与 `enter` 冲突：下一段 `enter = 0` 时转场终点是全暗页 | warning |
| 7 | deck 里出现 `.reveal .fragment { transition: ... }` 这类整体覆盖 | warning（D0 的坑） |
| 8 | 一段里同时出现 `dim` 与默认 `fade` | warning（两种画面语言混用会显乱） |

## 8. 否决过的方案

1. **拼接期 `xfade`**（`ffmpeg -filter_complex` 交叉淡化）。本机 ffmpeg 9.1 带 `xfade`，但它只能做 ffmpeg 的转场，**拍不到 reveal 的转场与 Auto-Animate**；还要放弃 `-c copy`、每段缩短 T 再补偿，音频对轨更绕。留给"不想改录制、只要一个淡化"的将来选项。
2. **前缀式转场**（转场放在后一段的开头）。见 6.1，违反"句首完整构图"。
3. **恢复跨句同文档以复活 Auto-Animate**。需要"一个 deck 从第 1 句连续录到第 40 句"，与"一句一录、重录只花一句"正面冲突，且一句坏掉要整段重来。被后缀式转场替代。
4. **让转场吃掉"页尾停留"**。停留的目的是"最后一屏能独立看 1 秒以上"，转场吃掉它就把目的抵消了。
5. **加 `teachEnter` 全局**。见 5.2，被 D3 吸收。
6. **靠帧率/降采样优化循环动画的文件体积**。用户明确这一轮不考虑；且丢帧会丢中间状态，30 fps 输出重采样后几乎无损，但实现复杂度不值得现在付。

## 9. 代价

| 项 | 成本 |
|---|---|
| D0 | 模板 CSS 一段 + skill 一节；不改代码 |
| D1 | 模板 `teachCue` 一段 + skill 一节；不改代码 |
| D2 | `slides.ts` 读两个全局；`rules.ts` 一条 warning |
| D3 | `slides.ts` 加 `exit` 分支；`pipeline.ts` 传参；`ffmpeg.ts` 补静音；`timings.json` 加字段；`buildSrt` 改累加；`rules.ts` 八条；`assemble-act.py`（项目侧）跟改 |

**风险**：
- D3 让段长与时间轴账本多一个字段，任何一处漏改都会让并行验收的"时长 = timings 合计"失败。这是最大的一处。
- 转场让"重录一句"的边界从"一句"扩到"一句 + 它的尾转场"，作者要理解。
- Auto-Animate 的补间若长于 `exitMs`，会被截断（观感是"滑到一半就切了"），所以 6.6 要求两者对齐。

## 10. 验收（全部离线，落代码后执行）

1. **D0**：`fixtures/teach/motion/` 每页一个变体（`dim`、`fade-up`、`zoom-in`、`draw`、`count`、`bar`、`custom`），渲染后抽帧断言"每拍的帧间差异超过阈值"，且末帧是完整版面。——**已做（2026-11-25，§13）**：落成 `test/teach-motion.test.ts`，八页（七种变体 + 一个 `--teach-dur: 0ms` 负对照），断言"段内至少 5 帧画面在变"与"末帧 = 全部节拍点亮后的 deck 截图"。
2. **D1**：同一 fixture 的 `data-teach-stage` 页，抽帧断言元素尺寸/颜色按 `data-step` 单调变化（与本次实测的判据一致）。——**已做（2026-11-25，§13）**：抽帧数三种形色的像素，首帧是 step-1 灰、末帧是 step-3 洋红；删掉 `teachCue` 里的同步后该断言即失败（实测）。
3. **D2**：`video_teach_plan` 对"某拍之后剩 200 ms 而 `teachTransition` 是 480"给出 warning；不声明时不报。——**已做（2026-11-25，§14）**：`test/teach-transition.test.ts` 三例覆盖估时/实测/不声明三种情形，另有录制器一例（见 §14.2）。
4. **D3**：`fixtures/teach/transition/` 三句 slides，`meta.transition.durationMs: 400`。断言：① 段长 = `durationMs + exitMs`；② 第 2 段首帧与第 1 段末帧**像素相同**（证明接缝连续）；③ 成片时长 = `Σ(durationMs + exitMs)`；④ SRT 的第 2 句起点 = 第 1 句起点 + 第 1 句 `durationMs + exitMs`。
5. **跨 engine**：`fixtures/teach/mixed/`（slides + manim）断言 slides 段的 `exitMs` 被降级为 0，且 plan 给了 warning。
6. **并行**：用 `assets/teach/runs.py` 起一份两幕 fixture，断言幕内转场正确、幕首无 `exitMs`、逐幕验收的时长判据仍然成立。

## 11. 与 TODO 的对应

- **B10** → 第 3 章（D0）· **已落成**
- **B11** → 第 4 章（D1）· **已落成**
- **B12** → 第 5 章（D2）· **已落成**
- **B13** → 第 6、7 章（D3）· 未做

skill 的改动在代码落地、验收通过后同步——**未被验证的功能不写进 skill**。D0/D1 的对应段落（`video-teach-slides` 的「动效：先定画面语言，再选类」）已随实现一起写进去；D2/D3 那两处（`video-teach-storyboard` 的 `transition` 字段、`video-teach-iterate` 的"改一段要连带重录谁的尾转场"）等代码落地再写。

## 12. 划界：不做什么

- 不做幕间转场（`TEACH-PARALLEL-ACTS.md` §7 的接缝验收不变）。
- 不做"淡出到黑"的伪转场。
- 不补 reveal 的五个插件（markdown / highlight / notes / zoom / search）。
- 不为循环动画做帧数与体积优化。
- 不把 `exitMs` 写进 `audio/<id>.wav`。
- 不改"音频是时钟"与"一句一录"这两条地基。

## 13. 实现记录：D0 与 D1（2026-11-25）

D0（页内动效库）与 D1（页内手动 auto-animate）落成，**都不改代码**：全部在随包的模板 deck 与 skill 正文里，所以 `src/` 一行没动，工具面也没变。

### 13.1 落了什么

| 位置 | 内容 |
|---|---|
| `assets/teach/deck/index.html` | `:root { --teach-dur: 480ms; --teach-ease }` 与 `.reveal .slides .fragment { transition-duration/-timing-function }`（**只改时长**，保留 reveal 各变体的 `transition-property`）；四个类 `dim` / `draw` / `count` / `bar`；`.beat` 的"当前项高亮"；`teachCue` 末尾把 `[data-teach-stage]` 的 `data-step` 跟着拍数写成 `target + 1` |
| `assets/skills/video-teach-slides.md` | 新一节「动效：先定画面语言，再选类」：两种画面语言、时长怎么改（含"覆盖 `transition` 会杀掉内置变体"）、类清单与内容类型对照、`data-teach-stage` 的五条边界、`fragment custom` 依次聚焦、四条禁用；原「动效用自带的 fragment 就够」那条收窄成"按与时钟的关系判断"（§3.4 要求）；检查清单补两条 |
| `src/skills.ts` | `video-teach-slides` 的 routing description 带上动效 |
| `fixtures/teach/motion/` | `sections.html`（八页：七种变体 + 一个 `--teach-dur: 0ms` 负对照）+ `storyboard.yaml`。**页面单独成文件**，测试用 `writeDeck` 把它装进真实模板再录，这样量的是随包模板的 CSS 与 `teachCue`，不是副本 |
| `test/teach-motion.test.ts` | 两例：plan 在 fixture 上无待修项；渲染八段后逐页量"画面在动的帧数"与"末帧 = 全部节拍点亮后的 deck 截图"，并量 stage 页首末帧的颜色 |
| `demo/motion/` | 同一份 `sections.html` 装进模板得到的样本项目（稿本 + deck + 封面页），用 DeepSeek 音色 `stella` 出片：`renders/motion/v001.mp4`，46.17 s |

### 13.2 实测证据

`test/teach-motion.test.ts` 一次跑完（本机，ffmpeg 9.1 + Playwright Chromium），八页每页两句节拍，30 fps 的成片里逐帧比：

| 页 | 变体 | 句内"画面在变"的帧数 | 末帧与"全部点亮"的 deck 截图平均差 |
|---|---|---|---|
| s01-1 | `dim` | 10 | 0.1 |
| s01-2 | `fade-up` | 24 | 0.1 |
| s01-3 | `zoom-in` | 24 | 0.1 |
| s01-4 | `draw` | 12 | 0.0 |
| s01-5 | `count`（900 ms 滚动） | 38 | 0.0 |
| s01-6 | `bar` | 14 | 0.0 |
| s01-7 | `data-teach-stage` | 25 | 0.1 |
| s01-8 | 对照 `--teach-dur: 0ms` | **2** | 0.0 |

负对照是这套断言有牙的地方，两处都真跑过：

- **把对照页的时长改回 480 ms**，该页从 2 帧变成 23 帧，测试失败在 "the 0 ms control tweened"。
- **删掉 `teachCue` 里那段 `data-step` 同步**，stage 页从 25 帧掉到 13 帧，且末帧"step-3 颜色（洋红）0 px"，测试失败在 "the last frame is not in the step-3 colour"。

样本成片上的同一件事（按 30 fps 数事件）：七种变体每拍的连续变化是 3–13 帧，最后一页（0 ms 对照）两次变化各**只有 1 帧**，峰值位移却相近——这就是"动起来"与"闪一下"的差别。

### 13.3 实现时改掉的口径

1. **`data-step = target + 1`**（§4.2 已改）：原文写 `Math.max(1, target)`，会让第一拍与"首拍之前"都落在 1 上，2 拍的页面只剩一次变形。
2. **模板自己的 CSS 注释里不能出现字面量 `<section>`**：旧构建的页数统计只剥注释与 `<script>`、不剥 `<style>`，于是 CSS 注释里的一个 `<section>` 会让 deck 多出一页（`video_teach_plan` 因此报了"第 1 页只有 1 个 fragment"）。当前源码已剥 `<style>`（B1 那轮的修复），但这句注释改成"the section element"更稳——文档里写契约，注释里写标记名，两次都栽在同一个坑上（§B1 的第三轮审查也是这个）。

### 13.4 它换不来什么

- **跨句仍然是硬切**：每句独立录制再拼接，页转场拍不到，`data-teach-stage` 也只在当前页内接续。要连续得上 D3（B13）。
- **`fade-in-then-out` 这类"一拍消失"的变体**现在能用，但消失之后的位置会留白，页内节拍仍按"一件事一到两次变化"规划。
- **循环动画的帧数代价没处理**（§2）：装饰循环可用，别全片铺开。

## 14. 实现记录：D2（2026-11-25）

D2 是这一套里唯一动代码的一档，因为要改的两件事都不在 deck 里：**等多久才开始录**，以及**这一拍的时间够不够它的动效播完**。

### 14.1 落了什么

| 位置 | 内容 |
|---|---|
| `src/teach/slides.ts` | `DeckGlobals` 加两个可选全局（`teachPageTransition` / `teachTransition`，后者只给校验用）；页模式切页后先 `page.evaluate` 读活页面上的 `teachPageTransition`，再 `waitForTimeout(声明 ?? 300)`。`PAGE_TRANSITION_MS` 从"硬编码"降级为"默认值"，注释写明它只是默认。 |
| `src/teach/rules.ts` | `DeckInfo.transitionMs`（deck 声明的 `teachTransition`，没有就 `null`）；新类型 `BeatSchedule`（一句的时长、每个 cue 落在多少毫秒、是否用的估时）；`auditDecks` 收第三个参数 `{ beats }`，新函数 `transitionFindings` 产出两种 warning（"下一拍会重叠" / "句尾会被切"）。 |
| `src/teach/tools.ts` | `inspectDecks` 用 `declaredMs('teachTransition')` 读声明（`(?!=)` 挡住 `===` 这种守卫）；新函数 `beatScheduleOf` 把 `timings.json`（通过 `reconcileTimings` 的）或字数估时换成 `BeatSchedule`；**plan 里读旁白的位置提到审计之前**，因为校验要的是实测时长。 |
| `assets/teach/deck/index.html` | 模板自己声明 `teachPageTransition = 500`（它的 `fade` 就是 0.5 s）与 `teachTransition = 480`（等于 `--teach-dur`），两行都写了为什么。 |
| `assets/skills/video-teach-slides.md` | 「最小骨架」从"三个全局"改成"三个必需 + 两个可选"，新增一小节写清什么时候该声明、默认值是什么、`count`/`draw`（900 ms）该声明 900。 |
| `test/teach-transition.test.ts` | 四例：plan 用它估时给 warning、用实测给 warning（且没有"估时"字样）、不声明时一句不说；录制器在有/无声明两种情形下首帧的差别。 |

### 14.2 实测证据

录制器那一半靠"可以量出来的差别"：测试用一个切页会亮红 700 ms 的 deck（700 ms 落在默认 300 与声明 1000 之间，两种情况不可能同时通过），数首帧里红色像素（320×180 = 57 600 像素）：

| 情形 | 首帧红色像素 | 末帧红色像素 |
|---|---|---|
| 声明 `teachPageTransition = 1000` | **0** | 0 |
| 不声明（默认 300 ms） | **57 584**（整屏都是转场） | 0 |

**这个断言有牙**：把录制器改回硬编码 `PAGE_TRANSITION_MS`，声明那一例的首帧变成 57 584，测试失败（实测）。

校验器那一半的三条路各跑一次（一句话、两个 cue）：

| 情形 | 声明的 `teachTransition` | 结果 |
|---|---|---|
| 无旁白（按 32 字估 6.4 s），最后一拍落在 95% | 480 | warning，并写明"这是按 32 字估的时长" |
| 有旁白 2600 ms（实测），两拍落在 780 / 1170 ms | 480 | warning：`fragment 1 at 780 ms and fragment 2 follows 390 ms later`，没有"估时"字样 |
| 同上，但 deck 没声明 | 无 | 一句不说 |

### 14.3 边界

- **一个 deck 只能声明一个页内时长**。`count` / `draw` 是 900 ms，`--teach-dur` 是 480 ms，声明只能挑一个；skill 里写的是"用了 900 ms 的那两个类就声明 900"。
- **不比较页切换时长是否合理**。声明 `teachPageTransition = 5000` 不会报警，只是每句多等 4.7 s；那是作者的明确选择，D3 的 `meta.transition.durationMs`（100–1200 的拒绝区间）管的是稿件侧。
- **声明值要按自己用的那一档填**。reveal.css 给的时长是 `fast` 0.2 s / `default` 0.4 s / `slow` 1.2 s，`fade` 另算（固定 0.5 s）。样本片（`demo/contract`，用 zoom + slow）第一版声明 900，量出两页首帧与"稳态截图"差 2.2，改成 1300 后六句全部 ≤ 0.04；同一批帧里，切页后 300 ms 的画面与稳态差 8.7–9.0，也就是旧默认会录进去的那种帧。这条差别是量出来的，不是看出来的。
- **仍然不加 `teachEnter`**（§5.2）。
- **校验器不做"每拍各自时长"的推断**：它只拿 deck 声明的那一个数字比，剩下的靠 skill 的写法约束。

## 15. 验收补强：拍子迟到与末帧校验（2026-11-25）

### 15.1 触发它的那只片子

`demo/contract` 的 v002 里，`s01-5` 的第二拍晚了 **1834 ms**：应在 3966 ms 落到「录制器不读它；读它的是 video_teach_plan」那一行，实际到 5800 ms 才落，而句子在 5920 ms 被切——480 ms 的淡入只录到前 **122 ms**。观感是"这一页没播完"，正是用户看到的那一处。

查证过程与排除项：

| 事实 | 证据 |
|---|---|
| 同一页**不是**每次都坏 | v001 该拍 +34 ms、v003 +44 ms；把 `recordDeckSegment` 直接跑三次，全部 +34…+44 ms |
| 稿子与 deck 没问题 | cues 一直是 0.33 / 0.67；同一段代码、同一份 deck |
| 不是系统时钟跳变 | `log show --predicate 'process == "timed"'` 在 17:40–17:52 只有时区计算，没有时间调整 |
| 画面真的没动，不是"动了没录到" | 帧表显示 2447–5798 ms 一段 3351 ms 的连续静止，之后 125 ms 内 13 帧——转场是那时才开始的（帧的时间戳来自浏览器 `MonotonicTime`，捕获时刻不会骗人） |

录制器的拍子闸门是 `waitForTimeout(该拍的时刻 − 已过时间)` 加一次 `page.evaluate`。这条链横跨两个进程（Playwright 驱动进程里的定时器、以及回到插件宿主进程的往返），任一环被挂住 1.8 s，拍子就迟到；而**页面此时是静止的**，所以任何"抽帧看有没有变化"的检查都不会报错。

### 15.2 落了什么

**一、把拍子记下来，并给它一次重录的机会**（`src/teach/slides.ts`、`src/teach/pipeline.ts`）

- 拍子时钟从 `Date.now()` 换成 `performance.now()`：一句话的拍子间隔是 3–8 秒，只有单调时钟能保证这期间的差值不被系统时间调整影响。
- 每拍记 `{ fragment, atMs, actualMs }`；`lateBeats()` 挑出晚于 120 ms（30 fps 的四帧）的拍。
- `renderSegments` 遇到迟到**自动重录这一句一次**，`retried` 记下来；重录仍迟到才报，并在 message 里说清"是机器忙，不是稿子的问题，再录一次"。
- `video_teach_render` 的结果新增 `motion_findings: string[]`，并把每条以 `warning:` 打给用户。

**二、末帧校验：这一段是不是在动画中途被切了**（`src/teach/slides.ts` 的 `finishedLayout`、`src/teach/ffmpeg.ts` 的 `frameDelta`）

录完一段后浏览器还开着，于是把 deck 驱动到这一句的最后一拍、等它声明过的 `teachTransition`（默认 700 ms，夹在 300–3000 之间）再加 200 ms，截一张图，与**段末那一帧**比一次：640×360 灰度、逐像素比对，报"变了多少像素"与"平均差多少"。

阈值是量出来的，不是拍的：

| 情形 | 差异像素占比（640×360 灰度，差 > 12 记一次） |
|---|---|
| 正常收尾：段末帧 vs 完成版面 | **0.000**（平均差 0.015） |
| 少亮一拍（拍子迟到时录到的画面） | **1.1%** |
| v002 那段被切的末帧 | **11.0%** |

判定线 `SETTLE_CHANGED = 0.002`（0.2%）：比噪声高两个数量级，比最小的信号（少亮一拍）低五倍。真正用来判定的是"变了多少像素"，整帧平均差对"少一行字"太钝（1.1% 的变化只让平均差动 1.9），所以两个数都报、只拿占比判定。

### 15.3 证据

`test/teach-transition.test.ts` 新增四例：

- **纯函数**：`lateBeats` 的边界（120 ms 以内不算，超过算）、`motionFindings` 的四种措辞（该重录 / 重录过仍然迟到 / 末帧被切 / 检查没跑起来），以及"没有拍子时不说"。
- **强制迟到**：让 deck 自己的 `teachCue` 忙等 260 ms（唯一诚实的制造办法），`renderSegments` 录完发现迟到、自动重录一次、仍迟到，于是报出 `stayed late when recorded a second time`。实测这一段从录到报耗时 8.7 s（两次录制）。
- **末帧校验**：同一页录两次，一次让 480 ms 的淡入只剩 200 ms 就切（`unfinished`，差异 > 0.002），一次给足三秒（`finished`，差异 < 0.002）。修这条测试时发现测试 deck 的 `.beat` 是暗色，30% 到 100% 的不透明度只差 6 个亮度级——**低对比度的动效本来就会漏过这个检查**，换成亮色后判定正确。这条限制写进了 §15.4。

### 15.4 它查不到什么

- **亮度差很小的动效**：暗色元素在暗背景上的渐变，差异落在阈值以下，会判成"完成"。要更严就得比结构而不比亮度（例如边缘图），成本高得多。
- **装饰性循环动画**：末帧本来就不会等于截图，会报假警报。看到这条先确认那页有没有循环。
- **Manim 段**：没有拍子也没有"完成版面"可比，两项检查都是 `skipped`/不存在；它的时长由场景自己的 `run_time` 决定。
- **迟到之外的原因造成的"画面不动"**：比如转场在无头浏览器里停摆（2026-11-24 那次），末帧校验会把它当成"未完成"报出来，但根因不同，处置办法都是重录那一句。
