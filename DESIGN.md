# DSH 视频生成插件 — 设计说明

> **包名已定**：npm 包名 `dsh-video-forge`（2026-10-13 实测可用）。
> 原占位名 `dsh-video-studio` **在 npm 上已被他人占用**（`dsh-video-studio@0.4.3`，作者 litao36253，是一个仅 Windows、自装 ffmpeg 的本地剪辑工作台，功能面正好落在本文 §1 的非目标里）。
> 本地目录仍是 `~/Code/github.com/tkliuxing/dsh-video-studio`（本文所有路径按此写）。**仓库与目录将一并改名为 `dsh-video-forge`**（2026-10-15 决定，随 M5 发布链路一起做；本地目录由用户自己改，因为会话就在这个目录里运行）。
> 本文是设计决策记录，不是最终 API 契约；实施中出现的新事实回写到这里。
> **2026-10-15 规划讨论改变了方向**：插件以模型工具为主，整个视频工作流在工作区的对话里完成，工作区就是项目，工作台页面删除，工具收敛为 3 个，另配 5 个 skill。§4、§5、§9 描述的仍是 M2.1 已实现的状态；与新方向冲突的地方以 **§16** 为目标设计，实施时再回写到各节。

## 1. 目标与非目标

**目标**：给 DSH 一个"生成视频"的能力，**以模型工具为主**，用户只在**工作区的对话里**就能走完整个视频工作流（2026-10-15 修订，原为"既能被模型当工具调用，也能被人当工作台使用"）；**工作区就是视频项目**，剧本、分镜、素材、产物都在里面（§16.2）；**全部走在线模型**（Seedance / MiniMax / 各类中转站），用同一套协议表接入；生成过程不阻塞会话、不怕超时、重启后可恢复、**不会因为超时或重启付两次钱**；产物能在聊天窗口内直接播放；用户随时能在对话里问出花了多少钱（§16.5）。

**非目标（首期）**：

- **不接本地模型推理**（2026-10-13 撤销原 mlx-serve / MiniMax-H3 路线，见 P5）；本插件是**在线模型的客户端**，不做推理、不做权重管理。
- 不做视频剪辑/时间线/多段拼接（那是 `deepseek-ivideo` 的地盘；npm 上占用 `dsh-video-studio` 的也是这一类）。本地 ffmpeg 能力列为待办、尚未决定（§16.8），决定前这条非目标不变。
- **不做按分镜批量生成**（2026-10-15）：一次生成一个镜头；分镜只是给模型参考的文本。
- 不做独立的工作台页面（2026-10-15，见 P8）。
- 不做自动配音/字幕烧录（可作为后续能力）。

## 2. 已定决策

| 编号 | 决策 | 选择 | 依据 |
|---|---|---|---|
| P1 | 能力面 | **模型工具 + Web 面板一起做**；包结构一开始就按 Host+Client 双半区设计 | 用户决策；八个前例全部是双半区单包 |
| P2 | 后端范围 | **只做在线供应商**：首期 = `generic-openai-videos`（OpenAI 兼容 `/v1/videos`，覆盖中转站与 Sora 类通道）+ `ark-seedance`（火山方舟）；因此必须做协议表 | 用户决策（2026-10-13）；`dsh-newapi-video` 的教训是硬编码端点最先坏 |
| P3 | 产物与播放 | **落 `$DSH_HOME/dsh-video-forge/outputs`**，自建 token 化路由 + 工具卡片播放；另给显式"导出到工作区" | 内置 `/api/file` 20 MiB 上限、忽略 Range、无分段；attachment 音视频无专门处理；内置 `ui-chat` 无 video 节点 |
| P4 | 长任务 | **持久化台账 + `ctx.jobs` 承载"盯守"** | 用户决策；八个前例**没有一个**用 `ctx.jobs`，属新增设计原语，M0 必须验证 |
| P5 | 模型来源 | **只用在线模型，不接本地推理**。原 mlx-serve / MiniMax-H3 协议、`rgb8+pcm → MP4` 本地 mux 与 ffmpeg 依赖**整条撤销** | 用户决策（2026-10-13） |
| P6 | 验证环境 | **绝不使用正在运行的 dsh 实例**（`http://127.0.0.1:3080/`，即当前 GUI）；验证一律另起实例并显式指定独立 `DSH_HOME`、独立端口 | 用户决策（2026-10-13）；细节见 §13 |
| P7 | 定位 | **以模型工具为主**；整个工作流在工作区的对话里完成 | 用户决策（2026-10-15）；DSH 的对话总是开在某个工作区里 |
| P8 | 界面 | **删除"视频工坊"工作台页**（`main` + `sidebar.panellist`）；聊天卡片是唯一的工作界面，配置卡保留。**修订 P1** | 用户决策（2026-10-15）；见 §16.4 |
| P9 | 产物位置 | **产物落在工作区的 `renders/<shot>/vNNN.mp4`**，`video_export` 删除。**修订 P3**（台账仍在 `$DSH_HOME`） | 用户决策（2026-10-15）；见 §16.2 |
| P10 | 工作区组织 | **默认布局 + 清单映射**：`video-project.yaml` 可以把剧本、分镜、素材、产物映射到用户已有的目录 | 用户决策（2026-10-15），未选"固定预设"或"完全不规定" |
| P11 | 工具与 skill | **工具 3 个**（`video_generate` / `video_status` / `video_cancel`）+ **随插件附带 5 个 skill**（`video-project` / `video-prompting` / `video-storyboard` / `video-iterate` / `video-guide`） | 用户决策（2026-10-15）；DSH 的 `ctx.skills` 支持插件注册提供方；见 §16.3 |
| P12 | 成本可见性 | 台账保存供应商用量；金额 = 用量 × 价格表（**预设参考价，用户可改**）；事前估算**只在被问时**给 | 用户决策（2026-10-15）；两家接口都不返回金额；见 §16.5 |
| P13 | 下一阶段 | **先做真实通道验证（M2.5）**，用方舟 Seedance 与 MiniMax 的真实 key | 用户决策（2026-10-15）；三个协议至今只对 fixture 验证过 |

**默认项（本文直接定，不再讨论）**

- 超时后**只查不重提**：提供状态查询工具 + 工具描述与系统提示词双重约束，并在宿主层拦重复提交（前例中只有 `dsh-game-material-master` 做到宿主层）。**2026-10-15 发现的缺口**：现有实现先提交、后写台账，响应丢失时宿主层根本拦不住；改为"先写意图再提交"，见 §16.7。
- 凭据永不进模型上下文、不进浏览器：Config 用 `role('secret')`，UI 只回掩码。
- 文案全部走 locale 字典（硬编码会被 `verify-client-ui-i18n` 拒）。
- 产物**绝不自动删除**（对齐 DSH attachment 的既有价值观），只提供显式清理与容量提示。
- 声明 `dsh.engines.dsh` 与锁步 peer（前例八个里只有 iris 声明了 engines）。peer 区间必须写成 `^0.1.7-rc.1 || ^0.2.0-rc.1` 这种显式双段：因为门禁用 `includePrerelease: true`，单段 `^0.1.7-rc.1` 跨不到 `0.2.x`（这正是 issue #1 的成因）。

## 3. 包结构与清单

```
dsh-video-studio/               # 目录名；npm 包名 = dsh-video-forge
├── package.json
├── tsconfig.json
├── tsdown.config.ts            # Host 入口 + Client 入口双产物（抄 dsh-presets-hidden）
├── cordis.patch.yml            # 插入一行：id=video-forge, name=dsh-video-forge
├── icon.svg                    # 市场卡片图标，自包含 SVG，≤256 KiB
├── locale/en.json              # meta.title / meta.description + 全部文案键
├── locale/zh.json
├── src/                        # Host 半区（函数插件）
│   ├── index.ts                # name / inject / Config / apply
│   ├── config.ts               # schemastery Config（volatile）+ snapshot() 取普通值
│   ├── ledger.ts               # 任务台账：原子写、恢复、容量策略
│   ├── watch.ts                # 盯守：轮询 → ctx.jobs 输出环 → 结算
│   ├── download.ts             # 拉取 provider 产物 → $DSH_HOME 落盘（0600/0700）
│   ├── settings.ts             # 纯类型 + 默认值 + 解析规则（无 DSH 依赖，可单测）
│   ├── runtime.ts              # 工具共享的运行时面（设置快照、产物路径、URL 构造）
│   ├── credentials.ts          # 凭据解析顺序（对象解构！）
│   ├── download.ts             # 产物落盘（0600/0700 + 128-bit token）
│   ├── materials.ts            # 素材解析（绝对路径 / http(s) URL → data: URL + digest）
│   ├── providers/              # 协议表
│   │   ├── adapter.ts          # 协议接口 + HTTP/状态归一化
│   │   ├── dot-path.ts         # 可配置字段提取（中转站形状不可预知）
│   │   ├── index.ts            # adapterFor(provider, model)
│   │   ├── generic-openai-videos.ts  # OpenAI 兼容 /v1/videos（中转站、Sora 类）
│   │   └── ark-seedance.ts     # 火山方舟 Seedance
│   ├── operations.ts           # 提交/取消/导出/列表的唯一实现（工具与面板共用）
│   ├── tools.ts                # 四个工具的 schema/文案/卡片元数据（薄适配层）
│   ├── trust.ts                # 面板 API 的信任门（回环 / 已配对设备）
│   ├── media-route.ts          # token 化媒体路由（GET/HEAD + Range/206）
│   └── panel-api.ts            # 工作台的宿主路由族 /video-forge/api/*
├── client/                     # Client 半区
│   ├── index.ts                # 座位注册：toolview 卡片 / main+panellist / overlay badge / 配置卡
│   ├── cards.tsx               # 四个工具的结果卡片
│   ├── video-card-model.ts     # 卡片的纯推导（无 React，可单测）
│   ├── panel.tsx               # 工作台页（提交 + 任务/产物列表 + 取消/导出）
│   ├── panel-api.ts            # 面板的 HTTP 客户端（文档相对 URL）
│   ├── badge.tsx               # shell.overlay 的进度 badge（无事时 return null）
│   ├── settings-card.tsx       # 配置卡（默认项/限额/供应商状态/JSON 编辑）
│   ├── config-card-seat.ts     # 主位+回退座位的选择策略（无组件、可单测）
│   ├── icons.tsx               # 侧栏字形
│   └── locales.ts              # 中英文字典
├── test/                       # 单测 + 契约测试（81 例）
└── fixtures/                   # 离线仿真在线 API 的假 provider（见 §13）
```

`package.json` 关键字段（对齐你现有插件约定与 `docs/user/develop/basic/publish.md`）：

```jsonc
{
  "name": "dsh-video-forge",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js",
               "./package.json": "./package.json", "./locale/*.json": "./locale/*.json" },
  "files": ["lib", "icon.svg", "locale/*.json", "cordis.patch.yml", "README.md"],
  "dsh": {
    "engines": { "dsh": ">=0.1.7-rc.1 || ^0.2.0-rc.1" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime",
                "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-conversation",
                "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-primitives"] }
  }
}
```

依赖规则（实测版）：与宿主共享实例的 dsh 包——`@deepseek-ai/dsh-tools`、`dsh-host-webserver`（**注意不是 `dsh-web-server`**）、`dsh-settings`、`dsh-credentials`、`dsh-jobs`、`dsh-system-prompt`——同时进 `peerDependencies` 与 `devDependencies`，区间写成 `^0.1.7-rc.1 || ^0.2.0-rc.1`。唯一的运行时依赖是 `@deepseek-ai/schemastery`（配置 schema）；**没有 zod、没有 mime-types**——MIME 与扩展名映射是自己写的几十行，少一个依赖。客户端半区只允许 `require` 平台模块表里的 9 个模块（`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/dsh-cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`），其余一律内联，所以对 `ui-tool` / `ui-conversation` 只能做**类型导入**（编译期擦除）。**发布优先 npm 或 `pnpm pack` 的 tarball**，GitHub 直装需要用户 `allowBuilds` 授权（等于允许装包时执行代码），不作为首选分发路径。发版走 GitHub Actions + npm trusted publishing / OIDC，不在本地 `npm publish`。

## 4. 能力面 A：模型工具（4 个，不多做）

> **2026-10-15 规划修订（目标设计见 §16.3）**：工具收敛为 3 个。`video_export` 删除，因为产物直接落在工作区；`video_generate` 增加 `shot` / `from` / `characters`，素材改用工作区相对路径；`video_status` 不带参数时还返回可用模型、配置状态与花费汇总。判断与工作流交给随插件附带的 skill。本节下文仍是 M2.1 的实现状态。

| 工具 | 参数要点 | 返回 | 说明 |
|---|---|---|---|
| `video_generate` | `prompt`(必)、`provider?`、`model?`、`mode`(t2v/i2v/s2v)、`first_frame?`、`last_frame?`、`reference_images[]?`、`duration_seconds?`、`resolution?`、`aspect_ratio?`、`wait_seconds?`(默认 0) | `{ kind:'job', jobId, task:{ localId, providerTaskId, provider, model, status } }` 或 `{ kind:'done', artifact }` | 登记台账 → `ctx.jobs.start` 盯守 → 立即返回 jobId；`wait_seconds>0` 时有界等待（上限 600s） |
| `video_status` | `{ task_id?, limit? }` | 最近任务列表：状态、进度、产物路径与播放 URL、失败原因 | **超时/重启后的唯一入口**；也是"只查不重提"的落地机制 |
| `video_cancel` | `{ task_id }` | `{ cancelled, providerSupported }` | 请求 provider 取消；与 `job_kill`（只停盯守）语义**不同**，必须在描述里写清 |
| `video_export` | `{ task_id, target_path? }` | 导出的工作区路径 | 显式把产物从 `$DSH_HOME` 复制进工作区，供 `present`/交付 |

契约遵循 `docs/cookbook/adding-a-tool.md`：`output.schema` 声明**一个**规范 JSON 值、`output.render` 给人看的文案、`output.presentationMeta` 提供卡片所需的有界事实（产物 id、duration、宽高、provider），`presentCall`/`presentResult` 必须**纯函数**（回放也会跑）。`isConcurrencySafe: () => false`（生成是付费且重资源操作）。每个工具自己设 `timeoutMs`（`dsh-guard-timeout-policy` 只做协作式取消）。

素材来源：**工作区绝对路径**（读成 `data:` URL，方舟文档明确接受 base64）与 **http(s) URL**（透传）；两者都带 digest，指纹因此对"用了哪张图"敏感，而不只对提示词敏感。`first_frame`/`last_frame` 与 `reference_images` 互斥；上限图 20 MB / 视频 100 MB；提示词要求模型先 `read` 确认本地文件存在。

> **会话附件 id 本期未实现（M1 有意收窄）**：附件库读图需要完整的 `ImageAttachmentRef`（id + 已校验的媒体类型/字节数/尺寸），光是 id 推不出来，硬做等于猜。工具会明确回"暂不接受附件 id，请给绝对路径或 URL"，而不是半可用。补它需要拿到会话附件的完整 ref，列为 M2 项。

**重复提交拦截放在宿主层**：以 `sha256(canonical params)` 为指纹，同一指纹在 `dedupeWindowSeconds` 内直接拒绝并回既有 task 的 id。

## 5. 能力面 B：Web 面板

> **2026-10-15 规划修订（目标设计见 §16.4）**：工作台页（`main` + `sidebar.panellist`）删除，面板 API 的 `generate` 一并删除；聊天卡片承担进度显示与取消；配置卡、badge、`overview` / `cancel` / `media` 路由保留。本节下文仍是 M2.1 的实现状态。

| slot | 用途 | 与初稿的差异 |
|---|---|---|
| `tool.call.toolview`（按线名 keyed） | `video_generate` / `video_status` 的结果卡片：`<video controls>` 播放器 + 任务状态 | — |
| **`main` + `sidebar.panellist`（同一个 id）** | **工作台页**：提交生成、参数预设、任务与产物列表 | **原定 `shell.overlay`，实测改掉** |
| `shell.overlay`（badge） | 会话内"有 N 个任务在跑"的环境提示 | 由工作台降级为提示 |
| **`plugins.bundle.config`（主）→ `settings.plugins.tab`（回退）** | 供应商与模型配置：**从「本版本支持的供应商」里挑（可加多个）**、协议/默认供应商/默认模型都是选项、Base URL、**Key（掩码显示 + 可写入）**、模型能力矩阵 | **原定 `settings.section`**；M2.1 由 JSON 文本框改为表单 + 选项 |
| `conversation.view` | 任务/产物 tab（可选，二期） | — |

三条实测理由（都会在开发手册里踩到）：

1. **工作台不该放浮层**。`shell.overlay` 的官方定位是「badge、toast、status pill」，10 个既有占用者是 1 个全窗面板 + 3 个 modal + 6 个 toast，**没有任何一个常驻面板**；而且该层是 `pointer-events: none` + `> * { auto }`，一个铺满的 wrapper 会挡住整个应用。真正的面板一律是 **`main`（keyed）+ `sidebar.panellist`（同一个 id）**：`main` 给面板分配空间，shell 自己管侧栏按钮/高亮/标签。`shell.overlay` 保留给环境提示（badge 在没事时 `return null`，这是官方约定）。
2. **配置卡的家是 `plugins.bundle.config`，不是 `settings.section`**。dsh 0.1.7 起把「插件自己的配置」从 Settings 搬到侧栏 Plugins 页，`plugins.bundle.config` 以**包名**为 key 渲染在该 bundle 的详情页；`settings.plugins.tab` 是没有挂插件管理页时的唯一回退位。两个座位**同时**注册会重复，所以走 `config-card-seat.ts` 的"尝试主位 → 被拒则回退 → 主位晚到时迁移"策略（`register` 对未声明座位**抛错**，这个拒绝就是回退信号；`slots/changed` 在 `register`/dispose 内部同步触发，故必须有重入闩锁）。
3. **配置读写走 `ctx.configForms`**（经 `ctx.get('configForms')` 取，避免插件与宿主 cordis 类型身份不一致），写用 `mutate([{op:'set', path:[...], value}])`：拒绝返回 `false`、传输失败才 reject。config 的命名空间就是 profile 行的 `id`（`video-forge`），所以卡片要等 `whileServed(['video-forge'])` 成立再注册。

卡片从 `ToolCallBlock` 的 args / content / metadata 派生，不做工具调用的反向依赖，畸形输入回退通用行。媒体播放走 §9 的自建路由。

> **工作台的浏览器侧不能调工具**（工具调用属于 agent 回合），所以它有自己的一族宿主路由：`/video-forge/api/{overview,generate,cancel,export}`。这一族**不是**薄壳——它调用的正是 `operations.ts` 里工具用的同一批函数，浏览器提交与模型提交不可能在校验、去重、盯守上分叉。
>
> **信任门**：harness 只认证自己的 index 与 bundle，**不**拦插件路由，所以这一族自带闸门——本机回环放行，已配对设备放行（`remoteWebUiPairing` 在时装），未配对的局域网浏览器 403；socket 地址为准，`X-Forwarded-For` 永不采信，并要求浏览器的同源标记。MEDIA 路由则用 128-bit token 授权，两者策略不同且都写明了理由。
>
> **密钥两条通道，职责不同**：**写**走官方的 `ctx.remote.credentials.{describe,set,unset}`（客户端 `inject` 需含 `'remote','remote.credentials'`）——凭据域归宿主管，插件不自己写文件、也不经自己的路由搬密钥；**读**（"已配置 / 来源 / `sk…1234`"）由本插件自己的 `/video-forge/api/overview` 算，因为官方通道**任何读方法都不返回密钥值**，只有 `{configured, source, writable}`。密钥值**只单向流动**：进 password 输入框 → 送宿主 → 立刻从组件状态里丢掉，页面上永不回显，也不进日志。凭据行按 **config 里声明的 `authRef`** 渲染（不是按 overview 返回的 provider），这样面板 API 不可达时——也就是最需要修 key 的时候——照样能设 key。

**配置界面（M2.1，2026-10-14）**：供应商列表原本是一个 JSON 文本框（"全能力、不自造控件"），实际用起来是把 schema 背给操作者。现在改为**行编辑器 + 预设目录**，细节见 §8.1。

## 6. 长任务、恢复与取消

**台账**（`$DSH_HOME/dsh-video-forge/tasks.json`，原子写）：

```jsonc
{ "version": 1, "tasks": [{
  "localId": "v-20261013-0001", "provider": "ark", "protocol": "ark-seedance",
  "model": "doubao-seedance-1-0-pro", "providerTaskId": "…",
  "status": "submitting|unconfirmed|queued|running|succeeded|failed|cancelled|orphaned",
  "progress": 0.42, "submittedAt": "…", "updatedAt": "…",
  "paramsFingerprint": "<sha256>", "params": { /* 已脱敏 */ },
  "artifacts": [{ "path": "$DSH_HOME/…/v-….mp4", "bytes": 12345678,
                  "mime": "video/mp4", "width": 832, "height": 480,
                  "durationSec": 5.2, "token": "<128-bit>", "createdAt": "…" }],
  "error": null
}]}
```

**盯守**：`ctx.jobs.start({ kind:'video', label, owner, run })`，`owner` 是**会话 id**（`exec.agent.id`，不是 Agent 对象——文档 `adding-a-tool.md` 写的 `owner: exec.agent` 会在运行期抛错）。`run(job)` 拿到的是 **`JobHandle`**（`append` / `updateProgress`），不是 `ctx`。`run` 每 `pollIntervalMs`（默认 5000，按 provider 能力矩阵可调）查一次 provider，把进度按行推进 job 输出环（模型用 `job_output` 读，人在 Web 任务列表看），到终态结算并附产物摘要。工具发布 jobId 之后使用**任务自有的取消信号**，不再用 `exec.signal`（后者只影响本次调用的等待）。

> **M0 那个"无前例"的问号已经落地（2026-10-13 实测）**：`ctx.jobs` 确实能用，但有一个**作用域围栏**——`jobs-local` 的 `servesOwner()` 要求"从 owner 作用域可达的层里存在 controller"，而 `@deepseek-ai/dsh-tool-jobs` 的 controller 是**按 agent 作用域**挂载的。因此：
> - 从**工具的 execute** 里带 `owner: exec.agent.id` 启动 → 正常，`job_output` / 完成通知 / `job_kill` 全都按设计工作；
> - **无 owner 启动**（例如 `apply()` 里的重启对账，那时没有活着的 agent）→ 一律抛 `background jobs unavailable: no job controller serves this agent`。
>
> 结论：watch 的**轮询循环与驱动方式解耦**。同一循环有两个驱动——`startWatch()`（job，agent 作用域）与 `startInProcessWatch()`（定时器，无 agent 时用，进度只进日志与台账，`video_status` 是读取面）。这条也修正了一个真实缺陷：早先对账把"起不了 job"误判成"联系不上 provider"，把健康任务标成 `orphaned`——现在两者的失败路径严格分开。

**重启恢复**：`apply()` 读台账；`status ∈ {queued, running}` 的任务先查一次 provider 实际状态再决定，标为 `orphaned` 并在 `video_status` 中列出——**不假装还活着，也不重提付费**。模型可对 `orphaned` 任务显式"重新盯守"。

**提交顺序：先写意图再提交（2026-10-15）**：`generate()` 在发 POST 之前，先在台账里写一条带指纹的 `submitting` 记录（去重与并发检查在同一把写锁里再做一次，两个并发提交挤不过去）。工具在台账读完之前就已注册，所以提交与一切写入都先等 `ledger.ready()`，否则一次早到的提交既看不见已有的重复记录，又会把它们从磁盘上冲掉。之后按结果分三种：

- 供应商返回了任务 id → 补上 `providerTaskId`，转 `queued`，开始盯守。
- 明确失败（供应商自己的 HTTP 4xx 或 500 错误体），或请求根本没发出去 → `failed`，`error.code = 'not_submitted'`。供应商侧没有任务，所以这种记录**不拦重试**。
- 结果说不清（网络错误、超时、408 与 502/503/504/52x 这类超时或网关错误——上游可能已经接受了请求、2xx 却读不出 id、进程死在请求途中）→ `unconfirmed`，`error.code = 'submit_unconfirmed'`，文案写明"可能已在供应商侧创建并计费，请勿重复提交"。它在去重窗口内照样拦住同一指纹，`video_status` 照常列出；它**不占并发名额**，因为在没有列表接口的协议上它永远解不开。

本次调用的取消信号只在发送前有效（写意图之前最后检查一次）。POST 发出后改由 `requestTimeoutMs` 限时，调用被取消也会把提交跑完、记下 id 并开始盯守——中止一个已经发出的请求只会丢掉回执，丢不掉任务。

重启对账（`src/reconcile.ts`）先处理 `submitting` / `unconfirmed`，再处理 `queued` / `running`。遗留的 `submitting` 说明上个进程死在请求途中，先转 `unconfirmed`。方舟用任务列表 `GET {base}/contents/generations/tasks`（7 天窗口，每页 20 条，新的在前）找 `[submittedAt − 2 分钟, submittedAt + requestTimeoutMs + 2 分钟]` 内、同一模型、且没被台账里其他记录认领的任务：**恰好一个**就接管（补 id、转 `queued`，再走常规对账与盯守）；零个、多个、列表读不到、翻了 10 页还没翻到提交时刻、超过 7 天，都保持 `unconfirmed`，并把原因写进 error。列表项不带提示词，只有模型和时间，所以**同一模型下另有一条未解决记录与它的时间窗重叠时，一律不接管**：否则 A 可能领走 B 的任务，B 被报成"多半没建"，再提一次就付两次钱。同一账号下别的客户端在同一时间窗里建的任务也会成为候选，这是列表能给的极限，多于一个就不认。对账的每次写入都在锁内重查行状态，并跳过本进程正在提交的行，不会覆盖一条刚被正常提交补上 id 的记录，也不会给它再起一个盯守。`filter.model` 只认推理接入点 id（`ep-…`），所以模型名在客户端比对。MiniMax 与 `generic-openai-videos` 没有列表接口，只能如实展示。任何情况下都不自动重提。台账读入时也不丢行：不认识的状态读成 `orphaned`，`queued`/`running` 却没有供应商 id 的读成 `unconfirmed`。

**取消语义（两件不同的事）**：`job_kill` = 停止盯守（不再轮询，provider 侧继续跑）；`video_cancel` = 请求 provider 取消（协议支持时）。两者都要在工具/job 描述里写明，避免模型误以为 kill 就等于停止计费。

## 7. 供应商适配层（协议表）

模型引用格式 `providerId::modelId`（抄 `dsh-iris`，模型只搬引用、不展开密钥）。

| 协议 | 覆盖 | 状态 | 关键差异 |
|---|---|---|---|
| `generic-openai-videos` | OpenAI 兼容 `/v1/videos` 的在线通道：各类中转站、Sora 类供应商、自建网关 | **首期** | 提交/查询路径与 taskId/状态/URL 字段用 dot-path 配置，端点不硬编码 |
| `ark-seedance` | 火山方舟 Seedance（`doubao-seedance-*`） | **首期** | payload 形状与上一家不同（`content[]` 多模态 + `ratio`/`duration`/`watermark`），任务查询是 `GET /contents/generations/tasks/{id}`，按 `model` 名分流 |
| `minimax-video` | MiniMax 视频生成 V2（`MiniMax-H3` / `MiniMax-H3-Max`） | **已接**（2026-10-15） | `content[]` 与 Seedance 同形同角色名，但提交/查询路径、`task_id`、查询体包在 `task` 下、`aigc_watermark`、**无取消**；`resolution`/`duration` 必填 |
| `kling`（可灵） | 官方 API（AK/SK → JWT 签名）/ 官方 MCP（OAuth） | 二期 | 优先官方通道；OAuth 走 `mcp-remote` 时**不落任何 key** |
| `gemini-veo` | 浏览器登录态 | 二期，**默认关闭** | 前例明示 ToS 与封号风险，开启需显式确认 |

本地推理协议（原 `openai-videos` 的 mlx-serve 分支）**已撤销**：不再有 `rgb8` 帧解码、不再有 `pcm_s16le` 音频、不再需要本地 mux 与 ffmpeg 探测。产物一律是 provider 直接给出的 MP4 下载 URL。

能力矩阵（每个模型声明）决定参数校验与提示：`t2v / i2v / flf2v / s2v`、是否有原生音轨、支持的分辨率与宽高比、时长范围与是否离散、是否有原生水印开关、单次可生成条数、轮询间隔建议、**是否支持取消**、`authMode`（`api-key` / `oauth` / `none`）、是否异步任务制（部分通道是同步阻塞返回）。**不再有 `muxNeeded` 与帧数阶梯**（那是本地推理才有的约束）。

### 7.1 首期两家的实测形状（2026-10-13 查官方文档钉死）

**`ark-seedance`**（[创建](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh) / [查询](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh) / [列表](https://docs.volcengine.com/docs/ark/list-video-generation-tasks-api?lang=zh) / [取消](https://docs.volcengine.com/docs/ark/cancel-or-delete-video-generation-tasks-api?lang=zh)）

```
POST   {base}/contents/generations/tasks        Authorization: Bearer $ARK_API_KEY
  body: { model, content:[{type:'text',text}|{type:'image_url',image_url:{url},role:'reference_image'}|{type:'video_url',...}],
          ratio, duration, resolution, frames, generate_audio, watermark, seed, camera_fixed,
          return_last_frame, draft, service_tier, callback_url, execution_expires_after, priority }
  resp: { id: "cgt-…" }
GET    {base}/contents/generations/tasks/{id}
  resp: { id, model, status, content:{ video_url }, usage, created_at, updated_at, seed,
          resolution, ratio, duration, framespersecond, error }
GET    {base}/contents/generations/tasks?filter.status=…&page_size=…    # 列表，7 天窗口
DELETE {base}/contents/generations/tasks/{id}   # 只能取消**排队中**的任务；成功返回 {}
```

- 默认 base：`https://ark.cn-beijing.volces.com/api/v3`；产物 URL **有效期 24 小时**（Seedance 2.5 另有 100 次下载上限）→ 必须尽快落盘（§9）。
- 首期这一家**不需要 dot-path 配置**，字段名直接写在适配器里；只有 `generic-openai-videos` 需要（中转站形状不保证）。
- **模型目录（2026-10-14 按官方[创建视频生成任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)与[模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=zh)核对，固化在 `provider-presets.ts`）**：API 可调用的是 2.5 / 2.0 / 2.0 fast / 2.0 mini / 1.0 pro / 1.0 pro fast 六个；1.0 lite 与 Seaweed 只在控制台体验，不进预设。模型列表**拿不到在线目录**：管控面 `ListFoundationModels` 只认 AK/SK 签名，插件只持有推理用的 API Key，返回里也没有时长/分辨率等能力字段。

  | Model ID | 模式 | resolution | duration（秒） | generate_audio |
  |---|---|---|---|---|
  | `doubao-seedance-2-5-260628` | t2v / i2v / flf2v / s2v | 480p, 720p, 1080p（默认 720p） | 4–30，或 -1 | ✅ 默认 true |
  | `doubao-seedance-2-0-260128` | t2v / i2v / flf2v / s2v | 480p, 720p, 1080p, 4k（默认 720p） | 4–15，或 -1 | ✅ |
  | `doubao-seedance-2-0-fast-260128` | t2v / i2v / flf2v / s2v | 480p, 720p | 4–15，或 -1 | ✅ |
  | `doubao-seedance-2-0-mini-260615` | t2v / i2v / flf2v / s2v | 480p, 720p | 4–15，或 -1 | ✅ |
  | `doubao-seedance-1-0-pro-250528` | t2v / i2v / flf2v | 480p, 720p, 1080p（默认 1080p） | 2–12（另有 `frames`） | ❌ |
  | `doubao-seedance-1-0-pro-fast-251015` | t2v / i2v | 480p, 720p, 1080p（默认 1080p） | 2–12（另有 `frames`） | ❌ |

  `ratio` 全部取自 `16:9 / 4:3 / 1:1 / 3:4 / 9:16 / 21:9 / adaptive`，但有两条**按任务类型**的限制无法写成按模型的列表，留给供应商报错：2.5 的首帧/首尾帧任务只收 `adaptive`；1.0 的文生视频不收 `adaptive`。`duration: -1`（2.x 智能选时长）不进列表——不传 duration 就交给供应商的默认值（2.5 的默认正是 -1；2.0 系列文档没写默认值），不必让工作台解释一个哨兵值。2.x 的参考视频/参考音频、视频编辑/延长、样片模式，适配器尚未接（`content[]` 只发文本与图片）。

**`generic-openai-videos`**（OpenAI Videos 兼容面）

```
POST {base}/videos   { model, prompt, seconds, size }        → { id, status, progress?, … }
GET  {base}/videos/{id}                                       → { id, status, progress?, url?, … }
GET  {base}/videos/{id}/content                               → 二进制 MP4（有的中转在对象里回 url，两条都要支持）
DELETE {base}/videos/{id}                                     → 取消
status ∈ { queued, in_progress, completed, failed, cancelled }；completed 后取内容
```

- 已知差异（写进能力矩阵与降级路径）：`seconds` 有实现是字符串、有实现是数字；完成判定统一看 `status == 'completed'`，产物优先取 `url`/`data.0.url`（dot-path 可配），缺字段则回落到 `/content`。
- 该协议**必须允许覆盖四个路径与提取点**（`endpoints.submit/query/content/cancel` + `statusPath`/`resultUrlPath`/`idPath`/`errorPath`），因为中转站的字段层级不保证。

**`minimax-video`**（2026-10-15 按 [创建](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create) / [查询](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query) 核对）

```
POST {base}/v2/video_generation                Authorization: Bearer $MINIMAX_API_KEY
  body: { model, content:[{type:'text',text}|{type:'image_url',image_url:{url},role:'first_frame'|'last_frame'|'reference_image'}|…],
          resolution, duration, ratio, extra?, callback_url?, aigc_watermark }
  resp: { task_id: "424010985738629" }
GET  {base}/v2/query/video_generation/{task_id}   # 只查得到 7 天内的任务
  resp: { task: { id, model, status, error?:{code,message}, content?:{url}, resolution, duration, ratio, usage, … } }
status ∈ { queued, running, succeeded, failed, cancelled }
错误体是 OpenAI 风格 { type:'error', error:{ type, message, http_code }, request_id }，非 2xx 由 requestJson 统一带摘录抛出
```

- 默认 base：`https://api.minimax.cn`（路径自带 `/v2`，base 不带版本号）；产物 URL 有时效但文档未写多久，重新查询会给新地址 → 同样尽快落盘（§9）。
- `content[]` 与 Seedance 同形、角色名相同，适配器直接复用 `buildArkContent`；角色名仍取模型的 `frameRole*` 配置。
- **必填项在提交前拒绝，不替用户猜**：`resolution`、`duration` 必填且文档没有默认值；文生视频必须给具体 `ratio`（不收 `adaptive`）。首帧/首尾帧任务的 `ratio` 由图片决定，传了也被忽略，所以照传不拦。
- **没有取消接口**：适配器 `cancelable: false`，预设模型的 `cancelable` 也是 `false`，配置卡上不会显示成"可取消"。`cancelled` 只作为状态出现。
- 文档没有音轨开关，不发 `generate_audio`；`aigc_watermark` 显式发 `false`。
- 模型目录（固化在 `provider-presets.ts`，分辨率保留官方的大写拼写，适配器原样转发）：

  | Model ID | 模式 | resolution | duration（秒） |
  |---|---|---|---|
  | `MiniMax-H3` | t2v / i2v / flf2v / s2v | 768P, 2K | 4–15 |
  | `MiniMax-H3-Max` | t2v / i2v / flf2v / s2v | 480P, 768P（默认 768P） | 5–15 |

  `ratio` 取自 `21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / adaptive`。尚未接：H3-Max 的 `extra.prompt_expansion_mode`（config schema 没有对应字段）、参考视频/参考音频、仅尾帧任务（`VideoMode` 里没有这种形态）、`callback_url`。

## 8. 配置与凭据

Config 用 **schemastery**（`@deepseek-ai/schemastery`，DSH 的设置层就是这个）声明；**设置命名空间就是 profile 行的 `id`**（`video-forge`），没有单独的注册调用。

> 两处与初稿不同，都是实测修正：**不是 zod**；**没有 `scope.watch`**——它全仓库不存在，活配置机制是 schemastery 的 `.volatile()` + `ctx.on('loader/volatile-update', …)`。volatile 字段解析出来是引用（要 `.get()` 取当前值），所以运行时每次操作都调一次 `snapshot(config)` 取一份普通值：这样既拿到最新配置，又不会在一次调用里看到新旧混杂的半个配置。工具与路由都按需读快照，**因此配置变化不需要重新注册任何东西**。

```jsonc

```jsonc
{ "enabled": true,
  "providers": [
    { "id": "ark", "protocol": "ark-seedance",
      "baseUrl": "https://ark.cn-beijing.volces.com/api/v3", "authRef": "ARK_API_KEY",
      "models": [{ "id": "doubao-seedance-1-0-pro", "modes": ["t2v","i2v"],
                   "durations": [5,10], "resolutions": ["720p","1080p"],
                   "aspectRatios": ["16:9","9:16","1:1"], "cancelable": true }] },
    { "id": "relay", "protocol": "generic-openai-videos",
      "baseUrl": "https://example-relay.example/v1", "authRef": "RELAY_VIDEO_KEY",
      "endpoints": { "submit": "/videos", "query": "/videos/{id}",
                     "resultUrlPath": "data.0.url", "statusPath": "status" },
      "models": [{ "id": "sora-2", "modes": ["t2v"], "cancelable": false }] }
  ],
  "defaultProvider": "ark", "defaultModel": "doubao-seedance-1-0-pro",
  "outputDir": null,                 // null → $DSH_HOME/dsh-video-forge/outputs
  "pollIntervalMs": 5000, "waitSecondsMax": 600,
  "dedupeWindowSeconds": 120, "maxConcurrent": 1,
  "retain": { "maxTasks": 200, "maxGiB": 20 } }
```

密钥解析顺序（**必须按对象解构**）：settings scope → `ctx.credentials.resolve(authRef)` 取 `.value` → 环境变量 `<PROVIDER>_API_KEY`。缺失时**带准确 key 名报错**，不做跨供应商静默回退。UI 只回 `sk-…末4位`。

> 前例踩过的坑：`ctx.credentials.resolve()` 返回 `{ value, source } | undefined`，而某个插件写的是 `typeof resolved === 'string'`，导致它**从未命中**、实际只跑环境变量。

### 8.1 配置界面（M2.1，2026-10-14）

配置卡的第一版把 `providers` 当 JSON 文本框编辑，默认供应商/默认模型是自由文本输入框。问题不在能力（文本框确实能表达一切），而在**它要求操作者先把 schema 背下来**：协议名、`authRef` 的命名约定、模型 id 的一个字符之差，都只能在运行时报错。改动如下：

| 原本 | 现在 | 为什么 |
|---|---|---|
| 默认供应商/默认模型 = 文本框 | **下拉选项**（供应商来自当前列表；模型来自所选供应商） | 二者必须是已声明集合里的元素，自由文本只能产生"未知供应商/未声明模型"这类运行时错误 |
| 新增供应商 = 手写 JSON | **预设目录下拉 + 添加**（`provider-presets.ts`：方舟 Seedance / OpenAI Sora / 自建网关或中转） | "本版本支持的供应商"是有限的、已知的；预设把协议、Base URL、`authRef`、起步模型一次填好，仍可逐项改 |
| 协议 = 字符串 | **下拉选项**（`SUPPORTED_PROTOCOLS`） | 协议名的唯一真值来自实现；文案走 locale（`config.protocol.<id>`），不复用协议名当界面文本 |
| 模式 = 字符串数组 | **四个复选框**（`VIDEO_MODES`） | 少一个模式就是一个运行时会被拒的请求 |
| 只能有 0/1 个供应商（要加就是整段重写） | **任意多个**，自动去重 id（`ark` → `ark-2`） | 同一家两条通道（如官方直连 + 自建中转）是正常配置 |

四条实现约束（都会在别处再遇到）：

1. **目录是数据，不是代码分支**。`provider-presets.ts` 不 import 任何适配器、任何 `node:` 内置，因此浏览器半区可以内联它；`SUPPORTED_PROTOCOLS` 是**单一声明**——`settings.ts` 的协议联合、`config.ts` 的 schemastery union、协议表 `providers/index.ts` 全部由它派生，并有一个编译期断言（`[Exclude<…>] extends [never]`）保证"实现了但没列进选项"不可能发生。预设的模型能力列表**故意留空**：按 `assertGeometry` 的语义，空 = "交给供应商决定"，凭空写一个时长才是真错。
2. **表单与 JSON 是一个值的两个视图，不是两份状态**：`edit` 只有三种形态——"未改动"、"行编辑（drafts）"、"文本编辑（text）"。行编辑后文本由表单重新生成；文本编辑后行由文本解析生成。保存时以**当前活着的那个视图**为准，且**文本视图原样写入**（不重新规范化），所以两种入口不会各写一半。JSON 视图收在 `<details>` 里，JSON 坏掉时自动展开。
3. **写之前先校验，且校验要能被读懂**：`validateDrafts` 返回带行号的 `DraftProblem`（供应商 id 空/重复、Base URL 空、模型 id 空/同供应商内重复），由 locale 组织成句子（如"第 3 个供应商没有 Base URL。"）。宿主 schema 仍是最终门禁，这里只是把错误从"保存失败"变成"改哪一行"。**JSON 视图也跑同一套校验**，否则文本框就成了绕过校验的后门。
4. **表单没露出的字段原样带过**（`rest`）：`endpoints`（dot-path）、`sizes`、`pollIntervalMs`、`frameRole*` 等仍只能从 JSON 编辑，但一次行编辑**不会**把它们丢掉——"表单没显示"不等于"可以删除"。

> 界面细节记录的坑：**带值的 key 会导致输入框失焦**。行与模型的 React key 必须用索引（这些行是按位置编辑的），用 `provider.id` 当 key 会在每次按键时重建整张卡片。同理，列表类字段（时长/分辨率/宽高比）以**文本**为准、按键即解析：严格受控的数组会让 `5, 1` 在输入中途被改写成 `5`。另外，从 JSON 派生的 drafts 必须 `useMemo` 在解析结果上——每次渲染新建数组会让凭据 effect 无限重跑。

## 9. 产物与播放

> **2026-10-15 规划修订（目标设计见 §16.2）**：产物改落工作区的 `renders/<shot>/vNNN.mp4`，旁边放一份同名 `.json` 说明文件；台账仍在 `$DSH_HOME`。媒体路由继续按台账解析路径，但要处理文件被移动或删除、符号链接指向工作区之外等新情况。本节下文仍是 M2.1 的实现状态。

- **落盘**：`$DSH_HOME/dsh-video-forge/outputs/<localId>/`，目录 `0700`、文件 `0600`（POSIX）。不写工作区，避免几十 MB 二进制污染仓库、也不让 `workspace/changes` 每轮把它算成变更。产物从 provider 的临时 URL 下载（provider 侧 URL 会过期，必须落盘）。
- **路由**：`ctx.webServer.register({ kind:'prefix', path:'/video-forge/media', handler })`，形态 `GET|HEAD /video-forge/media/:taskId/:token/:name`。
  - **路径只从台账解析**，绝不接受客户端传来的绝对路径（杜绝穿越）；`:name` 仅作展示。
  - 每个产物一个 128-bit 随机 token，只有 `taskId + token` 完全匹配才命中。
  - **必须实现 Range / 206**：内置换行播放要靠它起步与拖拽；同时 `private, no-store`、`nosniff`、沙箱 CSP。
- **导出**：`video_export` 把产物复制进工作区，之后可由 `present` 变成交付物。
- **容量**：按 `retain` 给提示，清理永远显式，不自动删。

## 10. 日志与回放

不新增会话事件：任务与产物都通过既有 `tool/result` 承载（`presentationMeta` 提供卡片事实）。presenter 必须是 `args`（+结果）的纯函数，禁止在 `presentCall` 里读文件或时钟。若后续要把"素材已注册为交付物"变成模型可见输入，再按"模型可见 ⟺ 记日志"补 `SessionEventMap` 成员并同步 TS/Python SDK 期望输出。

## 11. 安全、权限与合规

- **市场能力声明**：会用到 `network`、`fs-write`、`credentials`（**不再涉及 `shell`**：没有 ffmpeg 探测，也不 spawn 任何命令）。声明与实际行为必须一致。
- **审批**：模型工具调用走 DSH 既有审批与权限档位，插件不自行放宽。
- **密钥**：只留宿主进程，浏览器只看到掩码与 token 化媒体 URL。
- **合规**：`gemini-veo`（浏览器 cookie 逆向通道）默认关闭并显式警告；优先可灵官方 API/MCP 等有授权的通道。
- **上游预稳定**：声明 `dsh.engines.dsh` + 锁步 peer，并用既有的四级证据链做定期兼容性巡检。

## 12. 测试矩阵

| 层 | 必须覆盖 |
|---|---|
| real-composition | 用真实 `cordis.yml` 走 Loader 启动，断言工具注册、路由注册、设置卡片、卸载后全部撤销（HMR dispose） |
| 呈现 | presenter 纯函数 + 用录制会话回放（keyless recorded snapshot） |
| 台账 | 提交→轮询→完成→**重启恢复**；`orphaned` 判定；原子写与并发写 |
| 路由 | token 正确/错误/伪造、Range 206、越权路径、超限响应 |
| 凭据 | 解析顺序、**对象解构**（防前例那个恒不命中的坑）、掩码输出、缺 key 报错文案 |
| 协议 | 对 `fixtures/` 的假 provider 跑通提交/轮询/终态/失败/取消五条路径；dot-path 提取与缺字段降级 |
| 纪律 | 重复提交拦截、并发上限、`job_kill` 与 `video_cancel` 语义区分 |
| 校验 | 互斥参数、体积上限、能力矩阵约束（分辨率/时长/宽高比） |
| i18n | 无硬编码文案（走字典） |
| 可选 | **真实在线 API e2e**（有 key 才跑，无 key 自动跳过） |

**已落地（120 例，`pnpm check`）**：台账 11（损坏隔离、并发写、id 序列、token 成对校验）、协议 19（dot-path、方舟角色/状态映射、中转站路径与 state 归一化、几何与能力校验）、媒体路由 14（真 socket：200/206/416/HEAD/404/405）、工具面 17（互斥、几何、去重、并发上限、取消、导出）、fixture 端到端 9（两种协议的成功/失败/取消/放弃/进程内驱动）、**面板 API + 信任门 13**（真 socket + 伪造 socket：403、掩码不泄漏、提交/取消/导出、错误映射）、**座位策略 5**（主位/回退/晚到迁移/重入/释放）、**客户端注册 7**、**卡片推导与渲染 11**、**配置卡写路径 14**（jsdom + testing-library：path op 形状、非法 JSON 拒写、拒绝态、密钥写入/清空/只读/空值拒发/拒绝信息原样显示/**值不回显也不残留在 DOM**）。绝大多数用例不依赖 DOM；只有配置卡那 14 例用 jsdom，卡片渲染用 `react-dom/server`。

## 13. 验证纪律（隔离实例，硬性）

**验证一律另起实例，绝不使用正在运行的 dsh。**

- 正在运行的实例是 `http://127.0.0.1:3080/`（`DSH_HOME=~/.dsh`、profile `web`），它是用户的工作环境：往里装插件、改设置、跑付费生成都会污染真实配置与会话。
- 验证实例固定参数：

  ```
  DSH_HOME=/tmp/dsh-video-studio-verify/home      # 独立身份：独立凭据、独立设置、独立会话
  dsh web --port 34781                            # 独立端口，避开 3080
  CLI: npm 实包 @deepseek-ai/dsh@0.2.0-rc.2        # 不用本地 checkout 的 dev CLI
  代码: /tmp/dsh-video-studio-verify/shadow        # 隔离影子副本，原仓库保持 clean
  ```

- 为什么不用本地 checkout 的 dev CLI：`~/.local/bin/dsh` 是指向本地仓库 `apps/cli/src/bin.ts` 的 wrapper，其 HEAD/tag/工作区状态会污染"通道级"结论（记忆 `wu-compat-verification-negative-control-and-real-cli-b3e0b116`）。任何兼容性/可安装性结论必须建立在 **npm 实包 + 隔离 `DSH_HOME` + 隔离影子副本** 上。
- 加**负对照**：跑一个必然失败的门禁用例（如 peer 区间 `^0.0.1` 的假插件）确认门禁真的在拦，否则 exit 0 无法区分"通过"与"没跑"。
- 收尾必须清理：`job_kill` **不会**杀掉宿主孙进程，会留下仍占端口的孤儿 host。收尾用 `job_list` + `ps`（核对 `cwd` 与 `DSH_HOME`）+ 端口检查，确认进程已退出后再删临时目录（记忆 `wu-job-kill-orphans-background-host-process-a997869b`）。
- 在线 API 验证分两档：**离线 fixture**（`fixtures/` 里的假 provider，仿真首期两家协议的请求/响应形状）覆盖全链路回归；**真实 key e2e** 只在有 key 时手工跑一次，结果回写本文。fixture 只能证明"我们的形状假设自洽"，不能替代真实通道证据——这条差距要在交付话术里说清。
- **环境必须清干净**：DSH 会通过环境变量把"我是哪个实例"传下去（`DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` / `DSH_SESSION_ID` / `DSH_SHELL` / `DSH_WEB_URL`）。从当前会话里直接起第二个实例会**继承**这些值，`--profile web` 会立刻报 `select a profile only once`。验证实例要这样起：
  `env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_SHELL -u DSH_WEB_URL DSH_HOME=/tmp/… dsh web --port 34781 --no-open`
  （`--no-open` 是必须的：默认会去开你桌面上的浏览器。）

**2026-10-13 隔离实例实测结果（`DSH_HOME=/tmp/dsh-video-studio-verify/home`、端口 34781、npm 实包 `@deepseek-ai/dsh@0.2.0-rc.2`）**：

| 检查 | 结果 |
|---|---|
| 安装门禁（正向） | `dsh plugin --profile web add dsh-video-forge-0.1.0.tgz` → exit 0 |
| 安装门禁（**负对照**） | 同环境装一个 peer 区间 `^0.0.1` 的假插件 → exit 1，报 `installation rejected … incompatible with dsh 0.2.0-rc.2`。门禁是真在跑，故上面的 exit 0 才有意义 |
| composition | `--profile web --dump-config` 里出现 `id: video-forge / name: dsh-video-forge`，无「跳过/不兼容」 |
| 客户端半区 | 启动载荷里含 `dsh-video-forge/client.js`；combo 包（10.4 MB，HTTP 200）里能查到本插件的注册 id、英文卡片文案 `Generation failed` 与中文 `取消视频任务`——说明卡片与双语字典都被真实装载 |
| 宿主半区（长任务真链路） | 往台账塞一条 `running` 任务、重启实例：对账 → 查 provider → 仍在跑 → **进程内接管盯守** → 轮询到 `succeeded` → 下载 64 KiB 到 `$DSH_HOME/dsh-video-forge/outputs/v-20261013-0001/v-20261013-0001.mp4`（目录 `0700`、文件 `0600`）→ 台账落 `succeeded` + 128-bit token |
| 媒体路由（真 HTTP） | `GET /video-forge/media/<task>/<token>/x.mp4` → 200、`video/mp4`、`accept-ranges: bytes`、`private, no-store` + `nosniff` + 沙箱 CSP；`Range: bytes=100-199` → **206 + `content-range: bytes 100-199/65536`**；错 token → 404；落地字节与磁盘文件 sha256 一致 |
| 收尾 | `job_kill` 之后用 `lsof` + `ps` 复核 34781 / 34799 已释放、无孤儿进程；用户正在用的 3080 实例**全程未被使用**（未认证、未安装、未触发任何生成） |

**尚未被证据覆盖**：真实在线通道（本机凭据库里只有四个 LLM key，没有任何视频供应商 key；本机在用的中转也只提供文本/图像模型，没有视频模型）与真实浏览器里的播放/卡片观感。

**2026-10-13 M2 追加实测（同一隔离实例，全新 profile 重装）**：

| 检查 | 结果 |
|---|---|
| 客户端半区（M2 座位） | combo 包（10.5 MB，HTTP 200）里能查到 `plugins.bundle.config`、`sidebar.panellist`、`shell.overlay`、`video-forge/api` 与中英文案（`视频工坊` / `Video workbench`）——两个新座位与工作台确实被装载 |
| 信任门 | `GET /video-forge/api/overview` 从回环 → 200；从伪造的非回环 socket → 403（单测覆盖）；`GET /` 仍 401（harness 自己的登录墙），说明面板 API 的放行策略与 UI 登录墙是**两件独立的事**，前者按 §5 的回环/配对门 |
| **面板提交真实跑通** | `POST /video-forge/api/generate` → 200，任务落台账；宿主进程内盯守把 fixture 轮询到 `succeeded`，下载 64 KiB 到 `$DSH_HOME/dsh-video-forge/outputs/v-20261013-0001/`（`0700/0600`）；`overview` 随后返回 `progress: 1` 与文档相对的 `playUrl` |
| 播放链路 | 面板给出的 `playUrl` 直接 `GET` → 200 `video/mp4` + `accept-ranges`；`Range: bytes=0-99` → 206；**sha256 与宿主写入的文件一致** |
| 密钥写入通道存在 | 浏览器运行时确实装载了 `credentials` remote：预加载批次里能找到 settings-controller 生成的 remote client（`describe` 参数/结果 codec 齐全），方法签名与卡片调用的一致（`describe(refs[])` → `Record<ref,{configured,source?,writable}>`、`set(ref,value)`、`unset(ref)`） |
| 密钥状态（掩码） | 往隔离 `$DSH_HOME/.credentials.yaml` 写入 `ARK_API_KEY` 后，`overview` 返回 `{configured:true, source:"file", masked:"sk…1234"}`，且响应体**不含密钥值** |

**2026-10-14 M2.1 追加实测（配置界面；隔离实例 + 真浏览器）**：

环境同上（`DSH_HOME=/tmp/dsh-video-studio-verify/home`、端口 34781、npm 实包 `@deepseek-ai/dsh@0.2.0-rc.2`）。这次不只看字节：`dsh web` 启动时会打印带 token 的地址（`http://127.0.0.1:34781/?token=…`），因此可以用真浏览器把界面走一遍——**上一版"没在真浏览器里看过"的缺口这一轮补上了**（浏览器侧用 `agent-browser` 驱动一个独立 Chrome，不碰用户的浏览器）。

| 检查 | 结果 |
|---|---|
| 安装与装载 | 删掉隔离 profile 重新 `dsh plugin --profile web add dsh-video-forge-0.1.0.tgz` → exit 0；装完的 `lib/client.js` 与仓库构建产物 **sha256 一致**（同版本 tarball 重装会被 pnpm 判 up-to-date、复用旧字节——这一步必须删 profile 重装，见 §13 纪律） |
| 界面到位 | Plugins → Video Forge 详情页里，配置卡渲染出：供应商行、**协议下拉**（`Volcengine ARK · Seedance` / `OpenAI-Videos compatible`）、**"添加供应商"下拉**（方舟 / OpenAI(Sora) / 自建网关）、**默认供应商下拉**（选中的 `fixture`）、**默认模型下拉**（`Fixture Seedance (doubao-seedance-fixture)`）、模式复选框、能力列表、限额与存储字段——即 §8.1 的每一条都在真实宿主里生效 |
| 从预设加一个供应商 | 选 `OpenAI (Sora)` → 点 Add → 出现第二张供应商卡片，**协议已被预设置为 OpenAI-Videos compatible**、`authRef` 为 `OPENAI_API_KEY`、模型为 `sora-2`；凭据行在同一次渲染里多出 `OPENAI_API_KEY` 一行（凭据行跟随编辑中的列表，不是跟随已保存的配置） |
| **保存真的落进宿主** | 点 Save 后卡片显示 `Saved`；随后宿主自己的视图 `GET /video-forge/api/overview` 返回**两个** provider：`fixture / ark-seedance / http://127.0.0.1:34799/api/v3` 与 `openai / generic-openai-videos / https://api.openai.com/v1 / models=[sora-2]`——浏览器编辑 → 宿主配置 → 插件运行时这条链是通的 |
| **客户端校验真的拦得住** | 再加一个"自建网关/中转"预设（Base URL 为空）→ Save → 卡片报 `Save failed` + **`Provider #3 has no base URL.`**，且**没有**发出任何写请求（配置仍是上面那两个 provider） |
| 收尾 | 浏览器 `close --all`；`lsof -nP -iTCP:34781` 为空、`ps` 无遗留宿主进程；用户的 3080 实例（PID 75498）全程未被触碰 |

## 14. 里程碑

- **M0 协议探针（先做）**：用 `fixtures/` 假 provider 钉死两家协议（`generic-openai-videos` / `ark-seedance`）的提交、查询、终态、失败、取消五种响应形状；**同时验证 `ctx.jobs` 承载 provider 侧轮询**这一无前例的设计原语——若不合适，退化为 iris 式自管任务存储（台账独立存在，退化成本低）。有真 key 时补打一次真实 Seedance 出片，钉死真实响应与耗时。
- **M1 骨架（2026-10-13 完成，见 §13 实测表）**：包 + manifest + 4 个工具 + 台账 + 两家协议 + `$DSH_HOME` 产物 + 自建路由（Range/206）+ 播放卡片，81 例测试 + 隔离实例端到端。**未做**：`shell.overlay` 工作台浮层与 `settings.section` 设置卡片（原属 M2）、会话附件 id 素材（§4 说明）、真实在线 key 验证。
- **M2 面板与配置（2026-10-13 完成，见 §13 实测表）**：工作台页（`main` + `sidebar.panellist`）、环境 badge（`shell.overlay`）、配置卡（`plugins.bundle.config` 主位 + `settings.plugins.tab` 回退）、面板 API 族 + 信任门、双语文案、114 例测试。**密钥写入**：走官方 `remote.credentials`（见 §5），卡片里可直接设/清；**未做**：会话附件 id 素材（§4）、真实在线 key 的端到端验证。
- **M2.1 配置界面（2026-10-14 完成，见 §8.1 / §13 实测表）**：供应商改为**预设目录 + 行编辑器**（可加多个、id 自动去重），协议/默认供应商/默认模型改成选项，能力字段进表单，JSON 降级为高级视图；新增 `provider-presets.ts`（纯数据 + 读写/校验），`SUPPORTED_PROTOCOLS` 收成单一声明；客户端校验带行号、JSON 视图同一套校验。测试 120 → **161 例**，并在真浏览器里走通"加供应商 → 保存 → 宿主视图出现两个 provider"与"缺 Base URL 被拦下"。**仍未做**：会话附件 id 素材、真实在线 key 端到端、`conversation.view` 任务 tab。
> **2026-10-15 重排**：以下 M2.5–M6 取代原计划的"M3 协议扩展（可灵/Veo + 成本门控）"与"M4 收口"。可灵/Veo 后移；成本门控拆成"成本可见性"（进 M4）与"预算闸门"（低优先级，暂不做）；原 M4 收口并入 M5。

- **M2.5 真实通道与台账加固（下一步）**：
  - 环境按 §13 的纪律：隔离实例、npm 实包、影子副本。**key 由用户自己在隔离实例里填写**，不经过对话。
  - 花最少的钱：方舟用 `2.0-fast` 或 `2.0-mini`，480p、4 秒；MiniMax 用 `H3-Max`，480P、5 秒。
  - 每家跑：文生视频、首帧图生视频、首尾帧、故意传错参数、运行中重启实例看对账能否接上；方舟另测排队中取消（MiniMax 没有取消接口）。
  - 要钉死的事实：真实响应体（脱敏）、有没有进度字段、各阶段耗时、产物 URL 时效、错误体结构、**被审核拦截时的形状以及是否计费**、方舟 token 公式（§16.5）。结果回写 §7.1 与 §13。
  - 台账开始保存供应商用量；没结算用量的任务在 7 天内补查（§16.5）；审核拦截单独归类（§16.7）。
  - ~~**先写意图再提交**~~（§16.7）：**已完成**（2026-10-15，commit `1f9321c`，细节见 §6；测试 161 → 197 例）。M2.5 里用真实方舟 key 补一次"列表接口找回"的实测。
  - fixture 改成按录制的真实响应回放；另加一个"有 key 才跑、没 key 自动跳过"的在线测试。
- **M3 工作区即项目**（§16.2 / §16.4）：清单与目录映射；`renders/` 版本目录与宿主统一分配版本号；说明文件；角色登记；工具改成 3 个（`shot` / `from` / `characters`、工作区相对路径）；删除工作台页与面板 `generate`；聊天卡片显示实时进度并能取消；修掉"重启后进程内盯守不唤醒模型"；工作区写入的连带问题（`ctx.fs`、权限档位、文件被移动、符号链接）。会改工具 schema，所以放在发布之前。
- **M4 skill、指导与成本可见性**（§16.3 / §16.5 / §16.6）：5 个 skill 经 `ctx.skills` 提供方注册（可选依赖）；`video-guide` 及其一致性测试；`video_status` 的花费汇总与事前估算；预设价格表；用方舟 `return_last_frame` 做模型自检。
- **M5 发布**：仓库与目录改名为 `dsh-video-forge`、加 git remote、GitHub Actions 跑 `pnpm check`、npm trusted publishing / OIDC、README 双语、市场收录（`capabilities` + `locale` + `icon`）。
- **M6 内容片段重构**（§16.8）：**单独一次改造，不与 M3 合并**（2026-10-15 决定）。之后接 Seedance 2.x 的参考视频/音频、编辑/延长、样片模式，以及 MiniMax 尚未接的扩展项。
- **之后**：可灵（AK/SK → JWT）→（可选）Veo（默认关闭）。
- **低优先级 / 待办**：预算闸门（2026-10-15 决定暂不做）、本地 ffmpeg（未决，§16.8）、`conversation.view` 任务 tab（聊天卡片已承担大部分职责，待重新评估）。

## 15. 未决与风险

1. **`ctx.jobs` 的作用域围栏**：M0 已落地（§6），job 只能在有 agent 的上下文里启动。遗留问题：重启后由进程内定时器接管的任务**不会唤醒模型**。工作台删除后对话是唯一界面，这个缺口必须在 M3 修掉。
2. **在线通道的形态差异**：`generic-openai-videos` 假设"提交返回 id → 轮询查询 → 返回下载 URL"，但中转站普遍不保证这套形状（字段名、嵌套层级、是否同步阻塞各不相同），所以端点与字段必须 dot-path 可配。M2.5 会用真实 key 复核方舟与 MiniMax；中转站与 Sora 仍然没有 key，只有 fixture 证据。
3. **成本与限流**：每次生成都是付费调用，且可能触发并发/配额限制。金额只是用量乘以价格表的估算，价格表会过期，真实账单只在供应商控制台。预算闸门暂不做，所以防止模型连续花钱只能靠 `maxConcurrent`、去重窗口、"只查不重提"与 DSH 自身的审批。
4. **云供应商合规**：Veo 那条路有 ToS/封号风险；可灵官方通道更干净。方舟与 MiniMax 不涉及此风险。
5. ~~**npm 包名与原占位名的冲突**~~：已定，仓库与目录改名为 `dsh-video-forge`（M5）。
6. **上游 API 预稳定**：`engines.dsh` 与 peer 需随上游巡检更新（四级证据链见 §13）。
7. **提交响应丢失导致重复扣费**（2026-10-15 发现）：已修复（§6、§16.7）。遗留风险：MiniMax 与 `generic-openai-videos` 没有任务列表接口，`unconfirmed` 的提交只能如实告诉用户"可能已扣费"；方舟的列表找回只按模型与时间匹配，有歧义时宁可不接管，也还没用真实 key 验证过。
8. **方舟 token 公式是反推的**：`宽 × 高 × 帧数 ÷ 1024` 只对上了官方文档里的一个例子，官方没有写明，M2.5 核对。
9. **预设模型目录会过期**：模型 id 带日期，插件只有 API Key、拿不到在线目录。供应商报"模型不存在"时要不要在卡片上提示更新插件或改 id，尚未决定。
10. **skill 依赖宿主组合**：默认 CLI 组合挂了 `dsh-skill` 与 `dsh-tool-skill`，但不能假设所有组合都有。`skills` 做成可选依赖，工具在没有 skill 时也必须能正确工作。
11. **插件写工作区的接口未核实**：插件能否使用 `ctx.fs`、如何拿到会话的权限档位，需要查上游实现后再定方案（§16.2）。
12. **拖进对话的文件会不会落到工作区，未知**：会的话，"拖素材"就等于按路径引用；不会的话，会话附件支持（§4）仍然要做。

## 16. 目标设计（2026-10-15 规划讨论）

本节记录 2026-10-15 规划讨论的结论。它是目标，不是已实现的状态；实施时把落地的部分回写到 §4–§9，并在这里注明。

### 16.1 定位与使用形态

插件**以模型工具为主**。DSH 的对话总是开在某个工作区里，所以用户在这个工作区的对话里就能走完整个视频工作流，不需要单独的页面。

| 使用形态 | 例子 | 范围 |
|---|---|---|
| 一句话出片 | "做一个 5 秒的海边日落" | ✅ |
| 拖素材让它动起来 | "让 materials/cat.png 里的猫转头看镜头" | ✅（附件见 §15 第 12 条） |
| 迭代与续拍 | "镜头 3 再亮一点""接着上一段往下拍" | ✅ |
| 嵌在更大的任务里 | 做网页或 PPT 时生成一段视频素材 | ✅（产物本来就在工作区） |
| 问花了多少钱 | "这个项目的视频一共花了多少？" | ✅（§16.5） |
| 按分镜批量生成 | "把 shots.yaml 里的镜头全部生成" | ❌ 一次一个镜头 |
| 拼接成片 | "把这几段接成一个片子" | ❌（ffmpeg 待办，§16.8） |

### 16.2 工作区即项目

```
<workspace>/
  video-project.yaml          # 清单：默认模型、画幅、分辨率、项目风格提示词、角色、目录映射
  script/                     # 剧本
  storyboard/shots.yaml       # 分镜：镜头 id、描述、时长、引用的素材（参考文本，不批量生成）
  materials/                  # 角色、场景参考图，音频
  renders/<shot>/v001.mp4     # 产物，按镜头分目录、按版本编号
  renders/<shot>/v001.json    # 说明文件
  .dsh-video/                 # 插件自己的缓存
```

- **默认布局 + 清单映射**（P10）：上面是默认布局；已有项目可以在 `video-project.yaml` 里把各类内容映射到自己的目录，不必改结构。
- **插件只写 `renders/` 和 `.dsh-video/`**，从不移动或改写用户自己的文件。
- **倾向（未定）**：没有清单时按默认布局工作，第一次产出时写一份清单；`renders/` 里放一个只含 `*` 的 `.gitignore`，不碰用户根目录的 `.gitignore`，想把产物提交进 git（比如用 LFS）的人删掉它即可。
- **台账仍放全局**（`$DSH_HOME`），增加 `workspace` 和 `shot` 字段。原因：重启对账发生在 `apply()` 里，那时没有任何会话，插件不知道该去哪些工作区找台账；台账跟着工作区走就做不了重启恢复。
- **工作区根目录**：工具执行上下文里有 `exec.agent.session.header.cwd`；现在 `src/operations.ts` 里把 `workspaceRoot` 写死成了 `null`，M3 要接上。

**说明文件**：每个产物旁边放一份同名 `.json`，记录提示词、模型、参数、素材摘要、派生自哪个版本（`from`）、供应商任务 id、用量与估算花费。台账在全局，项目拷到别的机器上历史就丢了，有了说明文件，项目自己就能说清每个产物的来历；模型用通用的 read 工具就能翻历史；视频不进 git 时，这些小文件也可以提交。

**角色登记**：清单里声明角色，例如 `alice: { refs: [materials/alice/*.png], description: … }`。`video_generate` 接受 `characters: ['alice']`，由工具确定性地展开成参考图与描述，角色一致性不再取决于模型每次是否记得带上同样的参考图。

**产物进工作区带来的连带问题**（M3 一并解决）：

| 问题 | 处理 |
|---|---|
| 工作区可能在远程或沙箱里 | 通过 DSH 的 `ctx.fs` 写入，而不是直接用 Node `fs`（插件能否使用待核实，§15 第 11 条） |
| 会话权限档位（`read-only` / `workspace-write` / `danger-full-access`） | 尊重用户选的档位，只读会话里不往工作区写 |
| 用户会删除、移动、改名文件 | 旧会话的卡片显示"文件已移动或删除"，而不是坏掉的播放器 |
| `renders/` 里的文件被换成符号链接 | 媒体路由打开前确认真实路径仍在工作区内，否则拒绝 |
| 同一工作区开多个对话，同时给同一镜头出新版本 | 版本号由宿主原子分配，不由模型或客户端决定 |

### 16.3 工具与 skill 的分工

**原则**：工具只管宿主必须强制保证的事——花钱、密钥、去重、台账、盯守、产物写到哪里；判断与工作流交给 skill，再配合 DSH 已有的 read / write / edit 等通用文件工具。**工具不能依赖模型加载过 skill**：模型很可能不加载 skill 就直接调工具，所以工具自己读清单、自己算产物路径，工具描述里写全最基本的用法。skill 负责"做得好"，工具负责"做得对"。

| 工具 | 为什么必须是工具 |
|---|---|
| `video_generate` | 付费、密钥、去重指纹、台账、job 盯守。新增 `shot`、`from`（用上一版本的尾帧续拍）、`characters`；素材用工作区相对路径；自己读清单决定产物位置 |
| `video_status` | 超时或重启后的唯一入口。不带参数时还返回可用模型与能力、配置状态（供应商、key 是否已设置、当前工作区有没有清单）、没结算的任务；另支持花费汇总与事前估算（§16.5） |
| `video_cancel` | 让供应商停止计费，与 `job_kill`（只停止盯守）语义不同 |

`video_export` 删除。

| skill | 内容 | 调用方 |
|---|---|---|
| `video-project` | 工作区布局、清单怎么建怎么读、目录映射、`renders/` 版本约定；建项目时模型直接用 write 工具，不需要专门的 init 工具 | 模型 + `/video-project` |
| `video-prompting` | 视频提示词与镜头语言、运镜、时长与画幅的选择、各家供应商的写法差异 | 模型 |
| `video-storyboard` | 剧本怎么拆成分镜、`shots.yaml` 的格式 | 模型 + `/video-storyboard` |
| `video-iterate` | 什么时候出新版本、什么时候用 `from` 续拍、怎样用参考图和角色登记保持一致 | 模型 |
| `video-guide` | 使用指导（§16.6） | 模型 + `/video-guide` |

实现要点：

- 注册方式与 DSH 自带的 `dsh-skill-badge`、`dsh-skill-office` 相同：`ctx.skills.registerProvider(...)`。**`skills` 做成可选依赖**，没有 skill 注册表的组合里插件照样能用。
- 会话目录里只显示 skill 的名字与描述，正文由模型按需用 `skill` 工具加载，平时不占上下文。
- 工作区的 `.dsh/skills/<name>/SKILL.md`（rank 100）会覆盖插件自带的同名 skill（rank 600）。但覆盖是整份替换，用户一改就丢掉了插件后续对 skill 的更新，所以**项目风格放在清单里**，不鼓励靠覆盖 skill 来改风格。
- 待定：`video-prompting` 可以按当前配置动态生成正文（提供方的 `get()` 每次都会重新生成），只放用户实际配了的供应商的写法。省上下文，代价是测试要覆盖更多组合。

### 16.4 聊天卡片是唯一的工作界面

- 删除工作台页（`main` + `sidebar.panellist`）与面板 API 的 `generate`。
- 聊天卡片要能**实时显示进度**并**直接取消**。面板 API 保留 `overview`、`cancel`、`media`，信任门不变。
- 配置卡保留（填 key 需要它）；右下角 badge 保留。
- **修掉重启后不唤醒模型的缺口**（§15 第 1 条）：现在对话是唯一的界面，任务在重启后完成却没人知道，等于丢了。

### 16.5 成本可见性

两家接口都返回用量，但都**不返回金额**；查账单或余额要 AK/SK 签名，插件只有推理用的 API Key。

| | 火山方舟 Seedance | MiniMax |
|---|---|---|
| 查询接口里的用量 | `usage.completion_tokens`，文档称"可作为计费对账依据"；`total_tokens` 等于它；Seedance 2.0 有最低用量，不足时按最低值返回与计费 | `usage.output_seconds`、`input_seconds`、`input_image_count`、`input_audio_seconds` 与折算出的 tokens；**只有成功的任务才返回**，失败时为 `{}` |
| 计费方式 | 按 token 计费，单价因模型而异，含视频输入与不含视频输入也不同 | 按秒计费，单价随分辨率不同 |

**三层数字，可信度不同**：

1. **用量（准确）**：供应商返回的 tokens 与秒数，存进台账（M2.5）。
2. **估算金额（推算）**：用量 × 价格表。预设带参考单价，并写明币种、取价日期与来源链接，用户可以在配置里改（P12）。网上能找到的价格都来自第三方，彼此还对不上，不能写死成权威数字。所有金额都标注"估算，以供应商账单为准"。
3. **实际账单（权威）**：只在供应商控制台里能看到。插件要如实告诉用户这一点。

**在对话里怎么用**：用户问"这个项目花了多少钱"，模型调 `video_status`（花费汇总参数，范围可以是工作区或全部、可以限定起始日期），返回按供应商、模型、镜头分组的任务数、用量合计、估算金额、价格表日期，并列出用量未知的任务。

**事前估算只在被问时给**（P12），不在每次生成时主动显示。估算放在只读的 `video_status` 里，**不给 `video_generate` 加"只估算不提交"的开关**：付费工具上挂这种开关，模型一旦漏写参数就会真的提交。方舟按 token 公式估算，MiniMax 按秒数乘单价。

**方舟 token 公式（反推，待核对）**：文档例子中 5 秒 720p 消耗 108900 tokens，正好等于 `1280 × 720 × 121 ÷ 1024`（5 秒 × 24fps 再加 1 帧），即"宽 × 高 × 帧数 ÷ 1024"。官方没有写明，M2.5 用真实任务核对。

**没盯完的任务也在花钱**：`job_kill` 只是停止盯守，供应商那边照样跑、照样计费，孤儿任务也一样。用量要等任务结束后查询才拿得到，而**两家的查询接口都只保留 7 天**。所以台账规定：每个没结算用量的任务都要在 7 天内补查一次，不管有没有人盯着；过期还没查到的标成"用量未知"，**不按 0 计**。

**预算闸门**（单次或每日上限、超额审批）2026-10-15 决定暂不做，优先级很低。

### 16.6 使用指导

用户问"怎么用这个插件"时，由 `video-guide` skill 提供指导，不让模型临场发挥：模型只看得到工具描述，会提到已删除的功能、漏掉"先配 key"、或承诺做不到的事。

- **静态部分（skill）**：三步上手（在 侧栏 → 插件 → Video Forge 配好供应商与 key → 在项目工作区里开对话 → 直接说想要什么）；每种使用形态一两句示例话术；明确做不到的事；注意事项（每次都付费、金额是估算、超时后查状态不要重提、产物在 `renders/`、设置在清单里）。
- **动态部分（工具）**：不带参数的 `video_status` 返回当前状态。两者结合，回答能对上用户的处境。
- **skill 规定回答方式**：先诊断状态，再给最多三条下一步，详细内容等用户追问再展开；用户问哪一块只讲哪一块；用用户的语言回答，skill 正文只维护一份。
- **从不主动引导**：用户不问就不给，配置卡里不放新手横幅，系统提示词里也不提 `/video-guide`。但**工具调用失败时，报错仍要写清楚怎么修**（例如没配供应商时指向插件配置页），这是对失败操作的回应，不算主动引导。
- **防止指导过期**：加测试——指导里提到的工具名与参数必须真实存在，已删除的名字（`video_export`、"视频工坊"）不能出现。

### 16.7 提交与失败的稳健性

**先写意图再提交**：现有实现（`src/operations.ts`）先调用供应商的提交接口，成功后才写台账。只要请求已被供应商接受、但响应丢了（超时、网络断开、本次调用被取消——`options.signal` 会传进 submit），或者进程在两步之间退出，供应商就已经建了付费任务，台账里却没有，去重也拦不住下一次提交。修法：

- 提交前先写一条带指纹的 `submitting` 记录；成功后补上供应商任务 id；明确失败（供应商返回了错误体，或请求没发出去）标为 `failed`（`not_submitted`，不拦重试）；结果说不清的标成 `unconfirmed`，并且继续拦住同一指纹的重复提交。
- 请求一旦发出，就不再响应本次调用的取消信号。
- `unconfirmed` 的任务要去对账：方舟用任务列表接口（7 天窗口）按模型与时间找回，有歧义就不接管；MiniMax 与 `generic-openai-videos` 没有列表接口，只能如实告诉用户"可能已扣费"。不自动重新提交。
- **已完成**（2026-10-15，commit `1f9321c`），完整规则见 §6。

**审核拦截单独归类**：国内供应商会因内容审核拒绝提示词或图片。台账把"审核拦截"与其他失败分开记录；`video-prompting` / `video-iterate` 教模型怎么改写；要防止模型反复重试同一个会被拦的请求。被拦的请求是否计费，M2.5 确认。

**模型自检**：模型看不了视频，但能看图。方舟的 `return_last_frame` 能免费拿到一帧（有了 ffmpeg 还能抽更多关键帧），模型交付前对照提示词检查一遍，比如角色对不对、画面是不是崩了。这一帧也是 `from` 续拍的输入。

### 16.8 待办与未决

- **本地 ffmpeg（未决）**：会推翻两条已定的事——"不做拼接"的非目标，以及插件不声明 `shell` 能力（P5 当时整条撤掉了 ffmpeg），市场能力声明也要跟着改。可能的用途按价值排序：给不返回尾帧的供应商（如 MiniMax）截取尾帧以支持 `from` 续拍、为模型自检抽关键帧、读取时长与尺寸、生成缩略图、拼接。决定前不设计。
- **内容片段重构（M6，单独一次改造）**：`VideoMode = t2v | i2v | flf2v | s2v` 是四选一的枚举，装不下 Seedance 2.x 与 MiniMax 还没接的能力（参考视频、参考音频、编辑/延长、样片、仅尾帧）。两家的 `content[]` 已经是同一个形状，所以改成 `parts: [{ type: 'text' | 'image' | 'video' | 'audio', role, source }]`，mode 从 parts 推导、只用于校验，能力矩阵改成"模型接受哪些 role 的组合"。会动到工具 schema、台账里的 `params`、去重指纹与卡片。**不与 M3 合并**。
- **预算闸门**：暂不做（§16.5）。
- **可灵 / Veo**：排在 M6 之后；Veo 默认关闭。
- **预设模型目录过期提示**：未决（§15 第 9 条）。
- **客户端拆分**：`settings-card.tsx`（约 700 行）与 `providers-editor.tsx`（约 630 行）在膨胀，下一轮改配置卡之前先拆。
- **`conversation.view` 任务 tab**：聊天卡片已承担大部分职责，待重新评估。
