# DSH 视频生成插件 — 设计说明

> **包名已定**：npm 包名 `dsh-video-forge`（2026-10-13 实测可用）。
> 原占位名 `dsh-video-studio` **在 npm 上已被他人占用**（`dsh-video-studio@0.4.3`，作者 litao36253，是一个仅 Windows、自装 ffmpeg 的本地剪辑工作台，功能面正好落在本文 §1 的非目标里）。
> 本地目录仍是 `~/Code/github.com/tkliuxing/dsh-video-studio`（本文所有路径按此写），仓库名是否一并改为 `dsh-video-forge` 待定。
> 本文是设计决策记录，不是最终 API 契约；实施中出现的新事实回写到这里。

## 1. 目标与非目标

**目标**：给 DSH 一个"生成视频"的能力，既能被模型当工具调用，也能被人当工作台使用；**全部走在线模型**（Seedance / 可灵 / 各类中转站），用同一套协议表接入；生成过程不阻塞会话、不怕超时、重启后可恢复；产物能在聊天窗口内直接播放。

**非目标（首期）**：

- **不接本地模型推理**（2026-10-13 撤销原 mlx-serve / MiniMax-H3 路线，见 P5）；本插件是**在线模型的客户端**，不做推理、不做权重管理。
- 不做视频剪辑/时间线（那是 `deepseek-ivideo` 的地盘；npm 上占用 `dsh-video-studio` 的也是这一类）。
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

**默认项（本文直接定，不再讨论）**

- 超时后**只查不重提**：提供状态查询工具 + 工具描述与系统提示词双重约束，并在宿主层拦重复提交（前例中只有 `dsh-game-material-master` 做到宿主层）。
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

| slot | 用途 | 与初稿的差异 |
|---|---|---|
| `tool.call.toolview`（按线名 keyed） | `video_generate` / `video_status` 的结果卡片：`<video controls>` 播放器 + 任务状态 | — |
| **`main` + `sidebar.panellist`（同一个 id）** | **工作台页**：提交生成、参数预设、任务与产物列表 | **原定 `shell.overlay`，实测改掉** |
| `shell.overlay`（badge） | 会话内"有 N 个任务在跑"的环境提示 | 由工作台降级为提示 |
| **`plugins.bundle.config`（主）→ `settings.plugins.tab`（回退）** | 供应商与模型配置：Base URL、Key（掩码）、模型能力矩阵 | **原定 `settings.section`** |
| `conversation.view` | 任务/产物 tab（可选，二期） | — |

三条实测理由（都会在开发手册里踩到）：

1. **工作台不该放浮层**。`shell.overlay` 的官方定位是「badge、toast、status pill」，10 个既有占用者是 1 个全窗面板 + 3 个 modal + 6 个 toast，**没有任何一个常驻面板**；而且该层是 `pointer-events: none` + `> * { auto }`，一个铺满的 wrapper 会挡住整个应用。真正的面板一律是 **`main`（keyed）+ `sidebar.panellist`（同一个 id）**：`main` 给面板分配空间，shell 自己管侧栏按钮/高亮/标签。`shell.overlay` 保留给环境提示（badge 在没事时 `return null`，这是官方约定）。
2. **配置卡的家是 `plugins.bundle.config`，不是 `settings.section`**。dsh 0.1.7 起把「插件自己的配置」从 Settings 搬到侧栏 Plugins 页，`plugins.bundle.config` 以**包名**为 key 渲染在该 bundle 的详情页；`settings.plugins.tab` 是没有挂插件管理页时的唯一回退位。两个座位**同时**注册会重复，所以走 `config-card-seat.ts` 的"尝试主位 → 被拒则回退 → 主位晚到时迁移"策略（`register` 对未声明座位**抛错**，这个拒绝就是回退信号；`slots/changed` 在 `register`/dispose 内部同步触发，故必须有重入闩锁）。
3. **配置读写走 `ctx.configForms`**（经 `ctx.get('configForms')` 取，避免插件与宿主 cordis 类型身份不一致），写用 `mutate([{op:'set', path:[...], value}])`：拒绝返回 `false`、传输失败才 reject。config 的命名空间就是 profile 行的 `id`（`video-forge`），所以卡片要等 `whileServed(['video-forge'])` 成立再注册。

卡片从 `ToolCallBlock` 的 args / content / metadata 派生，不做工具调用的反向依赖，畸形输入回退通用行。媒体播放走 §9 的自建路由。

> **工作台的浏览器侧不能调工具**（工具调用属于 agent 回合），所以它有自己的一族宿主路由：`/video-forge/api/{overview,generate,cancel,export}`。这一族**不是**薄壳——它调用的正是 `operations.ts` 里工具用的同一批函数，浏览器提交与模型提交不可能在校验、去重、盯守上分叉。
>
> **信任门**：harness 只认证自己的 index 与 bundle，**不**拦插件路由，所以这一族自带闸门——本机回环放行，已配对设备放行（`remoteWebUiPairing` 在时装），未配对的局域网浏览器 403；socket 地址为准，`X-Forwarded-For` 永不采信，并要求浏览器的同源标记。MEDIA 路由则用 128-bit token 授权，两者策略不同且都写明了理由。

## 6. 长任务、恢复与取消

**台账**（`$DSH_HOME/dsh-video-forge/tasks.json`，原子写）：

```jsonc
{ "version": 1, "tasks": [{
  "localId": "v-20261013-0001", "provider": "ark", "protocol": "ark-seedance",
  "model": "doubao-seedance-1-0-pro", "providerTaskId": "…",
  "status": "queued|running|succeeded|failed|cancelled|orphaned",
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

**取消语义（两件不同的事）**：`job_kill` = 停止盯守（不再轮询，provider 侧继续跑）；`video_cancel` = 请求 provider 取消（协议支持时）。两者都要在工具/job 描述里写明，避免模型误以为 kill 就等于停止计费。

## 7. 供应商适配层（协议表）

模型引用格式 `providerId::modelId`（抄 `dsh-iris`，模型只搬引用、不展开密钥）。

| 协议 | 覆盖 | 状态 | 关键差异 |
|---|---|---|---|
| `generic-openai-videos` | OpenAI 兼容 `/v1/videos` 的在线通道：各类中转站、Sora 类供应商、自建网关 | **首期** | 提交/查询路径与 taskId/状态/URL 字段用 dot-path 配置，端点不硬编码 |
| `ark-seedance` | 火山方舟 Seedance（`doubao-seedance-*`） | **首期** | payload 形状与上一家不同（`content[]` 多模态 + `ratio`/`duration`/`watermark`），任务查询是 `GET /contents/generations/tasks/{id}`，按 `model` 名分流 |
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

## 9. 产物与播放

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

**已落地（114 例，`pnpm check`）**：台账 11（损坏隔离、并发写、id 序列、token 成对校验）、协议 19（dot-path、方舟角色/状态映射、中转站路径与 state 归一化、几何与能力校验）、媒体路由 14（真 socket：200/206/416/HEAD/404/405）、工具面 17（互斥、几何、去重、并发上限、取消、导出）、fixture 端到端 9（两种协议的成功/失败/取消/放弃/进程内驱动）、**面板 API + 信任门 13**（真 socket + 伪造 socket：403、掩码不泄漏、提交/取消/导出、错误映射）、**座位策略 5**（主位/回退/晚到迁移/重入/释放）、**客户端注册 7**、**卡片推导与渲染 11**、**配置卡写路径 8**（jsdom + testing-library：path op 形状、非法 JSON 拒写、拒绝态）。绝大多数用例不依赖 DOM；只有配置卡那 8 例用 jsdom，卡片渲染用 `react-dom/server`。

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

## 14. 里程碑

- **M0 协议探针（先做）**：用 `fixtures/` 假 provider 钉死两家协议（`generic-openai-videos` / `ark-seedance`）的提交、查询、终态、失败、取消五种响应形状；**同时验证 `ctx.jobs` 承载 provider 侧轮询**这一无前例的设计原语——若不合适，退化为 iris 式自管任务存储（台账独立存在，退化成本低）。有真 key 时补打一次真实 Seedance 出片，钉死真实响应与耗时。
- **M1 骨架（2026-10-13 完成，见 §13 实测表）**：包 + manifest + 4 个工具 + 台账 + 两家协议 + `$DSH_HOME` 产物 + 自建路由（Range/206）+ 播放卡片，81 例测试 + 隔离实例端到端。**未做**：`shell.overlay` 工作台浮层与 `settings.section` 设置卡片（原属 M2）、会话附件 id 素材（§4 说明）、真实在线 key 验证。
- **M2 面板与配置（2026-10-13 完成，见 §13 实测表）**：工作台页（`main` + `sidebar.panellist`）、环境 badge（`shell.overlay`）、配置卡（`plugins.bundle.config` 主位 + `settings.plugins.tab` 回退）、面板 API 族 + 信任门、双语文案、114 例测试。**未做**：在工作台里**写入**密钥（浏览器写密文的官方通道是 `ctx.remote.credentials.set`，卡片目前只显示"已配置/来源/掩码尾 4 位"并指向 harness 的凭据入口）、会话附件 id 素材（§4）、真实在线 key 验证。
- **M3 协议扩展**：可灵 →（可选）Veo，能力矩阵与成本门控。
- **M4 收口**：测试补齐、打包（npm/tarball）、README 双语、市场收录（`capabilities` + `locale` + `icon`）。

## 15. 未决与风险

1. **`ctx.jobs` 无前例**：八个前例都没用；其输出环是流式/pull 语义，把"轮询进度"映射进去是否顺手，M0 见分晓。
2. **在线通道的形态差异**：`generic-openai-videos` 假设"提交返回 id → 轮询查询 → 返回下载 URL"，但中转站普遍不保证这套形状（字段名、嵌套层级、是否同步阻塞各不相同），所以端点与字段必须 dot-path 可配；M0 的 fixture 只能证明形状自洽，真实通道仍需 key 复核。
3. **成本与限流**：每次生成都是付费调用，且可能触发并发/配额限制；`maxConcurrent`、去重窗口与"只查不重提"是硬约束，UI 上要给成本提示。
4. **云供应商合规**：Veo 那条路有 ToS/封号风险；可灵官方通道更干净。首期两家（方舟 + 通用中转）不涉及此风险。
5. **npm 包名与原占位名的冲突**：`dsh-video-studio` 已被占用，本包定为 `dsh-video-forge`；仓库目录名与仓库名是否同步改名待定。
6. **上游 API 预稳定**：`engines.dsh` 与 peer 需随上游巡检更新（四级证据链见 §13）。
