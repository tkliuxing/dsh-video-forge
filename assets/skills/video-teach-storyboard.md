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
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html                   # 省略时取 slides/<id>/index.html
    sentences:
      - id: s01-1
        say: 先看前几项完全平方数的倒数，它们一次比一次小。
        cues:
          - { fragment: 1, at_progress: 0.25 }   # 句子放到 25% 时出现
          - { fragment: 2, at_progress: 0.6 }    # 60% 时再出现一项
         # volcengine 才能写 at_word: { fragment: 1, at_word: 先看 }
  - id: s02
    engine: manim
    scene: scenes/s02.py                          # manim 段必须给 scene
    sentences:
      - id: s02-1
        say: 把这些部分和画成折线，它会逼近一条水平线。
```

## 七条会直接决定成败的规则

1. **一句 = 一个录制单元 = 一个重试单元**。句子 id 同时也是音频文件名（`audio/<id>.mp3`）与时间轴的键，**全文唯一**。想改一句话就只改那一句，重跑 `sentences: [<id>]`。
2. **`say` 是念出来的字**，不是标注、不是提示词。中文按字计费，一句控制在 15–40 字；超过 120 字会被警告，超过 300 字直接拒绝。
3. **cue 有两种时间写法，取决于 provider**：
   - `at_progress`（0–1，句子音频时长的比例）：**两个 provider 都可用**，是默认 provider `deepseek` 下唯一能用的写法。`0.25` 表示这句话放到四分之一时切到那一步。它不与发音逐字对齐，属于按语义给的节拍。
   - `at_word`（稿子里看得见的词）：**只有 `volcengine` 能用**，因为它返回字级时间戳。deepseek 下写 `at_word` 会在校验阶段被拒绝，并提示改用 `at_progress`。
   - 一条 cue 只能写其中一个；都不写表示这句一开始就切。
4. **`fragment` 从 1 开始、在所在页内递增**。它是 reveal.js 的 fragment 序号，不是自由标签。页模式下编号**按页重来**：第 2 页的第一个节拍又是 1（因为 deck 的 `teachCue` 数的是当前页的 fragment）；只有纯 cue 模式（`volcengine`、全片一页）才是全片一路递增。
5. **一句一页，句内可分步**。无词时间戳时，画面契约是"每句一页 + 页内按 `at_progress` 分步"：句子开页，节拍依次显现。一句里放 2–3 个节拍最舒服；超过 3 个通常说明这句话讲了两件事，应当拆句——`video_teach_plan` 会报出来。
6. **每句以句末标点收尾**。`volcengine` 会把相邻几句合并成**一次**请求（默认行为），句子之间由插件补 `。` 再发出去；上一句若以逗号结尾，换来的只是逗号级换气，边界会糊。`deepseek` 逐句请求、不合并，标点仍决定它自己的停顿长短。问句用 `？`、感叹用 `！`，停顿更长。
7. **停顿策略随 provider 不同，这是实测结论**：
   - `deepseek`（默认）：**不补停顿**。它的气口本来就自然，补过反而显得赶；听感测试里原样拼接最像同一个人。
   - `volcengine`：按标点补，且只补不裁 —— `。` 约 400 ms、`？`/`！` 约 480 ms、`，`/`、`/`；` 约 170 ms、无标点约 120 ms。它逐句合成时句尾气口偏短，不补会显得被切断。
   - 两种都不裁语音自己的停顿：语音留得更长时按语音的算。

## 写完先做什么

```
video_teach_plan        # 校验 + 估时 + 报告本机缺哪个可执行
video_teach_narrate     # 合成旁白（相邻句合并成一次请求），写 timings.json（付费、联网）
video_teach_render      # 逐句渲染并拼成 renders/<shot>/vNNN.mp4
video_teach_export      # SRT、timeline.json、deck/
```

`video_teach_plan` 不花钱，报错会指出**行号与具体键**；它还会读 deck HTML，检查录制器要用的三个全局（`teachReady`、`teachCue`、页模式下的 `teachPage`）与页数是否够用。先跑它，再花钱。

## 常见错误

- `engine: manim` 却没写 `scene`，或 `engine: slides` 却写了 `scene` —— 两者不能互换。
- 为了不装 Manim 却仍写了 `engine: manim` —— 改成 `engine: slides` 并删掉 `scene`，路线照样通。
- `at_word` 写了稿子里没有的词 —— 校验会拒绝，因为这句话的画面永远不会动。
- 在 `provider: deepseek` 下写 `at_word` —— 会被拒绝（没有词时间戳）；改成 `at_progress`。
- `at_progress` 写 0.9 或 0.05 —— 能跑，但会被警告：太靠两端容易被换气吞掉，20%–80% 更稳。
- 段落误当句子塞进一条 `say` —— 会触发字数上限，也会让那一段的重录代价变成整段。
- **一句里塞两个句号** —— 合成时会被切成两句，但时间轴只认这一条的 id，句间停顿与词时间戳就对不上。一句话只写一个句末标点。
- **句子之间没用句号** —— 合并合成时插件会补上，但如果你用逗号或分号写“句子”，听起来只有逗号级换气，句子边界会糊。

## 内容与时间线的规则（`video_teach_plan` 会检查）

上一版样片踩的坑不是渲染问题，是内容与时间线打架：幻灯段有一句没写 cue，画面整整停了四十秒；Manim 段三句共用一个场景，同一段动画播了三次。下面这几条就是为它们写的，`video_teach_plan` 会按句子 id 报出来。

**1. 一句的时长预算**：中文 15–40 字，约 3–8 秒。低于 2 秒画面来不及看清，超过 8 秒一张画面要撑太久。按每秒 5 个字估（实测 876 字念了 174 秒）。

**2. 每句话都必须带来一次画面变化**。在 `volcengine`（有词时间戳）下，`slides` 段每句至少 1 个 cue，没有 cue 会被记为 silent 并点名。在默认的 `deepseek` 下画面本来就一句一页，因此"这一句没有 cue"不算缺陷；此时要看的是**页内节拍**：一句 2–3 个 `at_progress` 最舒服，超过 3 个说明这句话讲了两件事。

**3. cue 的 fragment 必须落在它所在那一页实际拥有的 fragment 数之内**。纯 cue 模式下按整份 deck 核对，越界是结构性错误，`video_teach_plan` 直接拒绝（那时还没花钱）；页模式下按页核对，越界给 warning 并指出是第几页——模板的 `teachCue` 会在页末夹住，不会翻页，但节拍就落错了位置。页模式下跨句的编号不需要递增（每页重新从 1 起）；纯 cue 模式里重复且不递增可以渲染，但画面不会动，会变成 warning。

**4. Manim 段一句一场景文件、一句一类**。同一个场景被多句复用，就是同一段动画重复播；校验会列出所有共用该场景的句子 id。要么拆场景，要么把句子并成一句。

**5. 节奏密度**：全片平均每 4–8 秒一次画面变化。平均间隔超过 8 秒会 warning；连续两句都没有变化会额外点名这一对。

**6. 时长与画面互相配平**：Manim 场景自身的时长应落在该句旁白时长的 70%–100%。短了尾部会冻结，长了会被截断——渲染时这两种都会被兜住，但观感是断的，所以写场景时就按这个比例配 `run_time`。

这些是 warning，不是硬错误（fragment 越界除外）：规则不判断品味，只提示"这句话会让一张画面停多久"，值不值得改由作者定。
