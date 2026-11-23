# 教学视频路线（规划稿，2026-11-20）

> 状态：**规划，未实现**。决策来自 2026-11-20 的问答会话（`session-2d3dbdb3`，限于"仅对话"工具面，读不到本仓库）；本节把那些决策按本仓库的实际形状重写了一遍，并把"会话里靠推测写的部分"改成读代码得到的事实，剩下的不确定性单独列在 §11。
>
> 相关：`DESIGN.md` §4（工具面）、§9（产物与播放）、§15（未决与风险）、§17.2（产物落点）、§19（视频面板）、§22（skill 结构）。

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
| 交付物 | 16:9 1080p mp4 · SRT · 烧入字幕 · 可交互 HTML deck · 封面 · 时间轴 JSON |
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
  captures/*.webm            # 录屏中间件（不入库）
  renders/<shot>/vNNN.mp4    # 成片，与在线生成的片子同一套版本编号
  renders/<shot>/vNNN.json   # 旁边的描述文件（prompt/参数/用量的位置继续留给生成路线）
  deck/                      # 可交互 HTML 产物
```

清单里建议新增一段而不是新建清单文件：

```yaml
collect:                      # 教学路线（名字待定，见 §11）
  voice: { provider: volcengine-tts, speaker: zh_female_xxx, clone_id: null }
  video: { size: [1920, 1080], fps: 30 }
  storyboard: storyboard.yaml
```

`storyboard.yaml` 草案：

```yaml
meta:
  title: 为什么 1+1/4+1/9+… = π²/6
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

## 6. 工具面（四个，名字待定）

| 工具 | 职责 | 副作用归属 |
|---|---|---|
| `video_teach_plan` | 校验 `storyboard.yaml`、拆句、产出渲染计划与耗时预估 | 只读 |
| `video_teach_narrate` | 逐句 TTS、落 `timings.json`（词级） | 付费 + 网络 |
| `video_teach_render` | 分段渲染 → CFR → concat → 混音 → 字幕；可只重录指定句 | 子进程 + 写工作区 |
| `video_teach_export` | `deck/` 静态 HTML、封面、外部 SRT、时间轴 JSON | 写工作区 |

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

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 | `storyboard.yaml` / `timings.json` 的 schema 与校验，目录约定 | 非法稿的报错能指出行号与具体键 |
| M1 | 单句最小闭环：TTS → 录屏 → CFR → 段 mp4 | 一句 3 秒，音画对齐误差 < 50ms |

**M0/M1/M2 已落地（2026-11-20）**，证据在 §13。代码：`src/teach/storyboard.ts`（解析与校验）、`voice.ts`（TTS 客户端）、`slides.ts`（CDP 录屏）、`manim.ts`（Manim 段）、`ffmpeg.ts`（探测/CFR/拼接/混流）、`deck.ts`（reveal.js 脚手架）、`pipeline.ts`（plan/narrate/render/assemble + 分段复用）。
| M2 | 多句拼接 + 只重录某句 | 改第 3 句不触发前两句重录 |
| M3 | Manim 段接入 + 跨引擎拼接 | 两段不同引擎拼成一条，无音画错位 |
| M4 | SRT / 烧字幕 / 封面 / deck 双产物 | 六种产物齐全 |
| M5 | 工具化 + skill 落地 + 3 分钟混合样片 | 从头看一遍不出戏 |

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

1. **reveal.js 正式模板**。`assets/teach/deck/` 里随包发 reveal.js 6.0.2 的 `reveal.js` / `reveal.css` / `theme.css` 与它的 MIT LICENSE（共 744 KB），模板 `index.html` 把契约压到两个全局：`window.teachCue(index)` 与 `window.teachReady`。`teachCue` 用 `Reveal.nextFragment()` 循环到第 n 个 fragment（Reveal 没有"跳到第 n 个 fragment"的 API，循环是诚实的写法，而且幂等）。`writeDeck()` 把这份模板和三个运行时文件抄进项目，**默认拒绝覆盖已有 deck**——deck 是手稿，重新脚手架覆盖掉手改内容是这里最坏的失败模式。
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

**拒绝优先于花钱**，五条都在离线测试里钉住：只读或权限未知的会话直接拒绝；`storyboard` 路径逃出工作区拒绝；没有 `ARK_VOICE_API_KEY` 拒绝并**点名这个引用**（`ARK_API_KEY` 不是它）；未知句子 id 拒绝并列出稿件里有哪些；没有旁白就渲染、没有成片就导出，都拒绝并说明先跑哪一个。

**命名与测试的约束**：工具名前缀是 `video_teach_`，因为 `test/guide-consistency.test.ts` 用 `/video_[a-z_]+/` 扫 skill 正文并要求命中真实工具名 —— 写成 `teach_video_plan` 会被扫成不存在的 `video_plan`。这条测试这一轮扩成了扫两个文件（`src/tools.ts` 与 `src/teach/tools.ts`），且顺手发现 skill 正文里写 `video_teach_*` 这种通配写法同样会被扫成 `video_teach_`，所以正文里只写具体工具名。

**skill**：`assets/skills/` 新增四份中文正文（storyboard / slides / manim / iterate），`src/skills.ts` 注册为 `video-teach-storyboard`（可作 `/` 命令）、`video-teach-slides`、`video-teach-manim`、`video-teach-iterate`。`test/skills.test.ts` 的名单与可调用集合相应更新。

**验证**：`pnpm test` 41 个文件、**590 passed / 6 skipped**（含 `test/teach-tools.test.ts` 14 例离线用例）；`pnpm run build` 通过，产物 `lib/index.js` 399 kB + `lib/ffmpeg-*.js` + `lib/manim-*.js`（后两者是懒载的子进程模块）；`node -e "import('./lib/index.js')"` 确认打包产物能加载、`apply` 与 `inject` 都在，`playwright-core` 的顶层引用不再阻塞加载。

**仍未做（下一轮）**：隔离实例里的端到端调用与 3 分钟混合样片仍未做。台账行与面板（§8 方案 A）已实施，`README` / `README.zh-CN.md` 的 Requirements 与工具表也已补上教学路线所需的外部依赖与四个工具。

**隔离实例验收（2026-11-20，成功）**：`DSH_HOME=/tmp/teach-verify/home dsh plugin --profile web add <repo>` 把仓库 link 进一个全新 profile 的 `web`（**关键是 profile 名要对上宿主实际启动的那个**；早先装进 `verify` 却启动 `web`，于是怎么都不加载），再 `dsh web --port 34798 --no-open`。结果：宿主起在 `http://127.0.0.1:34798`，插件自己的面板接口 `GET /video-forge/api/overview?token=…` 返回 `{"ok":true,…,"outputRoot":"/tmp/teach-verify/home/dsh-video-forge/outputs"}` —— 说明打包产物在真实宿主里加载成功、`apply()` 跑完（四个工具与四份 skill 都在同一段注册代码里，注册抛错就会让插件页不响应），且完全落在隔离的 `$DSH_HOME` 里，真实 `~/.dsh` 未被触碰（`tasks.json` 仍是 11 月 17 日那份）。两个坑记下来：`/video-forge/api/setup`、`/tasks` 是我猜的，真实动作名是 `overview` / `cancel` / `selection`；`dsh web --profile <name>` 与 `DSH_PROFILE` 同时存在时报 `select a profile only once`，干脆只用 `plugin --profile web add` 装、`dsh web` 不带 `--profile` 启动。

**仍未做**：宿主内**真的调用一次** `video_teach_*`（需要会话与模型，属付费验证）、3 分钟混合样片。

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

**界面**：设置卡片里新增一个折叠的「教学视频」小节（默认收起，所以纯生成式用户不会被它干扰）。标题行即使在折叠状态下也显示两个 provider 的凭据状态（`语音凭据：DeepSeek 已配置 · volcengine 未配置`），否则"键到底配没配"要展开才知道。展开后**每个 provider 一组**引用名输入框 + 凭据行（只显示已配置/未配置与掩码尾，保存后立刻清空输入框），下面是三个路径输入框与一个「探测这台机器」按钮。

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

- `teachPage(n)`：切到第 n 页（一句一页，页序 = 句子的顺序）。
- `teachCue(n)`：页内显示到第 n 步。
- `teachReady`：版式就绪。

录制时：句子开始先 `teachPage(句序号)`，再按 cue 的偏移 `teachCue(fragment)`。因此"折线逐点长出来"这类演示仍然能做，只是节拍由**作者按语义给比例**，不是由词决定。

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

- `fragment` **在所在页内**从 1 递增（第 2 页的第一个节拍又是 1）。纯 cue 模式下全片只有一页，编号自然全片递增。
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

用户指出「`ARK_VOICE_API_KEY` 在插件配置界面上可配置」这件事没有落实。查下来是两件事叠在一起：界面上那一行藏在默认折叠的「教学视频」小节里，而且**它只有一个引用名输入框**——DeepSeek 稿件（默认路线）跑起来要的是 `DEEPSEEK_API_KEY`，界面上却只会显示和写入 `ARK_VOICE_API_KEY`。所以严格说，DeepSeek 那个 key 从来没法在界面上配。

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

**给使用者的一句话**：这一节在插件配置卡片里、默认收起，标题行右侧就是两个 key 的状态；改完设置下一次工具调用即生效，但宿主进程必须重启过才能加载带这两个字段的构建。
