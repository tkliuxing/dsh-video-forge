# Video Teach Iterate — 改一句只重录一句

教学视频的迭代规则只有一条：**音频是时间轴的权威，句子是重录的单位**。任何改动都先问"这会动到哪几句"，再决定重跑多少。

**一个例外要知道**：`volcengine` 合成默认把相邻的几句**合并成一次请求**（为了语气连贯，见下面“合并合成改变了什么”），“重做一句话”会连带重做它所在的那一次请求。**默认的 `deepseek` 则是逐句请求**，所以它反而是最细的粒度：改一句只重合成那一句。画面侧的粒度两种都一样，永远是一句一段。**另一个例外是页尾停留**：项目给音频尾部补过静默之后，改台词要全量重录（`video_teach_narrate` 会重新量所有句子的时长，已补静默的句子会被再补一次），见「页尾停留」。

## 五种改动，五种代价

| 你改了什么 | 要重跑 | 代价 |
|---|---|---|
| 某句的 `say`（台词） | `video_teach_narrate` 全量重录 → 补尾停留 → 重算 cues → `video_teach_render` | 全片语音 + 全片画面（已补过静默时不能只重录一句，见「页尾停留」） |
| 某句的 `cues`（画面切换点） | 只 `video_teach_render sentences: [<id>]` | 一句画面，**不用重新合成语音** |
| 页尾停留（每页切页前约 1 秒无声） | 给每句音频尾部补静默 → 重渲染全片（`durationMs` 变了） | 本机免费；不重录旁白，但**补过的音频再补会叠加** |
| 某个 deck / scene 的排版 | 该段所有句子的 `render`（画面变了就要重录） | 只画面 |
| 音色、`speed_ratio` | 全量 `narrate` → 全量 `render` | 全片重来，因为每个词的偏移都变了 |

改版面那一条容易被忽略：同一个 deck 被多句共用时，改版面只影响它自己那句；但如果你在 deck 里改了**跨句共享的状态**（比如第二句要看到第一句留下的元素），就要把这一段从头录。

## 合并合成改变了什么

逐句单独发请求时，用户实际听出来“不像一个人”：音色没变，但语调与能量在句间漂；参数层面钉不住（`emotion`、`instruct` 这些字段实测没有效果，只有音色和整数语速可控）。改成一次请求多句之后，韵律跨句连续，问题才解决。

代价与边界：

- **重合成按“请求”计**，不按句子（这一条只对 `volcengine` 成立；`deepseek` 逐句请求，一句话就是一次请求）。`sentences: [s01-3]` 在合并模式下会把包含 `s01-3` 的那一段相邻句一起重合成，其余句子不受影响。
- **不跨过没被选中的句子合并**：中间那句沿用旧音频，合并会移动不该动的边界。
- 每次请求最多约 480 字，超过自动分段，长稿不会变成一次不可重试的请求。
- 想要逐句独立合成（对照、隔离某句的问题）用 `merge: none`，其余行为不变。
- 换音色或整数语速仍然是整片重来：每个词的偏移都会变。

## "只改画面不动语音"为什么成立

`timings.json` 是按句子存的：每句一条音频，外加词级时间戳（`deepseek` 没有，会写 `voice.timestamps: none`，画面改为一句一页（稿件的 `page` 可共页）+ `at_progress` 节拍）。渲染阶段只读它、不写它。所以：

- `video_teach_render sentences: [s01-2]` 只重录 `s01-2` 的段，别的段文件连 mtime 都不变。
- 组装时插件按稿件顺序把"这次渲染的"和"还在磁盘上的"合起来，缺哪句会直接报出句子 id，不会静默少一截。
- 段落文件在 `.dsh-video/teach/<句子 id>/segment.mp4`，可以整个删掉重来。

## 渲染结果里的「拍子迟到」和「末帧没播完」

`video_teach_render` 除了点数，还会报两件只在成片里才看得见的事，字段是 `motion_findings`：

- **拍子迟到**：某一拍实际落地的时刻比稿子说的时间晚了 120 ms 以上。原因是录制期间这台机器卡了一下（录制器的等待是一个定时器加一次到浏览器的往返，宿主忙的时候会迟到），**不是稿子的问题**。插件会自动重录这一句一次；仍然迟到才会报出来，这时再执行一次 `sentences: [<那句>]`，别去改 cues。
- **末帧没播完**：这一句的最后一帧与"把 deck 驱动到最后一拍后的版面"不一样，说明画面是用动画的一半被切下来的。这通常是稿子给的余量不够（最后一拍离句尾太近、或 `teachTransition` 声明得比实际动效短），改稿子或改用时，重录这一句就够。

两条都点名句子 id；`motion_findings` 为空才表示每一拍都在时间内播完了。**不要因为这两条去重跑 narrate**：旁白与它们无关。

判断真假也有边界：比较的是亮度差，所以"暗色元素在暗背景上变化"这种低对比度的动效可能漏报；页里有装饰性循环动画的，末帧本来就不会和截图一致，那是假警报。

## 页尾停留：让最后一屏停住约 1 秒

教学路线里**画面长度严格等于该句音频长度**（`timings.json` 的 `durationMs`），插件没有"尾停留"参数。DeepSeek 语音是 `natural` 策略、不补停顿，所以一句念完画面立刻切页，最后一个节拍几乎不停留。

正确的做法是给音频补静默，不要改渲染器：

1. 对每句 `audio/<id>.wav`（默认 provider 逐句合成）或 `audio/<id>.mp3`（`volcengine` 合并合成）用 `ffmpeg -af apad=pad_dur=<秒>` 追加静默，保持原采样率与声道。
2. 用 `ffprobe` **实测**补齐后的长度改写 `timings.json` 的 `durationMs`；不要用算术相加，避免舍入累积。
3. 按新的 `durationMs` 重算 cues（分母变了），再 `video_teach_render`（本机、免费）；`video_teach_export` 重出 SRT 与 timeline。

三条硬约束：

- **`timings.json` 是严格白名单**：只认 `voice` / `sentences` / `sampleRate` / `merge`。往里加自定义键（比如 `tailHoldMs`）会被 `video_teach_render` 拒绝（`unknown key`）。"是否已补过"的标记放旁车文件，例如 `script/.page-hold.json`。
- **别用 mtime 判断是否已补过**：写文件与 `st_mtime` 的精度差会让刚写完的文件被判成"更旧"，于是重复补一次。改成比对 `timings.json` 的 **sha256**；内容变了（重录过）才重新补。
- **改了台词要全量重录，不要只重录单句**：`video_teach_narrate sentences: [<id>]` 会从所有音频重新量时长，已经补过静默的句子会带着旧静默再被补一次，各页停留变成 2 秒。全量重录后再跑一次补静默，然后按新时长重算 cues。

补静默之后 `at_progress` 的分母变长，**必须重算 cues**（见 `video-teach-storyboard` 的「页内节拍」）；否则动作会整体后移，最后一拍贴到句尾。顺序固定为：定稿 → narrate → 补停留 → 重算 cues → render → export。

## 常见坑

- **改了台词却没重跑 narrate**：`video_teach_render` 会比对稿件与 `timings.json`，句子对不上就拒绝，并说明是哪一句 —— 别绕过它，绕过就会得到一条音画错位的片子。
- **只改 `say` 不改 `cues`**：词变了，`at_word` 指向的词可能消失，校验会拒绝。改台词时顺手看一眼 cues。
- **音色改了却只重录一句**：`timings.json` 里记着合成用的音色，`video_teach_plan` 会报 `stale`。音色是整片的，别半途换。
- **重录后忘了 export**：SRT 与 `timeline.json` 是按成片时间轴生成的外部字幕，改了片子要重新 `video_teach_export`，否则字幕对不上新版。
- **只跑 export 就想改画面里的字幕**：烧进画面的字幕是 `video_teach_render` **拼片时**生成的，export 只写外部 SRT。改了台词只跑 export，会得到「画面里旧字幕、文件里新字幕」的两份时间轴。要改画面里的字，必须重跑 `narrate → render`。
- **想只换封面却把整片重渲**：封面是 `video_teach_export` 从 `meta.cover` 那一页截的，改封面页只需重跑 export；文件名跟着最新版本号走，旧片的封面不会被覆盖。
- **封面只按 16:9 排版**：同一页还会在 4:3（1440×1080）下截一张，写死 `width: 1920px` 的版面会被裁掉两边。
- **加了页尾停留却没重算 cues**：`at_progress` 的分母变长，动作整体后移、最后一拍贴到句尾。先补停留，再按变化次数重算。
- **往 `timings.json` 里塞自定义键**：会被 render 拒绝（`unknown key`）；标记放旁车文件。
- **用 mtime 判断补静默是否执行过**：精度差会重复补；用 `timings.json` 的 sha256。
- **已补过尾停留时只重录一句**：那一句会带着旧静默再被补一次，各页停留不一致。改台词全量重录。
- **老 deck 的 `teachPage` 还写着 `Reveal.slide(n, 0, 0)`**：切页时会点亮第一拍，于是每页第一条 cue 永远不生效（画面一开就亮一块），共享页的 `enter: 0` 也无法兑现。模板从 2026-11-25 起用 `-1`（停在第 0 个 fragment 之前），但 `writeDeck` 不覆盖既有 deck，所以老项目要手改 deck 里那一行。这是**只改画面**：改完重跑 `video_teach_render`，不用重录旁白。
- **拿"文案变了"当旁白换了的证据**：画面、SRT、deck 文案都不是音频证据；要确认换没换，用包络相关或转写（见「逐幕返工与合并」）。
- **用主项目 `audio/` 覆盖 run 目录**：会把新录的音频盖成旧的；回收方向只能是 run → 主项目。

## 一次典型的返工

```
video_teach_plan                                    # 看是哪句、哪行出错
video_teach_narrate                                 # 改了台词就全量重录（已补过尾停留时尤其别只重录单句）
# 给每句音频补尾静默，并改写 timings.json 的 durationMs（做法见「页尾停留」）
# 按每页变化次数重算 cues（做法见 video-teach-storyboard「页内节拍」）
video_teach_render                                  # 全片重渲染（免费），旁白重新烧进画面
video_teach_export                                  # 重新出字幕、deck 与两张封面
```

只改某一页的版面、台词与节拍都没变时，仍可按句重录：

```
video_teach_plan
video_teach_render   sentences: [s02-1]
video_teach_render   assemble: true                 # 拼成新版本 v00N
video_teach_export
```

版本号每次成片 +1，旧版留着对比，不要手删。

## 逐幕返工与合并

多幕并行时（拆分方式见 `video-teach-storyboard` 的「多幕并行」），返工与合并有它自己的纪律。

### 先逐幕验收，再合并

合并不可逆：合并之后任何一幕返工都要重拼一次。所以每一幕先单独验收，过了再往下走。

| 项 | 判据 |
|---|---|
| 句数 | 该幕 `timings.json` 的句数 = 稿本句数 |
| 时长 | 成片时长 = 该幕 timings 合计（容差一帧） |
| **旁白真的换了** | 只有两条路：PCM 包络相关（同一段 ≈1.0），或直接转写 |
| 节拍 | 抽帧：句首是压暗态，句内某一刻点亮 |

**画面、SRT 文案、deck 文案都不是音频证据。** 有过一次改完台词，文案与画面都换了、音频还是旧的，连出三版才发现——三版都拿"文案变了"当证明。

### 回收用脚本，不要手 `cp`

```
python3 script/runs.py drift   --act <幕>     # 渲染前：副本与主项目一致吗
python3 script/runs.py collect --act <幕>     # 回收：先校验，再写
```

`collect` 先核对句数与逐句段长（容差两帧），任何一项不过就退出，**主项目一个字节都不动**——半收集比没收集更糟，主项目会混着新旧文件而没有标记。确认要按现状拷才加 `--force`。

回收的是 `audio/<幕>-*.wav`、逐句 `.dsh-video/teach/<id>/segment.mp4`、`timings.json` 与该幕稿本。不要回收整个 `.dsh-video/`：里面有中间帧，几百 MB，合并只需要逐句段。

### 合并三步

1. 备份主项目 `timings.json` 与 `storyboard.yaml`；
2. `timings.json` 按幕序拼接（句 id 已带幕前缀，不改 id）；
3. `storyboard.yaml` 按幕序补齐各段（含每句 cue），再 `assemble-act --all --join`。

合并后补三项全片验收：接缝处抽 9–10 秒转写（确认两幕的句子都在，concat 不吞句子）、看一眼末帧、章节表与整片时长对得上。

### 三条返工硬约束

- **不许用主项目 `audio/` 覆盖 `runs/<幕>/audio/`**：那会把刚录的新音频盖回旧的。回收是单向的，run → 主项目。
- **合并前不许删 `runs/<幕>/.dsh-video`**：删了之后单句重渲会报 `no picture for …`。
- **改完 deck 先同步副本再渲染**：录制器读的是 `runs/<幕>/slides/`，不同步就渲旧图。

## 中间产物：谁能删、谁要进版本库

| 文件 | 归属 | 进版本库？ |
|---|---|---|
| `storyboard.yaml` | 手写稿件，唯一入口 | **要** |
| `slides/<段>/`（含 reveal 运行时） | 手写版面、自包含 | **要** |
| `scenes/*.py` | 手写场景 | **要** |
| `timings.json` | 旁白产物，时间轴权威 | 要（它决定改动后是否要重录） |
| `audio/*`（`.wav` 逐句 / `.mp3` 合并） | 旁白产物 | 建议要（丢了就得重新花钱合成） |
| `deck/` | `video_teach_export` 导出的可交互版 | 不要，导出物 |
| `.dsh-video/teach/*/segment.mp4` | 逐句中间段，随时可重建 | 不要 |
| `renders/<shot>/vNNN.mp4` | 成片 | 不要（大文件），需要留档就另存 |

建议写进项目自己的 `.gitignore`（插件不会替你改）：

```gitignore
.dsh-video/
deck/
renders/
audio/*.mp3      # 团队要共享音色结果时删掉这一行
```

## 手改 `timings.json` 之后能只重录画面吗

能，而且这是它被单独存成文件的原因。`video_teach_render` 只读 `timings.json`，不写它：

- 改了某句的 `durationMs` 或词级时间点 → 直接 `video_teach_render sentences: [<id>]`，不用重新合成语音。
- 改了稿件的 `say` 或增删句子 → `video_teach_plan` 会报 `narration: stale` 并指出哪几句对不上，这时先 `video_teach_narrate` 补齐，再渲染。
- 改了 `meta.voice.speaker` → 全片都要重录，因为每个词的偏移都变了。

改完一定先跑 `video_teach_plan`：它同时会重算内容与时间线的规则（无 cue 句、fragment 越界、场景复用、平均节奏），比直接渲染省一次返工。
