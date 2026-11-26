# 多幕并行派发规程（2026-11-24）

一份教学视频稿本按幕（章节）拆开、同时交给多个子会话生成时，怎么组织、怎么隔离、怎么回收、怎么验收。

这份规程来自一次真实的五幕并行（a02–a06，113 句，196 页 deck）以及它撞到的六个坑。所有结论都有出处：插件代码、DSH 源码，或那次的实测。

## 0. 一句话

**并行单元是「一份稿本」，不是「一个目录」，也不是「一个会话」。**

隔离靠稿本放在哪个目录（`projectRoot = dirname(storyboard)`），不靠子会话的 cwd。

## 1. 为什么不能靠 cwd 隔离

链条（三处代码，前两处路径相对 DSH 仓库 `deepseek-harness`，第三处相对本仓库）：

| 环节 | 位置 | 事实 |
|---|---|---|
| 子会话的 `cwd` 参数写哪 | `packages/subagent/subagent/src/manager.ts:840` | 只设 `ctx.workingDirectory`，即那个 agent 的 shell 工作目录 |
| 子会话的 session meta 从哪来 | `packages/subagent/subagent/src/child-agent.ts:144` | `cwd: parentHeader.cwd`，**继承父会话的 cwd** |
| 插件读哪个 | `src/session-context.ts:54` | 读 `agent.session.header.cwd`，也就是上面继承来的那个 |

结论：**`subagent(cwd=…)` 不会改变教学工具的工作区**。工具看到的 `workspace.root` 永远是父会话目录。

后果是实测过的：一个子任务带着 `cwd=/tmp/vh-run/a05` 起来（那个临时目录早已清理，这里只作为现象的记录，不要去找），`video_teach_plan` 仍然读主项目的 `storyboard.yaml`；a04 那次因为句数正好也是 26，差点把自己的 26 句和主项目的 26 句搞混，直到比对内容才认出那是 a00+a01。

还有一条容易忽略：`storyboard` 必须是 workspace 相对路径，且不许含 `..`（`src/teach/tools.ts:119`）。所以连"用相对路径指到项目外面"这条路也堵死了。

## 2. 两个根，这是整套规程的地基

| 根 | 由什么决定 | 落在里面的东西 |
|---|---|---|
| `workspace.root` | 会话的 `header.cwd`（父会话，创建后不可改） | `renders/<shot>/`（`src/teach/tools.ts:734`）、`deck/<段>/`（export 抄的） |
| `projectRoot` | `dirname(storyboard)`（`src/teach/tools.ts:125`） | `audio/`、`timings.json`、`.dsh-video/teach/<id>/segment.mp4`（`src/teach/pipeline.ts` 的 `TeachPaths`、`segmentPath`） |

**稿本放在哪，状态就在哪；成片永远回主项目。** 这一条同时给出两件事：状态隔离（五幕互不覆盖），成片汇聚（不需要事后搬文件）。

## 3. 目录契约

```
<workspace>/
├── storyboard.yaml                主线稿本：全片合集。并行期间只读
├── audio/  timings.json  .dsh-video/     主线状态。并行期间只读
├── renders/<shot>/                成片。所有子任务都写这里，shot 不同就不冲突
└── runs/<act>/
    ├── storyboard.yaml            只含本幕句子的稿本 ← 并行单元
    ├── slides/<act>/index.html    deck 副本。渲染读的是它，不是主项目那份
    ├── scenes/                    该幕用到的 Manim 场景（若有）
    ├── script/  materials/  video-project.yaml
    ├── .python-version            钉到 3.11.x，见 §4
    └── audio/  timings.json  .dsh-video/   本幕私有状态
```

三层所有权，不许跨界：

| 层 | 谁写 | 规则 |
|---|---|---|
| 主项目根（稿本 / audio / timings） | 主线 | 并行期间**只读**。派发前后各记一次 sha256 作为证据 |
| `runs/<act>/` | 该幕的子任务独占 | 其他子任务不碰 |
| `renders/<shot>/` | 各子任务写自己的 shot | 版本号由工具分配，不手写 |

## 4. 派发前：主线一次性做掉五件事

这些事**不要留给子任务**。它们决定跨幕一致性，交给五个子任务做会得到五个答案。

1. **铺节拍（`frag`）**。每页几个拍由主线一次性定。实测压暗强度需要按幕调（a01 的黑底细线图元要 0.12 才看得出点亮，其余 0.42），这类视觉参数只能有一个出处。
2. **同步 deck 副本**。`runs/<act>/slides/<act>/` 是副本，渲染读它。主项目改了 deck 不拷进去，渲染出来就是旧图；a02-6 就是这么在三个版本里留着旧图，直到整片审看才发现。
3. **切稿本**。每份 `runs/<act>/storyboard.yaml` 只保留本幕句子，`deck:` / `scene:` 路径保持与主项目相同（相对 projectRoot）。
4. **钉运行环境**。`.python-version` 指向 3.11.x。系统 python 3.9 没有 PyYAML，`spread-page-beats.py` 会直接崩在 import。
5. **基线快照**。记下主项目 `storyboard.yaml` / `timings.json` 的 sha256 与 mtime。回收时比对，用事实证明"没被碰过"，而不是靠子任务自己说。

## 5. 派发：子任务提示词的最小集合

原则：**只给任务特有的事实，其余让它去读 README / skill / 记忆。**

必须给的六项：

1. **工作根**（主项目绝对路径）与**本幕 id**。
2. **每次工具调用都要带 `storyboard=runs/<act>/storyboard.yaml`**。漏了这一句，工具会去动主项目那份。这是最容易犯、后果最大的一条。
3. **六步命令序列**：`plan → narrate → apply-page-hold → spread-page-beats --only <act> --write → render shot=<act> → assemble-act <act>`。
4. **禁止事项**（§8 那六条，逐条写进提示词，不要指望它自己推断）。
5. **回收清单**（§6）。
6. **报告格式**：句数、旁白时长、成片路径、`plan` 的全部 warning、deck 里发现的问题（只报不改）。

不必给：项目背景、deck 结构、节拍怎么算、音色选择、叙事口径。

理由不只是省 token。背景描述会与记忆里的既有结论打架——a05-1 与 a06-6 的"三个项目都能单独用"就是同一类事实错误，子任务各自都没发现；而它会去读源码的那部分（例如依赖关系），反而是它自己查出来推翻了原稿的（a05-24 的关系名分布、a05-25 的写入路径）。

## 6. 回收与合并

**必须回收**（每幕一份）：

- `audio/<act>-*.wav` —— 该幕全部句子的旁白
- `.dsh-video/teach/<id>/segment.mp4` —— 该幕全部句子的逐句视频段
- `timings-<act>.json` / `storyboard-<act>.yaml` —— 合并输入，同时是留档

**不要回收**：整个 `.dsh-video/`。里面有中间帧，几百 MB，且合并只需要 `segment.mp4`。

**合并**（主线，串行执行）：

1. 先备份主项目 `timings.json` / `storyboard.yaml`；
2. `timings.json` 按幕序拼接（句 id 已带幕前缀，不需要改 id）；
3. `storyboard.yaml` 按幕序补齐各段（含每句的 cue）；
4. `python3 script/assemble-act.py --all --join` 出整片；
5. 重出整片 SRT 与章节表（`script/master-timeline.py`）。

顺序纪律：**先逐幕验收，再合并**。整合是不可逆的：合并之后任何一幕的返工都要重拼一次。

## 7. 验收

逐幕（每幕独立判断，不要等全片）：

| 项 | 判据 |
|---|---|
| 句数 | 该幕 `timings.json` 的句数 = 稿本句数 |
| 时长 | 成片时长 = 该幕 timings 合计，**每句按 `durationMs + exitMs`** 累加（容差一帧）。有跨句转场时"合计"不是旁白长度，见 [`TEACH-MOTION.md`](TEACH-MOTION.md) §6.4 |
| **旁白真的换了** | 只有两条路：PCM 包络相关（同一段 ≈ 1.0），或直接转写。**画面、SRT 文案、deck 文案都不是证据** |
| 节拍 | 抽帧：句首是压暗态，句内某一刻点亮 |
| warning | `plan` 的每条 warning 如实带回，不许"看起来都过了" |

全片（合并后）：

- **接缝抽帧 + 转写**：在幕与幕的接缝处抽 9–10 秒转写，确认两幕的句子都还在（防止 concat 吞句子）；
- **末帧**：看一眼最后的画面（有过一次谢幕页 42% 灰的事故）；
- 章节表与整片时长对得上。

## 8. 禁止事项

写进每个子任务的提示词，逐条。

1. 不许改主项目的 `storyboard.yaml` / `timings.json` / `audio/`。
2. **不许用主项目的 `audio/` 覆盖 `runs/<act>/audio/`**。有一次重录后为了恢复被删的目录，把主项目那份旧录音拷了回去，覆盖了新录音，结果三个版本都带着旧音频，而证据只有"文案变了"。
3. 合并前不许删 `runs/<act>/.dsh-video`。删了之后单句重渲会报 `no picture for …`。
4. 不许改视觉参数（压暗强度、字号、布局）。这些归主线。
5. 不许把"渲染完成"当验收。要看帧，要**听**（或转写）音频。
6. 改了 deck 必须同步 `runs/<act>/slides/<act>/` 副本，再渲染。

## 9. 只有并行才会出现的三个风险

顺序执行时这些问题不存在，因为一个人从头看到尾；五个子任务各看自己那一幕时，它们全都藏在接缝上。

1. **事实一致性**。同一句错的判断会在两幕里各写一遍（a05-1 与 a06-6 都是"三个项目都能单独用"）。子任务只对自己那一幕负责，没人会去比对另一幕。
   → **事实审计放在合并阶段，由主线对全片 196 句统一做**，不委托。
2. **观感一致性**。五个人各自调压暗强度，就会得到五种"点亮"手感。
   → 视觉参数只在主线定；子任务只准用，不准调。
3. **副本漂移**。主项目改了 deck 或稿本，run 目录里那份没同步，渲染出的就是旧内容，而且工具不会报错（它只知道自己读的那份）。
   → 改完就同步；`assemble-act.py` 已有 md5 比对告警，拼片时会把不一致的幕点出来。

## 10. 脚手架：`assets/teach/runs.py`（已落地）

§4 的预处理、§7 的验收与 §9 的副本漂移，三个子命令对上了：

| 子命令 | 做什么 | 对应 |
|---|---|---|
| `prepare --act a05` | 从主稿本切出本幕、拷 deck/scene 与 `materials/` `script/`、写 `.python-version`、记主项目基线的 sha256 | §4 |
| `drift --act a05` | 比对 `runs/<act>/slides/<act>/` 与主项目同名目录，不一致退出 1 并点名文件 | §9 第 3 条 |
| `collect --act a05` | 先校验句数与逐句段长，再回收 `audio/` 与逐句 `segment.mp4`，另拷 timings 与稿本 | §6、§7 |

用法：从插件目录拷进项目，跟项目一起走版本控制。

```bash
cp <插件目录>/assets/teach/runs.py script/runs.py
python3 script/runs.py prepare --act a05     # 派发前
python3 script/runs.py drift   --act a05     # 渲染前
python3 script/runs.py collect --act a05 --dry-run   # 回收前先看一眼
python3 script/runs.py collect --act a05
```

**为什么是 python 而不是 node**：`prepare` 要读写 `storyboard.yaml`，而随包分发的 node 脚本拿不到插件的 `node_modules`（`yaml` 是插件的运行时依赖，不在用户工作区的解析链上）。项目侧已经依赖 PyYAML，缺它时 `prepare` 明确报错退出 3，不静默降级。

**collect 先校验后写**：句数、逐句段长（容差两帧；画面段按 `durationMs + exitMs`，音频只按 `durationMs` —— 尾转场是画面多出来的部分，音频里没有）任何一项不过就退出 1，**主项目一个字节都不动**。半收集的状态比没收集更糟：主项目里会混着新旧文件，而没有任何标记说明哪几个是新的。确认要按现状拷才加 `--force`。

**没做的部分**：合并（`timings.json` 按幕拼、`storyboard.yaml` 补 cue）仍是手工，脚本只在结尾把步骤打出来。这一步涉及 cue 的取舍（手调过的值不能被脚本覆盖），交给主线判断。

验证（2026-11-24，真实项目 `video-hypatia` 五幕，170 句）：

```
a02 104 / a03 92 / a04 52 / a05 58 / a06 34 个待回收文件（= 句数 × 音频与画面段）
五幕 collect --dry-run 全部 exit 0，逐句段长与 timings 一致
```

`drift` 另在合成项目上验过两条路径：改主项目 deck 后正确报不一致并退出 1，重跑 `prepare` 后恢复一致。

规程里**面向派发那一刻**的那一半已经进了 skill，不再只活在这份文档里：

- `video-teach-storyboard` 的「多幕并行：把稿本拆成一幕一份」：拆分契约、为什么这样拆就隔离了、派发前四件事、三件不交给子任务的事。
- `video-teach-iterate` 的「逐幕返工与合并」：逐幕验收四项（含「验收看音频不看文案」）、回收用脚本、合并三步、三条返工硬约束。

文档留的是完整推理与代码依据；skill 留的是照着做的部分。改规程时两处一起改，否则下一个派发的人只会看到其中一半。
