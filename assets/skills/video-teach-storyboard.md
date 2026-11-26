# Video Teach Storyboard — 教学视频的分镜怎么写

教学视频不是"让模型生成一段画面"，而是**旁白驱动**：先说清楚每一句讲什么，画面再跟着词走。手写入口只有一个 `storyboard.yaml`，其余（音频、时间轴、分段、成片）都是它派生出来的。

## 和生成路线的分工

| 要什么 | 用哪条路 |
|---|---|
| 真人感的场景、镜头运动、角色 | `video_generate`（在线模型） |
| 公式推导、坐标系、逐项累积的动画 | `video_teach_render` + `engine: manim` |
| 幻灯片式讲解、要点逐条出现 | `video_teach_render` + `engine: slides` |

`engine` 有两个取值，**只用 `slides` 是完全合法的路线**：不装 Manim、不装 Python、不装 TeX 也能出片，只需要 `ffmpeg` 与一个 Chromium。只有当内容需要公式推导、坐标系连续动画时才值得为 `engine: manim` 去装那套工具链（见 video-teach-manim）。

两条路线都落在 `renders/<shot>/` 下、都按 `vNNN` 版本递增，但互不共享状态。

## 文件

```yaml
meta:
  title: 为什么 1 + 1/4 + 1/9 + … = π²/6
  voice:
    provider: deepseek                            # 默认；volcengine 是另一个选择（唯一能带词时间戳的）
    speaker: stella                               # deepseek 有 stella / tide；volcengine 用 zh_female_…_bigtts
    speed_ratio: 1                                 # 可选，整数；deepseek 不支持调语速
  video:
    size: [1920, 1080]                            # 可选，默认就是 1080p
    fps: 30                                       # 可选
  cover: cover/index.html                         # 可选：封面页。缺省就没有封面（不会拿成片首帧顶替）
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html                   # 省略时取 slides/<id>/index.html
    sentences:
      - id: s01-1
        say: 先看前几项完全平方数的倒数，它们一次比一次小。
        # 这一页有 2 个 fragment → 3 次画面变化（换页算第一次），两拍落在
        # 说话时长的 1/3、2/3 处；假设句尾有 1 秒停留，分母是含停留的实测时长，
        # 所以比例略小。算法见「页内节拍：按变化次数算」；不要手写固定比例。
        cues:
          - { fragment: 1, at_progress: 0.27 }
          - { fragment: 2, at_progress: 0.54 }
         # volcengine 才能写 at_word: { fragment: 1, at_word: 先看 }
  - id: s02
    engine: manim
    scene: scenes/s02.py                          # manim 段必须给 scene
    sentences:
      - id: s02-1
        say: 把这些部分和画成折线，它会逼近一条水平线。
```

## 七条会直接决定成败的规则

1. **句子 id 全文唯一，但"返工单位"取决于旁白契约**（见下一节）：
   - `deepseek`（逐句契约）：一句 = 一个录制单元 = 一个重试单元，音频是 `audio/<id>.wav`。改一句就只重录那一句（`sentences: [<id>]`）；已补过页尾停留的项目例外，见 `video-teach-iterate`。
   - `volcengine`（母带契约）：旁白是**一条母带**（`audio/narration.mp3`；按约 480 字分块请求、再拼成一条音轨），句子只是母带里的一个区间（`beginMs` + `durationMs`）；画面上**一个 slides 段一次连续录制**。所以返工单位是**段**，不是句：改一句台词要重合成整条母带、重录整段画面。
2. **`say` 是念出来的字**，不是标注、不是提示词。中文按字计费，一句控制在 15–40 字；超过 120 字会被警告，超过 300 字直接拒绝。
3. **cue 有两种时间写法，取决于 provider**：
   - `at_progress`（0–1，句子（或母带里这一段）实测时长的比例）：**两个 provider 都能写**，`deepseek` 下是唯一能用的写法；`volcengine` 下也认，但它不对词，只是"在这一段里按比例落"。**逐句契约的分母包含句尾停留的静音**。数值不是随手写的，要按「页内节拍：按变化次数算」的公式得出：一页 n 个 fragment 就有 n+1 次画面变化，第 k 个 fragment 落在说话时长的 k/(n+1)。它不与发音逐字对齐，属于按语义给的节拍，不要据此承诺"讲到哪个字画面动到哪"。
   - `at_word`（稿子里看得见的词）：**只有 `volcengine` 能用**，因为它返回字级时间戳。deepseek 下写 `at_word` 会在校验阶段被拒绝，并提示改用 `at_progress`。
   - 一条 cue 只能写其中一个；都不写表示这句一开始就切。
4. **`fragment` 从 1 开始、在所在页内递增**。它是 reveal.js 的 fragment 序号，不是自由标签。页模式下编号**按页重来**：第 2 页的第一个节拍又是 1（因为 deck 的 `teachCue` 数的是当前页的 fragment）；纯 cue 模式（`volcengine`）不分页重来，全片一路递增，多页 deck 由录制器按这个号翻页。
5. **`deepseek` 是一句一页，句内可分步**；`volcengine` 是"页跟着节拍走、跨句不重载"。无词时间戳时，画面契约是"每句一页 + 页内按 `at_progress` 分步"：句子开页，节拍依次显现。要让几句共用一个版面，按「一页承载多句」写 `page` / `enter`。**换页本身算第一次画面变化**，一页 n 个 fragment → n+1 次变化；第 k 个 fragment 落在说话时长的 k/(n+1) 处，所以最后一拍也在句内结束，最后一段句长加尾停留才是"完整一屏"的停留。一句里放 2–3 个节拍最舒服；超过 3 个通常说明这句话讲了两件事，应当拆句——`video_teach_plan` 会报出来。
6. **每句以句末标点收尾**。`volcengine` 默认把**整份稿子合成一条母带**（超过约 480 字自动分块，块内一次请求）；补 `。` 只发生在**块内**相邻句之间，块与块之间是两条音频直接拼接；上一句若以逗号结尾，换来的只是逗号级换气，边界会糊。`deepseek` 逐句请求、不合并，标点仍决定它自己的停顿长短。问句用 `？`、感叹用 `！`，停顿更长。
7. **停顿策略随 provider 不同，这是实测结论**：
   - `deepseek`（默认）：**不补停顿**。它的气口本来就自然，补过反而显得赶；听感测试里原样拼接最像同一个人。
   - `volcengine`：按标点补，且只补不裁 —— `。` 约 400 ms、`？`/`！` 约 480 ms、`，`/`、`/`；` 约 170 ms、无标点约 120 ms。**这条只对 `merge: none` 的逐句合成生效**；母带由服务自己按标点断句，插件不再逐句补。
   - 两种都不裁语音自己的停顿：语音留得更长时按语音的算。

## 两种旁白契约：先看你手上的 provider 走哪条

同一个 `storyboard.yaml` 结构，两种 provider 走出来的是两套流水线。**先确定走哪条，再决定稿子和返工方式**；`video_teach_plan` 的 `picture:` 行会同时写画面驱动与旁白契约（母带契约下还会点名 `audio/narration.mp3`）。

| | `deepseek`（逐句契约） | `volcengine`（母带契约） |
|---|---|---|
| 旁白 | 逐句请求、逐句文件 `audio/<id>.wav` | **一条母带** `audio/narration.mp3`（约 480 字一块，块一次请求），句子是 `beginMs` + `durationMs` 的区间 |
| 画面驱动 | 页模式：一句一页，`at_progress` 按实测时长比例 | cue 模式：节拍在 `at_word` 的词上；**每句开头把页面翻到这一句第一个节拍所在的页**（没有节拍的句子不翻，沿用上一句的画面），句中跨页的拍再翻一次 |
| 录制 | 一句一次 `page.goto` | **一个 slides 段一次连续录制**，deck 只加载一次，跨句不重载 |
| 句间接缝 | 硬切或 `meta.transition` 尾转场 | **没有接缝**：翻页就是转场，录在它发生的时刻 |
| 返工单位 | 一句 | 一个 slides 段（`sentences:` 会自动扩到整段并报告多录的句 id） |
| `timings.json` | 每句 `audio` + 相对词时间 | 根上 `narration` + 每句 `beginMs`，两者互斥 |

### 怎么选：默认 DeepSeek，这三件事才换 volcengine

| 你要什么 | 选谁 | 为什么 |
|---|---|---|
| 默认的讲解片（要点分步、图文对比、结论） | **`deepseek`** | 逐句请求、气口自然，跨句听感最像同一个人；不需要词级对轨 |
| **讲到某个词、画面就动一下**（`at_word`） | `volcengine` | 只有它返回词级时间戳，cue 才能挂在词上 |
| **旁白快慢要可调**（`speed_ratio`） | `volcengine` | 只有它的接口收整数语速；`deepseek` 没有这个参数 |
| **长稿要连续语气、整片一条音轨** | `volcengine` | 默认就是母带契约；注意每约 480 字一个块，块边界处语气仍会重启 |

反过来，换 `volcengine` 也要接受两个代价：**返工单位变成"段"**（改一句要重录整段、重合成整条母带），以及**句间没有"页尾停留"可补**（节奏由母带自己的气口决定）。想两者都要，用下面的 `merge: none` 把它拉回逐句契约。

### 怎么写：稿件里只有三个字段，凭据在设置里

```yaml
meta:
  voice:
    provider: volcengine            # 省略 = deepseek
    speaker: zh_female_liuchangnv_uranus_bigtts   # deepseek 默认 stella；volcengine 没有默认，必须写
    speed_ratio: 1                  # 可选，整数，0 会被拒；只有 volcengine 用它
```

- **凭据引用名跟 provider 走**：`deepseek` 用 `DEEPSEEK_API_KEY`（Bearer），`volcengine` 用 `ARK_VOICE_API_KEY`（X-Api-Key）。两个都在设置的「教学视频」里配，一个 provider 一行；**视频生成的 `ARK_API_KEY` 与语音无关，不能拿来当语音 key**。
- **契约默认由 provider 决定，`merge` 是那个开关**：`provider: deepseek` → 恒为逐句契约；`provider: volcengine` → 默认母带契约，narrate 带 `merge: none` 则回到逐句契约（见下面的逃生门）。`video_teach_plan` 的 `picture:` 行现在同时写画面驱动与旁白契约。
- **`speed_ratio` 在 `deepseek` 下会被静默忽略**（合成请求里没有语速字段），不报错也不生效——要调语速就得换 provider。

### 逃生门：`merge: none` 把 volcengine 拉回逐句契约

`video_teach_narrate` 的 `merge` 参数（`auto` 默认 / `none`）只对 `volcengine` 有意义：

- `auto`（默认）：整份稿子一次请求 → **母带契约**（一条 `audio/narration.mp3` + 每句 `beginMs`，画面每段连续录制）。
- `none`：逐句请求、逐句文件 `audio/<id>.mp3` → **逐句契约**：可以只重做一句、可以补页尾停留、可以用 `meta.transition`，代价是跨句语气会漂。

用它的场合：要隔离某一两句做 A/B、要逐句音频单独交付、或者必须给某一屏补停留。**换契约要重新 narrate**，只改参数不会把已有母带拆开。

母带契约的两个直接后果，写在稿子之前就该知道：

- **没有「页尾停留」可补**。句间的停顿由母带自己的气口决定，`video-teach-iterate` 的补静音流程只适用于逐句契约。
- **区间必须铺满母带**：span 0 从 0 起、后一段接着前一段，`timings.json` 解析时拒绝有缝或有重叠的写法（报 `must tile the master`）。这是手改文件时最容易踩的一条。
- **`meta.transition` 在母带契约下不生效**（`video_teach_plan` 会提示）：没有接缝可切，deck 自己的页切换就是转场。

## 页内节拍：按变化次数算，不要手写比例

默认 provider（`deepseek`）没有词时间戳，页内节拍由作者给比例。**该给多少不是审美问题，是算出来的**：一页有几个动作，动作就该均匀落在这一句的相应位置上。

- **一页有 n 个 fragment，就有 n+1 次画面变化**：换页是第 1 次（t = 0），第 k 个 fragment 是第 k+1 次。
- **第 k 个 fragment 的这一次变化落在这一句"说话时长"的 k/(n+1) 处**。说话时长 = `durationMs` − 尾停留静音（没加过停留就是 `durationMs` 本身）。**尾停留不是 `storyboard.yaml` 的字段**，它是对音频的后期处理（见 `video-teach-iterate` 的「页尾停留」）。
- **换算成 `at_progress` 时，分母是含尾停留的 `durationMs`**：

  ```
  spoken         = durationMs − holdMs
  at_progress(k) = (k/(n+1) × spoken) / durationMs
  ```

  例：n = 2、说话 4.16 s、尾停留 1 s → `durationMs` = 5.16 s，两拍在 1.39 s 与 2.77 s，`at_progress` ≈ 0.27 / 0.54。念完前 1.39 s 动作已全部播完，后面 1.39 s + 1 s 静默留给完整一屏。

- **为什么不能手写固定的 0.4 / 0.72**：这个比例和"这一页有几个动作"无关；加上尾停留后分母变长，同样的比例会把动作整体往后推，最后一拍几乎贴着句尾，观感就是"念完了才动，然后干停一秒"。
- **改了 deck 的页数或某页 fragment 数，cues 要整页重算**；只重渲染，不用重录旁白（见 `video-teach-iterate`）。

实现上数一遍每页 `.fragment` 的个数、读 `timings.json` 的 `durationMs`、按公式写回 `storyboard.yaml` 即可。deck 的 `<section>` 顺序必须与句子顺序一致，否则数和句会错位。如果算出第一拍低于 20%，`video_teach_plan` 会给 warning——这通常是在提示该拆句或拆页。

## 一页承载多句：`page` / `enter`

三句讲同一件事的三个次第时，画面的元素框往往完全重合，翻页感只剩下右上角页码和左侧标题整行替换。这时让这几句共用 deck 里的一个 `<section>`，稿件用两个可选键说明页归属：

```yaml
sentences:
  - id: a00-6
    say: 第一个负责存。
    page: 5                       # 从 0 起的页号；缺省＝本句在段内的下标
    cues: [{ fragment: 1, at_progress: 0.3 }]
  - id: a00-7
    say: 第二个负责自己组织。
    page: 5
    enter: 1                      # 进这一页时已经亮到第 1 拍
    cues: [{ fragment: 2, at_progress: 0.3 }]
```

`enter` 不写时按「同页上一句**留在屏幕上的拍数**」推算（本句是该页第一句时为 0）。写成与推算值相同的数时两种写法等价，写出来只是让读稿的人不用自己推一遍；写成更大的值是刻意在句首跳拍（合法），写成更小的值会被拒绝（见下）。独立成页的句子也可以写 `enter > 0`，效果是「这一页一打开就亮着几拍」，用在你希望它接着上一段的观感时；这时 `page` 写它自己的下标，其余句子可以不写（见下面第 1 条）。两个键都只能是非负整数，且 `enter` 必须和 `page` 写在同一句上：只写 `enter` 说不清是进哪一页（这一条在解析期就拒绝，并给出行号）。

**共享页上编号规则反转**：同一页内 fragment 要跨句继续递增（第 1 句 1、第 2 句 2、第 3 句 3）。`teachCue` 是幂等的「显示到第 k 步」，同页第二句若又从 1 编号，第一拍只会把已经亮着的再确认一次，画面不动。不同页之间照旧每页从 1 起，判定看两句的 `page` 是否相同。

以下写法会被拒绝（`video_teach_plan` 在花钱前报出来）：

1. **只给一部分句子写 `page`**。例外只有一种：句子写 `page: <它自己的下标>` **并且**写了 `enter`，也就是「这一页一打开就亮着几拍」——这种声明不挪页，可以单独写。除此之外（声明了别的页，或者只写 `page: i` 却没写 `enter`）都必须整段都写：共享关系与进页状态都要看相邻句，半张映射没有唯一答案。
2. **`page` 回退**。录制严格按句序，页号变小等于让画面倒着走。
3. **`enter` 不小于本句第一个 cue 的 `fragment`**。那一拍开录前就亮过了，cue 到时不会有任何变化。校验给出的改法是一个**区间**：不小于上一句留下的拍数、小于本句首个 cue；这个区间为空（上一句留下的比首个 cue 还多）时，唯一出路是把节拍按整页重新编号。
4. **`enter` 比同页上一句留下的拍数还少**。写出来的 `enter` 是权威值，比承接值小就意味着开录瞬间有一拍**消失**，观众看到的是画面倒退。要带着上一句的状态就干脆不写，要换状态就写更大的值（或干脆换页）。同一句最多报一条：若首个 cue 也不高于上一句留下的拍数，那就没有任何 `enter` 值可用，改法是重新编号。
5. **同一页内 fragment 没有递增**，也就是上面那条编号规则被违反。
6. **`enter` 没写 `page`**。解析期就拒绝并给出行号：只写 `enter` 说不清是进哪一页。

以下几件由 deck 侧核对：**挪去的页必须真实存在**（`max(page) + 1` 超过 deck 的页数会被拒绝，那一页根本不存在；deck 有多出来的页不会被录到时只给 warning），以及**页数数不出来时**（deck 没有 `<section>`，页在 JS 里生成）明说一句「页号没有核对过」而不是静默跳过。细节见 `video-teach-slides`。

在 `volcengine`（词级时间戳、纯 cue 模式）下这两个键不生效，`video_teach_plan` 会提示一句，不要以为画面会跟着变。Manim 段也不看这两个键。

**共享页改变了「这句没有 cue 也不算缺陷」的前提**。单独一页时，没有 cue 的句子里画面仍然变了（换页就是那次变化）；共享页上，若这一句既不开新页、也不写更大的 `enter`，那么它整句期间画面一动不动——这条现在会被 `video_teach_plan` 记为 silent 并点名。要么给它一个节拍（编号接着上一句继续数），要么让它独享一页。

**母带契约下不需要这两个键**：一个 slides 段连续录制，几句的节拍落在同一页上，deck 自己就不会翻页——共用一页在这里是「节拍还没走到下一页」，不用声明。

**它换不来什么**：共享页内没有转场——两句在同一页上，没有页码可翻，硬录只会让下一句的 `enter` 状态提前闪进画面（`video_teach_plan` 会把这条当成降级说出来）。跨句转场本身现在有了，但要显式声明，见下一节。重录仍只花一句的钱，页模式仍没有词时间戳。

**每页 6 个 fragment 的上限仍然成立**（约定，不由代码强制），共享页更快撞到：三句各两拍正好到顶，再多就说明这几句不该挤在一页。

## 跨句转场：`meta.transition`（只属于逐句契约）

**先看你在哪条契约上**（见上文「两种旁白契约」）：

- **母带契约**（`volcengine` + 默认 `merge: auto`）**没有句间接缝**，翻页录在它发生的时刻，`meta.transition` 写了也不生效（`video_teach_plan` 会提示你删掉；渲染时 `exitMs` 恒为 0，接缝类 finding 也一并跳过）。这条不用管。
- **逐句契约**（`deepseek`，或 `volcengine` + `merge: none`）里，句子之间默认硬切；要让翻页发生在画面里（含 reveal 的 Auto-Animate 跨页形变），在 `meta` 里声明一次：

```yaml
meta:
  transition:
    mode: deck          # deck | none；none 等于不声明
    durationMs: 520     # 100–1200，必填，不写就拒绝（不给默认值）
sentences:
  - id: a00-4
    say: 这句念完之后画面才会翻页。
    transition: none    # 可选：这一句的尾部回硬切
```

三条要记牢：

1. **时长归稿件，形态归 deck**。稿件只写"多长"，是淡入、滑动、缩放还是跨页形变，都在 deck 里（`data-transition`、`data-auto-animate`）。逐句只允许写 `transition: none`，写别的形态会被拒绝。**`durationMs` 要不短于 deck 声明的 `window.teachPageTransition`**，否则转场只录到一半就被切（`video_teach_plan` 会给 warning）；跨页 Auto-Animate 还要对齐 deck 的 `autoAnimateDuration`。
2. **只有"同段、同 engine、下一页 ≠ 本页"才有转场**。共享同一页的两句之间没有转场（没有页码可翻）；段与段之间、幕与幕之间一律硬切（另一个 deck / 另一份项目，拿不到下一页初态）。
3. **它让每一句长了一点**。时间轴里每句多出 `exitMs`，成片时长、SRT 起点、逐幕验收都按 `durationMs + exitMs` 算。作者只需要知道一件事：**改了某一句的版面，它前一句的尾转场还停在旧版面上**，重新录前一句（`video_teach_render sentences: ["<前一句 id>"]`）。渲染结果的 `seam_findings` 会点名这件事，但不会自动替你重录。

`video_teach_plan` 在此之前就会把账算清：`transitions:` 一行写"多少句有转场、多出多少毫秒、哪些被降级以及为什么"（共享同页 `same-page` / 段末 `segment-end` / manim 段 `manim` / deck 页数数不出来 `cue-mode`）。**转场录在前一句的尾部，不在后一句的开头**，所以句首永远是完整构图，句尾的"最后一屏停留"也仍然完整。

## 写完先做什么

```
video_teach_plan        # 校验 + 估时 + 报告本机缺哪个可执行，并说明走哪条契约
video_teach_narrate     # 合成旁白，写 timings.json（付费、联网）
                        #   deepseek：逐句请求、逐句音频文件
                        #   volcengine：一条母带（按 480 字分块请求）+ 每句 beginMs
# ↓ 只对 deepseek（逐句契约）适用：
#   需要页尾停留 → 给每句音频尾部补静默并改写 durationMs（见 video-teach-iterate）
#   尾停留定了之后 → 按每页变化次数重算 cues（见上文「页内节拍」）
video_teach_render      # 渲画面并拼成 renders/<shot>/vNNN.mp4，把旁白烧进画面
                        #   deepseek 逐句录；volcengine 每段连续录
video_teach_export      # SRT、timeline.json、deck/，以及两张封面（写了 meta.cover 才有）
```

`video_teach_plan` 不花钱。**解析期**的错误给行号与具体键；**内容与 deck 规则**的错误按句子 id 与键点名（不给行号）。它还会读 deck HTML，检查录制器要用的三个全局（`teachReady`、`teachCue`、`teachPage`——页模式与多页的 cue 模式都要它）与页数是否够用。先跑它，再花钱。cues 的数值依赖 `durationMs`，所以顺序是**先定尾停留、再算 cues、最后渲染**。

## 封面：单独一页 HTML，两种画幅

封面是**作者写的一页**，不是成片首帧，也不是 deck 的首页：首帧通常是半句话加动画中途，缩到 300 px 读不出东西。做法：

- 稿件里写 `meta.cover: cover/index.html`（相对稿本目录）。不写就没有封面，`video_teach_export` 会明说，不会拿首帧顶替。
- 这一页会被截图**两次**：1920×1080（16:9）与 1440×1080（4:3），落到成片旁边 `vNNN.cover-16x9.png` / `vNNN.cover-4x3.png`。两种画幅等高、只改宽，所以版面用一个 media query 写一次：

```html
<style>
  body { margin: 0; height: 100vh; background: #0f172a; color: #f8fafc }
  h1 { font-size: clamp(40px, 6vw, 90px); margin: 0 }
  @media (max-aspect-ratio: 4/3) { h1 { font-size: 72px } }  /* 4:3 下别让标题出界 */
</style>
```

- 契约比 deck 轻：**不需要** `teachReady` / `teachCue` / `teachPage`。截图前等 `document.fonts.ready` 加 150 ms，所以别写无限动画（会截到中间态），也别依赖需要点击才出现的内容。
- 截完会数一次颜色：整页只有一种颜色就当失败（说明样式没加载或脚本报错），不会悄悄出一个纯色封面。
- **一句话能读清、缩到手机列表能认出**：一个主标题 + 至多一行副标题就够了。片长、期号这类信息放副标题，不要放第三行。

## 常见错误

- `engine: manim` 却没写 `scene`，或 `engine: slides` 却写了 `scene` —— 两者不能互换。
- 为了不装 Manim 却仍写了 `engine: manim` —— 改成 `engine: slides` 并删掉 `scene`，路线照样通。
- `at_word` 写了稿子里没有的词 —— 校验会拒绝，因为这句话的画面永远不会动。
- 在 `provider: deepseek` 下写 `at_word` —— 会被拒绝（没有词时间戳）；改成 `at_progress`。
- **手写固定的 `at_progress`（比如 0.4 / 0.72）** —— 它和这一页有几个动作无关，加上尾停留后会把动作推到句尾；按「页内节拍」的公式算。落在 20%–80% 之外仍会 warning（太靠两端容易被换气吞掉）。
- **用尾停留代替句内节拍** —— 尾停留只负责最后一屏看得住，动作本身仍要在念完之前播完；顺序是先补尾停留、再按变化次数重算 cues。
- **改了 deck 的 fragment 数却没重算 cues** —— 节拍会落空或挤在句尾；重算后只需要重渲染。
- **共享页上忘了让编号跨句递增** —— 同页第二句又从 1 编号，第一拍画面不动；`video_teach_plan` 会拒绝这种写法。
- **`enter` 写成等于或大于本句第一个 cue 的 `fragment`** —— 那一拍在开录前就亮过了，cue 到的时候不会有变化，同样会被拒绝。
- **以为共享页能拍出句间过渡** —— 在逐句契约下每句仍是独立录制再拼接，跨句必然硬切；母带契约下共享页天然连续（一个段一次录制）。
- **在 `volcengine` 稿子里靠 `meta.transition` 想要页间转场** —— 母带契约没有接缝，这句配置不生效。翻页录在句首与跨页的拍上，`video_teach_plan` 会提示。
- **以为母带契约也能"只重录一句"** —— 旁白是一次请求、画面是一段一次录，改一句就是重合成整条母带 + 重录整段；`video_teach_narrate sentences: [...]` 会直接拒绝，`video_teach_render sentences: [...]` 会扩到整段。
- **改了台词只跑 `video_teach_export`** —— 烧进画面的字幕与外部 SRT 同源于 `timings.json`，export 不动画面。会分叉的时机是「重新 narrate 了却没重渲」：文件里新、画面里旧。改台词走 `narrate → render → export`。
- **把封面画成 16:9 固定宽度的版面** —— 4:3 那张会被裁掉两边；用 media query 或流式宽度，别写死 `width: 1920px`。
- 段落误当句子塞进一条 `say` —— 会触发字数上限，也会让那一段的重录代价变成整段。
- **一句里塞两个句号** —— 合成时会被切成两句，但时间轴只认这一条的 id，句间停顿与词时间戳就对不上。一句话只写一个句末标点。
- **句子之间没用句号** —— 合并合成时插件会补上，但如果你用逗号或分号写“句子”，听起来只有逗号级换气，句子边界会糊。

## 内容与时间线的规则（`video_teach_plan` 会检查）

上一版样片踩的坑不是渲染问题，是内容与时间线打架：幻灯段有一句没写 cue，画面整整停了四十秒；Manim 段三句共用一个场景，同一段动画播了三次。下面这几条就是为它们写的，`video_teach_plan` 会按句子 id 报出来。

**1. 一句的时长预算**：中文 15–40 字，约 3–8 秒。低于 2 秒画面来不及看清，超过 8 秒一张画面要撑太久。按每秒 5 个字估（实测 876 字念了 174 秒）。

**2. 每句话都必须带来一次画面变化**。在 `volcengine`（有词时间戳）下，`slides` 段每句至少 1 个 cue，没有 cue 会被记为 silent 并点名。在默认的 `deepseek` 下，没写 `page` 时"这一句没有 cue"不算缺陷（换页本身就是变化），此时要看的是**页内节拍**：一句 2–3 个 `at_progress` 最舒服，超过 3 个说明这句话讲了两件事。**共享页是例外**：同一页上既不开新页、也没有 cue（或更大的 `enter`）的那一句，整句画面不动，会记为 silent 并点名（见「一页承载多句」）。节拍的位置按「页内节拍」的公式算，不要手写固定比例。

**3. cue 的 fragment 必须落在它所在那一页实际拥有的 fragment 数之内**。纯 cue 模式下按整份 deck 核对，越界是结构性错误，`video_teach_plan` 直接拒绝（那时还没花钱）；页模式下按页核对，越界给 warning 并指出是第几页——模板的 `teachCue` 会在页末夹住，不会翻页，但节拍就落错了位置。页模式下不同页之间不用递增（每页重新从 1 起），但**同一页内跨句必须递增**（共享页，见「一页承载多句」）；纯 cue 模式里重复且不递增可以渲染，但画面不会动，会变成 warning。

**4. Manim 段一句一场景文件、一句一类**。同一个场景被多句复用，就是同一段动画重复播；校验会列出所有共用该场景的句子 id。要么拆场景，要么把句子并成一句。

**5. 节奏密度**：全片平均每 4–8 秒一次画面变化。平均间隔超过 8 秒会 warning；`volcengine` 下连续两句都没有变化会额外点名这一对。

**6. 时长与画面互相配平**：Manim 场景自身的时长应落在该句旁白时长的 70%–100%。短了尾部会冻结，长了会被截断——渲染时这两种都会被兜住，但观感是断的，所以写场景时就按这个比例配 `run_time`。

这些是 warning，不是硬错误（fragment 越界除外）：规则不判断品味，只提示"这句话会让一张画面停多久"，值不值得改由作者定。

## 多幕并行：把稿本拆成一幕一份

片子分幕多、要同时出片时，**并行单元是一份稿本，不是一个目录，也不是一个会话**。

顺序执行时一个人从头看到尾；五幕同时派出去之后，问题全部藏在接缝上。

### 契约

每一幕一份稿本，放自己的子目录：

```
runs/<幕>/storyboard.yaml                    只有这一幕的句子
runs/<幕>/slides/<幕>/                       deck 副本（录制器读的是它）
runs/<幕>/audio/  timings.json  .dsh-video/  这一幕的私有状态
```

调用工具时**每次都带 `storyboard`**：

```
video_teach_plan    storyboard: runs/a05/storyboard.yaml
video_teach_render  storyboard: runs/a05/storyboard.yaml   shot: a05
```

漏掉这个参数，工具就回去动主项目那份稿本。给子会话传 `cwd` 帮不上忙：工具读的是会话创建时从父会话继承的目录，不是 `cwd` 参数。

### 为什么这样拆就隔离了

项目根取的是**稿本所在目录**，所以 `audio/`、`timings.json`、`.dsh-video/` 自然落在 `runs/<幕>/` 里，五幕互不覆盖；成片仍落在工作区根的 `renders/<幕>/`，回收时不用搬文件。这两条路径是分开的，别去改它。

### 派发前主线先做掉四件事

1. **铺节拍**：每页几个 `fragment` 一次性定。压暗强度这类视觉参数只能有一个出处，五个子任务各调会分叉。
2. **同步 deck 副本**：主项目改了 `slides/<幕>/` 没拷进 run 目录，渲染出来还是旧图，而且不会报错。`drift` 能查出来。
3. **钉解释器**：`runs/<幕>/.python-version` 写 3.11.x。系统 python 常常没有 PyYAML，节拍脚本会崩在 import。
4. **记基线**：主项目稿本与 `timings.json` 的 sha256，回收时用它证明没被碰过。

插件的 `assets/teach/runs.py` 用 `prepare --act <幕>` 把这些一次做掉，顺带把本幕稿本切进 `runs/<幕>/storyboard.yaml`（拷进项目 `script/runs.py` 再用）。

### 三件事不要委托给子任务

- **事实一致性**：同一句错的判断会在两幕里各写一遍，没有人会去比对另一幕。审计放在合并阶段对全片统一做。
- **视觉参数**：见上，只能一个出处。
- **验收**：子任务只能报"渲完了"；验收要看帧、听音频，见 `video-teach-iterate` 的「逐幕返工与合并」。

完整规程（提示词最小集合、回收清单、六条禁止事项）见插件仓库的 `docs/TEACH-PARALLEL-ACTS.md`，它不在你的工作区里。

## 做宣传教学片时：结构比画面先定

给产品或插件做宣传片时，前两稿被打回都不是渲染问题，是结构问题。照这四条改，通常一次就能过：

1. **钩子从观众的问题开始**，不要用"这条片子是它自己做的"这类自指彩蛋开场。观众得先认出自己的痛（"同一个镜头抽十几次，分不清哪一版能用"），才愿意听你怎么解决。
2. **一句话主张要能直接念出来**，并且不和后面的命名打架。片子里如果把同一个词既当贬义（痛点）又当路线名（客观），观众第一分钟就会觉得矛盾；主张句只讲纪律，路线名留到分岔页再出现。
3. **两条路线要用结构体现，不是一句台词**。抽卡路线（在线模型）与本机路线（slides + Manim）至少各有一页细节，中间放一页正面回答"选哪条"；再点明两条路线落在同一个 `renders/`、同一套版本号。
4. **先讲价值、后讲操作，安装命令最多出现一次**。加一页就要合并一页：每多一句都多一次 TTS 费用，片长控制在 60–75 秒比较稳。

