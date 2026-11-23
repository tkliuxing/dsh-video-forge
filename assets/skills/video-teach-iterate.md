# Video Teach Iterate — 改一句只重录一句

教学视频的迭代规则只有一条：**音频是时间轴的权威，句子是重录的单位**。任何改动都先问"这会动到哪几句"，再决定重跑多少。

**一个例外要知道**：`volcengine` 合成默认把相邻的几句**合并成一次请求**（为了语气连贯，见下面“合并合成改变了什么”），“重做一句话”会连带重做它所在的那一次请求。**默认的 `deepseek` 则是逐句请求**，所以它反而是最细的粒度：改一句只重合成那一句。画面侧的粒度两种都一样，永远是一句一段。

## 四种改动，四种代价

| 你改了什么 | 要重跑 | 代价 |
|---|---|---|
| 某句的 `say`（台词） | `video_teach_narrate sentences: [<id>]` → `video_teach_render sentences: [<id>]` | 一句语音（`deepseek`）或它所在的那次合并请求（`volcengine`）+ 一句画面 |
| 某句的 `cues`（画面切换点） | 只 `video_teach_render sentences: [<id>]` | 一句画面，**不用重新合成语音** |
| 某个 deck / scene 的排版 | 该段所有句子的 `render`（画面变了就要重录） | 只画面 |
| 音色、`speed_ratio` | 全量 `narrate` → 全量 `render` | 全片重来，因为每个词的偏移都变了 |

第三条容易被忽略：同一个 deck 被多句共用时，改版面只影响它自己那句；但如果你在 deck 里改了**跨句共享的状态**（比如第二句要看到第一句留下的元素），就要把这一段从头录。

## 合并合成改变了什么

逐句单独发请求时，用户实际听出来“不像一个人”：音色没变，但语调与能量在句间漂；参数层面钉不住（`emotion`、`instruct` 这些字段实测没有效果，只有音色和整数语速可控）。改成一次请求多句之后，韵律跨句连续，问题才解决。

代价与边界：

- **重合成按“请求”计**，不按句子（这一条只对 `volcengine` 成立；`deepseek` 逐句请求，一句话就是一次请求）。`sentences: [s01-3]` 在合并模式下会把包含 `s01-3` 的那一段相邻句一起重合成，其余句子不受影响。
- **不跨过没被选中的句子合并**：中间那句沿用旧音频，合并会移动不该动的边界。
- 每次请求最多约 480 字，超过自动分段，长稿不会变成一次不可重试的请求。
- 想要逐句独立合成（对照、隔离某句的问题）用 `merge: none`，其余行为不变。
- 换音色或整数语速仍然是整片重来：每个词的偏移都会变。

## "只改画面不动语音"为什么成立

`timings.json` 是按句子存的：每句一条音频，外加词级时间戳（`deepseek` 没有，会写 `voice.timestamps: none`，画面改为一句一页 + `at_progress` 节拍）。渲染阶段只读它、不写它。所以：

- `video_teach_render sentences: [s01-2]` 只重录 `s01-2` 的段，别的段文件连 mtime 都不变。
- 组装时插件按稿件顺序把"这次渲染的"和"还在磁盘上的"合起来，缺哪句会直接报出句子 id，不会静默少一截。
- 段落文件在 `.dsh-video/teach/<句子 id>/segment.mp4`，可以整个删掉重来。

## 常见坑

- **改了台词却没重跑 narrate**：`video_teach_render` 会比对稿件与 `timings.json`，句子对不上就拒绝，并说明是哪一句 —— 别绕过它，绕过就会得到一条音画错位的片子。
- **只改 `say` 不改 `cues`**：词变了，`at_word` 指向的词可能消失，校验会拒绝。改台词时顺手看一眼 cues。
- **音色改了却只重录一句**：`timings.json` 里记着合成用的音色，`video_teach_plan` 会报 `stale`。音色是整片的，别半途换。
- **重录后忘了 export**：SRT 与 `timeline.json` 是按成片时间轴生成的外部字幕，改了片子要重新 `video_teach_export`，否则字幕对不上新版。

## 一次典型的返工

```
video_teach_plan                                    # 看是哪句、哪行出错
video_teach_narrate  sentences: [s02-1]             # 只重合成那一句
video_teach_render   sentences: [s02-1]             # 只重录那一段
video_teach_render   assemble: true                 # 拼成新版本 v00N
video_teach_export                                  # 重新出字幕与 deck
```

版本号每次成片 +1，旧版留着对比，不要手删。

## 中间产物：谁能删、谁要进版本库

| 文件 | 归属 | 进版本库？ |
|---|---|---|
| `storyboard.yaml` | 手写稿件，唯一入口 | **要** |
| `slides/<段>/`（含 reveal 运行时） | 手写版面、自包含 | **要** |
| `scenes/*.py` | 手写场景 | **要** |
| `timings.json` | 旁白产物，时间轴权威 | 要（它决定改动后是否要重录） |
| `audio/*.mp3` | 旁白产物 | 建议要（丢了就得重新花钱合成） |
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
