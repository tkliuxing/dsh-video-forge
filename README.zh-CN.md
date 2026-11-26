# dsh-video-forge

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）
的工作区对话里用在线模型生成视频。说一句要什么镜头，成片就会落在工作区的
`renders/<shot>/vNNN.mp4`；每次生成都记在一份持久化台账里，所以超时或重启
**不会让你付两次钱**。

按设计**没有本地推理路径**：这个插件只是在线模型的客户端。

> English: [README.md](./README.md)

## 环境要求

- **DSH 0.2.x**（含 rc 版本）。包里声明了 `engines.dsh`
  （`^0.2.0-rc.1 || ^0.2.1-rc.2`），宿主会拒绝安装声明区间与运行版本不符的插件。
  它不会悄悄加载一个按宿主没有的 API 编译出来的插件。
- **Node** `^22.19.0 || >=24.0.0`。
- 至少一家受支持供应商的账号与 API key（火山方舟 ARK Seedance、MiniMax，或任意
  OpenAI-Videos 兼容网关）。没配置之前不会生成，也不会产生费用。
- **生成式**视频不需要 ffmpeg、模型权重或 GPU：渲染在供应商侧，本插件只搬字节。
- **教学视频**（四个 `video_teach_*` 工具）的渲染在这台机器上，因此需要本地工具。
  清单按等级分，只有第一级是任何稿件都需要的：
  - **任何教学视频**：`PATH` 上有 `ffmpeg` 与 `ffprobe`。缺了 `video_teach_plan`
    直接报阻塞，`video_teach_render` 也会拒绝动手。
  - **slides 段**（`engine: slides`）：一个 Chromium。`playwright-core` 随插件装，
    浏览器本身不随包，可以让 Playwright 的缓存回答，或用 `TEACH_CHROMIUM` 指定
    可执行文件。这一级**永不阻塞**：录制之前的步骤没有它照样能跑，要等真正开始
    录制才会失败。
  - **manim 段**（`engine: manim`）：装了 `manim` 模块的 Python，以及 `latex` 与
    `dvisvgm`。只有稿件里真有 manim 句子才需要；缺了会在 `plan` 或 `render` 动手前
    就被拒绝，并给出两条出路。这里有个坑。**BasicTeX 有 `latex` 但没有 `dvisvgm`**，
    只装 BasicTeX 会报 `latex error converting to dvi`，要么用 TinyTeX，要么单独把
    `dvisvgm` 补上。

  三个环境变量说明这些工具在这台机器上的位置。它们是拓扑，不是密钥：
  - `TEACH_PYTHON`：装了 `manim` 的解释器，用专用 venv 也可以。
  - `TEACH_TEXBIN`：同时有 `latex` 与 `dvisvgm` 的 bin 目录。
  - `TEACH_CHROMIUM`：Chromium 的可执行文件。

  **不装 Manim 也能做完**：把段落都设成 `engine: slides`，整条路线只需要 ffmpeg
  与一个 Chromium。稿件怎么写见 `video-teach-storyboard` skill，安装步骤与"什么时候
  值得上动画"见 `video-teach-manim`。生成式视频完全用不到这些。

## 安装

```bash
dsh plugin --profile web add dsh-video-forge
```

`web` 是你启动的 profile（`dsh web`）；换成你实际在用的 `desktop`、`tui` 等即可。
装完重启该 profile。

## 配置供应商

常规做法是在 GUI 里：**侧栏 → 插件 → Video Forge**。它会以可选列表给出本版本支持
的协议：火山方舟 ARK（Seedance）、MiniMax（H3）、OpenAI（Sora），或自定义的
OpenAI-Videos 兼容网关，并自动填好 Base URL、凭据引用与厂商文档里的模型，允许
添加多家供应商。API key 经宿主的凭据服务保存，界面只显示掩码后的尾号。

同样的配置也可以手写进 profile 的 `cordis.patch.yml`：

```yaml
- id: video-forge
  name: dsh-video-forge
  config:
    providers:
      - id: ark
        protocol: ark-seedance
        baseUrl: https://ark.cn-beijing.volces.com/api/v3
        authRef: ARK_API_KEY
        models:
          - id: doubao-seedance-2-0-fast-260128
            modes: [t2v, i2v, flf2v, s2v]
            resolutions: ['480p', '720p']
            aspectRatios: ['16:9', '9:16', '1:1']
    defaultProvider: ark
    defaultModel: doubao-seedance-2-0-fast-260128
```

模型按 `providerId::modelId` 引用。凭据先走宿主凭据服务，再走环境变量
（`<PROVIDER>_API_KEY`）；回环网关可以不带 key。

教学路线的旁白用的是另一项凭据，它不是供应商 key，而且**每个语音供应商各有一个**：
DeepSeek 用 `DEEPSEEK_API_KEY`，火山用 `ARK_VOICE_API_KEY`。两者都是普通的凭据引用名，
可以在设置页里直接填（「教学视频」小节里每个 provider 一行，折叠状态下标题会显示
是否已配置），也可以按同名环境变量导出。`ARK_API_KEY` 不能用于语音，那个端点会用一条
很像"模型未激活"的 401 拒绝它。

语音有两个供应商，由稿件的 `meta.voice.provider` 选择：

- `deepseek`（默认）：DeepSeek 官方语音。同一段稿子盲听对比里它最像同一个人，原样拼接
  的气口也最自然。两个音色（`stella`、`tide`），不能调语速，**没有词级时间戳** ——
  所以画面按页驱动：一句一页，页内节拍用 `at_progress`（该句实测时长的 0–1 比例）摆放。
  节拍跟着语义走，不对齐单字发音。稿件也可以用 `page` / `enter` 让连续几句共用一页，
  版式不动、画面在同一页上演进。凭据引用 `DEEPSEEK_API_KEY`。
- `volcengine`：唯一返回字级时间戳的供应商，也是唯一能做"讲到这个词、画面动一下"
  （`at_word`）的。凭据引用 `ARK_VOICE_API_KEY`。需要逐词联动时再换它。

## 在对话里怎么用

- "做一个黄昏灯塔的 5 秒镜头" → 调用 `video_generate`；聊天卡片跟着任务实时更新，
  出片后可以直接播放。
- "让 `materials/cat.png` 里的猫转头看镜头" → 用工作区图片做首帧（i2v）生成。
  拖进对话的附件也行：模型把它看到的路径传进来，插件按字节认出这是图片。
- "接着上一个镜头" → `from` 取上一版 take 的尾帧（ARK）作为这一版的首帧，落在同一个
  镜头目录里。
- "Alice 走进来" → `characters: ['alice']` 会带上 Alice 注册在案的描述与参考图，
  让她在每个镜头里长得一样。
- 超时或重启之后问"好了吗？" → `video_status`。插件在重启后接管的任务，完成时还会
  主动在对话里说一声。
- `/video-prompting 雨夜里外卖员找不到门牌，十几秒那种紧张感` → 把口语需求改写成目标模型
  要的形态（MiniMax H3 就是三段字段加 `[Shot N]` 时间轴），只给提示词，不生成。

## 工具

| 工具 | 作用 |
|---|---|
| `video_generate` | 提交一次生成（t2v / i2v / flf2v / s2v），立刻返回任务 id 与后台 job id。`shot` 决定 `renders/` 下的目录名；`from` 接着上一版拍；`characters` 应用 `video-project.yaml` 里注册的角色。拒绝（只读对话、远端工作区、清单写坏、重复请求）都发生在**花钱之前** |
| `video_status` | 恢复入口：最近的任务、进度、每部片在哪、失败原因、内容审核拒绝、供应商上报的用量。不给任务 id 时还会报告当前设置：有哪些供应商、key 是否配好、模型与模式，以及本工作区的清单、权限模式与角色。超时之后先查这里，**不要重新提交** |
| `video_cancel` | 请供应商停下（与 `job_kill` 不同：后者只是停止盯守，供应商照旧干活照旧计费） |
| `video_teach_plan` | 校验教学稿 `storyboard.yaml`、估时、检查内容与时间线的配合（哪句没有画面变化、fragment 是否越界、场景有没有被复用），并报告本机缺哪个外部程序。免费、不联网 |
| `video_teach_narrate` | 合成旁白（默认 DeepSeek 语音 `DEEPSEEK_API_KEY`；火山 `volcengine` 可选，唯一带字级时间戳），写 `timings.json`；`sentences` 只重合成指定句 |
| `video_teach_render` | 一句一段地从 reveal.js 幻灯片与/或 Manim 场景渲染，再拼成 `renders/<镜头>/vNNN.mp4`，旁白烧进画面；`sentences` 只重录指定句，其余段不动。渲染后抽样帧颜色，把可疑静帧点名 |
| `video_teach_export` | 写成片旁的 SRT 与 `timeline.json`，把 deck 导出到 `deck/`，并把 `meta.cover` 那一页按 16:9 与 4:3 各截一张封面。SRT 按词级时间戳切；默认音色没有词级时间戳，就一句一条。它与烧进画面的是同一份 cue 文本 |

### 教学视频

教学视频的旁白由 TTS 合成、画面在这台机器上画出来，所以不需要供应商 key，渲染不花钱。
时间轴由旁白决定：每句音频的长度就是那句的长度。默认音色没有词级时间戳，所以画面按句
换页（稿件用 `page` 声明时可以几句共用一页），句内的节拍按该句时长的比例摆放（见上文
两个语音供应商一段）；只有换成 `volcengine` 才能让画面跟着某一个词动。

| 适合 | 不适合 |
|---|---|
| 公式推导、坐标系、数字逐步累积 | 真人质感、镜头调度、角色表演 |
| 要点逐条出现的幻灯片式讲解 | 复杂场景调度与光影变化 |
| 改一句只重录一句的返工节奏 | 任何需要"看起来像实拍"的内容 |

句子之间默认是硬切。稿件写 `meta.transition`（`mode: deck` 加一个 100–1200 ms 的时长）之后，
deck 自己的页切换会被录在**前一句的尾部**——包括 reveal 的 Auto-Animate 跨页形变——所以句首仍是
完整画面，句尾的"最后一屏停留"也仍然完整。时长归稿件、形态归 deck：要多长写在稿子里，长什么样
（淡入、滑动、缩放、形变）写在 deck 里。只有"同一个 deck 内、下一页确实不同"的相邻两句才有转场：
共享同一页、段与段之间、幕与幕之间、以及纯 cue 模式（`volcengine`）都没有。转场期间没有旁白，
所以每一段长成`时长 + 转场`，成片时长、字幕起点、逐幕验收都按这一个账本算；改后一句的版面要
连带重录前一句，渲染结果会把这件事点名。

随包的模板 deck 自带一页内的动效库：压暗点亮（`dim`）、描边画出（`draw`）、数字滚动
（`count`）、条形生长（`bar`），加上 reveal 自带的逐条出现与缩放进场；同一个元素也能在
一页内连续变形（容器加 `data-teach-stage`，形状全写在 CSS 里）。节奏靠 `--teach-dur` 调，
默认 480 ms，某一页要快就在那一页覆盖变量，别去重写 `.fragment` 的 `transition`。
判断一个动效能不能用看它与时钟的关系：由节拍触发的是确定的，跟时钟无关的循环不是。
写法与禁用清单见 `video-teach-slides` skill。

`video_teach_plan` 不只检查格式：每句幻灯必须至少带来一次画面变化，平均每 8 秒至少变一次
画面，一句的时长应在 2 到 8 秒之间，cue 的 fragment 不能超过 deck 实际拥有的数量，
两句话不能共用一个 Manim 场景（否则同一段动画会重复播）。问题会点名到句子 id。
越界的 cue 会被直接拒绝；deck 缺 `teachReady` / `teachCue` / `teachPage` 这几个契约
也会直接拒绝，这一类在录音花钱之前就能发现。

产物：成片在 `renders/<镜头>/vNNN.mp4`，旁边 `vNNN.json`，并出现在视频面板里。
旁白已经烧进画面，成片可以直接发平台；烧字幕需要带 libass 的 ffmpeg，缺它时片子照样拼出来，
只是结果里写明「没烧」而不会失败。`video_teach_export` 给其余几样：成片旁的 `.srt`
（同一份 cue 的旁挂文件）、`vNNN.timeline.json`、`deck/` 下的可交互幻灯片，以及
`vNNN.cover-16x9.png` 与 `vNNN.cover-4x3.png`（由稿件里 `meta.cover` 指的封面页截图）。
`storyboard.yaml`、`slides/<段>/`、`scenes/*.py`、`timings.json`、`audio/` 属于项目、值得进版本库；
`.dsh-video/`、`deck/`、`renders/` 可以重建。稿子格式、两种引擎的约定、只重录一句的做法见
`video-teach-*` 系列 skill。

## 费用，以及什么离开了你的机器

`video_status` 也回答钱的问题：`cost: true` 把已结算用量乘价目表求和（按
供应商/模型/镜头分组，附价目表日期，以及还有哪些任务的用量未知）；`estimate` 在提交前
先给一次请求估价。**每个数字都标注为估算，真正算数的是供应商的账单**，而且厂商确实
有过不打招呼就调价的历史。

价格来自公开数据源（[LiteLLM 的价格库](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json)，
按 7.0 CNY/USD 折算并按分辨率档拆分），而不是手写在源码里；手写的那份写下的当天就
已经错了。这份数据在后台抓取，绝不发生在工具调用里；整体校验后缓存在
`$DSH_HOME/dsh-video-forge/price-cache.json`，取值顺序是
*你自己的行 > 新抓到的 > 缓存 > 内置快照*。每笔金额都带 `price_source`
（`remote` / `cache` / `bundled` / `none`，以及时效与最近一次失败），价目表里查不到的
模型报"未定价"而不报 0。raw GitHub 到不了时，把 `priceSourceUrl` 指向镜像
（jsDelivr、npmmirror）；留空则关闭该数据源。

会离开你机器的是提示词、你点名的参考图、`video-project.yaml` 里的角色描述，还有
`from` 用到的上一个镜头的尾帧。这些都会用你配置的 key 上传给你配置的供应商，受那家
厂商的条款约束。**没有任何东西会发给插件作者**；本插件不带遥测。供应商的内容审核可能
直接拒绝任务：拒绝会被记录下来，完全相同的请求不会被重提，改过的请求照常放行。

## 随包附带的 skill

插件带 5 个 skill（由模型用 `skill` 工具加载，其中 4 个也注册为 `/名字` 命令）。
它们负责引导工作流；工具本身是自洽的，从不依赖某个 skill 是否被加载过。

| Skill | 覆盖什么 |
|---|---|
| `video-project`（`/video-project`） | 工作区布局与 `video-project.yaml`：路径、默认值、风格、角色、版本号 |
| `video-prompting`（`/video-prompting`） | 怎么写/改提示词：通用结构、时长与画幅、供应商差异；目标模型是 MiniMax H3 时按官方格式改写（三段字段、`[Shot N]` 时间轴、图生固定指令行） |
| `video-storyboard`（`/video-storyboard`） | 把剧本拆成 `storyboard/shots.yaml`，一次一个镜头地生成 |
| `video-iterate` | 重拍还是续拍（`from`）、角色一致性，以及交付前的尾帧自检 |
| `video-guide`（`/video-guide`） | 端到端用法：配置、能做什么不能做什么、费用、成片落在哪 |

## 工作区就是项目

```
<workspace>/
  video-project.yaml        # 可选：默认值、风格、角色、目录映射
  materials/                # 参考图（任意布局；路径按工作区相对写）
  renders/<shot>/v001.mp4   # 每一版 take，永不覆盖
  renders/<shot>/v001.json  # 这一版由什么产生：提示词、模型、素材、用量
  renders/<shot>/v001.last.jpg  # 它的尾帧（ARK），供 `from` 使用
```

一个工作区里第一条视频还会顺手写出带注释的 `video-project.yaml`，以及内容为 `*` 的
`renders/.gitignore`（想提交成片就删掉它，比如配合 LFS）。清单大致是这样：

```yaml
version: 1
defaults: { provider: ark, model: doubao-seedance-2-0-fast-260128, resolution: 720p, aspect_ratio: "16:9" }
style: warm film grain, soft daylight
characters:
  alice: { refs: [materials/alice/*.png], description: "red scarf, short black hair" }
paths: { renders: renders }
```

清单解析不了，或某一节里键名拼错，都会在提交之前被拒。插件只写 `renders/`（以及首次
产出的那两个附带文件）；它尊重对话的权限模式：只读对话会被拒绝，workspace-write 下
一个其实是指向工作区外部的 `renders/` 也会被拒绝。万一工作区最终放不下这条已经付过钱
的视频，它留在 `$DSH_HOME` 里，`video_status` 会说明原因。

## 协议

| 协议 | 覆盖 |
|---|---|
| `ark-seedance` | 火山方舟 Seedance（`POST/GET/DELETE {base}/contents/generations/tasks`），带免费的尾帧（`return_last_frame`） |
| `minimax-video` | MiniMax 视频生成 V2（`POST /v2/video_generation`、`GET /v2/query/video_generation/{id}`）；不能取消，没有尾帧 |
| `generic-openai-videos` | OpenAI-Videos 形状的网关（`/v1/videos`），每条路径与状态词都可配 |

## 界面入口

| 位置 | 是什么 |
|---|---|
| 输入框工具行 | **Video model** chip：这个对话用哪个模型生成，以及时长 / 分辨率 / 画幅。它的优先级高于 `video-project.yaml` 里的 `defaults`，而 `defaults` 又高于插件设置的默认供应商与模型；你（或模型）在调用里显式传的参数仍然最优先。"自动"把决定权还回去。按会话隔离：新对话从"自动"开始。内置预设认识的模型，即使配置里没写时长/分辨率/画幅，也按内置声明列出可选值；chip 会注明是补的 |
| 聊天 | 每次 `video_generate` 一张卡片，跟着任务实时更新：状态与进度、出片后是真正的 `<video>` 播放器、文件在哪（或已被移走/删除）、供应商还可能停下时的取消按钮，以及两条出口：**在文件查看器中打开**该视频，或去面板看 **全部视频** |
| 右侧栏 → **视频** | **本工作区**里的每一部片子，新镜头在前：一版 take 一行，带状态、大小与时长，最新的一条默认展开并可播放。进行中与失败的排在最下面；`renders/` 里台账不认识的片子标为"仅文件"。插件交付到工作区之外的片子根本不列出：这个面板是本项目的视频，那条片子落在哪由聊天卡片负责说明。面板只读：从不提交，也不删东西 |
| 右侧栏 → 文件查看器 | 打开 `.mp4`（从面板、文件树，或对话里的路径）会在与文本、图片同一个 tab 里播放，上方仍是宿主自己的工具栏（刷新、用你的播放器打开） |
| 引导页（右侧栏的"+"） | 可以选到"视频"面板 |
| 右下角角标 | 在飞的任务数（没有时隐藏） |
| 侧栏 → 插件 → Video Forge | 供应商与模型以表单呈现；API key 经宿主凭据服务保存，界面只显示掩码后的尾号 |

没有单独的工作台页面，视频面板也不是：浏览器侧任何东西都无法提交一次付费生成或写文件。
浏览器侧只访问 `/video-forge/api/{overview,cancel}`，除已配对的设备外仅限回环。
宿主不为插件路由做门禁，所以由本插件自己做。

## 东西都在哪

- 视频：工作区的 `renders/`（见上）。不在任何工作区对话里发起的调用，成片留在
  `$DSH_HOME/dsh-video-forge/outputs/`。
- 台账：`$DSH_HOME/dsh-video-forge/tasks.json`。什么都不自动删，`retain` 只报告
  插件自己目录的压力。
- 媒体：`GET|HEAD /video-forge/media/<taskId>/<token>/<name>`。路径只从台账解析，绝不
  来自请求；一个 128-bit token 授权访问，且工作区里的片子只在它仍是当初写入的那个文件
  时才提供。
- 流式播放：`GET|HEAD /api/video-forge/stream?path=…[&sessionId=…]` 以 HTTP Range
  提供 mp4，长片可以跳到中间而不必整段读完。它挂在宿主自己的已认证 `/api` 通道上
  （仅 owner、同源），读的是同一个用户本来就能通过 `/api/file` 打开的文件，加上 Range
  并没有多给任何可达性。上面那条插件自己的信任门路由做不到这点：它只认识台账里记过的
  文件。

## 升级与卸载

```bash
dsh plugin --profile web add dsh-video-forge@latest   # 升到最新版
dsh plugin --profile web remove dsh-video-forge       # 卸载
```

两步之后都重启 profile。卸载**不会**删除 `$DSH_HOME/dsh-video-forge/`（台账、产物、
价格缓存）或工作区的 `renders/`。那些是你的数据，要清自己清。

## 开发

```bash
pnpm install
pnpm check     # tsc --noEmit、tsdown 构建、vitest
```

`fixtures/provider.ts` 是一个离线替身，跑在真 socket 上，模拟 ARK / MiniMax /
OpenAI 兼容协议，所以整条"提交 → 轮询 → 下载 → 交付"链路不需要 key 也不需要网络就能跑完。
`fixtures/litellm-video-sample.json` 是上游价格数据的一份冻结切片，内置快照被断言等于
这份冻结样本的归一化结果，两者因此不会漂移。

针对真实供应商的实测是分开的，永不进入 `pnpm check`。`free` 只发不可能产生计费任务的
请求；`paid` 还会为每家供应商真跑一次最便宜的生成：

```bash
VIDEO_FORGE_LIVE=free ARK_API_KEY=… MINIMAX_API_KEY=… pnpm test:live
```

设计说明（中文，一个里程碑一节，坑也写在里面）在
[docs/DESIGN.md](docs/DESIGN.md)；发版流程在 [docs/RELEASING.md](docs/RELEASING.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。

内置价格快照派生自 [LiteLLM 的价格库](https://github.com/BerriAI/litellm)（MIT）。
厂商名称与模型 id 仅作描述性使用；本项目与这些厂商没有隶属关系。
