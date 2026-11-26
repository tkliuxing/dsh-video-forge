# 教学视频路线（2026-11-20 起，已实现）

> 状态：**已实现**。§1–§12 是决策与规划，§13 起是逐轮实施记录，§25（一页承载多句 `page` / `enter`）2026-11-24 提案、2026-11-25 实现，§26 是「最初漏交的两种产物」在 2026-11-25 补齐的记录（烧入字幕、封面）。决策来自 2026-11-20 的问答会话（`session-2d3dbdb3`，限于"仅对话"工具面，读不到本仓库）；规划部分按本仓库的实际形状重写了一遍，并把"会话里靠推测写的部分"改成读代码得到的事实，剩下的不确定性单独列在 §11。
>
> 相关：`DESIGN.md` §4（工具面）、§9（产物与播放）、§15（未决与风险）、§17.2（产物落点）、§19（视频面板）、§22（skill 结构）；多幕并行派发的规程单独写在 [`TEACH-PARALLEL-ACTS.md`](TEACH-PARALLEL-ACTS.md)；幻灯段的动效与跨句转场方案单独写在 [`TEACH-MOTION.md`](TEACH-MOTION.md)（2026-11-25 方案；D0–D3 已实现，见 `TODO.md` B10–B13）。

## 1. 目标与非目标

**目标**：在同一个插件里加一条与在线模型生成并列的制作路线，产出 3b1b 式数学动画与幻灯片讲解混合的教学视频。声音是讲解，画面是动画与幻灯片，时间轴由旁白决定。

**非目标**：

- 不做视频剪辑器。改一句台词只重录那句，不做非线性编辑。
- 不做通用动画编辑器。Manim 段与 reveal.js deck 都是代码/文本产物，手写入口只有 `storyboard.yaml`。
- 不替换现有的 `video_generate` 路线。两条路线共存，共用 `renders/` 目录与版本编号规则。

## 2. 已定决策（用户拍板，2026-11-20）

| 维度 | 决定 |
|---|---|
| 画面引擎 | Manim CE（数学动画）+ reveal.js（幻灯片），同一条片子里可以混用 |
| 时间轴权威 | 音频。TTS 逐句合成，词级时间戳驱动画面 |
| 语音 | 火山/豆包云端 TTS；声音复刻**尚未开通**，先用预置音色把管线跑通（预置音色可抓取，候选见 §10.1） |
| HTML 出帧 | Playwright 实时录屏，**按句分段**（一句一段 WebM） |
| 中间格式 | `storyboard.yaml` 是唯一手写入口 |
| 集成形态 | 现有插件加工具 + 中文 skill，与在线生成路线共存 |
| 交付物 | 六项：16:9 1080p mp4（旁白可烧进画面）· 外部 SRT · 可交互 HTML deck · 时间轴 JSON · 16:9 封面 · 4:3 封面（后两项 2026-11-25 补齐，实现与实测见 §26） |
| 首个真验收 | 一条 3 分钟混合样片：既有 Manim 段也有幻灯片段，旁白讲到哪画面走到哪（选题 π²/6，2026-11-20 定） |

## 3. 与现有仓库的接缝（读代码确认，2026-11-20）

这七条是上一会话读不到、只能列为"需要你补"的部分，现在按源码写清。

1. **工具注册面**（`src/tools.ts`）。三个工具都走 `ctx.tools.register(defineTool({...}))`，schema、模型可读的描述文本、卡片 `presentationMeta` 都写在同一个文件里；真正的副作用（校验、去重、提交、盯守、取消）全在 `src/operations.ts`，面板 API 与工具共用同一套函数。注释里写明理由：一个付费副作用两份实现，先漂移的永远是安静的那份。新工具必须照这个分法拆。
2. **任务台账**（`src/ledger.ts`，落盘 `$DSH_HOME/plugins/dsh-video-forge/tasks.json`）。一行 `VideoTask` 的形状是围绕"供应商任务"长的：`provider` / `protocol` / `providerTaskId` / `progress` / `billing` / `paramsFingerprint`。面板要的 `TaskRow` 是这个结构的一次投影。
3. **面板行的唯一来源是台账**。`src/panel-api.ts` 的每个读接口都调 `operations.listTasks`，客户端 `src/client/video-panel-model.ts` 再按 `workspacePath` 判 `placement`（`workspace` / `outside` / `unmapped`）只列工作区内的片子。**换句话说：本地 ffmpeg 渲染出来的 mp4 只要不进台账，就不会出现在右侧视频面板**，跟它落在 `renders/` 哪个文件夹无关。
4. **产物落点与版本号**（`src/destination.ts`）。`planDestination` 定 `<工作区>/<renders>/<shot>/`，`deliverArtifact` 写文件并在旁边写描述文件，版本号 `vNNN` 在写入时分配；`renders/` 指到工作区外会被拒绝。教学视频的成片应当复用这套落点，而不是自己拼路径。
5. **skill 的注册与校验**（`src/skills.ts` + `assets/skills/*.md`）。`SKILLS` 数组里每条给 `name` / 中文 `description` / `file` / `userInvocable`，正文进 `package.json#files` 的 `assets`。`test/guide-consistency.test.ts` 有两条硬约束：skill 正文里出现的每个 `video_*` 名字都必须是 `src/tools.ts` 里真实注册的工具；`video_export` / `视频工坊` / `workbench` / `工作台` 四个词永远不许出现。**注意这条正则**：正文写 `teach_video_plan` 会被扫成 `video_plan` 然后断言失败，所以新工具名建议统一成 `video_teach_*` 前缀，或者同时改这条测试。
6. **插件目前不启动任何子进程**（`src/` 全树没有 `child_process`，只有 HTTP 调用与 `ctx.jobs` 的进程内任务）。教学路线必须新增这项能力：ffmpeg 转码/拼接、python 跑 Manim、Playwright 起浏览器。宿主侧有 `ctx.subprocess`（`packages/subprocess`，提供可执行查找、受管进程区间、输出捕获），用它是正路；但它属于宿主组合里的可选服务，插件要按可选依赖写（像 `skills`、`jobs` 那样 `ctx.get('subprocess')` 判断后降级），别默认所有组合都有。
7. **凭据机制**（`src/credentials.ts`）。`authRef` → `ctx.credentials.resolve` → 环境变量兜底，从不跨供应商回退。TTS 若作为新供应商接入，必须走同一条解析链，不另起一套 key 读取。

## 4. 管线

```
storyboard.yaml
      │ ① video_teach_plan：校验 / 拆句 / 每句绑定画面指令 / 估时
      ▼
  逐句 TTS（火山异步长文本，enable_subtitle≥2）→ audio/s01-1.mp3 + timings.json（词级，权威）
      │ ② video_teach_narrate
      ▼
  ┌────────── ③ video_teach_render：逐句独立成段，可只重录指定几句 ──────────┐
  │  Manim 段：按句目标时长构造动画 → 段 mp4（静音）                        │
  │  幻灯片段：按 timings.json 的偏移推进 Reveal 的 fragment → 录屏 WebM      │
  └──────────────────────────────────────────────────────────────────────┘
      │ 每段统一 1920×1080 / 30fps / yuv420p，长度裁到该句音频真实时长
      ▼
  concat（句间硬切，段边界可 xfade）→ 混音 → 字幕烧入
      ▼
renders/<shot>/vNNN.mp4 + .srt + .timeline.json + cover.png + deck/
```

上一会话里有三处技术判断，保留并在下面写明为什么：

- **录制不承担时间权威**。Playwright screencast 只产出浏览器真实重绘的帧，静态停留期没有帧，输出天然是可变帧率。所以录制时不播声音，只按 `timings.json` 的偏移推进画面；转码时用 `fps=30` 补帧、用 `-t <音频时长>` 裁齐。漂移的源头在录制进程与音频播放之间的竞速，把它切断即可。
- **按句分段录**。漂移最多污染一句，改一句也只重录一段。整条一次录完的话，两分钟的视频漂 200ms 就得从头再来。
- **音频 URL 只活 1 小时**（火山异步接口返回的 `audio_url`）。拿回 URL 立刻落盘；落盘失败整句重合成，不要缓存 URL。

## 5. 目录约定

```
<工作区>/
  video-project.yaml         # 已有清单；新增 collect 段（见下）
  storyboard.yaml            # 教学路线唯一手写入口
  audio/s01-1.mp3 …          # 逐句音频（中间件，不入库）
  timings.json               # 权威时间轴（句级 + 词级）
  scenes/s02.py …            # Manim 段，一句一文件
  slides/s01/                # reveal.js deck，一句一页、一名词一 fragment
  cover/index.html           # 封面页（可选）：同一页在 16:9 与 4:3 下截图，见 §26.2
  captures/*.webm            # 录屏中间件（不入库）
  renders/<shot>/vNNN.mp4    # 成片（旁白已烧进画面），与在线生成的片子同一套版本编号
  renders/<shot>/vNNN.json   # 旁边的描述文件（prompt/参数/用量的位置继续留给生成路线）
  renders/<shot>/vNNN.cover-16x9.png   # 封面两种画幅，与成片同版本号
  renders/<shot>/vNNN.cover-4x3.png
  deck/                      # 可交互 HTML 产物
```

清单里建议新增一段而不是新建清单文件：

```yaml
teach:                        # 教学路线（实际实现就叫 teach，见 src/config.ts；字段形态以那里为准）
  voice: { provider: volcengine-tts, speaker: zh_female_xxx, clone_id: null }
  video: { size: [1920, 1080], fps: 30 }
  storyboard: storyboard.yaml
```

`storyboard.yaml` 草案：

```yaml
meta:
  title: 为什么 1+1/4+1/9+… = π²/6
  cover: cover/index.html     # 可选：封面页，缺省则 export 不出封面（不会拿成片首帧顶替）
segments:
  - id: s01
    engine: slides
    sentences:
      - id: s01-1
        say: 先看一个完全平方数的倒数。
        visual: { type: fragment, target: "#eq1", effect: fade-up }
      - id: s01-2
        say: 把它们加起来，直觉上应该收敛到某个有限值。
        visual: { type: fragment, target: "#eq2", effect: highlight }
  - id: s02
    engine: manim
    scene: scenes/s02.py
    sentences:
      - { id: s02-1, say: 现在把每条曲线画出来。 }
```

`timings.json` 草案：

```json
{ "sentences": [ { "id": "s01-1", "audio": "audio/s01-1.mp3",
    "begin": 0, "end": 2870,
    "words": [ {"t":"先","b":25,"e":235}, {"t":"看","b":235,"e":495} ] } ] }
```

实际落地的字段以 `src/teach/storyboard.ts` 的 `parseTimings` 为准：`id` / `text` / `audio` /
`durationMs`（音频实测长度，权威）/ `exitMs`（这一句尾部录了多长的跨句转场，缺省 0）/ `words`。
`durationMs` 是**旁白**的长度，`durationMs + exitMs` 才是**画面**那一段的长度。

## 6. 工具面（四个，命名已定：`video_teach_*`，§11 第 5 条）

| 工具 | 职责 | 副作用归属 |
|---|---|---|
| `video_teach_plan` | 校验 `storyboard.yaml`、拆句、产出渲染计划与耗时预估 | 只读 |
| `video_teach_narrate` | 逐句 TTS、落 `timings.json`（词级） | 付费 + 网络 |
| `video_teach_render` | 分段渲染 → CFR → concat → 混音 → 烧字幕（`subtitles=` + `force_style`）；可只重录指定句 | 子进程 + 写工作区 |
| `video_teach_export` | `deck/` 静态 HTML、外部 SRT、时间轴 JSON、封面 16:9 + 4:3（`meta.cover` 声明时） | 写工作区 |

四条通用约束（由现有代码约束导出，不是新定的）：

- 每次调用都读实时配置快照，热改设置下一句就生效，不重新注册工具。
- `execute` 只返回一个规范化 JSON，模型读的散文归 `output.render`，卡片要的有界事实归 `output.presentationMeta`，且这两个必须是对 `args` 与返回值的纯函数（会话回放时会重跑）。
- 付费/子进程的副作用只写一份，面板与工具共用。
- 长任务挂 `ctx.jobs`，可被 `job_kill`，并遵守既有"只查不重提"的恢复纪律。

## 7. skill（中文，四个）

| skill | 内容 | `/` 命令 |
|---|---|---|
| `video-teach-storyboard` | 分镜怎么写：一句一个画面指令、字数上限、避坑 | 是 |
| `video-teach-manim` | Manim 段约定：一句一文件、时长配平、坐标系与字体风格 | 否 |
| `video-teach-slides` | reveal.js 段约定：fragment 命名、主题、公式排版 | 否 |
| `video-teach-iterate` | 改一句只重录一段的操作规程 | 否 |

正文里只能出现真实注册的工具名（§3.5），并且要像 `video-prompting` 那样把长参考材料放到子目录（`assets/skills/teaching/`），只让主正文承担路由。

## 8. 台账与面板怎么办（方案 A 已实施，2026-11-20）

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 台账扩一层 `origin`**（**已选**） | `VideoTask` 加可选 `origin: 'provider' \| 'local'`；本地渲染写 `provider: 'local'`、`model: 'teach-video'`、`providerTaskId: null`、`status: 'succeeded'`，产物与大版本号继续走 `destination.ts` | 要逐处过一遍对 `provider` 做假设的代码：`adapterFor`（取消/对账）、计费结算、价格估算。属于"改动面小但必须审完"的那类 |
| B. 另立台账 + 面板第二个数据源 | 新文件 `teach.json`，面板加一个"教学"分组 | 面板模型多半要重写一遍，`placement`/分组/去重逻辑会分裂成两份 |
| C. 不上面板 | 只写 `renders/`，靠文件浏览 | 与 2026-10-20 定的"面板列本工作区成片"的期望相反 |

选定 A（2026-11-20 用户拍板），并已按下面说的做了。它的风险要提前写明：**本地渲染没有供应商可查，`orphaned` / `unconfirmed` / `billing` / 价格估算这些概念对它都不成立**。行里必须显式表达"这条不是供应商任务"，而不是靠字段缺省表达（`provider: 'local'` 是哨兵值，任何按 provider 查适配器的地方都要先判它）。

**实施（2026-11-20）**：

- `VideoTask` 加 `origin?: 'provider' | 'local'`；缺省读作 `provider`，所以旧行与所有供应商行不受影响。判断收敛成一个函数 `isLocalRender()`（`src/types.ts`），**不靠 `provider === 'local'` 字符串**——否则将来真有一家叫 local 的供应商，两种含义会悄悄合并。
- `recordLocalRender()`（`src/operations.ts`）在成片落盘后写行：`provider: 'local'`、`protocol: 'local-render'`、`model: 'teach-video'`、`providerTaskId: null`、`status: 'succeeded'`，`artifacts[0].location` 用既有的 workspace 形状（`relativePath` / `shot` / `version` / `sidecar`），token 与新行 id 都由既有机制生成。它是 `video_teach_render` 在 `assemble` 之后调用的，工具的返回值里带 `task_id`。
- `listTasks` 的 `TaskRow` 加 `origin`，面板拿到 `workspacePath` 就按既有 `placementOf` 判成工作区内成片、`status: succeeded` 判成 ready —— **面板代码一行都没改**。
- 所有按 provider 查适配器的路径都先判它：对账的两处 list 过滤加 `!isLocalRender(task)`；`video_cancel` 拒绝并说明"本机渲染的片子没有东西可取消，也没扣费"；成本汇总按 `billing` 为空的既有规则天然跳过本地行。
- 测试 `test/teach-ledger.test.ts`（6 例）：行能被面板读到（`origin`/`workspacePath`/`shot`/`durationSeconds`/`playUrl`）、每次渲染都是新 id、取消被拒、不计成本、不计入插件自身字节预算、缺 `origin` 的旧行读作 provider。

## 9. 里程碑

| 阶段 | 内容 | 验收 | 状态（2026-11-25 核对） |
|---|---|---|---|
| M0 | `storyboard.yaml` / `timings.json` 的 schema 与校验，目录约定 | 非法稿的报错能指出行号与具体键 | ✅ §13 |
| M1 | 单句最小闭环：TTS → 录屏 → CFR → 段 mp4 | 一句 3 秒，音画对齐误差 < 50ms | ✅ §13 |
| M2 | 多句拼接 + 只重录某句 | 改第 3 句不触发前两句重录 | ✅ §14 |
| M3 | Manim 段接入 + 跨引擎拼接 | 两段不同引擎拼成一条，无音画错位 | ✅ §14（第三句走 Manim，落在同一路径形状） |
| M4 | SRT / 烧字幕 / 封面 / deck 双产物 | 六种产物齐全 | ✅ 六种（2026-11-25 补齐后两项：烧入字幕进 mp4、封面出 16:9 与 4:3 两张），实现与实测见 §26 |
| M5 | 工具化 + skill 落地 + 3 分钟混合样片 | 从头看一遍不出戏 | ✅ 工具与 skill §15，样片 §16 |

**M0–M5 全部落地（M0–M3、M5 于 2026-11-20，M4 于 2026-11-25）**，证据在 §13–§16 与 §26。代码：`src/teach/storyboard.ts`（解析与校验）、`voice.ts`（TTS 客户端）、`slides.ts`（CDP 录屏）、`manim.ts`（Manim 段）、`ffmpeg.ts`（探测/CFR/拼接/混流）、`deck.ts`（reveal.js 脚手架）、`pipeline.ts`（plan/narrate/render/assemble + 分段复用）。M4 的两项缺口（烧入字幕、封面）与它们的实现记录见 §26。

## 10. 本机环境现状（2026-11-20 实测）

| 组件 | 状态 |
|---|---|
| node | v24.22.3（`engines` 满足） |
| ffmpeg / ffprobe | 9.0.2，`/opt/homebrew/bin` |
| python3 | 3.11.12（pyenv shim） |
| manim | **已装 0.22.1**，在专用 venv `~/.local/venvs/teach-video`（不污染 pyenv 全局） |
| LaTeX | **TinyTeX**（`~/Library/TinyTeX`，含 `dvisvgm`），补了 standalone / preview / amsmath / amssetspace / doublestroke / tipa / relsize / amsfonts / babel-english |
| Chromium | Playwright 缓存 `chromium-1243`；`playwright-core@1.61.1` 已进 `dependencies`（不下载浏览器，用现成缓存或 `TEACH_CHROMIUM` 指定） |
| 插件自身 | `dependencies` 现为 `yaml` / `schemastery` / `playwright-core`；子进程只有 `src/teach/` 下的 ffmpeg 与 manim |

**实际用的装法（与第二轮"BasicTeX + tlmgr"不同，理由如下）**：brew 的 `basictex` 已在本机，但它的 `tlmgr` 装不了包（`/usr/local/texlive/2026basic` 属 root，`sudo` 需要密码），而且它**不含 `dvisvgm`**（Manim 排版公式必须用它）。brew 的 `dvisvgm` 公式会把 5GB 的 texlive 整包拖下来。最终改成 **TinyTeX**：用户可写、自带 `dvisvgm`、`tlmgr install` 直接可用，装完体积约 300 MB。

插件侧只做可执行检查（`python3` / `ffmpeg` / `latex` 各自是否存在），并把缺什么报清楚，不自动安装。

### 10.1 预置音色怎么拿（2026-11-20 实测）

火山的预置音色是一张**静态清单**，官方没有"列出音色"的公开接口，唯一来源是文档页。`www.volcengine.com/docs/6561/1257544` 是 SPA，抓下来只有 1.6 MB 的壳；**同一个 doc id 在 `docs.volcengine.com` 上是服务端渲染的全文**：

```bash
curl -sSL -A "Mozilla/5.0" https://docs.volcengine.com/docs/6561/1257544 -o /tmp/voices.html
```

实测：5.5 MB，8 张表、606 行、去重后 601 个 `voice_type`（`zh_` 前缀 180 个，其中 2.0/uranus 91、1.0/mars 50、多情感 15）。单元格文本落在 `span[data-string="true"]` 里，按 `<tr>` / `<td>` 切开就能还原成表。列是「场景 / 音色名称 / voice_type / 语种方言 / 支持能力 / 特殊标签」。

由此定做法：插件**内置一份精选清单**（离线、确定），整表刷新做成可选手动动作，不在每次合成前抓网页。

讲解类候选（都是 2.0 大模型音色，带「指令遵循」，适合逐句控语气）：

| 用途 | voice_type | 名称 | 文档里的场景标签 |
|---|---|---|---|
| 默认女声 | `zh_female_liuchangnv_uranus_bigtts` | 流畅女声 2.0 | 视频配音 |
| 备选女声 | `zh_female_qingxinnvsheng_uranus_bigtts` | 清新女声 2.0 | 通用场景 |
| 备选男声 | `zh_male_ruyayichen_uranus_bigtts` | 儒雅逸辰 2.0 | 视频配音 |
| 备选男声 | `zh_male_m191_uranus_bigtts` | 云舟 2.0 | 通用场景 |

两条**只有真实合成才能定**，列进 §11 C：① 这些音色是否需要先在控制台开通或付费（表里没有标注，多情感与部分角色音色通常要单独开通）；② 是否都支持异步接口的字级时间戳。第一句合成的结果就是验收，报错换候选，不靠猜。

### 10.2 TTS 凭据实测（2026-11-20）

结论先行：**`ARK_API_KEY` 不行，`ARK_VOICE_API_KEY` 配非 plan 端点可以**。端点是你补的那个，不带 `/plan`：`POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`。

#### 用 `ARK_API_KEY` 为什么不行

账号里存着 `ARK_API_KEY`（`$DSH_HOME/.credentials.yaml`，36 字符），插件现有的 ark 供应商就靠它跑视频生成。拿它去调语音合成试了三处，全部失败：

| 调用 | 结果 |
|---|---|
| `GET https://ark.cn-beijing.volces.com/api/v3/models` | **200**，说明这把 key 本身有效；返回的模型域只有 LLM / VLM / VideoGeneration / ImageGeneration / 3DGeneration / Embedding / Router，**没有任何 speech 类模型** |
| `POST https://ark.cn-beijing.volces.com/api/v3/audio/speech`（OpenAI 形状）与 `/api/v3/tts` | **404**，标准 Ark 没有 TTS 路由 |
| `POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional`，`X-Api-Resource-Id: seed-tts-2.0` | HTTP 200，正文 `code 45000010`：`acquire failed err:call ark get status code:401 … API key or AK/SK … is missing or invalid`，即 Agent Plan 网关转发给 Ark 校验时判这把 key 不是 plan 专属 key |
| 同上，`X-Api-Resource-Id: seed-tts-1.0` | **403** `code 45000030`：`requested resource not granted` |

结论：**语音合成不在标准 Ark 的统一 API 里**，是单独产品线（[接入语音模型](https://docs.volcengine.com/docs/ark/agent-plan-personal-voice-model?lang=zh) 属 Agent Plan，网关是 `openspeech.bytedance.com/api/v3/plan/...`，只认 Agent Plan 的专属 API Key）。所以要跑 TTS，二选一：

1. **Agent Plan 专属 API Key**（订套餐后拿），一把 key 通吃 TTS 与 ASR，请求头 `X-Api-Key` + `X-Api-Resource-Id: seed-tts-2.0`，HTTP 入口 `POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional`，流式 NDJSON，音频在 `data` 字段的 base64 里，`code 20000000` 收尾。请求体里 `audio_params.enable_timestamp` 是时间戳开关（HTTP 那条示例没开也没有回时间戳，字级时间戳大概率只在 WebSocket 单向/双向流式里返回，需实跑确认）。
2. **豆包语音（openspeech v1）的 appid + access token**，走老的 `api/v1/tts` 那一套鉴权，与 Ark key 无关。

插件侧因此要把语音做成**独立供应商条目**，不复用 ark 那条：`protocol` 不同、鉴权头不同（`X-Api-Key` vs Bearer，或 appid/token），`authRef` 也不该指向 `ARK_API_KEY`——拿视频的 key 去调语音会得到一个很像"没开通"的 401，正是本表第二次实验那种误导性错误。

**M1 不被这条卡住的兜底**：macOS 自带 `say` 能出音频但没有字级时间戳，只能先验画面侧（录屏 → CFR → 裁剪 → 拼接）。时间轴驱动必须等真 TTS，否则验的不是那条管线。

#### 用 `ARK_VOICE_API_KEY` 的成功形状（已跑通）

```bash
curl -sS https://openspeech.bytedance.com/api/v3/tts/unidirectional \
  -H "X-Api-Key: $ARK_VOICE_API_KEY" \
  -H "X-Api-Resource-Id: seed-tts-2.0" \
  -H "Content-Type: application/json" \
  -d '{"req_params":{"text":"先看一个完全平方数的倒数。","speaker":"zh_female_liuchangnv_uranus_bigtts",
       "audio_params":{"format":"mp3","sample_rate":24000,"enable_subtitle":true}}}'
```

响应是 NDJSON，一行一个 JSON：音频在 `data` 字段的 base64 里，末行 `code` 为 `20000000`。

**字级时间戳就在这个响应里，不需要 ASR 对齐，也不需要 `enable_timestamp`。** 关键是 `audio_params.enable_subtitle: true`（注意是**布尔**，传 `2` 会得到 `cannot unmarshal number into … enable_subtitle of type bool`）。打开后每句带一个 `sentence` 对象：

```json
{ "text": "先看一个完全平方数的倒数。", "phonemes": [],
  "words": [ { "word": "先", "startTime": 0, "endTime": 0.2, "confidence": 0.938 },
             { "word": "看", "startTime": 0.2, "endTime": 0.39, "confidence": 0.92 } ] }
```

实跑两条，记下四个必须处理的细节：

1. **会混进一条累积句**：长文本时同一个响应里除每句一条带 `words` 的 `sentence`，还有一条 `text` 是全文累积、`words` 为空的句子。**只取 `words` 非空的那条**，否则时间轴会被整段错位。
2. **word 不一定是一个字**：标点会并进相邻词（`"来，"`），所以字符数与 `words` 长度不等（13 字 ↔ 12 词）。驱动画面只能按 word 的 `startTime`，不能按字符序号算。
3. **时间是该句音频内的秒（浮点）**，两段实测：`0 → 2.075` 与 `2.62 → 6.185`；音频总长 6.672，**尾部静音约 0.49 s**。所以段长取音频真实时长，不取最后词的 `endTime`，否则句尾会被吞。
4. **音色不用单独开通**：`zh_female_liuchangnv_uranus_bigtts`、`zh_female_qingxinnvsheng_uranus_bigtts`、`zh_male_ruyayichen_uranus_bigtts`、`zh_male_m191_uranus_bigtts`、`zh_female_vv_uranus_bigtts`、`zh_female_xiaohe_uranus_bigtts`、`zh_female_gaolengyujie_uranus_bigtts` 都直接合成成功。**1.0（mars）音色配 `seed-tts-2.0` 会报 `55000000 resource ID is mismatched with speaker related resource`**，要用 1.0 音色得换成对应的 resource id（本账号未开通）。

**插件侧落点**：语音供应商条目的 `authRef` 是 `ARK_VOICE_API_KEY`（已存进 `$DSH_HOME/.credentials.yaml`），请求头 `X-Api-Key`，resource id 固定 `seed-tts-2.0`，端点不带 `/plan`。与 ark 视频那条共用 baseUrl 的说法不成立，两者是不同 host，如实写清楚。

**M1 不再需要兜底**：TTS 这半边能出音频加字级时间戳，剩下的都是画面侧的工作。

## 11. 需要你补的东西

### A. 只有你能给的

1. ~~**TTS 的凭据形态**~~：已解决（§10.2）。`ARK_VOICE_API_KEY` + `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional` + `X-Api-Resource-Id: seed-tts-2.0`，音频与字级时间戳都能拿到。插件里是**独立供应商条目**，`authRef = ARK_VOICE_API_KEY`，不复用 `ARK_API_KEY`。
2. ~~**默认音色**~~：已定候选，见 §10.1（默认取「流畅女声 2.0」`zh_female_liuchangnv_uranus_bigtts`，男声备选「儒雅逸辰 2.0」）。可用性待真实合成。仍缺一样只有你能给：你账号里**实际开通了哪些音色**（控制台能看到），这决定默认值落不落得住。
3. ~~**样片选题**~~：已定，π²/6（`1 + 1/4 + 1/9 + … = π²/6`）。讲稿素材仍要你确认：用自带推导，还是用你手头已有的讲义。

### B. 需要你拍板的设计

4. ~~**面板集成**~~：已定，方案 A（§8）。
5. ~~**工具命名**~~：已定，`video_teach_*`（与现有 `video_*` 前缀的测试和路由一致，不动测试）。
6. ~~**LaTeX 依赖策略**~~：已定，BasicTeX + `tlmgr`，Manim 走本机 pip（§10）。
7. ~~**发布节奏**~~：已定，**先跑通样片再发布**；含新依赖的版本要在 README 的 Requirements 里写清外部可执行（`python3` / `ffmpeg` / `latex`）与 Manim 安装方式。

### C. 只能实测才知道

8. ~~**TTS 字幕粒度与音色开通**~~：已实测（§10.2），字级、标点并入相邻词、候选音色全部可用。剩下待测的是长文本上限与并发（多句并行合成时的限流）。
9. Playwright 录屏在本机 1920×1080 下的实际丢帧率，决定 `fps` 滤镜是补帧还是干脆改用确定性逐帧截图。
10. Manim 渲染耗时与 LaTeX 首渲染缓存，决定是否要在 M3 前就做预热。

### D. 已达成的决定（2026-11-20 第二轮问答，保留记录）

- **面板集成 = 方案 A**：`VideoTask` 加显式来源标记，本地渲染行带 `provider: 'local'` / `origin: 'local'`，上右侧视频面板。
- **LaTeX = BasicTeX + `tlmgr`**，Manim 装本机；插件只检查外部可执行是否存在，不代装。
- **TTS 鉴权 = 两种都支持**：适配层按配置里的类型分支，不做隐式猜测。
- **默认音色 = 预置音色**：从官方音色列表抓取并内置精选清单，默认「流畅女声 2.0」`zh_female_liuchangnv_uranus_bigtts`（§10.1）。
- **样片选题 = π²/6**。
- **工具命名 = `video_teach_*`**。
- **发布节奏 = 样片跑通后再发**。


## 12. 已知风险

| 风险 | 对策 |
|---|---|
| 录屏 VFR / 掉帧 | 录制不出声、按 `timings.json` 推进、`fps` + `-t` 强制 CFR（§4） |
| 句间拼接缝隙 | 每段尾部干净裁切，拼完用 `ffprobe` 校验段数与总时长 |
| Manim 时长配不上音频 | 一句一段 + `wait(剩余)` 配平，兜底 `setpts` 微调 |
| 子进程能力在宿主组合里不存在 | 按可选服务处理，缺失时工具明确报"这个宿主没装 subprocess 服务"，不静默降级 |
| 音频 URL 1 小时过期 | 立刻落盘，失败整句重合成 |
| 台账里混入非供应商行 | §8 方案 A 的哨兵值必须在所有 `adapterFor` 调用点先判 |
| 验证污染真实环境 | 照 `DESIGN.md` §13：`/tmp` 快照 + 独立 `DSH_HOME` + 独立端口，不用 3080 那个实例 |

## 13. M0/M1 实施记录（2026-11-20）

**实测（`TEACH_VIDEO_LIVE=1 pnpm exec vitest run --config vitest.live.config.ts test/teach-live.test.ts`）**：

- 一句话旁白："先看前几项完全平方数的倒数，把它们一项项加起来。" → 音频 **4440 ms**，字级时间戳齐全。
- 幻灯片段（fixture deck，三个 fragment 按词触发）：1920×1080 / 30fps，段长与音频差 **7 ms**。
- 整片（画面 + 旁白混流）：**4433 ms**，与音频差 7 ms，文件 83 636 B，含音轨。
- Manim 段（fixture scene，含 `MathTex`）：渲染 3.8 s，重定时后 **4032 ms**，超长 0 ms。
- 结论：**M1 的音画对齐误差 7 ms，远低于 50 ms 的验收线。**

**四个实现上不得不做的决定**（都由实测逼出来，已写进代码注释）：

1. **cue 可以是一个短语**。TTS 把中文切开成单字词，稿子里写的"先看"是两个词。`cueOffsetMs` 先找死单个词，再按连续词拼接找起点，所以稿子能写人话而不是写 token。
2. **短于音频的段要用 `tpad` 补，不是靠 `fps`**。`fps` 只在输入还有帧时补；Manim 场景比旁白短 472 ms 时，段就短 472 ms。现在统一 `tpad=stop_mode=clone:stop_duration=10` 再 `-t <音频时长>`，两个方向都被钉住。
3. **concat 的清单必须落成文件**。`-f concat -i -` 不接受 stdin，会报 `Error opening input file -`。现在把清单写到输出旁边的 `.concat.txt`。
4. **录屏用 CDP `Page.startScreencast`，不用 `page.screencast`**。装上的 `playwright-core@1.61.1` 没有那个公开 API；CDP 版本给出带时间戳的 JPEG 帧，`encodeFrames` 按相邻帧间隔写 concat 时长再 `fps=30` 补齐，静帧停留照样出 30fps。

**测试**：`test/teach-storyboard.test.ts`（17 例）与 `test/teach-voice.test.ts`（8 例）跑在普通 `pnpm test` 里，全部离线；`test/teach-live.test.ts`（5 例）只在 `TEACH_VIDEO_LIVE=1` 时跑，已加进 `vitest.live.config.ts`。

## 14. M2 实施记录（2026-11-20）

**实测（同一套 live 测试，`M2` 用例）**：三句旁白（两句幻灯 + 一句 Manim），逐句渲染后按时间轴拼成整片。

- 旁白合计 **8400 ms**；整片 **8400 ms**（差 0 ms），1920×1080、含音轨、187 KB。
- **只重录一句是真的**：先渲染 `s01-1`，再单独渲染 `s01-2`，`s01-1` 的 `mtime` 与字节数都没变（测试直接断言了这两项）。
- 第三句走 Manim 引擎，落在同一个路径形状（`.dsh-video/teach/<sentence>/segment.mp4`），段长与旁白差 < 50 ms。
- 组装拿到的是 `planSegments` 的结果：`reused = [s01-1, s01-2]`、`fresh = [s02-1]`，并且**缺段会直接报出句子 id**，不会静默少一截。

**这一轮补的两块**：

1. **reveal.js 正式模板**。`assets/teach/deck/` 里随包发 reveal.js 6.0.2 的 `reveal.js` / `reveal.css` / `theme.css` 与它的 MIT LICENSE（共 744 KB），模板 `index.html` 把契约压到三个全局：`window.teachCue(index)`、`window.teachPage(index)`（页模式）与 `window.teachReady`。`teachCue` 用 `Reveal.nextFragment()` 循环到第 n 个 fragment（Reveal 没有"跳到第 n 个 fragment"的 API，循环是诚实的写法，而且幂等）。`writeDeck()` 把这份模板和三个运行时文件抄进项目，**默认拒绝覆盖已有 deck**——deck 是手稿，重新脚手架覆盖掉手改内容是这里最坏的失败模式。
2. **分段复用**。`segmentPath()` 定死每个句子的段路径；`planSegments()` 把"这次渲染的"和"磁盘上已有的"合成一条完整时间轴，缺哪句就报哪句。

**资源路径的一个坑**：`skills.ts` 用 `new URL('../assets/skills/', import.meta.url)` 能同时适配源码与打包产物，是因为它就在 `src/` 顶层；`src/teach/deck.ts` 深一层，打包后会被折进 `lib/index.js`，同一行代码在两种形态下指向不同目录。改成从 `import.meta.url` 往上走、找到第一个带 `assets/teach/deck` 的祖先目录，两种形态都对。

**测试**：新增 `test/teach-deck.test.ts`（7 例，离线：脚手架、拒绝覆盖、标题转义、资源定位、分段复用与缺段报错）。`pnpm test` 全绿，`pnpm run build` 通过。

## 15. 工具化实施记录（2026-11-20）

四个工具注册在 `src/teach/tools.ts`，由 `src/index.ts` 在 `registerTools` 之后单独注册。分成两个文件而不是塞进 `src/tools.ts`，是因为教学路线有自己的 workspace / 凭据 / 可执行检查逻辑，但"副作用只写一份"的规矩没变：工具层只做 schema、散文与拒绝，所有动作仍在 `src/teach/pipeline.ts`。

| 工具 | 做了什么 | 不做 |
|---|---|---|
| `video_teach_plan` | 校验稿件、列出时间轴顺序的句子、估时、报告 `ffmpeg`/`ffprobe`/`python3`/`latex`/`dvisvgm`/`chromium`/`ARK_VOICE_API_KEY` 的状态、判断 `timings.json` 是 current 还是 stale | 不花钱、不联网、不渲染 |
| `video_teach_narrate` | 逐句 TTS，写 `timings.json`；`sentences: [...]` 只重合成指定句，其余从既有 timings 里原样保留 | 不渲染画面 |
| `video_teach_render` | 逐句渲染（slides/manim），按需拼成 `renders/<shot>/vNNN.mp4` 并写旁描述 JSON；`sentences: [...]` 只重录指定句，其余复用磁盘上的段 | 不合成语音 |
| `video_teach_export` | 写 `vNNN.srt`（按词定时的字幕）、`vNNN.timeline.json`、把 deck 抄进 `deck/<segment>/` | 不重新渲染、不重新合成 |

> 2026-11-25 之后这两行的产物各多一样：`render` 拼片时把旁白烧进画面，`export` 按 `meta.cover` 出 16:9 与 4:3 两张封面，见 §26。表里保留的是这一轮的形状。

**拒绝优先于花钱**，五条都在离线测试里钉住：只读或权限未知的会话直接拒绝；`storyboard` 路径逃出工作区拒绝；没有 `ARK_VOICE_API_KEY` 拒绝并**点名这个引用**（`ARK_API_KEY` 不是它）；未知句子 id 拒绝并列出稿件里有哪些；没有旁白就渲染、没有成片就导出，都拒绝并说明先跑哪一个。

**命名与测试的约束**：工具名前缀是 `video_teach_`，因为 `test/guide-consistency.test.ts` 用 `/video_[a-z_]+/` 扫 skill 正文并要求命中真实工具名 —— 写成 `teach_video_plan` 会被扫成不存在的 `video_plan`。这条测试这一轮扩成了扫两个文件（`src/tools.ts` 与 `src/teach/tools.ts`），且顺手发现 skill 正文里写 `video_teach_*` 这种通配写法同样会被扫成 `video_teach_`，所以正文里只写具体工具名。

**skill**：`assets/skills/` 新增四份中文正文（storyboard / slides / manim / iterate），`src/skills.ts` 注册为 `video-teach-storyboard`（可作 `/` 命令）、`video-teach-slides`、`video-teach-manim`、`video-teach-iterate`。`test/skills.test.ts` 的名单与可调用集合相应更新。

**验证**：`pnpm test` 41 个文件、**590 passed / 6 skipped**（含 `test/teach-tools.test.ts` 14 例离线用例）；`pnpm run build` 通过，产物 `lib/index.js` 399 kB + `lib/ffmpeg-*.js` + `lib/manim-*.js`（后两者是懒载的子进程模块）；`node -e "import('./lib/index.js')"` 确认打包产物能加载、`apply` 与 `inject` 都在，`playwright-core` 的顶层引用不再阻塞加载。

**当时仍未做（下一轮），后文都已补上**：隔离实例里的端到端调用见下一段，3 分钟混合样片见 §16。台账行与面板（§8 方案 A）已实施，`README` / `README.zh-CN.md` 的 Requirements 与工具表也已补上教学路线所需的外部依赖与四个工具。

**隔离实例验收（2026-11-20，成功）**：`DSH_HOME=/tmp/teach-verify/home dsh plugin --profile web add <repo>` 把仓库 link 进一个全新 profile 的 `web`（**关键是 profile 名要对上宿主实际启动的那个**；早先装进 `verify` 却启动 `web`，于是怎么都不加载），再 `dsh web --port 34798 --no-open`。结果：宿主起在 `http://127.0.0.1:34798`，插件自己的面板接口 `GET /video-forge/api/overview?token=…` 返回 `{"ok":true,…,"outputRoot":"/tmp/teach-verify/home/dsh-video-forge/outputs"}` —— 说明打包产物在真实宿主里加载成功、`apply()` 跑完（四个工具与四份 skill 都在同一段注册代码里，注册抛错就会让插件页不响应），且完全落在隔离的 `$DSH_HOME` 里，真实 `~/.dsh` 未被触碰（`tasks.json` 仍是 11 月 17 日那份）。两个坑记下来：`/video-forge/api/setup`、`/tasks` 是我猜的，真实动作名是 `overview` / `cancel` / `selection`；`dsh web --profile <name>` 与 `DSH_PROFILE` 同时存在时报 `select a profile only once`，干脆只用 `plugin --profile web add` 装、`dsh web` 不带 `--profile` 启动。

**仍未做**：宿主内**真的调用一次** `video_teach_*`（需要会话与模型，属付费验证）。3 分钟混合样片已产出，见 §16。

**更早的一次尝试（2026-11-20，未成功，保留以便对照）**：`DSH_HOME=/tmp/teach-verify/home dsh plugin --profile verify add <repo>` 装包成功（pnpm link），profile 的 `package.json` 里 `dsh.profile.bundles` 已经包含 `dsh-video-forge`；但 `dsh web` 起来后 `$DSH_HOME/dsh-video-forge/`（插件自己的数据目录）并未创建，说明插件没有加载。启动时加 `--profile verify` 直接报 `select a profile only once`（即便 `env -u DSH_PROFILE`），不加则宿主新建了一个 `web` profile，插件不在其中。宿主本体是健康的（`/?token=…` 返回 401 属正常鉴权）。下次先弄清 `DSH_PROFILE` / `DSH_PROFILE_DIR` / `--profile` 三者的互斥语义。

## 16. 混合样片与两处画面缺陷（2026-11-20）

`fixtures/teach/sample/` 是可复跑的自包含工程：`storyboard.yaml`（25 句、约 880 字）、`slides/s01/`（含 reveal.js 运行时与 16 个 fragment 的版面）、`scenes/` 下三个 Manim 场景。测试 `test/teach-sample.live.test.ts`（`TEACH_VIDEO_SAMPLE=1`）把整份工程复制到临时目录并跑完整条管线，`TEACH_SAMPLE_OUT=…` 会把成片与 SRT 复制到仓库的 `renders/sample/`。

### 16.1 两处画面缺陷与根因（都是实测定的，不是猜的）

初版成片有 117 秒没有画面：0–116 s 纯白，117.2–175.9 s 全黑（`blackdetect` 实测 58.7 s）。抽帧后逐项定性：

| 缺陷 | 实测证据 | 根因 |
|---|---|---|
| 幻灯段纯白 | 1920×1080 全帧只有一种颜色 (255,255,255)，1 s 与 6 s 两帧字节完全相同 | deck 模板缺 `html, body { height: 100% }`：`<body>` 高度塌成 0，`.reveal` 拿到 0 高度，reveal 把版面缩到 `scale(0.2)`，白底上的白字什么都看不见。计算样式里 `.reveal` 背景是 `rgb(25,25,25)`（主题本身加载成功），但零高元素不着色 |
| 模板初始化写法无效 | `new Reveal({...})` 对着 v6 的单例被调用 | reveal.js 6 的 UMD 导出是单例，`initialize(config)` 才是文档化路径；构造出来的实例不会接管页面 |
| Manim 段"全黑" | 单独渲染场景：`pix_fmt=yuv420p`、帧内 361–6293 种颜色、亮像素 6k–20k；管线编码后仍为 6104/14862/20469 亮像素 | **不是缺陷**：`blackdetect` 用 `picture_black_ratio_th=0.98`，Manim 默认黑底 + 细线条刚好超过 98% 黑像素，于是被判定为黑场。画面内容一直在 |
| 幻灯末段约 40 s 画面不动 | s01-10…s01-16 七个段落的抽帧颜色数完全相同、逐像素 diff 为空 | 两层：① 16 行在 40px 字号下超出 960×700 的舞台，第 11 行起被裁掉（看不到也占不到画面）；② `teachCue` 把 `getIndices().f` 直接与目标比较，而 `f` 是**已显示最后一片的零基下标**，于是每句话多显示一行，最后两档饱和到同一画面 |
| Manim 一分钟重复 | 9 句共用一个 `scenes/s02.py` | 内容组织问题：一句一段、一段一场景才对，已拆成三个场景（部分和折线 / 虚线极限 / 尾巴与上界） |

### 16.2 这一轮改了什么

- `assets/teach/deck/index.html`：补 `html, body { height: 100%; margin: 0 }` 与 `.reveal { width/height: 100% }`；改用 `Reveal.initialize(config)` 单例；`teachCue` 按 `(f ?? -1) + 1` 计算已显示片数，消掉多显示一行。
- `src/teach/slides.ts`：录制前先截图一次并数颜色，**只有一种颜色就拒绝录制**并说明 deck 没布局成功。之前的两次"成功"正是没有这道检查。
- `src/teach/ffmpeg.ts`：新增 `countFrameColors()`，把任意帧解码成 rgb24 后统计不同颜色数，供录制自检与测试共用。
- `src/teach/manim.ts`：新增 `discoverTex()`，按 `TEACH_TEXBIN` → `/Library/TeX/texbin` → `~/Library/TinyTeX/bin/universal-darwin` → `~/.TinyTeX/...` → `PATH` 顺序找 `latex` 与 `dvisvgm`；两者分属不同安装时用 shim 目录把两个可执行放到同一 PATH 上；都找不到就点名缺哪一个（BasicTeX 有 `latex` 没有 `dvisvgm`，正是这条要覆盖的情形）。
- `src/teach/pipeline.ts` / `src/teach/tools.ts`：`deck`、`scene`、`audio`、`timings` 的根改为 **`storyboard.yaml` 所在目录**；`renders/` 仍相对工作区根。
- `src/teach/tools.ts` 的 `video_teach_plan`：开工前检查稿件里每个 `deck` / `scene` 是否存在（缺失当场报，不等到 `render` 才发现），TeX 状态复用 `discoverTex()`，不再出现"计划说缺、渲染却能找到"的矛盾。
- 测试：`test/teach-live.test.ts` 与 `test/teach-sample.live.test.ts` 都加了**抽帧颜色数 > 1** 的断言（幻灯与 Manim 各若干帧），`test/teach-tools.test.ts` 增加资产缺失与"路径相对稿件目录"两例。
- 样片内容：Manim 拆成 `s02_partial_sums.py`、`s03_limit_line.py`、`s04_tail_bound.py` 三个场景，storyboard 对应 `s02`/`s03`/`s04` 三段各三句；deck 行距与字号压缩到 16 行全可见。

### 16.3 成片实测（2026-11-20）

| 项 | 结果 |
|---|---|
| 旁白 | 25 句，**165 192 ms**（2 分 45 秒） |
| 成片 | **165 192 ms**（与旁白差 0 ms），1920×1080 / 30fps / h264 + aac，**3.78 MB** |
| 分段 | 25 段（16 句幻灯 + 9 句 Manim，三个场景各三句） |
| 抽帧自检（PIL 独立统计） | 幻灯段三帧颜色数 **2 161 / 22 486 / 37 073**；Manim 段三帧 **1 625 / 4 271 / 4 949**；三组 Manim 收尾帧 **5 227 / 7 490 / 7 747** 且两两逐像素不同 |
| 幻灯段末四帧 | 31 730 / 33 983 / 36 538 / 37 073，相邻帧逐一不同（不再有冻结的尾段） |
| 管线耗时 | 约 215 s（录音按真实时长走）+ TTS/Manim 渲染 |

**仍存在的已知问题**（不影响可看性，但记下来）：成片像素格式是 `yuvj420p`（full range），个别非浏览器播放器会显得偏亮；Manim 三段里每段仍被三句共用（同一场景重渲染 3 次，而非 9 次），画面会在组内重复；Manim 的画面在 1080p 里偏小（`Axes` 默认尺寸），观感上离 3b1b 还差一截。

## 17. 内容与时间线的规则 + 可执行校验（2026-11-20）

上一版样片证明思路与工具跑得通，但暴露了内容与时间线打架的问题：幻灯段有一句没有 cue，画面停了四十秒；Manim 段三句共用一个场景，同一段动画播了三次。两者都通过了当时所有检查，因为**时长是对的**。这一节把"每句话都必须带来一次画面变化"变成规则，并落到代码里。

### 规则（`src/teach/rules.ts`）

| 规则 | 阈值 | 依据 |
|---|---|---|
| 一句的时长 | 2–8 秒 | 低于 2 秒画面来不及看清；高于 8 秒一张画面撑太久 |
| 中文语速 | 5 字/秒 | 实测：876 字念了 174.3 秒（5.03 字/秒）。计划原先按 4 字/秒估，每次都低估五分之一 |
| 每句至少一次画面变化 | slides 段 cue ≥ 1 | 没有 cue 的句子画面完全不动 |
| fragment 越界 | cue ≤ deck 实际 fragment 数 | 结构性错误，`video_teach_plan` 直接拒绝（此时还没花钱） |
| fragment 递增 | 同一 deck 内跨句递增 | 不递增的画面切换等于没发生 |
| 平均节奏 | ≤ 8 秒／次变化 | 幻灯片讲解的可读上限 |
| 场景复用 | 一个 scene 只服务一句 | 复用即同一段动画重复播 |
| 场景自身时长 | 旁白的 70%–100% | 短了尾部冻结、长了被截断 |

`src/teach/rules.ts` 是纯函数模块：`auditManuscript(board, { deckFragments })` 返回 `structural`（拒绝）与 `warnings`（点名到句子 id），`countDeckFragments(html)` 数 deck 里真实的 `class="fragment"` 数。计划工具在花钱之前调用它，结构性错误直接抛 `ConfigError`。

### 渲染后自检

`video_teach_render` 对每个**本次渲染**的段抽 4 帧（在 10%–90% 区间），用 `countFrameColors()` 数每帧的不同 sRGB 颜色数，再由 `judgeSamples()` 给两个启发式结论：

- **flat**：某帧颜色数 ≤ **64**。2026-11-20 那版白屏就是 1 种颜色、每个像素 `(255,255,255)`；实测最"稀"的真实帧是 Manim 的 1 625 种。64 比真实帧低三个数量级、比空帧高两个数量级，能抓"根本没画"，不会误伤"画得少"。
- **unchanged**：四个采样帧的颜色数完全相同。单独看是弱信号（静止版面本来就该如此），所以只报不断言——**它正是 cue 没触发时的样子**。

两条都是启发式：自检结果写进工具返回的消息，不失败、不改流程。判断"这是不是刻意停住"是作者的事。

### 测试

离线、不渲染、不花钱：

- `test/teach-rules.test.ts`（16 例）：字数越界、无 cue、连续两句无变化、fragment 不递增、平均节奏超限、fragment 越界为结构性、deck 未读时跳过范围检查、场景复用点名、抽帧判定三态、阈值低于实测最小值。
- `test/teach-tools.test.ts` 新增 2 例：稿件 cue 指向 deck 不存在的 fragment 时 `video_teach_plan` 拒绝；无 cue 句子以 warning 形式带着句子 id 出现在结果与消息里（含 `rhythm:` 一行）。

### 中间产物与工具边界

产物归属与 `.gitignore` 建议写进 `video-teach-iterate` skill；手改 `timings.json` 后可以只重录画面，不需要重新合成语音（`video_teach_render` 只读 timings）。

**没有新增 `video_teach_inspect`**。理由：抽帧检查已经在 `video_teach_render` 里做完并随结果返回，`video_teach_export` 负责外部字幕与 deck，再开一个"检查成片"的工具会让检查与渲染脱节（检查的是哪个版本？），而当前两个工具的输出已经能回答"这段是不是静帧、成片多长、字幕对不对"。真要独立核查成片时，`ffprobe` 与 `countFrameColors` 都在，属于运维动作，不需要模型工具。

## 18. TTS 跨句一致性 A/B 探测（2026-11-20）

用户观察：按句合成后拼起来的成片，语调/音色/感情有细微差异，听起来不像同一个人。这一节只记录**实测**，一致性判定留给人耳；试听包在 `renders/tts-ab/`（被 `renders/.gitignore` 忽略）。

**文本**：5 句、105 字，含一个问句与两个带逗号的复句。**音色** `zh_female_liuchangnv_uranus_bigtts`。四组各合成一次：

| 变体 | 做法 | 时长 | 处理 |
|---|---|---|---|
| `A_raw` | 逐句合成，`speech_rate` 固定 1.0，直接拼 | 20.640 s | 无 |
| `B_default-rate` | 逐句合成，不传 `speech_rate` | 20.424 s | 静音归一（便于对照） |
| `C_normalized` | 逐句，固定 rate，每段静音归一（前 40 / 后 180 ms）+ `loudnorm` 单遍 | 18.984 s | 归一化 |
| `D_single-request` | 整段一次请求，按 `sentence.words[]` 切句，其余同 C | 18.877 s | 归一化 |

**工程侧最明显的一条**：A/B 的整体响度是 **−23.5 / −22.9 LUFS**，C/D 是 **−15.8 / −15.7 LUFS**；句尾静音 A/B 在 336–548 ms 之间抖动，C/D 统一成 180 ms。也就是说"一句响一句轻、气口长短不一"这类听感差异，后处理就能收掉，不需要动 TTS。

**参数探测（同一端点，文本「测试。」，连续多次调用）**：

- 基线连续 3 次完全一致（816 ms / 6573 B）。
- `req_params` 里的 `emotion` / `emotion_scale` / `instruct` / `instruction` 与 `audio_params.pitch` 全部返回 200，但输出落在与基线相同的波动区间且**非单调** → **未观察到效果**；它们是否被服务端忽略无法从外部证伪。
- `audio_params.speech_rate` 传整数确实生效：1 / 2 / 10 / 50 / 100 → 1224 / 1032 / 984 / 576 / 552 ms。
- 两个字段的**类型**被实测确认：`speech_rate` 传 1.2 报 `json: cannot unmarshal number 1.2 into Go struct field AudioParams.req_params.audio_params.speech_rate of type int32`；`loudness_rate` 传 1.1 同样报 int32 错误（字段存在，但要整数，本轮未验证听感）。

**结论边界**：没有证据支持"用参数把情绪/语调钉死"；能确定钉住的是 `speaker`（音色）与 `audio_params.speech_rate`（语速，整数）。要进一步提升句间一致性，方向是**减少请求边界**（相邻短句合并成一次请求，按 `sentence` 取回各自时间戳）与**后处理归一化**，两者都不需要端点提供情绪参数。

**局限**：每组只合成一次，句间差异混着服务端自身的随机性（同一请求 3 次一致，但不同用例间出现过 840/1056 ms）；只有 5 句、105 字、单一音色。要定量应每组重复 3–5 次取分布。

## 19. 合并合成与标点停顿（2026-11-20，按用户试听判定落实）

用户听完 A/B 的判定：**D（整段一次请求）更连贯**，但 C 与 D 都在**断句处停留不足**；C 仍能听出语气/情感不是同一个人。随后决定不再重跑付费 A/B，直接按这个判定改代码。本轮没有跑任何合成。

### 四条改动

1. **合并请求成为默认**（`narrateSentences` 的 `merge: 'auto'`）。相邻且都被选中的句子合成**一次**请求，句子之间由 `joinUtterance()` 补 `。` 后拼接；返回的 `words[]` 用**字符偏移**映射回各自的句子（`assignWordsToSpans`），所以服务端合并或重切都不会错位。`sentences: [id]` 的收窄语义保留：只合并被选中的相邻句，不跨过被保留的句子。每次请求上限 `MAX_UTTERANCE_CHARS = 480`，超过自动分段。`merge: 'none'` 退回逐句请求，作为对照与故障隔离路径。
2. **停顿按标点给，且只增不减**（`SENTENCE_PAUSE_MS`）：`。` 400 ms、`？`/`！` 480 ms、`，`/`、`/`；` 170 ms、无标点 120 ms。实际取 `max(语音自己的气口, 标称值)`；上一版把句尾统一裁到 180 ms，正是“停留不足”的直接原因。
3. **切段边界取下一句首词**（`segmentTiming`）：合并模式下切片区间是「本句首词 `startTime` → 下一句首词 `startTime`」，最后一句到音频末尾；停顿天然留在段内，`durationMs` 因此包含停顿，时间轴数学不变。逐句模式保持「音频 + 补静音」。需要补时用 `cutAudioSegment()`（`atrim` 采样精确 + `apad` 补静音），既不需要切也不需要补时直接拷字节，不重编码。
4. **语速固定为整数**：`normalizeSpeedRatio()` 默认 1，永远显式发送 `speech_rate`（不依赖服务端默认值），非整数在本地就报「语速只接受整数」；稿件层面 `meta.voice.speed_ratio` 也在解析阶段拒绝小数并给出行号。

### 验证（全部离线）

- 新增 `test/teach-narration.test.ts` 20 例：停顿表与大小关系、拼接的标点修复与字符区间、词到句的映射（含服务端重切）、整数语速与稿件行号报错、`segmentTiming` 的“边界取下一句首词 / 只补不裁 / 逐句模式保留引子与自然停顿”、分组（相邻合并、不跨保留句、480 字分段），以及用 `ffmpeg lavfi` 合成正弦波验证 `cutAudioSegment` 裁剪与补静音的实测时长（±40 ms）。
- `pnpm test` 636 passed / 7 skipped；`pnpm run build` 通过。

### 需要人工复核

程序能证明切片边界与时长，**证明不了“听起来像一个人在讲、停顿够不够”**。下次重跑后请重点听：句间是否还有“急着接下一句”的感觉；问句之后是否有明显长于陈述句的停顿；连续三到四句的语气是否还漂。

## 20. Manim 是可选的：依赖分三档 + 开工前拒绝（2026-11-20）

产品判断（用户提出）：**Manim 不能是必须的**。别的用户没装 Manim 时，这条路线应当仍能做完（纯 `engine: slides`），并且应当有人给了安装指引。

改动前的两个毛病：`video_teach_plan` 把 `python3` / `latex` / `dvisvgm` 和 `ffmpeg` 一起列成一排 missing，看起来纯幻灯片工程也是坏的；而 Manim 真缺的时候要等到 `video_teach_render` 才报错，那时旁白已经花过钱了。

现在的做法：

1. **依赖分三档**（`src/teach/rules.ts` 的 `assessDependencies()`，纯函数，探针结果由调用方给）：
   - `required`：`ffmpeg`、`ffprobe` —— 任何工程都需要；
   - `slides`：Chromium —— **永不阻塞**，它只是查找提示（`playwright-core` 随包）；
   - `manim`：`python3`、`manim`（模块是否装得进那个解释器）、`latex`、`dvisvgm` —— **只有稿件里真的存在 `engine: manim` 的句子时才参与判定**。
   判定还按 `sentences: [...]` 收窄：只重录幻灯片那几句时，缺 Manim 不算问题。
2. **报告按档给出**：`tools:` 一行先说「这份稿件需不需要 Manim」以及是哪几句；然后 `required:` / `slides:` / `manim:` 三行分别列状态；不需要 Manim 时，那三样缺失**不进 `missing`**。
3. **开工前拒绝**：稿件有 manim 段而缺依赖时，`video_teach_plan` 与 `video_teach_render` 都在动手前抛错，消息里有句子 id、缺的是哪一个程序、以及两条出路——照命令装（每条都带可复制命令），或把那几句改成 `engine: slides` 并删掉 `scene`。拒绝消息点明 **BasicTeX 有 `latex` 没有 `dvisvgm`** 这个坑，并给出 TinyTeX 方案。
4. **区分「没有解释器」和「解释器里没有 Manim」**：探针会跑 `python -c "import manim; print(manim.__version__)"`，前者提示装 Python 并把 `TEACH_PYTHON` 指过去，后者只提示 `pip install manim`。

**skill 同步**：`video-teach-manim` 开头新增「先判断：需要 Manim 吗」——什么情况必须 Manim（公式推导、坐标系连续动画、多状态连续变化），什么情况 slides 就够（要点分步、对比、图片、图表），以及三样依赖的完整装法与 `TEACH_PYTHON` / `TEACH_TEXBIN` 用法；`video-teach-storyboard` 的 `engine` 说明写明「只用 slides 完全合法」；`video-guide` 的依赖一节改成分档表述。公式能力如实写明：目前只有 Manim 的 `MathTex` 或 HTML/图片，**包内没有 MathJax/KaTeX**。

**测试**：`test/teach-deps.test.ts`（12 例）——纯函数覆盖三档判定、两种缺失区分、BasicTeX 提示、收窄只选幻灯片、Chromium 永不阻塞；工具层用注入的探针验证「纯幻灯片 + 全无 Manim 也照常 plan」「manim 稿缺 dvisvgm 时 plan 拒绝且消息含句子 id 与两条出路」「render 同样在动手前拒绝」。探针注入而不是改环境变量：没有哪台机器能按需卸掉 ffmpeg 或 dvisvgm。

## 21. 设置界面：语音凭据与三个路径（2026-11-20）

用户要求把语音凭据和教学路线用到的路径放进插件设置页，理由很直接：插件设置页本来就能配 ARK / MiniMax 的供应商 key，语音没道理只能靠环境变量。

**落地的设置项**（都是 `volatile`，改完下一次工具调用即生效，不用重启）：

| 设置项 | 默认 | 作用 |
|---|---|---|
| `teachVoiceAuthRefDeepseek` | `DEEPSEEK_API_KEY` | DeepSeek 语音凭据的**引用名**。真正的 key 走宿主凭据服务，配置文件里没有明文 |
| `teachVoiceAuthRefVolcengine` | `ARK_VOICE_API_KEY` | 火山语音凭据的**引用名**，同上 |
| `teachPythonPath` | 空 | 装了 Manim 的 Python；空则 `TEACH_PYTHON`，再退到 `PATH` 上的 `python3` |
| `teachTexBinPath` | 空 | 同时有 `latex` 与 `dvisvgm` 的 bin 目录；空则 `TEACH_TEXBIN`，再走自动发现 |
| `teachChromiumPath` | 空 | Chromium 可执行文件；空则 `TEACH_CHROMIUM`，再用 Playwright 自带查找 |

**优先级是刻意的**：设置 → 环境变量 → 自动发现。环境变量是宿主启动那一刻的快照，GUI 用户改不动它，这次的 TeX 缺失就是被这条卡住的；所以设置必须赢。解析集中在一个函数里（`src/teach/probe.ts` 的 `teachPaths`），工具、探测、面板接口共用。

**界面**：设置卡片里新增一个可折叠的「教学视频」小节，**默认展开**（2026-11-23 改：默认收起会被读成"没有东西可配"，而这节正是要配 key 与路径的地方；纯生成式用户可以直接收起）。标题行始终显示两个 provider 的凭据状态（`语音凭据：DeepSeek 已配置 · volcengine 未配置`），收起时也看得到。展开状态下卡片会自动探测一次这台机器（`GET /video-forge/api/teach`），所以列出的版本是当下的，不是"上次按按钮时"的。展开后**每个 provider 一组**引用名输入框 + 凭据行（只显示已配置/未配置与掩码尾，保存后立刻清空输入框），下面是三个路径输入框与一个「探测这台机器」按钮。

一组一个引用名是必须的：DeepSeek 的语音端点吃它的普通 API key，火山吃语音专用的 `ARK_VOICE_API_KEY`，一个引用名只可能对其中一个正确。早先只有一个字段时，DeepSeek 稿件（默认路线）显示的是火山的引用名（2026-11-20 修正，`voiceAuthRefFor()` 现在按 provider 取）。探测结果来自新增的 `GET /video-forge/api/teach`，返回 `ffmpeg` / `ffprobe` / `chromium` / `python3` / `manim` / `latex` / `dvisvgm` 的实际状态与版本；它单独成一个接口而不是塞进 `overview`，因为探测要 spawn 一次 Python，而视频面板轮询 `overview` 的频率远高于有人打开设置。

**没有做的事**：密钥输入框不会写进配置——它调用现成的凭据服务；设置里也没有音色字段，音色属于稿件的 `meta.voice.speaker`。

## 22. DeepSeek 官方 TTS：可用，但没有字级时间戳（2026-11-20）

**结论：接口存在且可用，已接成第二个语音供应商，但它只能做"整句驱动"的画面，不能做 cue 驱动的画面。**

文档（[语音合成](https://api-docs.deepseek.com/zh-cn/guides/tts)、[API](https://api-docs.deepseek.com/zh-cn/api/tts)）：

- `POST https://api.deepseek.com/v1/tools/tts`，`Authorization: Bearer $DEEPSEEK_API_KEY`，body `{ text, voice_id?, format?, filter_markdown? }`，响应是音频流（`audio/wav` 或 24 kHz 16-bit 单声道 PCM）。
- 音色只有两个：`stella`（女声，默认）、`tide`（男声）；语种按文本自动识别（含普通话、粤语、英语等）。
- 限制：单次 ≤ 10 000 计费字符、请求体 ≤ 64 KiB、音频 ≤ 30 分钟；**不支持调节语速**；429 是并发上限，400 可能是内容审核。
- 计费：每 1 万字符 3 元（限时 1.5 元），**汉字按 2 个字符计**，所以中文实际是每万汉字 6 元，比火山语音的 5 元/万字符贵。
- 文档里没有时间戳、字幕、逐词对齐之类的任何参数；WebSocket 版也只回 PCM 帧 + 结束事件。

**实测（2026-11-20，一次短句）**：`200`，`audio/wav`，`pcm_s16le / 24000 Hz / 单声道`，1.84 s。请求 `{"text":"你好，我是 DeepSeek。","voice_id":"stella","format":"wav"}`。

**因此集成是按能力切分的**：

- `meta.voice.provider: deepseek` 时，`video_teach_narrate` 逐句合成（不允许合并请求，因为没有词时间戳就无法切片），写 `audio/<句>.wav` 与 `timings.json`，并在 `voice.timestamps: none` 里**显式声明**"这些音频没有词时间戳"。
- `video_teach_render` 看到 `timestamps: none` 且稿件里有任何 cue 时**直接拒绝**，消息说明"cue 是某个时刻的主张，这个供应商不提供时刻"，给两条出路：去掉 cue（每句一张静帧），或换回火山语音。**不会去猜时间**。
- `timings.json` 的解析也收紧：词时间戳为空只在 `voice.timestamps: none` 时合法，否则仍按"不能驱动画面"报错。

**已知缺口**：DeepSeek 的语速不可调，所以 `speed_ratio` 对它无效（会被忽略，文档已写）；ASR 接口（`/v1/tools/asr`）同样只回整段文本与时长，不能用来自动补出词级时间戳。

## 22. 默认语音改为 DeepSeek，以及"无词时间戳"成为一等公民（2026-11-20）

用户听完 A/B 试听包后的裁决：**DeepSeek 更好，用它**。原话要点：多段之间音色/情感一致，听起来是一个人；多句拼接即使不补间隔也比 ark 自然；语速比 ark 慢，正合教学视频（给观看者理解时间）。

### 默认值与停顿策略

| | `deepseek`（默认） | `volcengine` |
|---|---|---|
| 凭据 | `DEEPSEEK_API_KEY` | `ARK_VOICE_API_KEY` |
| 音色默认 | `stella`（`tide` 可选） | 无默认，必须写明 `*_bigtts` id |
| 语速 | 不支持 | 整数 `speed_rate` |
| 词级时间戳 | **没有** | 有（`enable_subtitle: true`） |
| 合成方式 | 逐句请求（`merge` 对它是空操作） | 相邻句合并成一次请求 |
| 停顿 | **不补**：保留语音自带气口 | 按标点补，且只补不裁（§18 的表） |
| 画面驱动 | 一句一页 + 页内 `at_progress` 节拍 | `at_word` 按词触发 fragment |

停顿策略写成了代码里的 `pausePolicyFor(provider)`（`src/teach/voice.ts`），不是文档约定：`natural` 与 `punctuation` 两种，加一个 provider 时不可能只改一半。依据是盲听——给 DeepSeek 补停顿反而显得赶。

### 画面契约：一句一页 + 句内可分步

无词时间戳不等于"一句一张死图"。deck 契约从两个全局变成三个：

- `teachPage(n)`：切到第 n 页（默认一句一页，页序 = 句子的顺序；稿件用 `page` / `enter` 可以让连续几句共用一页，见 §25）。
- `teachCue(n)`：页内显示到第 n 步。
- `teachReady`：版式就绪。

录制时：句子开始先 `teachPage(该句的页)`，再按 cue 的偏移 `teachCue(fragment)`。因此"折线逐点长出来"这类演示仍然能做，只是节拍由**作者按语义给比例**，不是由词决定。共享页时在切页与开录之间还有一次 `teachCue(enter)`，把上一句留下的亮度先打回去（§25.3）。

cue 因此有两种时间写法：

- `at_progress`（0–1）：**两个 provider 都可用**；cue 时刻 = `at_progress × 该句实测时长`。
- `at_word`：**只有 `volcengine` 可用**。`deepseek` 下写了会在解析阶段被拒绝，并提示改用 `at_progress`（`storyboard.ts`，带行号）。
- 一条 cue 只能写一种；都不写表示句子一开始就切。

校验（`rules.ts`）：`at_progress` 落在 20%–80% 之外给 warning（太靠两端容易被换气吞掉）；一句内超过 3 个节拍给 warning（通常说明这句话讲了两件事，应当拆句）。`volcengine` 的"每句至少一个 cue"规则在 `deepseek` 下不适用——那里一句本来就换一页。

### 它丢掉了什么，明确写出来

- 节拍与发音**不逐字对齐**，允许有可接受误差；不能承诺"讲到哪个字画面动到哪"。
- 想恢复逐词联动，只能换回 `volcengine`（或外挂 ASR 对齐，未做）。

### 入口处都会被明确告知

同一件事在五个地方说清，避免"以为有、其实没有"：`video_teach_plan` 的 `picture:` 行与 warnings、`video_teach_narrate` 的返回与消息（`word_timings: false`）、`video_teach_render` 的 `picture:` 行、`timings.json` 的 `voice.timestamps: "none"`、以及 `video-teach-storyboard` / `video-teach-slides` 两份 skill。

### 测试

新增离线用例：`at_progress` 解析、0–1 范围、两种 provider 下的 `at_word` 门禁、一条 cue 不能同时写两种时间、cue 时刻 = 比例 × 实测时长、同句 fragment 递增、20%–80% 与"超过 3 个节拍"的 warning、`deckDriveMode()` 的两种取值、模板包含 `teachPage`。样片目录新增 `fixtures/teach/page-mode/`（DeepSeek + `at_progress` 的最小工程），原来的 `fixtures/teach/sample/` 显式声明 `provider: volcengine`，作为 cue 驱动的例子保留。

## 23. 独立验收运行暴露的缺陷与修正（2026-11-20）

一个**不继承上下文**的子智能体照仓库文档从零跑了一遍 DeepSeek 页模式（稿子 → plan → narrate → render → 成片），这轮真正要验证的不是"能不能出片"，而是"换一个不了解内情的人照文档能不能走通"。结论是：**能跑通，但默认状态下跑不通**。它挖出 10 个缺陷，其中 3 个是断流级的（当轮已修），剩下 7 个这轮全部处理完。

### 断流级（当轮已修，本轮的测试补上了它们缺的那一环）

| 症状 | 根因 | 修法 |
|---|---|---|
| narrate 之后 render/export 全线报 `timings has unknown key "sampleRate"` | 写方写 `sampleRate`/`merge`，读方白名单不认；测试把内存对象直接喂给 render，从不经过磁盘 | `serializeTimings()` 与 `parseTimings()` 并排放在 `storyboard.ts`，写读同一处 |
| 句内节拍全丢，整句只剩最后一帧 | CDP `metadata.timestamp` 是**秒**，代码把差值当毫秒，四秒录制的所有帧都挤在 0–5 ms | `(timestamp - startedAt) * 1000` |
| 默认路线的 SRT 是空文件，消息还说 word-timed | 只遍历 `sentence.words`，DeepSeek 恒为空 | 无词时间戳时按整句产出一条 cue，消息分支 |

第二条同时**修正了上一轮对"40 秒画面冻结"的归因**：当时判给版式溢出与 cue 下标，真实主因是时钟单位。

### 这轮修掉的七个

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 4 | `plan` 说"cue 不会生效"，同一次 `render` 又说"节拍按 at_progress 生效"，两个输出当着用户面互相反对 | `planStoryboard` 的文案停留在 `at_progress` 之前 | 改成页模式口径：页数、句内 `at_progress` 节拍、不与发音对齐 |
| 5 | DeepSeek 稿件下 `plan` 报 `ARK_VOICE_API_KEY configured`，实际用的是 `DEEPSEEK_API_KEY` | 依赖报告用设置里的**裸引用名**，没走 `voiceAuthRefFor()` | 按稿件 provider 解析引用名，报告与真实调用同源 |
| 6 | `assemble: false` + 部分 `sentences` 被 `planSegments` 卡死（段落已经渲好，调用却失败） | 无条件要求每句都有画面 | `planSegments(..., { requireAll })`：要拼片才强制，否则把缺的句子作为 `pending` 报回 |
| 7 | 页模式首拍前只有标题的帧（57 色）被判 `flat` | 阈值 64 高于实测最稀的真实帧，且"任一帧平"即判 | 阈值降到 16，判据改成"**每一帧**都没画东西" |
| 8 | 每段开头闪一帧 deck 首页（35 ms） | 先开 screencast、后 `teachPage` | 先切页并等过场结束，再开录；t0 仍是第一帧 |
| 9 | 页模式 deck 缺 `teachPage` 只在 render（钱已花）报错 | plan 不读 deck 契约 | `auditDecks()` 在 plan 期检查 `teachReady` / `teachCue` / `teachPage`、页数、页内 fragment 数 |
| 10 | 成片音轨比旁白短 72 ms，末句尾巴被切 | `-shortest` 取两流较短者 | 去掉 `-shortest`，成片长度取较长流 |

### 一条契约修正：页模式下 fragment 编号按页算

验收运行里子智能体踩到的第二个坑：`rules.ts` 要求 fragment 在**整段**里递增，而模板的 `teachCue` 数的是**当前页**的 fragment。照规则编号、用模板实现，第 2 页的 cue 3 会多推一次 `nextFragment` 直接翻页——它自己在 deck 里做了全局→局部换算才让 32 个节拍落对页。

现在的口径统一成"reveal.js 的原生语义"：

- `fragment` **在所在页内**从 1 递增（第 2 页的第一个节拍又是 1）。纯 cue 模式不分页重来，编号全片递增；多页的 cue 模式 deck 由录制器把这个号翻成"第几页第几拍"（见 §27）。
- 模板的 `teachCue(n)` 把 `n` **夹在本页 fragment 数内**，所以一个 cue 永远不会翻页（宁可停在最后一拍，也不跳页）。
- `auditDecks()` 在页模式下按页核对编号上限，越界给 warning 并指出第几页；跨句递增的检查在页模式下不再执行（那是 cue 模式的规则）。
- `fixtures/teach/page-mode/` 按新口径改了编号与 deck；样例 deck（cue 模式）不受影响。

### 新增的回归测试

- `timings` 写读往返：`serializeTimings` → `parseTimings` 完全等值，两种 provider 各一例（这条正是三个断流缺陷里漏掉的那类）。
- `planSegments` 的 `requireAll`：部分渲染不报错、缺段作为 `pending`，拼片时仍然拒绝。
- `auditDecks`：缺 `teachPage`/`teachCue`/`teachReady` 结构性拒绝、页数少于句数 warning、页内编号越界 warning、页模式不做跨句递增检查。
- 抽帧判定：整段为空才判 `flat`；一帧稀疏（57 色）不判。

`pnpm test` 692 passed / 7 skipped，`pnpm run build` 通过。

### 仍未做

1. 用 DeepSeek 真跑一遍 `narrate → render`（付费，极小额度即可验证默认路径的这几处改动）。修完的这几条都只经过离线验证。
2. 在 GUI 里点开设置页看一次探测结果（需重载插件）、把样片放进工作区 `renders/` 后在视频面板点开一次。
3. 按 §17 的规则返工那条 3 分钟样片（3 句超预算、平均 10.5 秒一次变化、场景复用、Manim 画面偏小）。
4. 听感复核（句间停顿是否够、语气是否还漂）——只有人耳能判。

## 24. 设置页的语音 key 修正：一个 provider 一个引用名（2026-11-23）

用户指出「`ARK_VOICE_API_KEY` 在插件配置界面上可配置」这件事没有落实。查下来是两件事叠在一起：界面上那一行在「教学视频」小节里（当时默认收起），而且**它只有一个引用名输入框**——DeepSeek 稿件（默认路线）跑起来要的是 `DEEPSEEK_API_KEY`，界面上却只会显示和写入 `ARK_VOICE_API_KEY`。所以严格说，DeepSeek 那个 key 从来没法在界面上配。

### 改法

- 设置拆成 `teachVoiceAuthRefDeepseek`（默认 `DEEPSEEK_API_KEY`）与 `teachVoiceAuthRefVolcengine`（默认 `ARK_VOICE_API_KEY`）。`voiceAuthRefFor(teach, provider)` 在 `probe.ts` 里按 provider 取，工具、依赖报告、设置卡片共用同一个答案。
- 卡片里每个 provider 一组「引用名输入框 + 凭据行（保存 / 删除，只显示掩码与来源）」。改一个不影响另一个。
- **折叠状态下标题行也显示两个 key 的状态**（`语音凭据: DeepSeek 已配置 · volcengine 未配置`）。这条是刻意的：用户来这个页面就是想知道「key 到底配没配」，藏在折叠里等于没有。

### 渲染真实宿主时抓到的两个缺陷

这轮按仓库既定做法起了一个隔离实例（`DSH_HOME=/tmp/teach-ui-verify`，端口 34799，`dsh plugin --profile web add <repo>`），用 Playwright 打开插件页截图并真的把两个 key 存进去。抓到两个只看代码看不出来的问题：

1. **`refreshCredentials` 会清空其它行的状态**：保存一个 key 之后只重新查询那一个引用，`setCredentials(Object.fromEntries(...))` 把其余状态整张替换掉，标题行于是对另一个 provider 说"无法检查"。改成合并（`{ ...current, ...fresh }`）。
2. **布局被撑开**：把一组字段塞进列方向的 flex 容器后，`FIELD` 上的 `flex: '2 1 260px'` 变成**高度**基准，模块之间拉开 260px 空白。改成让 label 落在 `ROW` 里（同一行内 flex 才按宽度算）。

两条都有回归测试：`test/client-config-card.test.tsx` 里"保存一个 key 之后两行状态都还在"在旧实现上失败、在新实现上通过。

### 验收

隔离实例里实测：`DeepSeek 凭据引用名 → DEEPSEEK_API_KEY`、`volcengine 凭据引用名 → ARK_VOICE_API_KEY`，各填一次 key 点「保存密钥」，标题行变成 `语音凭据: DeepSeek 已配置 · volcengine 已配置`，宿主 `.credentials.yaml` 的 `refs` 里出现这两个名字（值不打印）。截图见 `renders/settings-ui/`（该目录被 `.gitignore` 忽略）。

**给使用者的一句话**：这一节在插件配置卡片里、默认展开，标题行右侧就是两个 key 的状态；改完设置下一次工具调用即生效，但宿主进程必须重启过才能加载带这两个字段的构建。

## 25. 一页承载多句：`page` / `enter`（2026-11-24 提案，2026-11-25 实现）

这一节的依据是一条真实片子（`video-hypatia`，七幕 196 页）跑完整条路线后留下的证据，不是推演。2026-11-24 写的是提案，2026-11-25 按这一节落成代码，实现与验证记录在 §25.12；§25.3 与 §25.6 已按实际代码改写，理由与否决过的方案原样保留。

### 25.1 为什么需要它

a00-6、a00-7、a00-8 三页讲的是同一件事的三个次第（「第一个负责存 / 第二个负责自组织 / 第三个负责看见」），右侧三张能力卡依次点亮。用 Playwright 量三页的元素框，**完全重合**：

| 页 | h1 | 左栏 | 右图 |
|---|---|---|---|
| a00-6 | `[96,126,1728,75]` | `[96,217,832,683]` | `[992,323,832,471]` |
| a00-7 | 同上 | 同上 | 同上 |
| a00-8 | 同上 | 同上 | 同上 |

版面早就做对了，观众仍读成「翻页」。泄漏只剩两处：右上角页码 `6/11 → 7/11 → 8/11`，以及左侧大标题整行替换（58 px 跳变）。作者要的是「同一页在演进」。

不改代码能做到的极限是让它**看起来**像一页：页码固定成 `a00 · 6–8/11`，左侧换成常驻标题，变化下沉到细节行。这能止住翻页感，但屏幕上的大标题不再逐字对应旁白的「第一个 / 第二个」，那部分语义只能靠旁白承担。

要真的共享一页，插件必须额外知道两件事，而这两件事 deck 自己算不出来：

1. **哪几句属于同一页**。页号原本就是句在本段里的下标（当时的 `findIndex` 在 `renderSegments`，现在由 `src/teach/storyboard.ts` 的 `pageSlots` 解析），deck 只是被动接收 `teachPage(n)`。
2. **进入这一页时该亮到第几拍**。每句都是独立的 `page.goto` → `teachPage` → 等 300 ms 过场 → 开录（`src/teach/slides.ts` 的切页块，`PAGE_TRANSITION_MS = 300`）。新导航会清空 DOM，上一句点亮的卡不会留到下一句，所以进页状态必须由录制器在开录之前打到位。

**两条不要走的路**：

- **把三句合成一句**。86 字按 5 字/秒（`CHARS_PER_SECOND`）约 17 秒，超 `MAX_SENTENCE_SECONDS = 8`；更要紧的是合成后只剩一条 cue，页内节奏反而丢了，还要为这一句重录旁白。
- **在 deck 里给 `teachPage` 加一张「页号 → 句号」映射表**。看着能省事，但它把「页序」这件事复制到每个项目里。一旦句序调整（拆句、并句），映射表静默错位，画面和旁白就不同步，而且**没有任何检查会发现**。判断依据只能有一个出处，就是稿子。

### 25.2 语法（两个可选键）

`storyboard.yaml` 的 sentence 增加 `page`（从 0 起的页号，缺省＝本句在段内的下标）与 `enter`（进入该页时先显示到第几拍，缺省＝同页内上一条句子的最后一拍，本句是该页第一句时为 0）：

```yaml
sentences:
  - { id: a00-6, say: ..., page: 5 }
  - { id: a00-7, say: ..., page: 5, enter: 1 }
  - { id: a00-8, say: ..., page: 5, enter: 2 }
```

`enter` 不写时按上一条规则推算（推算值 = 上一条句子留在屏幕上的拍数，不是它最后的 cue 编号；上一句若写了更大的 `enter`，留下的就是那个数）。写成与推算值相同的数时两种写法等价（写出来只是省得读稿的人自己推一遍）；写成**更大**的值是刻意在句首跳拍（合法，页面开录即多亮几拍），写成**更小**的值会被拒绝，因为那一拍会当场消失。

两个键都只能是非负整数。**`enter` 必须和 `page` 写在同一句上**（只写 `enter` 说不清是进哪一页），这一条在解析期就拒绝，因为它与相邻句无关，能直接报出行号。

### 25.3 改动点（五处）

| 位置 | 现在 | 改成 |
|---|---|---|
| `src/teach/storyboard.ts` 的句子解析 | `knownKeys(…, ['id','say','cues'])` | 白名单加 `page`、`enter`；两者校验非负整数；`enter` 无 `page` 直接拒绝 |
| `src/teach/storyboard.ts` 的 `pageSlots(segment)` | 无 | 逐句解析出 `{ page, enter }`：页号缺省＝句下标，`enter` 缺省＝同页上一句留下的最后一拍（本句是该页第一句为 0）。`pageSlotOf` 给渲染器取单句，`pagesUsed` 给 plan 与 deck 核对数页数 |
| `src/teach/pipeline.ts` 的 `renderSegments` | `page = segment.sentences.findIndex(...)` | `pageSlots` 的结果同时给出 `page` 与 `enter`，一起传给录制器 |
| `src/teach/slides.ts` 的切页块 | 切页后等 300 ms | `RecordDeckOptions` 加 `enter?: number \| null`；切页后若 `enter > 0` 先 `teachCue(enter)`，再等 300 ms |
| `assets/teach/deck/index.html` 的 `teachPage` | `Reveal.slide(n, 0, 0)` | `Reveal.slide(n, 0, -1)`：切到一页时**一个拍都不亮** |

`assets/teach/deck/index.html` 那一行是落成时发现的既有缺陷，不在原提案里：`Reveal.slide` 的第三个参数是「落到第几个 fragment」，传 `0` 等于落到第 0 个（已显示），也就是切页当场点亮第一拍。后果是第一拍永远等不到自己的 cue（`teachCue(1)` 看到已经亮着，直接跳过），观众看到的是「页面一开就亮一块」；共享页的 `enter: 0` 因此根本无法兑现。改 `-1`（停在第 0 个之前）后开页是暗的，`teachCue` 的每一步都有变化。`test/teach-deck.test.ts` 起一份真实模板 deck 驱动一遍来守这条：切页后可见拍数 0、`teachCue(1)` 后 1、`teachCue(2)` 后 2、重复 `teachCue(1)` 不变（拿旧行为跑这条测试会失败在第一个断言上）。

**已经建好的项目不会自动修**：`writeDeck` 不覆盖既有 deck，所以老项目的 deck 里仍是 `Reveal.slide(n, 0, 0)`，第一拍照旧提前亮、第一条 cue 照旧空转。要修就手改 deck 里那一行（`0` → `-1`），然后只重渲，不用重录旁白（见 `video-teach-iterate` 的「只改画面时重跑什么」）。

`src/teach/slides.ts` 那一行（切页块）的顺序是硬要求：screencast 在 300 ms 之后才开，`teachCue(enter)` 必须落在这段等待里。否则第 2 句的 t=0 仍是「整页暗」，观众会看到第一张卡闪两次。

解析与校验分开，也是刻意的：`pageSlots` 只算不判。同一条规则在两处各判一次就会报两遍，而规则本身需要相邻句（`page` 单调、`enter` 承接），那属于 `rules.ts` 的活儿。

### 25.4 为什么用 `teachCue(enter)`，不扩展 `teachPage(n, enter)`

契约仍然是两个函数：`teachPage(n)` 切页，`teachCue(k)` 显示到第 k 步。第三个数只是录制器在开录前多调一次 `teachCue`，语义不变。老 deck 完全兼容（没写 `enter` 就不调），模板一行都不用改。

扩展 `teachPage` 的签名会把「要不要处理第二个参数」这个分支复制到每个项目的 deck 里，而 deck 并不知道「这一页是第几句进来的」这件事该由谁负责。

### 25.5 编号规则要跟着改（最容易做错的一处）

§23 定的口径是「fragment 在所在页内从 1 递增，跨句不检查」。共享页打破这条，因为 `teachCue` 是幂等的「显示到第 k 步」：同页第二句如果又从 1 编号，`teachCue(1)` 只会把已经亮着的第一张卡再确认一次，**画面不动**，等于把「静帧」这个老缺陷换个地方复发。

共享页的规则：**同一页内，fragment 跨句继续递增**（第 1 句 1，第 2 句 2，第 3 句 3）。两条规则并存，判定看页是否相同：

- **不同页之间**不比较（§23 的现有行为）；
- **同一页内**必须递增，否则结构性拒绝（照 `auditManuscript` 里那段跨句检查的写法，实现在 `pageFindings`）。

这不是推翻 §23，是补它的另一半：一句一页时页面之间没有共享状态，共享页时同一页就是一条连续时间线。

### 25.6 校验：哪些写坏的稿子会被拒绝，哪些只提示（`src/teach/rules.ts`）

`auditManuscript` 里新增 `pageFindings(segment)`，只在页模式（无词时间戳）跑；`auditDecks` 则把「句 → 页」的映射换成 `pageSlots` 的结果。提案时只有「四条拒绝 + 按页核对页数」，落成时多出几条：`enter` 让画面倒退、共享页整句无变化、共享页要 `teachCue` 却缺失、页数数不出来（后三条在原提案里看不见，是共享页把旧规则的豁免前提改掉了）。

下表是代码的全集，**类型列就是判据**，不另标「共几条」——那类计数随行数漂，上一版就写错过。写作侧该知道的收在 `video-teach-storyboard`，deck 侧该知道的收在 `video-teach-slides`：

| 规则 | 类型 | 谁来判 | 说明 |
|---|---|---|---|
| 只给一部分句子声明 `page` | 拒绝 | `pageFindings` | 例外只有一种：句子写 `page: <它自己的下标>` **并且**写了 `enter`（「这一页一打开就亮着几拍」），这种声明不挪页，可以单独写。除此之外——声明了别的页，或只写了 `page: i` 没写 `enter`——都必须整段都写，否则共享关系与进页状态都无从判定 |
| `page` 回退 | 拒绝 | `pageFindings` | 录制严格按句序，页号变小等于让画面倒着走 |
| 同页内 fragment 没有递增 | 拒绝 | `pageFindings` | §25.5。因为缺省的 `enter` 就是上一句留下的拍数，这条与下一条在代码里是同一个判断，消息按「写出来的 `enter`」和「承接上一句」分两种措辞 |
| `enter` 不小于本句首个 cue | 拒绝 | `pageFindings` | 那一拍开录前就亮过了，cue 到时不会有变化。给出的改法是**合法区间**（≥ 上一句留下的拍数、< 首个 cue），而不是「改小一点」——后者常常会被下一条规则再拒一次 |
| 挪去的页 deck 没有 | 拒绝 | `auditDecks` | 段里有句子挪到别的页（`page` ≠ 它自己的下标）且 `max(page) + 1 > deck 页数`：那一页不存在。**只对挪页的段拒绝**；一句一页的段保持原有 warning（模板的 `teachPage` 会夹住，句子停在最后一页而不是失败） |
| deck 有页永远录不到 | warning | `auditDecks` | `max(page) + 1 < deck 页数`，**只对挪页的段**：多出来的页一次也不会出现。没挪页时只比较句数与页数（原有 warning） |
| 页内 fragment 上限 | warning | `auditDecks` | 上限改成取该句**所在页**的 fragment 数，而不是用句下标当页下标 |
| `enter` 超过该页的 fragment 数 | warning | `auditDecks` | `enter` 是「这一页亮到第几拍」的声明，和 cue 一样受该页上限约束；超过时 deck 会夹在页末，页面一开就是全亮 |
| `enter` 比同页上一句留下的少 | 拒绝 | `pageFindings` | 写出来的 `enter` 是权威值，比承接值小就意味着开录瞬间有一拍消失，画面倒退。同一句最多一条：若「首个 cue 不高于上一句留下的拍数」，那么**没有任何 `enter` 值**能同时满足两条，消息直接要求把节拍按整页重新编号 |
| 共享页上整句画面不动 | warning + `silent` | `auditManuscript` | 同一页上既不开新页、也没有 cue 或更大的 `enter` 的那一句，整句期间画面不变。「没 cue 不算缺陷」的豁免只对独立成页的句子成立。逐句点名，因此「连续两句无变化」那条成对 warning 只在 cue 模式报（页模式报它等于同一个缺陷说两遍） |
| 有 `enter > 0` 却缺 `teachCue` | 拒绝 | `auditDecks` | 整段一条 cue 都没有、但有 `enter > 0`（共享页或独立成页都可能）时，录制器仍要用 `teachCue` 打回进页状态；缺了在录音前拒绝，而不是录制时才发现 |
| 页数数不出来 | warning | `auditDecks` | deck 没有 `<section>`（或页在 JS 里生成）而稿件声明了 `page`：页号无法核对，明说一句，不静默跳过 |
| 节拍数数不出来（cue 模式） | warning | `auditDecks` | deck 的 `class="fragment"` 数不出来（节拍在 JS 里生成）时，整 deck 的越界核对无从做起：同样明说一句 |
| `enter` 没写 `page` | 拒绝 | 解析期（`storyboard.ts`） | 这一条与相邻句无关，解析时就能带行号报出来 |

词级时间戳（`volcengine`）下这两个键不生效——纯 cue 模式的页由节拍推出来，不是声明的。这条不改行为，只给一句 warning，否则作者会以为页号写了就该有变化。

### 25.7 不改的部分（划界）

- **跨句仍然是硬切**。每句独立录制、单独编码、最后拼接，跨句过渡动画拍不到，本提案不改变这一点。观众感到「连续」的原因只能是版面、页码、几何三者一致。
  - **2026-11-25 补充：这条已被取代，但原文保留。** [`TEACH-MOTION.md`](TEACH-MOTION.md) §6 的 D3 方案把 `[正文][转场 exitMs]` 合成一段来录，跨句转场（含 Auto-Animate）因此可以进成片；实现后本节对"跨句只能硬切"的判断不再成立。
  - **2026-11-26 补充：已落地。** 稿件写 `meta.transition` 才有转场，不写仍然是硬切（本节描述的默认行为不变）。段结构变成 `[正文 durationMs][转场 exitMs]`，`timings.json` 每条多一个 `exitMs`，凡是"只有 durationMs"的算法都要按 `durationMs + exitMs` 加：成片时长、SRT 起点、逐幕验收、`runs.py collect`。实现记录与逐缝实测见 [`TEACH-MOTION.md`](TEACH-MOTION.md) §16，样片在 `renders/transition/`。
- **重录仍然只花一句的钱**。共享页不改变「一句一录像片段」，`sentences: ['a00-7']` 仍然只重渲那一段。
- **页模式仍然没有词时间戳**。`enter` 与 `at_progress` 都与发音不逐字对齐。
- **每页 fragment 上限仍是 5**（skill 里的排版约定，**不由代码强制**：代码只核对「cue 不超出该页实际 fragment 数」，5 是排版判断）。共享页让这个数字更快撞到（三句 × 每句 2 拍 = 6），所以 skill 里要同时写：共享页按「一页三句、每句两拍」规划版面，超了就说明这几句不该挤在一页。
  - **2026-11-26 取代：上限改为 6**。共享页上一页三句、每句两拍正好到顶，四拍以上才该拆页。理由与改动见 §27，此处按决策日志的规矩保留原文。

### 25.8 已成立但没写进契约的一条：SVG 元素也能当节拍

同一条片子还依赖一个**现有实现已经支持、文档里却没写**的行为：`class="fragment"` 写在 SVG 的 `<g>` 上同样有效。

- `countDeckFragments` 用正则数 `class="fragment"`（`src/teach/rules.ts`；只看标记，注释与 `<script>` 里的字面量不算），`<g>` 会被数到；
- `pageFragments` 按 `<section>` 切分，`<g>` 落在 section 内，算进该页；
- `teachCue(k)` 是 deck 自己的 JS，点亮「当前页前 k 个」，`<g>` 与 `<div>` 一视同仁（SVG 的 `opacity` 同样吃 CSS 类）。

这条让「一页内三张卡依次亮」不必拆三页，是**不改代码就能拿到**的能力。必须写成契约，否则以后有人把正则收紧成「只数 section 的直接子元素」，项目侧会静默坏掉。稳妥的写法是 deck 给每个节拍元素加 `data-beat="k"`，`teachCue(k)` 点亮 `data-beat ≤ k`，不依赖 DOM 顺序。

### 25.9 验收（全部离线，2026-11-25 全部通过）

1. 新 fixture `fixtures/teach/shared-page/`：三句共享一页，`enter: 0 / 1 / 2`。`video_teach_plan` 通过，除一条 page-mode 说明外没有待修项，且不再出现「Give each sentence its own `<section>`」。
2. 渲染该 fixture 后抽帧：fixture 的版面是三块色带，按「亮了几块」断言 0→1 / 1→2 / 2→3，其中第 2 句的首帧必须是 1——等于第 1 句末帧的状态，证明 `enter` 真的在开录前打到位。
3. `rules.ts` 的负例：同页第二句的 fragment 从 1 重新开始 → 拒绝；`enter` ≥ 本句第一个 cue 的 `fragment` → 拒绝；挪页的声明只给一半句子写 → 拒绝；`page` 越界 → 拒绝。
4. 老 fixture（`fixtures/teach/page-mode/`、`fixtures/teach/sample/`）的**句 → 页映射**行为不变（没写 `page` 的段仍是一句一页）：`pnpm test`、`pnpm run build`。page-mode fixture 自身有三处与契约不一致被修掉（节拍元素补 `class="fragment"`、注释里不再出现字面量 `<section>`），所以它现在在 plan 里是干净的，这与「映射行为不变」不冲突。
5. skill 同步：`video-teach-storyboard` 写 `page` / `enter` 与「跨句必然硬切」的事实，`video-teach-slides` 写共享页的 deck 怎么写（`teachPage` 幂等、进页拍由录制器先打到位、不依赖 DOM 残留）。

### 25.10 代价

storyboard 多两个可选键，`rules.ts` 的页面检查、`slides.ts` 一次额外调用与一个选项字段，两份 skill 各一段。换来的是「同一版面承载多句」从「靠固定页码伪装」变成契约里的一等能力，且判断依据（页归属 + 进页拍数）只有稿子一个出处。

### 25.11 和它配套、但不改插件的两件事

同一次片子还暴露了项目侧的两个缺口。它们不需要改插件，写在这里是为了不让读者以为「装了这个提案就都解决了」：

1. **素材真伪没有机器判定**。截图有四种状态（拍到 / 拍不到 / 拍到但与旁白矛盾 / 拍到但不能整图上镜），现在全靠人在 README 表格里记。做法是把它们收进一份 `materials/shots/shots.yaml`（`status` / `crop` / `must_show` / `forbidden`），角标由判定结果生成，而不是由人写。**已单独立文档展开：[`docs/TEACH-MATERIALS.md`](TEACH-MATERIALS.md)**（2026-11-25）：断言在拍摄时对 DOM 做，不在出片后对 PNG 做；`materials/shots/shots.yaml` 与 `storyboard/shots.yaml` 是两个不同的文件。同一份文档还定了 deck 静态资源（图标内联、位图外链）与抽卡参考图（立绘、首尾帧）的落点与台账。
2. **图元被等比缩小到读不清**。库里的图元只按设计宽度画，塞进窄列后整体缩到 0.72，字号跌破 24 px。要在图元上声明最小可用宽度，自检里断言宿主列宽不小于它，不满足就要求重排，而不是缩放。

### 25.12 实现与验证（2026-11-25）

代码（§25.3 的五处改动 + 校验）：

- `src/teach/storyboard.ts`：`Sentence` 加 `page` / `enter`，白名单与非负整数校验，`enter` 无 `page` 拒绝；新增 `pageSlots` / `pageSlotOf` / `pagesUsed`，只算不判（`PageSlot` 同时给出 `page` / `enter` / `lit`，`lit` 是这一句结束时页面亮到第几拍，规则用它判「画面有没有动」）。
- `src/teach/pipeline.ts`：`renderSegments` 用 `pageSlots` 的 `{ page, enter }` 驱动录制器；`planStoryboard` 的页数改成稿件实际用到的页数（共享页比句子少），措辞不再说「一句一页」。
- `src/teach/slides.ts`：`enter` 在切页与 300 ms 等待之间调用 `teachCue`，因此 t=0 就带着进页状态。
- `src/teach/rules.ts`：`pageFindings` 的四类拒绝（见 §25.6：局部声明、页回退、`enter` 不小于首个 cue、`enter` 让画面倒退）。两条 `enter` 相关的拒绝同句最多报一条，且给出的改法都在合法区间内（≥ 上一句留下的拍数、< 首个 cue）；当这个区间为空时直接要求按整页重新编号，`auditDecks` 用同一份 `pageSlots` 做页数核对（越界拒绝、多余页 warning）、「该页 fragment 上限」、「`enter` 不超过该页 fragment 数」、「无 cue 但 `enter > 0` 时必须有 `teachCue`」与「页数数不出来时明说」；`auditManuscript` 另给两条：词级时间戳下「这两个键不生效」的 warning，以及共享页上整句画面不动的那一句记 `silent` 并点名。
- 工具文字：`video_teach_plan` / `video_teach_render` / `video_teach_narrate` 的描述与结论行都不再说「每句一页」，改成「句子的页由稿件给（自己的，或 `page` 共享的）」；plan 的 `rhythm:` 行改用 `pagesUsed`，不再按句数报页数。
- `assets/teach/deck/index.html`：`teachPage` 改成 `Reveal.slide(n, 0, -1)`，注释重写成「开页暗 + 共享页怎么接」（§25.3 的 deck 那一行）。

测试（`pnpm check`：738 passed / 7 skipped，构建通过）：

- `test/teach-storyboard.test.ts`：语法（`page` / `enter`、非负、`enter` 无 `page`）、`pageSlots` 的派生（承接上一句 / 开页为 0）、老 fixture 仍一句一页。
- `test/teach-rules.test.ts`：每类拒绝各一例（局部声明——含「只写自己那一页但没写 `enter`」的负例与「自己那一页 + `enter`」的正例、页回退、`enter` 不小于首个 cue、「倒退且编号重启」只报一条并给出合法区间、`enter` 让画面倒退）；「推荐的修法必须能通过」单独一例；共享页整句无变化被点名；词级时间戳下的无效提示；`auditDecks` 的越界拒绝 / 多余页 warning / 按所在页核对 fragment 上限 / `enter` 超过该页 fragment 数 / 无 cue 但 `enter > 0` 时要求 `teachCue` / 页数与节拍数数不出来时的 warning。
- `test/teach-deck.test.ts`：拿 `writeDeck` 生成的**真实模板 deck** 驱动一遍，断言切页后可见拍数为 0（旧行为是 1，这条测试在旧行为下第一个断言就失败）。
- `test/teach-shared-page.test.ts`：fixture 走 `video_teach_plan`，除一条 page-mode 说明外没有待修项（`rhythm:` 与 `picture:` 两行一并断言，避免结论行和 warning 互相打架）；改坏第二句编号则在花钱前拒绝；**真渲染三句并抽帧**，`litBands` 依次断言 `0→1 / 1→2 / 2→3`，其中第 2 句首帧必须是 1（若 `enter` 打在开录之后，这里会是 0）。
- 顺带修掉四处既有缺陷。前两处是 fixture 与契约不一致：`fixtures/teach/page-mode/` 与新的 shared-page deck 原来只用 `data-beat` 而没写 `class="fragment"`，插件按类名数不到节拍（`pageFragments` 会是 `[0,…]`，plan 报「该页 0 个 fragment」）；deck 注释里出现字面量 `<section>` 会被页分割正则当成一页。第三处是插件自己的模板 deck 切页即点亮第一拍（§25.3 的 deck 那一行），影响的是所有项目，不只是本轮的共享页；第四处是 `deckPageFragments` / `countDeckFragments` 把注释与 `<script>` 里的字面量当成真标记（`markupOnly`，见下段审查记录）。

**独立审查三轮**（每轮都是 0 上下文的新子任务，只给规则、代码与验收口径；后两轮只复核上一轮的修复）。第三轮的阻断项是 `deckPageFragments` 与 `countDeckFragments` 把注释和 `<script>` 里的字面量当成真标记：出厂模板的脚本注释里写着 `<section>`，于是「一页 deck」被数成两页，§25.6 承诺的「声明页不存在→拒绝」在模板 deck 上失效（只降级成一句「page 2 … 有 0 个 fragment」），同时还冒出一条假的「有页永远录不到」告警——而文档明说项目 deck 就是这份模板的副本。改法两层：两个计数函数先剥掉 HTML 注释与 `<script>` / `<style>` 体（`markupOnly`），模板注释也改成不带尖括号的措辞；新增一条单元负例（旧实现下 `[2,1,1,0]`，现在 `[2]`）与一条用 `writeDeck` 生成真 deck 走 plan 的用例。第三轮另外修的：skill 承诺「独立成页也能写 `enter > 0`」但代码要求整段都写 `page`（把局部声明规则收窄成「只有**挪页**的声明才要求整段都写」，并为这个能力补了用例）；`enter` 倒退与 `enter`≥首个 cue 在同一个句子上叠报两条、两条给的改法互相矛盾（合并成一条）；§25.3 标题「三个改动点」与表内 5 行不符、正文按序号指代还会随行序漂（改成按名字指）；计数类表述从 §25.6、skill 与 `TODO.md` 里删掉，改成「类型列就是判据」；`enter`/`teachCue` 两条消息把「独立成页」说成「共享页」；`docs/TEACH-PARALLEL-ACTS.md` 与 §25.7 的指针/约定标注。

第三轮修复由同一个审查者复核时，又找出三处**修复本身的问题**，值得单独记一笔，因为都是「改法没经过自己的校验」这一类：① 上一段合并出来的消息里，「或写至少 M」这条出路在 `首个 cue ≤ 上一句留下的拍数` 时会被下一条规则反过来拒绝——现在判据改成「有没有合法区间」，区间为空就直接要求重新编号，并加了一条「推荐的修法必须能通过」的用例（先断言坏稿被拒，再把消息里说的改法写出来断言通过）；② 局部声明放宽成「声明等于自己下标」时，**没写 `enter`** 的空声明也被放过了（那正是「想共享第 0 页」的初手写法，上一轮还会被拒），现在放宽只覆盖「自己那一页 + `enter`」，负例补上；③ `auditDecks` 的越界检查还按「段里有人写过 `page`」触发，于是独立成页的合法声明会让**没声明过页**的那一句被拒绝，现在按「段里有句子挪页」触发，其余退回原有的句数 warning。另外补了一条 cue 模式下「节拍数数不出来」的 warning（此前会静默跳过，与本仓库「未知必须显式」冲突）。

第一轮的阻断项一条：模板 deck 的 `teachPage` 在切页时就点亮第一拍，每页第一条 cue 因此永远不生效、`enter: 0` 无法兑现。这是本轮唯一一条只在真机上看得见的错误，fixture deck 的 `teachCue` 是幂等 setter 而不是 `nextFragment` 循环，所以端到端测试看不见它。修法见 §25.3 的 deck 那一行，并新增 `test/teach-deck.test.ts` 拿真实模板 deck 驱动一遍（旧行为下第一个断言就失败，已实测）。

第一轮另外 11 条：plan 的 `rhythm:` 行仍按句数报页数、并与同一条消息里的 warning 打架（已改用 `pagesUsed`，测试直接断言那两行原文）；文档头部仍写「§25 未实现」；`enter` 让画面倒退无人管（新增第五条拒绝）；共享页上「这句没有 cue 也不算缺陷」的豁免已不成立（新增 silent 规则）；`teachCue` 缺失要到录制才报，而那时旁白已付过钱（改在 plan 拒绝）；页数数不出来时静默跳过（改 warning）；`video_teach_narrate` 的结论行仍说「每句一页」；模板 deck 的三段注释与新行为相反；三处代码行号指针过期（改成函数名，不再引行号）；三处「零 findings」说过头（改成「除一条 page-mode 说明外无待修项」）；验收记录里的测试数比实跑少一个（改成 731 passed / 7 skipped）。

第二轮修的是回写口径：§25.6 的标题计数与表内行数不符（第三轮干脆把计数删掉，改成「类型列就是判据」）、§25.12 与 `DESIGN.md` 仍写「四条拒绝」、§25.2 与 skill 的「两种写法等价」与新增的「可以写更大的 `enter`」互相矛盾、`-1` 修复对已建项目意味着什么没写（老 deck 不自动修，手改一行后只重渲，`video-teach-iterate` 已补一条坑）、slides skill 把「第一条 cue 空转」写成了「每条 cue 都晚一步」、共享页逐句点名与「连续两句无变化」成对 warning 重复（成对警告改为只在 cue 模式报）、「页数数不出来」只写在 docs 而 skill 没提（两份 skill 各补一句）、开页句写 `enter > 0` 代码允许但没文档（skill 补一句）。

## 26. 两种曾经漏交的产物：烧入字幕与封面（2026-11-25 补齐）

### 26.1 现状：六种齐全

§2 的目标交付物是六项，§9 的 M4 验收写「六种产物齐全」。2026-11-25 之前实际只交付四种，两项缺口在本轮补齐：

| 产物 | 谁产出 | 状态 |
|---|---|---|
| 16:9 1080p mp4 | `video_teach_render`（`pipeline.ts` → `ffmpeg.ts` 的 CFR / concat / 混音） | ✅ |
| 外部 SRT | `video_teach_export`（`buildSrt`，`src/teach/subtitles.ts`） | ✅ |
| 可交互 HTML deck | `video_teach_export`（把 `segment.deck` 抄进 `deck/<段>/`） | ✅ |
| 时间轴 JSON | `video_teach_export`（`vNNN.timeline.json`） | ✅ |
| **烧入字幕** | `video_teach_render` 的 assemble 阶段（`muxNarration` 加 `subtitles=` 滤镜链） | ✅ 2026-11-25 |
| **封面 16:9 / 4:3** | `video_teach_export`（`src/teach/cover.ts`，`meta.cover` 声明时） | ✅ 2026-11-25 |

### 26.2 怎么补的（决策与实现）

**烧字幕。** assemble 时给混流加一条 `-vf subtitles=burn.srt:force_style='…'`（`src/teach/ffmpeg.ts` 的 `muxNarration`）。三处细节：

- SRT 是 `buildSrt(timings)` 在 assemble 当场写进 `.dsh-video/teach/burn.srt` 的，和 `video_teach_export` 写出的外部 `.srt` 是**同一个函数的同一段文本**，所以画面里的字和平台读到的字不会差一条 cue。
- 滤镜拿的是**文件名**而不是绝对路径，进程的 `cwd` 设成那个目录：ffmpeg 的滤镜链转义把路径里的冒号或引号变成解析错误，绕开比转义稳。
- 烧字幕必须重编码视频（滤镜不能作用在 copy 的帧上），所以这一条路径是 `libx264 -preset veryfast -crf 18`，与分段编码同一组参数；不烧时仍然 `-c:v copy`。

**前提的实测（本轮最花时间的部分）。** `docs` 原文写着「本机 ffmpeg 是否带 libass 没有实测过」，实测结果是**不带**：`ffmpeg 9.0.2_1`（Homebrew 现在的精简公式，11 个依赖）里 `ffmpeg -filters | grep subtitles` 为 0，`-h filter=subtitles` 直接报 `Unknown filter`，`drawtext` 也没有（没有 freetype/fontconfig）。替代品是 core 里的 `ffmpeg-full`（47 个依赖，含 libass / freetype / fontconfig），装完 `subtitles`、`ass`、`drawtext` 都在，但它是 **keg-only**：`/opt/homebrew/opt/ffmpeg-full/bin`，不进 PATH。

因此新增一条设置 `teachFfmpegBinPath`（目录，内含 `ffmpeg` 与 `ffprobe`；空则 `TEACH_FFMPEG_BIN`，再 PATH 查找），和既有的 `pythonPath` / `texBinPath` / `chromiumPath` 同一套解析顺序。依赖探测多一项 `probeFilter('subtitles')`：

- 缺 libass **不阻塞渲染**（旁白已经付费，拒绝只会让人花两次钱），但 assemble 时明确不烧，并把原因写进结果的 `subtitles` 字段与消息；`video_teach_plan` 提前警告一次，附上装什么的提示。
- 探测与实际烧录用的是**同一个** ffmpeg（`mediaTools(paths)` 一处解析），不会出现「探测说有、烧录说没有」。

**封面。** 结论：封面是**作者写的一页 HTML**，不是成片首帧，也不是 deck 首页。两条便宜路都不成立——首帧通常是半句话加动画中途，缩到 300 px 宽读不出任何东西；deck 首页是幻灯片，不是海报。所以：

- 稿件新增 `meta.cover`（工作区相对路径，通常 `cover/index.html`）。缺省时 `video_teach_export` **不出封面**并在消息里说明，不拿首帧顶替（`TODO.md` A2 里「要先定构图规则，否则每支片子都要人挑」的答案是：封面本来就要人设计，自动挑帧只能挑到"不那么难看的一帧"）。
- 出两种画幅：16:9 = 1920×1080，4:3 = 1440×1080（等高，只改宽，作者用一个 media query 就能同时适配）。用与录屏同一个 Chromium（`src/teach/slides.ts` 的 `playwright-core`），每种画幅一个独立 context，因为视口是 context 属性、改视口会留旧布局。
- 页面契约比 deck 轻：没有 `teachReady` / `teachCue`，等 `document.fonts.ready` 加 150 ms 稳定后截图；截完数一次颜色，纯色直接报错（说明样式没加载、脚本报错，或版面只在 16:9 下存在）。
- 产物落在成片旁边、同版本号：`vNNN.cover-16x9.png`、`vNNN.cover-4x3.png`，所以重渲一支新片不会覆盖旧片的封面，导出旧版本时也不会串号。

### 26.3 实测数字（2026-11-25）

字号是 ASS 单位：libass 按 PlayResY 缩放到画幅，而 ffmpeg 把 SRT 转 ASS 时用的是 288 高的画布，所以 1080p 下每个单位 ×3.75。

| 参数 | 值 | 依据 |
|---|---|---|
| `fontSize` | 18（≈67 px 行高） | 1080p 下占画面 5.8%，与常见平台字幕同档 |
| `marginV` | 12（≈45 px 离底边） | 与下沿留白，且不压 §17 建议的安全区 |
| `outline` | 1.5 | 2.5 在这个字号下把中文细笔画吃掉（已对比过 1 / 1.5 / 2） |

- 单行字幕：字形占 **行 969–1032**（63 px 高），落在承诺的 900–1080 带内。
- 45 字长句自动折两行：**行 911–1023**，仍在带内；出现第三行时块顶会越过 900，而 §17 的「一句 ≤8 秒 / ≈32 字」预算已经排除这种句子。
- 封面：`probe` 复核为 1920×1080 与 1440×1080，纯色自检通过（同一页在两种画幅下都画出了东西）。
- 字体：`PingFang SC`，fontconfig 在本机解析到 Hiragino Sans GB，中文与拉丁字形都正确；`TEACH_SUBTITLE_FONT` 可覆盖。

**端到端证据**：两份测试，一份一件产物 —— `test/teach-burn.test.ts`（需要带 libass 的 ffmpeg：`TEACH_FFMPEG_BIN=/opt/homebrew/opt/ffmpeg-full/bin pnpm test`）与 `test/teach-cover.test.ts`（需要一个能启动的 Chromium）。

- 烧字幕（`teach-burn.test.ts`）：解帧数暗像素，断言只出现在行 900–1080，且两句的字形列范围不同（证明不是冻结帧）；`burn_subtitles: false` 时整帧无暗像素，结果的 `subtitles` 写明「not burned」。
- 封面（`teach-cover.test.ts`）：两张封面的尺寸、外部 SRT 的文本与烧入的一致；没声明 `meta.cover` 时 `covers` 为空且消息说明，不拿首帧顶替。

### 26.4 运维提醒

- **本机现状（2026-11-25 装完后实测）**：`/opt/homebrew/bin/ffmpeg` 与 `ffprobe` 现在都指向 `Cellar/ffmpeg-full/9.1`（`ffmpeg -version` = 9.1，`subtitles` 滤镜在位），所以默认 PATH 就能烧，不用改设置。原来的 9.0.2 keg 还在（`Cellar/ffmpeg/9.0.2_1`），`brew unlink ffmpeg-full && brew link ffmpeg` 可以退回；退回后要么接受不烧，要么把设置里的 ffmpeg 目录指到 `/opt/homebrew/opt/ffmpeg-full/bin`（或导出 `TEACH_FFMPEG_BIN`）。
- 设置项留着是为了**别的机器**：PATH 上不是带 libass 的构建、或不想改系统链接时，指一个目录即可。指向不存在的目录会报 `missing (no ffmpeg in …)`，不会静默回退到 PATH。
- 不指也不出错：plan 警告、render 的 `subtitles` 写「not burned: …」、外部 SRT 照旧产出。
- **改台词后只跑 export 会让两种字幕分叉**：烧进画面的字幕在 assemble 时生成，export 只写外部 SRT。改了旁白要重跑 `narrate → render`，或者接受「画面里是旧字幕、文件是新字幕」。
- 换封面页不需要重渲视频：`video_teach_export` 会按当前 `meta.cover` 重出两张 PNG，文件名跟着最新版本号走。

### 26.5 为什么这两项曾经一直漏着

因为**没有任何验证路径覆盖过产物清单**：

- 离线测试断言的是 `srt` / `timeline` / `decks` 三个返回键与它们的内容，不检查「还应该有封面」；
- live 样片验收看的是 mp4 的时长、音画对齐与段数（§16.3），产物表里没有这两项就不在检查范围内；
- `README.zh-CN.md` 的产物描述（第 141 行）只写「成片在 `renders/<镜头>/vNNN.mp4`，旁边 `vNNN.json`」：SRT / deck / 时间轴 JSON 都没列，更不会提醒还缺两项。

于是「M4 完成」是从**执行记录**推出来的（工具有了、SRT 有了），不是从**产物清单**核出来的。这两件事在别的里程碑上刚好重合，在这里不重合，就漏了。补齐时把这条也补上了：`test/teach-burn.test.ts` 与 `test/teach-cover.test.ts` 是**对产物清单**的断言（画面里有没有字、字在哪、两张封面多大），不是对返回键的断言。

教训写在这里：**里程碑收尾时逐项对产物清单，而不是对「工具都实现了吗」**。工具在、清单缺一项，是最容易被执行记录掩盖的失败。

## 27. 三条口径：上限 6、cue 模式多页、改台词只重录一句（2026-11-26）

一次对 9 份 skill 正文的交叉审查（清单与逐条理由见 [`SKILL-CONSISTENCY.md`](SKILL-CONSISTENCY.md)）在文档之间找出 29 处互相矛盾的说法。其中三处不是措辞问题，要由用户定口径，定完连代码一起改：

1. **每页 fragment 上限 5 → 6**。共享页上"三句各两拍"正好撞线：旧口径一处说 6 已超限、该拆页，另一处把同一配置叫常态。上限取 6，两处都改成"三句两拍正好到顶"。这条一直是**约定、不由代码强制**（`rules.ts` 没有这个检查），所以只改文案。
2. **cue 模式允许多页**。旧文案一处写"全片只有一页"、一处写"一个或少数几页"，而录制器根本不切页：`page.goto` 之后它只按 `teachCue` 推拍，deck 永远停在第 0 页，多页 deck 的第 2 页起永远录不到，plan 也不报。改法是让 cue 模式的编号语义落地：稿件里的 fragment 号**全片递增**（原本就是这个约定），录制器用 deck 自己的每页 fragment 数把它翻成"第几页第几拍"（`cueLandings()`）。开录的状态由**稿件**决定：`cueStartFragments()` 给出每句开录时已经亮到第几拍，有 cue 的句子开在自己第一个 cue 之前，没有 cue 的句子开在故事走到的那个画面（页 + 拍）。句内跨页的拍在那一拍翻页。顺带修掉一个同源的既有缺陷：每句都是一次新的 `page.goto`，旧行为下第 9 句的第一个 cue 会把前 8 个拍**一次性点亮**，现在开录前它们已经亮着。

`teachPage` 只在**真要翻页**时才要求：单页的 cue deck 仍然只需要 `teachReady` + `teachCue`（第一版实现一律走"先切页再点灯"，把这类 deck 从第二句起全打断了，独立复核抓到后拆成 `turnPage()` 与 `lightBeats()`）。
   - 新增一条结构性拒绝：**多页的 cue 模式 deck 必须定义 `teachPage`**（`auditDecks`），否则要等到钱花完才发现翻不了页。
   - `meta.transition` 在 cue 模式下**仍然拒绝**，但理由换成真的那个：页由节拍推出、`exitSlots` 在稿件层算不出转场要落到的初态，不是"没有页驱"。（2026-11-26 起这条不再成立：落点可由 `cueOpening()` 算出，见 §28.5。原文保留供对照。）
3. **改台词只重录一句**。返工矩阵原来把"改 `say`"写成全量重录，与"默认 provider 逐句请求""`sentences` 可只重录指定句"两处相反。口径是：没补过页尾停留时 `narrate sentences:[<id>]` 只重合成那一句，成片重新生成；补过停留的项目仍要全量（已补的静音会被再补一次）。

配套三条 warning（都在花钱前）：没有 fragment 的页在 cue 模式下永远走不到、页数数不出来时 `teachPage` 无从核对、纵向栈让两份页数算法不一致。

验证：`test/teach-cue-pages.test.ts`（5 条换算 + 3 条开录状态 + 4 条真录制：首 cue 定页、句内跨页并断言末帧自检 `finished`、无 cue 句继承、单页 deck 不定义 `teachPage` 也能录）、`test/teach-rules.test.ts` 的"多页 cue deck 要 teachPage"、`test/teach-exit.test.ts` 的 page 模式负对照。无能力的机器上真录制那几条按既有约定跳过（CI 没有 Chromium、ffmpeg、ffprobe）。完整复核记录见 [`SKILL-CONSISTENCY.md`](SKILL-CONSISTENCY.md) §八。

## 28. 两版能力样片：DeepSeek 页模式与火山纯 cue 模式（2026-11-26）

用户的要求是「用现在的项目技能和代码做一支 teach 路线的视频，包含页内动画、转场、Manim 动画等现有能力包含的所有内容，DeepSeek TTS 与 ark TTS 各一版」。`demo/motion`、`demo/transition`、`demo/contract` 各自只演示一项能力，没有一支片子同时跑过页内动效库、共享页、跨句转场、`engine: manim`、封面与六种产物，所以新开 `demo/showcase/`。

### 28.1 结构：一份内容，两个稿本

同一批 deck（`slides/s01…s06`）、同两个 Manim 场景、同一张封面，两份稿本只差旁白与驱动模式：

| 段 | 引擎 | 句数 | 演示什么 |
|---|---|---|---|
| s01 | slides × 6 页 | 6 | 页内动效库：`fade-up` / `dim` / `beat`（`custom` 聚焦）/ `draw` / `count` / `bar` |
| s02 | slides × 3 页 | 3 | 跨页 Auto-Animate 一次（520 ms 尾转场）+ 一条 `transition: none` 的硬切对照 |
| s03 | slides × 1 页 | 2 | 共享页 `page` / `enter`，同一元素 `data-teach-stage` 连续变形 |
| s04 | manim | 1 | 公式推导（`MathTex` 逐行长出来） |
| s05 | manim | 1 | 坐标系连续动画（部分和逼近 π²/6） |
| s06 | slides × 2 页 | 2 | 封面两画幅、产物清单 |

成片：`renders/showcase-deepseek/v003.mp4`（15 句 / 107.3 s）、`renders/showcase-ark/v003.mp4`（15 句 / 105.8 s）。

### 28.2 两个 provider 分歧的三处，都写进了稿本注释

1. **转场只有页模式能拍**。`meta.transition` 在 cue 模式被拒（§27 第 2 条），所以 ark 版 15 句全是硬切，deepseek 版 7 处尾转场共 3 640 ms。
2. **共享页只有页模式能声明**。ark 版不写 `page` / `enter`，靠 `cueStartFragments()` 表达"接着上一句"：开录前把本句第一个 cue 之前的拍点亮，画面看起来一样，机制不同。
3. **SRT 的切分不同**。deepseek 一句一条 cue；ark 按词切（`v003.srt` 24 条 vs 15 条）。

音色差异有客观证据：同一句在成片里的中位基频，DeepSeek `tide` 约 96 Hz（10–90 分位 79–139），火山 `zh_female_liuchangnv_uranus_bigtts` 约 235 Hz（170–348）。

### 28.3 尾停留与节拍重算：`demo/showcase/hold.py` 与 `cues.py`

插件没有尾停留参数，做法按 `video-teach-iterate` 的「页尾停留」：给每句音频尾部补 900 ms 静默、用 `ffprobe` **实测**改写 `durationMs`、再按页内变化次数重算 `at_progress`。两个脚本把三条硬约束落成断言：

- `timings.json` 是白名单，不留 `tailHoldMs`，"补过没有"记在 `.page-hold.json` 的 sha256 上（不用 mtime）；
- 补静音前逐句核对"音频实测长度 vs `durationMs`"，不一致就拒绝——那说明只重录了一部分，再补会叠加第二遍静音；
- cues 用公式算而不是手写：`at_progress(k) = (k/(m+1) × spoken) / durationMs`，实测落在 0.285–0.593，尾停留 900 ms 的分母已经含在里面。

### 28.4 这一轮发现并修掉的两个缺陷

**一、合并合成的词级时间戳没有换算成句内偏移（默认路径上的功能级缺陷）。** `merge: auto`（默认）把相邻句一次请求发出，服务端按整段音频报时间戳；`segmentTiming()` 把每句切出来存成 `audio/<id>.mp3`，但写进 `timings.json` 的 `words` 仍是整段的绝对偏移。后果两条：`video_teach_render` 在解析阶段就拒绝（`timings.sentences[1].words ends at 12715 ms, past the audio's 7464 ms`），即便放过，`cueOffsetMs()` 会把 `at_word` 当成句内偏移，纯 cue 模式每一拍都晚一整段。改法：`pipeline.ts` 新增 `rebaseWords(words, startMs)`，合并路径写盘前减掉切片起点。已花的合成费不重花——数据侧用 `demo/showcase/words.py` 就地换算（断言换算后每句首个词为 0、末词不晚于该句 `durationMs`）。

**二、导出的 deck 打不开。** `video_teach_export` 把 deck **文件**拷到 `deck/<段 id>`：没有扩展名，浏览器当纯文本；`./reveal.js`、`./reveal.css`、`./theme.css` 也没跟过去。实测：headless Chromium 打开 `deck/s03`，`innerText` 就是 `<!doctype html>…` 源码，`window.Reveal` 不存在。改法：deck 写成 `deck/<段 id>/index.html`，并用 `localDeckAssets()` 把 HTML 里 `./名字` 形式的同目录文件一并拷过去。

验证：`test/teach-narration.test.ts` 新增两条（换算结果、单句请求不变且不产生零长词）；`test/teach-tools.test.ts` 新增两条（真走 `video_teach_export`：`decks` 为 `deck/s01/index.html` 且 `reveal.js`/`reveal.css` 已落盘；`localDeckAssets` 只收同目录引用）。`pnpm run build` 通过，`pnpm test` 782 passed / 7 skipped（含新增 4 条）。

**未验证的部分说清楚**：这两处修复都还没有在宿主内跑过一次完整链路——当前 3080 那个实例加载的是修复前的构建，合成本身是付费且要联网的，所以 `merge: auto` 的新路径只有单测证据；导出 deck 的新形状有端到端导出测试（离线、真实代码路径），但"重启宿主后重跑 export 才看得到"这件事没有在本实例上发生过。

### 28.5 补记（同日）：两处推翻上文

**一、句子被切错，根因不是合并、也不是上文第 28.4 条那个换算。** 用户听完说"volcengine 的音频有问题，大概是句子拆分"。查下去是第三个缺陷，比前两个都严重：

`assignWordsToSpans()` 用**字符游标**把服务端返回的词分配到各句：每读一个词，游标前进 `word.t.length`。但服务端返回的词**不含空白**，而发给它的文本含空白（本片里是 `交给 Manim 画`、`演示的 deck` 这样的三处空格）。于是游标每遇一个空格就少走一格，从句子里第一个空格所在的那句起，后面每句的边界都错位：前一句的音频尾巴粘上了后一句的开头两个字，而后一句丢了开头——实测 15 句里 4 句错，其中 `s05-1` 的开头"曲线"被整段切掉（`s04-1` 的音频里能听到"…一句。曲线"）。

改法：`joinUtterance()` 与 `assignWordsToSpans()` 统一按**非空白字符**计数（`spokenLength()`），并补一条回归用例（带空格的两句，断言第一句恰好 12 个词、第二句第一个词归第二句）。这只影响词到句的映射，不改音频本身。

**同时这说明了合并路径的整体状态**：`merge: auto` 上有两个独立缺陷（§28.4 的绝对偏移、本节的空白漂移），其中任何一个都会切错句子。渲染器会拒绝绝对偏移那种（`words ends past the audio`），但**空白漂移不报错**——它只是安静地切错。所以这一版先按 `merge: none` 重录了火山那条（15 次请求，逐句独立），每句的词拼起来必须等于该句 `say`（去掉空白），15 句全部通过；成片里每句开头的静音 62–102 ms 与源文件一致，没有切掉起音。修复落地后想回到合并合成的韵律连续性，重跑一次 `video_teach_narrate`（默认）。这条路径已经用 `test/teach-live.test.ts` 的 `M2b` 在真实服务上验过（2026-11-26，`TEACH_VIDEO_LIVE=1`，一次合并请求两句、稿件里故意带空格）：每句的词拼起来等于该句 `say`（去空白）、每句首个词在 0、末词不越过该句音频长度。离线侧另有 `assignWordsToSpans` / `rebaseWords` 的单测。

**二、`meta.transition` 在 cue 模式下不再拒绝，转场真的能拍了**（推翻 §27 第 2 条与 §26 之前的口径）。当初拒绝的理由是"那一句的页由它自己的节拍推出来，稿件层不知道落点"——这个理由在 §27 实现的 `cueLandings()` 之后就不成立了：给定 deck 的每页 fragment 数，第 n 号节拍落在第几页第几拍是算得出来的，而"下一句开口时的页与拍"正是 `cueOpening()`。所以：

- `exitSlots(board, mode, pageFragments?)` 里 cue 模式不再一律 `dropped: 'cue-mode'`，而是算出 `target = { page, enter }`，用的是录制器会落到的那一页、那一拍（两侧同一个函数）。
- 落点与这一句**结束时**所在页相同则仍是硬切（`same-page`）：没有页可翻，尾巴只会把下一句的开头状态提前抖出来。
- 唯一还算"拍不了"的情形是 deck 的页数数不出来（`<section>` 在 JS 里生成）：那时 `video_teach_plan` 给一条 warning 说明这些接缝保持硬切，不再拒绝整份稿件。
- 每页 fragment 数由 `pipeline.ts` 的 `deckPageCounts()` 读（narrate 与 render 共用），plan 那份直接复用 `inspectDecks()` 已经读到的 `DeckInfo.pageFragments`。
- `cueLandings()` / `cueOpening()` 从 `slides.ts` 挪进新模块 `src/teach/beats.ts`：`storyboard.ts` 是每个离线测试都会加载的模块，不能为了一个纯计算把 `playwright-core` 拖进来。

验证：`test/teach-exit.test.ts` 新增两条（cue 模式下带页数的落点、页数缺失时的 `cue-mode` 丢弃与 warning），并把原来那条"cue 模式拒绝"的用例改成"接受 + 只在数不出页数时 warning"；`test/teach-narration.test.ts` 新增空白漂移用例。

**还没发生的事**：这两处改动都在 `lib/` 里，而 3080 那个实例加载的仍是改动前的构建（用 `video_teach_plan` 探过：它还在报"meta.transition is set, but … cue mode"）。所以 `renders/showcase-ark/v005.mp4` 的音频已经是对的（重录于 `merge: none`），但**接缝还是硬切**；宿主重启后重跑 `video_teach_render` + `video_teach_export` 才会把稿件里那 520 ms 尾转场录进去（旁白不用重录）。

### 28.6 补记二：cue 模式转场真跑起来之后，又抓到一个（2026-11-26 晚）

宿主还没重启（进程起于 10:25，改动构建于 11:41），所以这一段是**直接调 `src/teach/pipeline.ts` 里 `video_teach_render` 实际使用的同一批函数**跑出来的：`renderSegments` → `planSegments` → `assembleVideo`，参数照工具那几行抄。目的不是绕开工具，是在等重启的时候先把"cue 模式到底能不能拍出转场"这件事验掉。

**抓到的缺陷：cue 模式下"末帧是否播完"的自检永远看错页。** 录制带尾转场的段之后，`finishedLayout()` 要回到**正文所在那一页**把最后一拍的版面复现出来做对比。页模式知道那是第几页（`pageSlots`），cue 模式的页要由节拍推出——而它用了 `options.page ?? 0`，cue 模式根本没有这个字段，于是每次都回第 0 页复现、再和正文最后一帧比：凡是不在第 0 页的正文字段都被判成"被动画切断了"。实测 `s01-2`…`s01-5` 各报 5.5–7.8%（阈值 0.2%），看着像节拍太迟，其实节拍余量都在 2.6 s 以上。改法：`finishedLayout()` 多收一个 `finalPage`，cue 模式传最后一拍落地的页（`landings.at(-1).page`）。回归用例加在 `test/teach-cue-pages.test.ts`（正文落在第 2 页、尾部翻回第 1 页，断言 `settle.status === 'finished'` 且尾部画面确实换了页），并用**负对照**跑过：把 `finalPage` 退回 `null` 时这条用例失败，恢复后通过。

**验证（`renders/showcase-ark/v007.mp4`，105.6 s）**：

| 项 | 结果 |
|---|---|
| 时间轴 | 7 处 `exitMs = 520`，合计 3 640 ms；`sum(durationMs + exitMs) = 105 546 ms`，成片 105.6 s |
| 8 处接缝抽查（正文最后一刻 / 尾部最后一刻 / 下一句第一帧） | 7 处尾转场：正文→尾部画面确实翻了页（1.4%–11.4%，`s02-1` 是 Auto-Animate 形变 11.4%），尾部最后一帧与下一句第一帧差 **0.00%–0.40%**（接缝连续）；`s02-2` 那句`transition: none` 仍是硬切 |
| 旁白没动 | 中位基频 231.9 Hz（火山音色）；15 句句首静音 62–102 ms，没有一句被切掉起音 |
| 导出物 | `v007.srt`（31 条按词切）· `v007.timeline.json` · 两张封面 · `deck/<段>/index.html` |

顺带把之前那个"导出 deck 打不开"的修复也验实了：`deck/s03/index.html` 在 headless Chromium 里 `window.Reveal` 存在、`teachReady === true`、标题读得到（改之前是纯文本源码）。

**补记三（同日 12:06 宿主重启后，工具路径跑通）**：`video_teach_render` + `video_teach_export` 各跑一次，得到 `renders/showcase-ark/v008.mp4`（105 600 ms，台账行 `v-20261126-0009`，右侧面板可列）。产物与上面那份脚本渲的 v007 **同内容**（四个时间点抽帧差 0.00%–0.45%），说明这条链路与工具走的确实是同一份代码。逐项复核：

- 时间轴：7 处 `exitMs = 520`（`s01-1…s01-5`、`s02-1`、`s06-1`），`sum(durationMs) = 101 906 ms` + `3 640 ms` = `105 546 ms`；
- 8 处接缝（7 转场 + `s02-2` 硬切）：尾部翻页 1.4%–11.4%（`s02-1` 形变 11.4%），尾部最后一帧与下一句第一帧差 **0.00%–0.40%**；`s02-2 → s02-3` 在 50 ms 内跳变 11.7%，没有渐变；
- 旁白：15 句句首静音 62–102 ms（无一句被切），中位基频 231.9 Hz；整片解码零错误；
- 导出 deck：`deck/{s01,s02,s03,s06}/index.html` 四个都在 headless Chromium 里 `window.Reveal` 存在、`teachReady === true`、页数 6/3/1/2 与稿件一致，没有加载失败的资源。

## 29. 第三种画面契约：单文件母带 + 连续录制（2026-11-26 起）

用户听完火山版后提出两点：语音一致性不好（那是 `merge: none` 的临时状态，默认合并已修好，实测逐句中位基频离散从 9.87% 降到 5.03%），以及**不要再把母带逐句切开**——一次请求生成全文，然后按词时间点对轨做 slide 录制。DeepSeek 那条路（分句合成、分句录制）保持原样。

### 29.1 契约

`timings.json` 多了一个根键，两种时钟二选一（`parseTimings` 拒绝同时出现）：

```jsonc
{
  "narration": "audio/narration.mp3",   // 母带：整片一条音轨
  "merge": "single",
  "voice": { "provider": "volcengine", "speaker": "…", "timestamps": "word" },
  "sentences": [
    { "id": "s01-1", "text": "…", "beginMs": 0, "durationMs": 6987, "exitMs": 0,
      "words": [{ "t": "幻", "b": 0, "e": 125 }] }   // 词时间仍相对本句
  ]
}
```

- **词时间与 cue 偏移仍相对本句**，所以所有既有的 timing 代码不动；`beginMs` 是把它们变成绝对时间的那一个数（字幕、连续录制、混音校验各自取用）。
- **span 首尾相接**：span 0 从 0 开始，span i 结束在 span i+1 开始处，最后一段一直延伸到母带末尾。因此画面总长**恰好**等于母带长度，混音不需要任何补静音。
- **`exitMs` 恒为 0**：没有接缝，就没有尾转场可放。`renderSegments` 在母带模式下强制归零并把 `dropped` 记成 `continuous`；`video_teach_plan` 的 `transitions:` 行会说清"这条片子没有接缝，删掉 meta.transition 或改用 `merge: none`"。

### 29.2 为什么这条形状值得单开一节

裁一个句子 = 猜它什么时候说完。2026-11-26 一天里两个静默缺陷都长在这个"猜"上：绝对偏移没换算（§28.4）、服务端丢空白导致游标漂移（§28.5）。母带形状**根本不做这个猜测**：音频整条保留，画面按绝对时间贴上去。实测（`renders/showcase-ark/v010.mp4`，91.9 s）：

| 项 | 结果 |
|---|---|
| 请求数 | 1（整片一次） |
| 母带 | `audio/narration.mp3`，91 992 ms；15 段 span 首尾相接、合计 91 992 ms |
| 成片音轨 vs 母带包络相关 | **0.9999**（同一段，没有被切、没有补静音） |
| 成片时长 vs 时间轴 | 91 992 vs 91 992 ms（差 0） |
| 字幕 | 按 `beginMs` 绝对定位，不再靠累加 |

### 29.3 录制也变成"一段一次"（同日晚补齐）

这一节落地的是**音频侧**：`narrate` 一次请求写母带、`assembleVideo` 直接混母带、`buildSrt` 走绝对时间、母带模式禁掉接缝。画面侧**仍然逐句录**（每句一次 `page.goto`），所以句子之间的换页发生在开录之前、录不到，观感是硬切——这正是用户要的下一步：一个段一次 screencast，deck 不重载，跨句天然连续。

设计已经定下（写在这里以免下一轮重新推）：`recordDeckSegment` 增加一个可选的已打开会话（page + 已读到的每页 fragment 数），跳过 `page.goto` 与开录前的驱页；连续模式开录前**不重放 `page` / `enter` / `teachCue(enter)`**——上一句的节拍已经留下状态，全局递增的编号让"接着来"是免费的。新函数 `recordDeckRun` 一个段开一次会话，逐句开停 screencast、各存各的段文件，这样 `planSegments` 的逐句返工、`only` 收窄、逐句末帧自检全部保留。迟到节拍的重录只能整段重来（重录单句会与前一帧的版面差几像素），这是这条路的代价，要写进 skill。

TTS 成本：一次请求（整片），比 `merge: none` 便宜，也比"逐句独立合成"更连贯。

**已落地**（`renders/showcase-ark/v011.mp4`，91.99 s）：新函数 `recordDeckRun()`（`src/teach/slides.ts`）一个 slides 段开一次浏览器会话，逐句开停 screencast、各存各的段文件；`renderSegments` 在母带模式下按段分组调用它，段内的 `page` / `enter` / `exitMs` 全部不出现——节拍编号本来就跨全段递增，上一句留下的状态就是下一句的开场，翻页发生在它该发生的那个节拍上、被录进画面。

逐缝核对（相邻段文件、320×180 灰度）：

| 接缝 | 类型 | 末帧 vs 下一句首帧 |
|---|---|---|
| s01-1…s01-6 之间（5 处） | 段内连续 | **0.01–0.02%** |
| s02-1…s02-3、s03-1→s03-2、s06-1→s06-2 | 段内连续 | **0.00–0.01%** |
| s01-6→s02-1、s02-3→s03-1 | 段间（换 deck） | 6.77% / 4.04%（该切就切） |

段的内部还能看到翻页本身：s01-1 的页在 s01-2 的第一个节拍处交叉淡入（相邻帧差 8% 量级），不再是"开录前偷偷换页"。

代价与边界，写进注释也写在这里：

- **迟到节拍只能整段重录**。重录单句要在新页面里把 deck 驱回它的开场状态，reveal 在换页时才排版，那一帧与上一句留下的能差几像素——所以 `renderSegments` 在任一句迟到时把整个段重录一次（本片 0 次）。
- **`sentences: [...]` 收窄在母带模式下扩到整段**并如实报告多录的句 id（半段重录会在全新 deck 上从故事中间开始）。
- **段与段之间仍是硬切**：另一个 deck 的初态拿不到，这条与非目标一样，不会变。
- **两处实现是有意重复的**：`recordDeckRun` 与 `recordDeckSegment` 各自管一种生命周期（连续 vs 逐句），page 模式与逐句 cue 契约不能被这次改造带回归。

### 29.4 换页时机：字幕在句首就切了，画面却等到第一个节拍的词（2026-11-26 晚）

用户看完 v011 说"前半截换页有半秒到一秒的延迟，拿画面和字幕一比就看出来了"。查下来不是录制延迟，也不是气口——是两个时钟的顺序问题：

1. **字幕**在句子的**第一个字**就切到新句（母带契约下 span 起点就落在第一个词上，`beginMs` 即字幕起点）。
2. **翻页**却在第**一个 `at_word` 的词**才发生——因为 cue 模式一直把"这一句在哪一页"当成"它第一个节拍落在哪一页"。

实测这一差值就是那个词的偏移：本片 13 句里 645 / 440 / 295 / 1010 / 290 / 170 / 790 / 520 / 1390 / 1420 / 2774 / 2110 / 0 ms。观众看到的是"字幕已经换句，画面还停在上一页"。

**改法**：连续录制器在每句开录后、第一个节拍之前，先把页面翻到这一句的开场页（`cueOpening` 的页与拍），节拍照旧按词触发。页切换动画因此录在句首（与字幕同时），节拍仍落在各自的词上。

验证（同一时刻 s01-2 起点 +0.15 s，字幕都已经是新句）：

| 版本 | 画面 |
|---|---|
| v011（改前） | 仍是上一页"画面跟不上旁白" |
| v012（改后） | 正在交叉淡入到"时钟交给旁白" |

回归用例：`test/teach-cue-pages.test.ts` 新增"句子边界就换页"（起点帧仍是上一页、400 ms 时已是新页）；原来那条"跨句边界画面连续"改成"边界不跳变（首帧≈上一句末帧，容差 40/255）+ 翻页录在第二句开头"——连续契约下接缝里本来就有一次翻页，要求帧完全相等是过时的断言。

**顺带纠正一个猜测**：这不是"气口"的问题。句子 span 的起点就落在第一个词上（实测 13 句首词偏移全是 0），所以字幕没有超前；超前的只有画面。

### 29.5 工具路径跑通（2026-11-26 15:10 宿主重启后）

`video_teach_render` + `video_teach_export` 各跑一次，得到 `renders/showcase-ark/v013.mp4`（91 992 ms，任务 `v-20261126-0011`，右侧面板可列）。与脚本渲的 v012 同内容（同一时刻抽帧一致）。复核：

| 项 | 结果 |
|---|---|
| 时长 | 成片 91 992 ms，时间轴 91 992 ms |
| 换页与字幕 | s01-2 起点 +0.15 s：画面正在交叉淡入新页、字幕已是新句；+0.9 s 新页完全落定 |
| 段内接缝（末帧 vs 下一句首帧） | 0.01–0.12%（七处），另有 s01-1→s01-2、s02-1→s02-2、s02-2→s02-3 三处 2.1–2.9%——那三处是句首捕获到的那一帧已经吃到一点淡入进度，不是跳切 |
| 段间接缝（换 deck） | 6.76% / 4.03%，该切就切 |
| 产物 | `v013.mp4 / .srt / .timeline.json / cover-16x9 / cover-4x3 / deck/` |

一处运行期行为要记住：s03 段第一遍有一拍迟到，连续契约下**整段重录了一次**（`recorded a second time after a late beat`），重录后无 motion finding。这是 §29.3 写下的代价，实际发生过一次。

