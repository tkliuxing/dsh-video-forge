# TODO — 未做的工作

这份文件回答一个问题：**还有什么没做，为什么，做完在哪留证据。**

它不是路线图，也不是愿望清单。每一条都能在 `docs/` 里找到出处，每条做完要回填。

## 怎么用

1. **一条一个 checkbox。** 做完把 `[ ]` 改 `[x]`，把那行的 `实现记录：待` 换成 `日期 · commit · 验证方式`。**不要删条目**，删了后来的人就不知道做过。
2. **先看出处，再看做什么。** 出处里写着为什么这么做、以及否决过哪些替代方案。跳过出处直接动手，最容易在相邻问题上返工一遍。
3. **只收「未做」。** 已经决定不做的收在 E 节并标「不是待办」，已经做完或曾被误标为未做的收在 F 节。两者都不该再被当成待办捡起来。
4. **新发现的项按分区分号追加**（A/B/C/D），不重排已有编号 —— 编号会被 commit message 和别的文档引用。

记号：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成（实现记录必填）。

编号按主题排，不按难度或成本；每条的「成本/前提」自己写清。

---

## A. 交付缺口：文档承诺了，代码没有

这两条最硬，因为 `docs/TEACH-VIDEO.md` §2 的交付物清单与 §9 的 M4 验收写的就是它们。现状核对与实现记录见同文件 §26（A1/A2 均在 2026-11-25 补齐）。

### [x] A1 烧入字幕

- **做什么**：在 `assemble` 阶段给 ffmpeg 的 `-vf` 加 `subtitles=renders/<shot>/vNNN.srt`，配 `force_style` 定字号与边距，字幕落在画面底部 900–1080 那条带里。
- **为什么**：目标交付物六项里的第五项；成片要能直接发平台，多数平台不吃外挂 SRT。
- **成本/前提**：本机 ffmpeg 9.0.2 是否带 `libass` **没有实测过**。不带时滤镜会被忽略或直接报错，先跑 `ffmpeg -filters | grep subtitles` 再动手。
- **出处**：`docs/TEACH-VIDEO.md` §2（行 27）· §9 M4 状态列（行 180）· §26.2 怎么补的（行 840）
- **已确认不冲突**：`docs/DESIGN.md` §1 非目标的「不做自动配音/字幕烧录」针对**自动生成**字幕，教学路线的字幕来自作者写好的稿子（该条正文已按此改写）。
- 实现记录：2026-11-25 · `5d184ac` · **实测结论：本机 ffmpeg 9.0.2 不带 libass**（`ffmpeg -filters | grep subtitles` 为 0、`-h filter=subtitles` 报 `Unknown filter`、`brew deps ffmpeg` 只有 11 个依赖、`drawtext` 也没有），改装 core 的 `ffmpeg-full` 9.1（`/opt/homebrew/opt/ffmpeg-full/bin`；装完 `/opt/homebrew/bin/ffmpeg` 与 `ffprobe` 实际已指向这台 9.1，所以本机默认 PATH 就能烧，设置项只是给别的机器留的口子）。代码：`src/teach/subtitles.ts`（`buildSrt` 从 `tools.ts` 移入 + `forceStyle`/`DEFAULT_SUBTITLE_STYLE`）、`muxNarration` 加 `subtitles=` 滤镜链（烧字幕时重编码视频，不烧仍 `copy`）、`assembleVideo` 把 SRT 写进 `.dsh-video/teach/burn.srt` 再烧；能力侧加 `probeFilter('subtitles')` 与新设置 `teachFfmpegBinPath`（空则 `TEACH_FFMPEG_BIN`，再 PATH），缺 libass 不阻塞渲染但 plan 警告 + render 结果的 `subtitles` 字段写明原因。验证：`TEACH_FFMPEG_BIN=/opt/homebrew/opt/ffmpeg-full/bin pnpm test`（`test/teach-burn.test.ts` 解帧断言行 969–1032 落在 900–1080 带内、`burn_subtitles: false` 时整帧无暗像素）；`pnpm test` 704 passed / 7 skipped，`pnpm run build` 通过

### [x] A2 封面

- **做什么**：`video_teach_export` 加一段产出一张封面图。两条便宜的路：取成片首帧（`-frames:v 1`），或在 deck 首页截一张（`teachPage(0)` + Playwright 截图，与 `src/teach/slides.ts` 的 CDP 录屏同一条路径，不需要新依赖）。
- **为什么**：目标交付物六项里的第六项。缺它时 `video_teach_export` 的工具描述与实际产物不符。
- **成本/前提**：要先定封面的构图规则（哪一页适合当封面），否则每支片子都要人挑。
- **出处**：`docs/TEACH-VIDEO.md` §2（行 27）· §6 工具表（行 134）· §9 M4（行 180）· §26.2（行 840）
- 实现记录：2026-11-25 · `6f8409a` · **构图规则已定（用户 2026-11-25）**：封面是**作者单独写的一页 HTML**，用无头浏览器截图，出 **16:9 与 4:3 两种画幅**；成片首帧与 deck 首页这两条「便宜路」都否掉了（首帧是半句话加动画中途，缩到 300 px 读不出；deck 首页是幻灯片不是海报）。代码：稿件新增 `meta.cover`（`storyboard.ts` 解析 + 拒绝越界路径）、新模块 `src/teach/cover.ts`（`playwright-core` 一次启动、每种画幅一个 context，1920×1080 与 1440×1080，等 `document.fonts.ready`，截完数颜色，纯色直接报错）、`video_teach_export` 产物 `vNNN.cover-16x9.png` / `vNNN.cover-4x3.png`；未声明 `meta.cover` 时不出封面并在消息里说明（不拿首帧顶替）。样例：`fixtures/teach/sample/cover/index.html`（含 4:3 media query）。验证：`test/teach-cover.test.ts` 两例（两张封面的尺寸与 SRT 文本和烧入一致；没声明 `meta.cover` 时 `covers` 为空且消息说明），另用 `probe` 复核 1920×1080 / 1440×1080

---

## B. 提案：方案已写，代码零行

### [x] B1 一页承载多句（`page` / `enter`）

- **做什么**：`storyboard.yaml` 的 sentence 加两个可选键 `page`（同段多句共享一个 `<section>`）与 `enter`（进页时先显示到第几拍）。三处改动 + 四条校验（落成后的实际改动点与校验全集见 `docs/TEACH-VIDEO.md` §25.3 与 §25.6 的两张表，这里不重述数量）。
- **落成时追加**：校验比提案多了几条（`enter` 让画面倒退、共享页整句无变化、共享页缺 `teachCue`、页数数不出来），以及解析期的「`enter` 没写 `page`」；模板 deck 的 `teachPage` 有个既有缺陷（切页时点亮第一拍，使每页第一条 cue 永远不生效），一并修掉。
- **为什么**：三页讲同一件事的三个次第时，页面元素框实测完全重合，观众仍读成翻页（泄漏只有页码与左侧标题）。不改代码的极限是「固定页码 + 常驻标题 + 变化下沉到细节行」，让同一版面**看起来**像一页。
- **改动点**：`src/teach/storyboard.ts`（键白名单 + `pageSlots`）· `src/teach/pipeline.ts`（`renderSegments` 的页号与 `enter`）· `src/teach/slides.ts`（切页后开录前的那次 `teachCue`）· `assets/teach/deck/index.html`（`teachPage` 切页不带亮）
- **校验**：`src/teach/rules.ts` 的 `pageFindings` + `auditDecks`（拒绝与 warning 的完整清单见 `docs/TEACH-VIDEO.md` §25.6 的表）
- **不要走**：把多句合一句（86 字约 17 秒，超 `MAX_SENTENCE_SECONDS = 8`）· 在 deck 里放「页号 → 句号」映射表（句序一调整就静默错位）
- **验收**：`fixtures/teach/shared-page/` 三句共享一页、`enter: 0/1/2`；抽帧断言第 2 句首帧 = 第 1 句末帧；老 fixture 行为不变
- **出处**：`docs/TEACH-VIDEO.md` §25（行 709–873，含 25.1 原因 / 25.3 改动点 / 25.5 编号反转 / 25.6 校验 / 25.9 验收 / 25.12 实现记录）· `docs/DESIGN.md` §23 末段（行 1604）· 决策摘要见记忆 `wu-teach-page-map-proposal-2026-11-24`
- 实现记录：2026-11-25 · `2967c52` · **代码**：`storyboard.ts` 加 `page`/`enter`（白名单、非负整数、`enter` 无 `page` 解析期拒绝）与 `pageSlots`/`pageSlotOf`/`pagesUsed`（只算不判；`PageSlot` 给 `page`/`enter`/`lit`，缺省 `enter` 承接同页上一句留在屏幕上的拍数）；`pipeline.ts` 用 slots 驱动录制器，`planStoryboard` 的页数改成稿件实际用的页数；`slides.ts` 在切页与 300 ms 等待之间调 `teachCue(enter)`，所以 t=0 就带进页状态；`rules.ts` 的 `pageFindings`（挪页却只声明一部分 / 页回退 / `enter`≥首个 cue / `enter` 让画面倒退——后两条同句只报一条）与 `auditDecks`（声明页不存在→拒绝；多余页 / `enter` 超页 / 共享页整句不动 / 页数数不出来→warning；无 cue 但 `enter>0` 缺 `teachCue`→拒绝），词级时间戳下给一条「这两个键不生效」的 warning。**修掉三处既有缺陷**：模板 deck 的 `teachPage` 用 `Reveal.slide(n, 0, 0)` 切页即点亮第一拍（第一条 cue 永远不生效、`enter: 0` 无法兑现，改 `-1`）；`page-mode` 与新的 shared-page deck 的节拍元素只有 `data-beat` 没写 `class="fragment"`；注释/脚本里的字面量 `<section>` 与 `class="fragment"` 被当成真标记（`deckPageFragments`/`countDeckFragments` 现在只看标记，模板注释也改了措辞）。**验证**：`fixtures/teach/shared-page/` 三句共享一页 `enter: 0/1/2`，`video_teach_plan` 除一条 page-mode 说明外无待修项（`rhythm:`/`picture:` 两行一并断言）；`test/teach-shared-page.test.ts` 真渲染三句并抽帧，`litBands` 依次 `0→1 / 1→2 / 2→3`（第 2 句首帧必须是 1），另有一例用 `writeDeck` 生成的真实 deck 走 plan（越界页必须被拒绝，且不许出现「有页永远录不到」的假告警）；`test/teach-deck.test.ts` 拿真实模板 deck 驱动，断言切页后 0 拍亮（旧行为下第一个断言就失败，已实测）；`test/teach-rules.test.ts` 有「注释/脚本不算页」的负例（旧实现下失败，已实测）；`pnpm check` 全绿（数量与证据见 `docs/TEACH-VIDEO.md` §25.12）。**skill 侧**：`video-teach-storyboard` 新增「一页承载多句」（语法、会被拒绝的写法、共享页下「没 cue 不算缺陷」的豁免失效、`volcengine` 与 Manim 段不生效、跨句仍硬切）、`video-teach-slides` 新增「一页承载多句」（`teachPage` 幂等且切页不带亮、进页拍由录制器打到位、编号跨句递增、无 cue 也要 `teachCue`、三条页数边界），`video-teach-iterate` 补「老 deck 手改 `teachPage` 后只重渲」，两份 routing description 同步。**流程**：独立审查三轮（每轮都是 0 上下文的新子任务；后两轮只复核上一轮的修复）。第一轮抓到 1 条阻断（模板 deck 切页点亮第一拍）与 11 条应当修，第二轮修回写口径，第三轮抓到 1 条阻断（模板 deck 注释里的字面量 `<section>` 让自己的页数多算一页，于是假告警、并漏掉「声明页不存在」的拒绝）与 7 条应当修，均已修并补了对应负例；清单见 `docs/TEACH-VIDEO.md` §25.12 末段

### [x] B2 把「SVG 元素级节拍」写成契约

- **做什么**：在 `video-teach-slides` 里写明 `class="fragment"` 可以写在 SVG 的 `<g>` 上；并建议 deck 给每个节拍元素加 `data-beat="k"`，`teachCue(k)` 点亮 `data-beat ≤ k`，不依赖 DOM 顺序。
- **为什么**：这条能力**现在就能用**（`countDeckFragments` 数正则、`<g>` 落在 `<section>` 内算进该页、`teachCue` 对 `<g>` 与 `<div>` 一视同仁），但文档没写。不写进契约，以后有人把正则收紧成「只数 section 直接子元素」，项目侧会静默坏掉。它也是「一页内三张卡依次亮」不必拆页的前提。
- **成本/前提**：免费，只改 skill 正文。
- **出处**：`docs/TEACH-VIDEO.md` §25.8（行 790–798）
- 实现记录：2026-11-25 · `video-teach-slides` 新增「SVG 里的元素也能当节拍」：`<g class="fragment">` 是一个节拍、`data-beat="k"` 定顺序而不用 DOM 顺序；原来只在本轮「静态资源」节里以论证形式顺带提过一次，不算契约 · 顺带更正了 `<img src="…svg">` "点不亮"的错误说法（会被计数、能整块点亮，丢的是改色与部分点亮）· `pnpm check` 705 passed / 7 skipped · 未提交

---

### [x] B3 多幕并行派发的规程写进 skill

- **做什么**：把 `docs/TEACH-PARALLEL-ACTS.md` 的规程落成两份 skill 的正文：`video-teach-storyboard` 写「稿本按幕切分」的契约（`runs/<act>/storyboard.yaml` 只含本幕句子、每次调用都要带 `storyboard=`），`video-teach-iterate` 写「逐幕返工与合并」的纪律（先逐幕验收再合并、不许删 `.dsh-video`、不许用主项目 audio 覆盖 run 目录）。
- **为什么**：规程现在是文档，只有读过它的人才会照做。写进 skill 才会在派发的那一刻被模型看到。这是记忆里 `rule-corrections-land-in-skills` 的同一件事：只写文档，下一次会在相邻问题上再返工一遍。
- **成本/前提**：免费，改 `assets/skills/` 两份正文 + `src/skills.ts` 的 routing description；`test/guide-consistency.test.ts` 会扫正文里的工具名。
- **出处**：[`docs/TEACH-PARALLEL-ACTS.md`](docs/TEACH-PARALLEL-ACTS.md) §5（提示词最小集合）· §6（回收与合并）· §8（禁止事项）
- 实现记录：2026-11-24 · `video-teach-storyboard` 新增「多幕并行：把稿本拆成一幕一份」（契约、为什么隔离、派发前四件事、三件不委托）；`video-teach-iterate` 新增「逐幕返工与合并」（逐幕验收四项、回收用脚本、合并三步、三条硬约束）与两条常见坑（拿文案当音频证据、反向覆盖 audio）；`src/skills.ts` 两份 routing description 都带上「多幕并行」· `pnpm test` 697 passed / 7 skipped，`pnpm run build` 通过 · `3f98832`

---

### [ ] B4 截图素材台账 `materials/shots/shots.yaml`

- **做什么**：建唯一台账，字段见设计文档 §7.3；`status` 由脚本按「`file` / `blocker` / `evidence.source`」三者的组合算出（§8 的七行矩阵），不手写。同时把 `materials/shots/README.md` 从手写表格改成由它渲染。
- **为什么**：同一批截图状态现在有七处抄本，已经漂移：README 说 S07「待拍」而 `slides/build.py:1522` 写「决定不拍」；`script/spec/a04.md:143` 说 S01「待拍摄」而 README 写已拍；`slides/acts/a06_art.py:293` 用的 `crops/S01-rows.png` 在 README 的裁切表里不存在；8 张 crops 的裁切参数没有留存，原图重拍即全废。
- **成本/前提**：半天，零付费。**历史 8 张没有 DOM 快照，只能落成 `unverified`**，角标带「未复核」——这是设计里刻意的诚实（§8），重拍才能升成 `shot`。
- **出处**：[`docs/TEACH-MATERIALS.md`](docs/TEACH-MATERIALS.md) §1.1（七处真值实测）· §7.1（两本台账的分工）· §7.3（字段）· §8（状态矩阵）
- 实现记录：待

### [ ] B5 拍摄脚本 `script/shoot-shots.mjs`

- **做什么**：把拍摄脚本稳定成项目内脚本：Playwright 起隔离实例 → 按选择器取 DOM 文本写进 `evidence.dom` → 截图 → 按 `crop.box` 生成 `crops/` → 把 `evidence.at` / `instance` / `evidence.dom` 写回 `shots.yaml`。当年那两个临时脚本（`cap5.mjs` / `cap6.mjs`）**不要假设还在**：在就直接改，不在就按 `materials/shots/README.md:26` 记录的步骤重写。
- **为什么**：断言必须在按快门那一刻对 DOM 做，出片后对 PNG 做不可行（整屏图缩到 0.27×，`slides/README.md:248` 记截图高度只能收到 586–620）。更根本的是，复现材料本身不能停在 `/tmp`：脚本、隔离实例的 `$DSH_HOME`、token 日志都放在那，等于这套截图没有任何人能重拍（`materials/shots/README.md:25–26` 现在就是这样）。
- **成本/前提**：一天。要重建隔离实例（`materials/shots/README.md:25` 提到的 3099 端口实例已不在）。Playwright 从插件 `node_modules` 硬编码 import（`script/shot-cover.mjs:3` 的现状），搬进脚本时一并改成可配置路径。
- **出处**：[`docs/TEACH-MATERIALS.md`](docs/TEACH-MATERIALS.md) §4（生产侧落点）· §9（证据区与字号判据）· §13 验收 1–3
- 实现记录：待

### [ ] B6 入片契约与 skill 写法

- **做什么**：三件：① `slides/build.py` 的 `shot=(path, w, h)` 改为取 `shots.yaml` 的 `file` 与 `crop.design_width`，`note` 的「界面示意」前缀由 `status` 生成；② `slides/art_frozen.py:124` 的 `shotflag` 改为三档文案（真实截图 / 真实截图（未复核）/ 界面示意）由 `status` 生成；③ 写进 `video-teach-slides`：证据区上限（宽 ≤ 1728、高 ≤ 620）、字号判据（`min_text_px × design_width / box.w`，`evidence` ≥ 24 px、`structure` ≥ 10 px，后者另用 `readable_because` 说明为什么这个缩放够用）、按需触发的初始化（deck 里出现 `materials/shots/` 的 `<img>` 才要求台账存在）、`shots` 是保留目录名、`materials/shots/shots.yaml` ≠ `storyboard/shots.yaml`。
- **为什么**：角标现在是人写的——S03 明显「搜索没真的执行」仍标「真实截图」。判定结果必须自己跑到画面上，否则又是一份手抄。初始化这一条同时回答「要不要在建项目时加一步」：不加进 `video-project` 的三步（那是参考图），只进教学路线的 slides skill。
- **成本/前提**：半天，改项目侧生成脚本 + 一份 skill 正文；项目根的 `video-project.yaml` 不需要新键（`paths.materials` 已覆盖）。
- **出处**：[`docs/TEACH-MATERIALS.md`](docs/TEACH-MATERIALS.md) §9（证据区与字号判据）· §8（角标由状态生成）· §14 第 1 条（字号下限已定）
- 实现记录：待

### [x] B7 `materials` 布局、`catalog.yaml` 与保留名

- **做什么**：按设计文档 §3 铺目录（角色沿用 `materials/<名字>/`）、写 `materials/catalog.yaml`（§7.2 字段：`kind` / `origin` / `used_by` / `license` / `source` / `prompt` / `model` / `sha256`）、定下保留名清单（`shots` / `images` / `icons` / `frames` / `style` / `catalog.yaml` 不许当角色名）。把 `script/facts.md` §E 的图片表与 `materials/README.md` 的散约定迁进 catalog。
- **为什么**：抽卡侧只有 `characters.<名字>.refs` 一条硬约定，首尾帧、风格板、立绘规格、来源都没有位置和去处（§1.2 的缺口表）；而 `materials` 下一层目录名被角色名占用，不先定保留名，`images/` 哪天会被登记成角色。
- **成本/前提**：半天，纯项目侧，不动插件。现有 `facts.md` 3 行与 `materials/README.md` 一段要迁移。
- **出处**：[`docs/TEACH-MATERIALS.md`](docs/TEACH-MATERIALS.md) §3（布局与保留名）· §4（生产侧）· §7.1（两本台账）· §7.2（字段）
- 实现记录：2026-11-25 · `materials/README.md` 重写（布局、往上两层的路径算式、内联/外链判据、保留名、catalog 字段、许可规矩）；新增 `materials/catalog.yaml` 登记 3 张 Hypatia 图（含此前无主、没在任何表里的 `hypatia-mitchell-1885-head.jpg`）；`script/facts.md` §E 改为指向 catalog，只留两条硬结论；建 `icons/` `frames/` `style/` 三个目录 · 未提交

### [x] B8 deck 静态资源与六条校验

- **做什么**：图标从 `icons/*.svg` 由构建脚本读入并内联成 `<svg>`；位图走 `../../materials/images/…`；写 `script/check-materials.py` 跑设计文档 §10 的六条：引用完整、路径形状、图标必须内联、台账双向一致、来源可复现、截图状态自洽。
- **为什么**：deck 现在是 `file://` 直接加载图片，插件不读也不查（`missingAssets` 只 stat deck/scene/cover 本身），改个文件名录制就静默出空白。而 a02-1 已经引了外部位图，`materials/README.md` 却还写着「deck 不引外部图片」，两边相反。
- **成本/前提**：一天，零付费。脚本落点已定：项目侧 `script/check-materials.py`（§14 第 2 条；python 是因为要读 YAML）。**不随插件分发**：规则写在 `video-project` skill 第 4 步，实现归项目的 agent（§11）。
- **出处**：[`docs/TEACH-MATERIALS.md`](docs/TEACH-MATERIALS.md) §5（内联/外链判据）· §10（六条校验）· §13 验收 5–6
- 实现记录：2026-11-25 · `slides/build.py` 的 `render_art` 补 `image`（外链）/ `icon`（内联：去 XML 声明与 DOCTYPE、加 class、缺文件报错）两个分支——`image` 之前根本没有分支，靠 a02 的冻结层掩盖着，一解冻图就没了；重跑构建 196 页与改动前逐字节一致 · `script/check-materials.py` 实现六条 + 保留名：真实项目通过，13 条负例全命中（路径形状 ×3 / 外部 URL / SVG 用 `<img>` / generated 缺 prompt / authored 缺 license / derived 来源不存在 / 孤儿文件 / 保留名冲突 / 字号 9.3<24 / must_show 缺 text / 沉默缺失）· 文件名由 `.mjs` 定为 `.py`（要读两份 YAML）· 2026-11-25 决定：校验器不随插件分发，新项目由项目的 agent 按 `video-project` skill 里的六条自己实现；已把六条写进 skill · 独立审查后修掉 5 条阻断（README 旧命令、`origin` 缺 authored、`derived` 的 source 形状、B8 残留"拷一份"、B9 立绘规格未落地）与 11 条应当修 · 未提交

### [x] B9 抽卡素材规格与初始化模板

- **做什么**：立绘规格写死（位图不支持 SVG、长边 ≥ 1024、背景干净、多视角 `front`/`side`/`back`、单角色单目录、一次 ≤ 9 张）；首尾帧放 `frames/<shot>/{first,last}.png`、风格板放 `style/`；**允许从成片派生并长期复用**（`origin: derived` + `source: renders/<shot>/vNNN.mp4`）；在 `video-project` 与 `video-teach-slides` 的初始化步骤里生成 `materials/README.md`（布局表 + 路径算式 + 引用判据）与 `catalog.yaml` 模板，并改掉 README 里「教学路线不需要素材文件、deck 不引外部图片」那句。
- **为什么**：首帧/尾帧与非角色参考图没有位置约定，模型每次临时传路径，下次就找不到同一张；立绘既可能是抽卡产物又被当输入，不记 `prompt`/`model` 就不可复现（§1.2）。初始化必须留下这份 README，否则规范只存在于 skill 里，用户打开项目看不到。
- **成本/前提**：半天，改两份 skill 正文；插件只写 `renders/` 与 `.dsh-video/`，不碰 `materials/`，所以模板靠模型建。
- **出处**：[`docs/TEACH-MATERIALS.md`](docs/TEACH-MATERIALS.md) §6（抽卡素材）· §11（初始化模板）· §14 第 3 条（已定：允许从成片派生）
- 实现记录：2026-11-25 · `video-project` 建项目改 4 步（`catalog.yaml` 与 `materials/README.md` 模板、保留名清单）；`video-teach-slides` 新增「静态资源：图标内联、位图外链」；立绘规格（位图、长边 ≥ 1024、`front`/`side`/`back`、≤ 9 张）与教学项目「没有 materials 就先按建项目第 2 步建」两条也写进了 skill；`src/skills.ts` 两份 routing description 带上素材 · 独立审查发现这两条原本没落地，已补 · `pnpm check` 705 passed / 7 skipped · 未提交

### [x] B10 D0：页内动效库（模板 CSS + skill 食谱）

- **做什么**：模板 `assets/teach/deck/index.html` 里加 `--teach-dur: 480ms` 与 `.reveal .slides .fragment { transition-duration: var(--teach-dur) }`（只改时长，**不覆盖 `transition`**，否则杀掉 reveal 内置变体的 transform）；补四个类：`dim`（压暗 `.42` → 点亮，整页构图句首完整）、`draw`（SVG `stroke-dashoffset` 一次性 keyframes）、`count`（数字滚动）、`bar`（条形生长）；`video-teach-slides` 加「动效食谱」（内容类型 → 用哪个类）与禁用清单（无限循环的信息型动画、整体覆盖 `.fragment` 的 `transition`）。
- **为什么**：实测一段 9.23 s 的句子只产生 23 帧，其中 20 帧集中在两次约 170 ms 的淡入里，其余 8 秒画面一个像素都不变——这是"呆板"的物理来源。管线本身能拍到 60 fps 的位移/缩放/绘制，瓶颈是默认只给了 opacity。另一条：某个 fixture deck 自写 `.reveal .fragment{transition:opacity 180ms}`，与 reveal 自己的规则同特异性且后加载，把 `fade-up`/`grow` 的 transform 全部变成瞬间跳变，作者无从得知。
- **成本/前提**：模板 CSS 一段 + skill 一节，不改代码。`480 ms` 的依据是实测 400 ms 拍 32 帧、200 ms 只拍 16 帧；不能用 demo 的 `cubic-bezier(0.77,0,0.175,1)`（实测前 77% 时间几乎不动）。
- **出处**：[`docs/TEACH-MOTION.md`](docs/TEACH-MOTION.md) §1.1（实测帧数，行 26）· §1.3（覆盖 `transition` 的坑，行 46）· §3（D0 全文，行 84）· §3.2 类清单（行 98）· §3.3 缓动（行 120）
- 实现记录：2026-11-25 · `f7e084c` · 模板 `assets/teach/deck/index.html`：`:root` 加 `--teach-dur: 480ms` 与 `--teach-ease`，`.reveal .slides .fragment` **只改时长**（保留各变体的 `transition-property`；覆盖 `transition` 会杀掉 `fade-up`/`grow`，这条坑写进注释），补四个类——`dim`（0.42→1，`visibility: inherit` 覆盖 `:not(.custom)` 的隐藏）/ `draw`（`stroke-dasharray` + 一次性 keyframes，`--teach-len` 定路径长度）/ `count`（注册 `--teach-num` 整数属性 + CSS counter，目标写 `--teach-to`，零 JS）/ `bar`（`scaleX` 生长，走合成器）；skill `video-teach-slides` 新增「动效：先定画面语言，再选类」（两种画面语言、时长只改不改、类清单与内容类型对照、四条禁用、负对照写法），原「动效用自带的 `fragment` 与 `fade` 就够」按 §3.4 收窄成"按与时钟的关系判断"；`src/skills.ts` 的 routing description 带上动效。验证：`test/teach-motion.test.ts` 用 `writeDeck` 把 `fixtures/teach/motion/sections.html` 装进**随包模板**再录，八页里前七页句内"画面在变"的帧数为 10 / 24 / 24 / 12 / 38 / 14 / 25，末帧与"全部节拍点亮"的 deck 截图平均差 ≤ 0.1；第 8 页是同一批元素 `--teach-dur: 0ms` 的负对照，只有 2 帧——把它改回 480 ms 该页变 23 帧并让测试失败（实测）。样本成片 `renders/motion/v001.mp4`（46.17 s，DeepSeek 音色 `stella`，项目在 `demo/motion/`）按 30 fps 数事件：前七页每拍 3–13 帧连续变化，对照页两次变化各 1 帧。未做：`fade-in-then-out` 这类"一拍消失"的用法只写进 skill、没进 fixture

### [x] B11 D1：页内手动 auto-animate（`data-teach-stage`）

- **做什么**：模板 CSS 给 `r-stack` + `.mover` 的写法示例；模板的 `teachCue` 末尾加一段可选同步——把 `[data-teach-stage]` 容器的 `data-step` 跟随当前拍数，deck 只写 CSS 不写 JS。同时给「依次聚焦」写法：`custom` 元素用 `current-fragment` 改颜色/位移/字重。
- **为什么**：reveal 的 Auto-Animate 是跨页补间，在我们的录制架构里被吃掉（换页发生在开录之前）。但 `.reveal .fragment:not(.custom)` 这条规则给了出口——`class="fragment custom"` 不被隐藏，reveal 只负责数它和推进它，样式全交给作者。实测：尺寸、颜色、圆角的变化被平滑补间并完整录取，观感与原生 Auto-Animate 同源。
- **成本/前提**：模板 CSS + `teachCue` 一段 + skill 一节；不改代码。边界要写清：`data-teach-stage` 只在当前页生效，跨页是 B13 的职责；共享页下编号跨句递增，作者要么按整页编号写 CSS，要么用 `enter`。
- **出处**：[`docs/TEACH-MOTION.md`](docs/TEACH-MOTION.md) §4（D1 全文，行 128）· §4.1 `.fragment.custom` 支点（行 130）· §4.2 连续变形（行 144）· §4.3 依次聚焦（行 171）
- 实现记录：2026-11-25 · `f7e084c` · 模板 `teachCue` 末尾把每个 `[data-teach-stage]` 的 `data-step` 写成 **`target + 1`**（不是文档原稿的 `Math.max(1, target)`：那会让"首拍之前"与第一拍都落在 1 上，2 拍的页面只剩一次变形；§4.2 已同步改口径并写明理由）；模板补 `.beat` + `.current-fragment` 的"当前项高亮"（`fragment custom` 不被 reveal 隐藏，样式全归 deck）；写法与五条边界（步号含义、容器自己不是 fragment、一容器一 `data-step`、只在当前页、共享页编号跨句递增）写进 `video-teach-slides` 的「动效」一节。验证：`test/teach-motion.test.ts` 的 stage 页抽 rgb24 帧数三种形色的像素——首帧 step-1 灰、末帧 step-3 洋红；**删掉那段同步后该页帧数从 25 掉到 13、末帧洋红 0 px，测试失败**（实测）；样本成片 37.4 s / 39.6 s 两帧可肉眼看到"矩形→圆形"的连续变形。未做：跨页/跨句的连续变形仍做不到（那是 B13 的职责）

### [x] B12 D2：录制契约（`teachTransition` / `teachPageTransition`）

- **做什么**：`src/teach/slides.ts` 读两个可选全局——`window.teachPageTransition`（切页过渡时长，替代硬编码的 `PAGE_TRANSITION_MS = 300`）与 `window.teachTransition`（页内单步过渡时长，仅用于校验）；`src/teach/rules.ts` 加一条 warning：某拍之后剩余时间 < `teachTransition` 时提示会与下一拍重叠。
- **为什么**：`transition: 'fade'` 在 reveal.css 里是固定 0.5 s，`transitionSpeed: 'fast'` 对它无效，而等待只有 300 ms——开录时还有约 200 ms 的转场在跑。现在靠前面的截图自检（1080p 截图 + 数颜色）耗掉额外时间才没暴露。同时校验器完全不知道"这一拍之后够不够播完"，只能在成片里看出来。
- **成本/前提**：`slides.ts` 两处取默认值；`rules.ts` 一条 warning。不声明就跳过校验，默认路径不变。**不加 `teachEnter`**：页入场动画被 B13 的尾转场吸收，加第三个全局会把契约从三个变四个。
- **出处**：[`docs/TEACH-MOTION.md`](docs/TEACH-MOTION.md) §5（D2 全文，行 188）· §5.1 两个全局（行 190）· §5.2 为什么不加 `teachEnter`（行 203）· §1.2 成因一（`PAGE_TRANSITION_MS`，行 40）
- 实现记录：2026-11-25 · 未提交 · `src/teach/slides.ts`：`DeckGlobals` 加两个可选全局；页模式切页后先 `page.evaluate` 读**活页面**上的 `teachPageTransition`（非数字 / 非有限 / ≤0 一律当没声明），再 `waitForTimeout(声明 ?? 300)`，`PAGE_TRANSITION_MS` 降级成默认值。`src/teach/rules.ts`：`DeckInfo.transitionMs`、新类型 `BeatSchedule`（一句的时长 + 每拍的毫秒 + 是否用的估时）、`auditDecks` 第三个参数 `{ beats }`、新函数 `transitionFindings` 产出"会和下一拍重叠"与"句尾会被切"两种 warning。`src/teach/tools.ts`：`declaredMs()` 读声明（`(?!=)` 挡住 `===` 这种守卫）、`beatScheduleOf()` 把通过 `reconcileTimings` 的旁白（`at_progress` 按实测换算、`at_word` 用词起点）或字数估时换成 `BeatSchedule`、**plan 里读旁白的位置提到审计之前**。模板声明 `teachPageTransition = 500`（它的 `fade` 就是固定 0.5 s）与 `teachTransition = 480`（等于 `--teach-dur`）；skill 的「最小骨架」改成"三个必需 + 两个可选"并新增一小节，顺带修掉示例里 `Reveal.slide(n, 0, 0)` 与检查清单冲突的旧写法。验证：`test/teach-transition.test.ts` 四例——录制器用一个切页会亮红 700 ms 的 deck（700 ms 落在默认 300 与声明 1000 之间，两种情况不可能同时过），声明时首帧红色像素 **0**、不声明时 **57 584 / 57 600**；把录制器改回硬编码后声明那例同样变成 57 584 并让测试失败（实测）。plan 侧三例分别断言：无旁白时按字数估时并写明"这是估的"；有 2600 ms 实测旁白时为 `fragment 1 at 780 ms and fragment 2 follows 390 ms later` 且无"估时"字样；deck 不声明时一句不说。`pnpm check` 744 passed / 7 skipped；样本按新模板重渲为 `renders/motion/v002.mp4`（46.17 s，逐句"在动的帧数" 8 / 20 / 22 / 13 / 39 / 14 / 25，0 ms 对照页仍是 2）。**2026-11-25 当日补**：这支样本成片的第一版（`renders/contract/v002.mp4`）里 `s01-5` 的第二拍迟到了 1834 ms，480 ms 的淡入只录到前 122 ms —— 观感是"这一页没播完"，而且当时的检查全都没报（帧色自检只问画了东西没有，`ignored_cues` 是空的）。于是同一天补了两件：拍子时钟换单调时钟并记录实际时刻、迟到自动重录一次、结果里给 `motion_findings`；录完把 deck 驱动到最后一拍截图，与段末帧比一次（640×360 灰度，判定线 0.2%）。证据与边界见 `docs/TEACH-MOTION.md` §15，`test/teach-transition.test.ts` 从四例增至十例（含"强制迟到→重录→仍迟到"与"末帧被切/已完成"各一例）。未做：一个 deck 只能声明一个页内时长（`count`/`draw` 的 900 ms 与 480 ms 无法同时表达），页切换时长的合理区间留给 B13 的 `meta.transition.durationMs`

### [ ] B13 D3：跨句转场（含音频对轨与并行衔接）

- **做什么**：① 段结构改成 `[正文 durationMs][转场 exitMs]`，`recordDeckSegment` 加 `exit: { page, enter, ms }` 分支（录完正文后 `teachPage(N+1)` + `teachCue(enterNext)` 再录 `exitMs`）；② `pipeline.ts` 用 `pageSlots` 全量算出下一段的 `{page, enter}` 传进去；③ 音频在每段后补 `exitMs` 静音（落在 `cutAudioSegment` 的 `apad` 或 assemble 时，**不能两处都补**）；④ `timings.json` 每条加 `exitMs`（缺省 0），`assembleVideo` / `buildSrt` / `assemble-act.py` 全部按 `durationMs + exitMs` 累加；⑤ `rules.ts` 八条校验（时长范围、纯 cue 模式拒绝、跨 engine 降级、`exitMs` 超句长、拍后余量、`enter=0` 全暗、整体覆盖 `transition`、`dim` 与 `fade` 混用）。
- **为什么**：这是唯一能把 reveal 的页转场与 **Auto-Animate** 录进成片的办法——补间发生在同一段录制内（同一文档先 `teachPage(N)` 再 `teachPage(N+1)`），不需要改"一句一录"的地基。转场放**前一段的尾部**而不是后一段的开头：放开头会让句首画面还在转场，违反"句首完整构图"；放尾部则在"最后一屏停留"之后，两不冲突。
- **成本/前提**：四周改动（`slides.ts` / `pipeline.ts` / `ffmpeg.ts` / `rules.ts`）+ 项目侧 `assemble-act.py` 跟改。**最大风险是一本账**：转场让段变长，任何一处按"只有 `durationMs`"算都会让并行验收的"成片时长 = timings 合计（容差一帧）"失败。跨 engine 边界一律降级为硬切（Manim 场景在另一个进程、另一份文件，拿不到"下一页初态"）。幕与幕之间不做转场。
- **出处**：[`docs/TEACH-MOTION.md`](docs/TEACH-MOTION.md) §6（D3 全文，行 207）· §6.1 归属（行 211）· §6.2 录制流程（行 226）· §6.3 音频（行 242）· §6.4 对轨（行 248）· §6.5 多幕并行（行 262）· §6.7 跨 engine（行 285）· §7 八条校验（行 303）
- 实现记录：待

---

## C. 待办：明确要做，只差动手

### [ ] C1 DeepSeek 真跑一遍 `narrate → render`

- **做什么**：在仓库自己的 fixture 上，用默认路线（DeepSeek 音色 + `at_progress` 节拍）真跑一次合成与渲染，确认 §23 修掉的几处没有回归。
- **为什么**：§23 的十个缺陷里有几条只经过离线测试。外部项目 `video-hypatia` 已经用 DeepSeek 出到 a00 v003（64.9 s、12 个节拍、每段都有画面变化），但那是另一个工作区的证据，不是本仓库 fixture 的证据。
- **成本/前提**：极小额度付费（一条短稿即可）。
- **出处**：`docs/TEACH-VIDEO.md` §23「仍未做」第 1 条（行 673）
- 实现记录：待

### [ ] C2 GUI 里过一次设置页与面板

- **做什么**：点开设置页看一次探测结果（需重载插件）；把一段成片放进工作区 `renders/` 后在视频面板点开。顺带看一眼「教学视频」小节的折叠状态与两个 key 的标题行，以及 2026-11-25 新增的 **ffmpeg 目录**输入框与探测结果里的 `subtitles:` 一行。
- **为什么**：§24 是在隔离实例里验证的，真实宿主上没点过；「面板只列本工作区片子」这条（`docs/DESIGN.md` §19.6）也只测过播种台账。
- **成本/前提**：免费，要重载插件。
- **出处**：`docs/TEACH-VIDEO.md` §23「仍未做」第 2 条（行 674）· `docs/DESIGN.md` §19.6（行 1150）
- 实现记录：待

### [ ] C3 按 §17 规则返工 3 分钟样片

- **做什么**：修三处超预算的句子（47 / 46 / 43 字，各约 9 秒）、把平均 10.5 秒一次变化压到 8 秒以内、拆掉被三句共用的 Manim 场景、放大 Manim 画面。
- **为什么**：样片是这条路线唯一的端到端证据；规则违反留着，后来的人会照着写。
- **成本/前提**：需要重新排稿与（部分）重录旁白。
- **出处**：`docs/TEACH-VIDEO.md` §17（规则，行 424）· §16.3（实测与已知问题，行 411）· §23「仍未做」第 3 条（行 675）
- 实现记录：待

### [ ] C4 听感复核

- **做什么**：听完一条完整成片，判两件事：句间停顿够不够、跨句语气是否还漂。
- **为什么**：只有人耳能判。§19 的停顿策略与 §22 的默认音色都是照试听定的，改过之后没人再听过完整成片。
- **成本/前提**：免费，需要一段时间。
- **出处**：`docs/TEACH-VIDEO.md` §18（行 465）· §19「需要人工复核」（行 507）· §23「仍未做」第 4 条（行 676）
- 实现记录：待

### [ ] C5 `MINIMAX_MODELS` 补 H3-Highspeed / H3-Lite

- **做什么**：在 `MINIMAX_MODELS` 里补这两个模型条目（能力、价格档）。
- **为什么**：现在只注册 H3 与 H3-Max，用户可选列表缺两档。
- **成本/前提**：免费，改一处常量；要不要跑一次真实调用验证另说。
- **出处**：`docs/DESIGN.md` §22.4「能力缺口」（行 1548）
- 实现记录：待

### [ ] C6 `generateAudio` 注释与「H3 原生立体声」不符

- **做什么**：presets 注释写 `generateAudio: false`，依据是「两家都没写音频开关」，但官方说 H3 原生立体声。要么改注释，要么补字段。
- **为什么**：注释里的错误判断会被下一次改动当成事实继承下去。
- **成本/前提**：免费。
- **出处**：`docs/DESIGN.md` §22.4（行 1548）
- 实现记录：待

### [ ] C7 `buildArkContent` 缺 reference_video / reference_audio role

- **做什么**：补这两个 role。要连带 M6（D5）的 `parts[]` 一起做才顺。
- **为什么**：现在只有三种图片 role，方舟的参考视频/音频能力接不进来。
- **成本/前提**：依赖 D5 的 schema 决定。
- **出处**：`docs/DESIGN.md` §22.4（行 1548）· §16.8（行 803）
- 实现记录：待

### [ ] C8 隔离实例里点一次 `/video-prompting`

- **做什么**：在隔离实例里用 `/video-prompting` 触发一次 skill。
- **为什么**：命令识别逻辑简单、风险低，但按 `docs/DESIGN.md` §13 的纪律，凡入口都该在隔离实例里点一次。
- **成本/前提**：免费。
- **出处**：`docs/DESIGN.md` §22.4「未做」（行 1547）
- 实现记录：待

### [ ] C9 卡片入口的浏览器实测

- **做什么**：一次真实（付费）生成，然后在真浏览器里点开聊天卡片。
- **为什么**：卡片是主要入口，现在只有隔离实例的播种数据。
- **成本/前提**：需要一次付费生成。
- **出处**：`docs/DESIGN.md` §19.5（行 1148）
- 实现记录：待

### [ ] C10 客户端拆分

- **做什么**：`settings-card.tsx`（约 700 行）与 `providers-editor.tsx`（约 630 行）在膨胀，下一轮改配置卡之前先拆。
- **为什么**：不是为了好看。改配置卡时每次都要在 700 行里找落点，改动面判断容易错（§24 的两个缺陷都是渲染层才发现的）。
- **成本/前提**：免费，纯前端重构，有现成测试兜底。
- **出处**：`docs/DESIGN.md` §16.8（行 807）
- 实现记录：待

### [ ] C11 面板缩略图

- **做什么**：列表行要真封面时，先看 `vNNN.last.jpg`（有尾帧时），或给流路由开一个只回首帧的小窗口端点。
- **为什么**：每行一张首帧＝每行一次媒体请求（窗口 1 MiB），列表长了不值得。现在是矢量占位方块，展开才有播放器。
- **成本/前提**：免费。
- **出处**：`docs/DESIGN.md` §19.5（行 1145）
- 实现记录：待

### [ ] C12 放开 `mov` / `webm` / `m4v`

- **做什么**：同时改渲染器的后缀声明与 `STREAM_MEDIA_TYPES`。
- **为什么**：现在这三种继续显示「无法预览」。
- **成本/前提**：免费，改两处。
- **出处**：`docs/DESIGN.md` §19.5（行 1147）
- 实现记录：待

---

### [x] C13 `prepare-runs` 脚本：派发前的一次性预处理

- **做什么**：给每一幕生成 `runs/<act>/`：切出只含本幕句子的稿本、拷 `slides/<act>/` 与 `materials/` 与 `script/`、写 `.python-version`、记下主项目 `storyboard.yaml` / `timings.json` 的 sha256。
- **为什么**：现在这五件事手工做了五次（五个目录 × 9.3 MB），漏一步就是一个坑：漏 `.python-version` → `spread-page-beats.py` 崩在 import；漏拷 deck → 渲染出旧图（a02-6 在三个版本里留着旧图）。手工重复五次的东西，第五次一定会漏。
- **成本/前提**：免费。已落为 `assets/teach/runs.py prepare`（形态见 D10）。
- **出处**：[`docs/TEACH-PARALLEL-ACTS.md`](docs/TEACH-PARALLEL-ACTS.md) §4（派发前五件事）· §10（脚手架）
- 实现记录：2026-11-24 · `assets/teach/runs.py` 的 `prepare` 子命令（`be684bb`）· 合成项目上验过：切稿本 2 句、拷 deck/materials/script、写 `.python-version`、记基线 sha256；`prepare` 后重跑可同步被改过的 deck 副本

### [x] C14 `collect-runs` 脚本：回收 + 逐句段长校验

- **做什么**：把每幕的 `audio/<act>-*.wav`、`.dsh-video/teach/<id>/segment.mp4`、`timings-<act>.json`、`storyboard-<act>.yaml` 拷回主项目，并**逐句校验段长与该句音频一致**（差超过两帧就指名报错）。
- **为什么**：手工 `cp` 犯过一次致命错误——为了恢复被删的目录，把主项目的旧 `audio/` 拷进了 run 目录，覆盖掉刚录的新音频，结果三个版本都带旧声音而没人发现。逐句段长校验能在拼片前抓到"重录了但没重渲"这类错位。
- **成本/前提**：免费。已落为 `assets/teach/runs.py collect`。
- **出处**：[`docs/TEACH-PARALLEL-ACTS.md`](docs/TEACH-PARALLEL-ACTS.md) §6（回收）· §7（验收）· §10（脚手架）
- 实现记录：2026-11-24 · `assets/teach/runs.py` 的 `collect` 子命令（`be684bb`）· 真实项目 `video-hypatia` 五幕 `--dry-run` 全部 exit 0（a02 104 / a03 92 / a04 52 / a05 58 / a06 34 个文件，逐句段长与 timings 一致）；合成项目上验过三条失败路径：缺音频、段长偏差 500ms（点名句子）、`--force` 照现状拷。**先校验后写**：任何一项不过就退出 1，主项目零改动

### [x] C15 run 目录副本漂移检查

- **做什么**：比对主项目 `slides/<act>/index.html`、`storyboard.yaml` 与 `runs/<act>/` 里副本的 md5，不一致就告警。
- **为什么**：渲染读的是副本，不是主项目；主项目改完不同步，渲染出旧内容而且工具不会报错（它只知道自己读的那份）。现在 `assemble-act.py` 里已有一条 md5 告警，但只在拼片时触发，太晚。
- **成本/前提**：免费。已落为 `assets/teach/runs.py drift`。
- **出处**：[`docs/TEACH-PARALLEL-ACTS.md`](docs/TEACH-PARALLEL-ACTS.md) §9 第 3 条（副本漂移）· §10（脚手架）
- 实现记录：2026-11-24 · `assets/teach/runs.py` 的 `drift` 子命令（`be684bb`）· 真实项目五幕全部一致 exit 0；改主项目 deck 后正确报不一致 exit 1，重跑 `prepare` 后恢复

---

## D. 未决：要拍板，或要外部信息

### [ ] D1 本地 ffmpeg 要不要通用化

- **现状**：能力已经有了，但只在教学路线里（`src/teach/ffmpeg.ts` 用 `node:child_process` 的 `spawn` 做 CFR / 拼接 / 混音 / 探测）。`video_generate` 那条路仍不拼接、不碰本地媒体，所以「不做剪辑/时间线/多段拼接」这条非目标**仍然成立**。
- **要定什么**：要不要把这份能力提到通用路线（拼接成片、`from` 续拍截尾帧、模型自检抽帧、缩略图）。真要做得把 `node:child_process` 换成宿主的 `ctx.subprocess`，并重估市场能力声明。
- **建议先做的一项**：给不返回尾帧的供应商（如 MiniMax）截尾帧，它直接决定 `from` 续拍能不能用。
- **谁定**：你。
- **出处**：`docs/DESIGN.md` §1 非目标（行 20）· §14 待办（行 634）· §16.8（行 802）· §17.4 `from` 注记（行 858）· §23 依赖与子进程偏离（行 1565）
- 结论：
- 实现记录：待

### [ ] D2 `conversation.view` 任务 tab

- **现状**：聊天卡片已承担大部分职责，先不拆。
- **谁定**：你。
- **出处**：`docs/DESIGN.md` §16.8（行 808）· §14（行 634）
- 结论：
- 实现记录：待

### [ ] D3 预设模型目录过期时要不要在卡片提示

- **现状**：模型 id 带日期，插件只有 API Key、拿不到在线目录。已出现第一个疑似例子（`doubao-seedance-1-0-pro-250528` 返回 `InvalidEndpointOrModel.NotFound`）。现在报错会带供应商原话。
- **谁定**：你。
- **出处**：`docs/DESIGN.md` §15 第 9 条（行 646）· §16.8（行 806）
- 结论：
- 实现记录：待

### [ ] D4 「接受的取消」之后 `tool-jobs` 的行为

- **要定什么**：`video_cancel` 被接受后任务标 `quiet`；但取消最终要让 job 的 `run` 返回 `{status:'killed'}`。`tool-jobs` 对这种情况是静默还是照常通报，以及插件被 cordis 重载时旧实例的 jobs 以 `teardown`（通报，正确）还是 `kill`（静默）结算，都要读 DSH 源码才能定。
- **影响**：「接受的取消后 quiet」与「teardown 不是 kill」两条规则能否端到端成立。
- **谁定**：需要 DSH 源码。
- **出处**：`docs/DESIGN.md` §15 第 15 条（行 661）· §17.10 开放问题（行 1079）
- 结论：
- 实现记录：待

### [ ] D5 M6 内容片段重构（单独一次改造）

- **做什么**：`VideoMode = t2v | i2v | flf2v | s2v` 是四选一枚举，装不下参考视频/音频、编辑/延长、样片、仅尾帧。改成 `parts: [{ type, role, source }]`，mode 从 parts 推导、只用于校验。
- **为什么**：两家的 `content[]` 已经是同一形状，枚举是唯一塞不下的地方。会动到工具 schema、台账 `params`、去重指纹与卡片，**不与 M3 合并**。
- **谁定**：你（涉及对外 schema）。
- **出处**：`docs/DESIGN.md` §16.8（行 803）· §14（行 632）
- 结论：
- 实现记录：待

### [ ] D6 可灵 / Veo 接入

- **现状**：排在 M6 之后；Veo 默认关闭（ToS/封号风险，可灵官方通道更干净）。
- **谁定**：你。
- **出处**：`docs/DESIGN.md` §16.8（行 805）· §15 第 4 条（行 641）
- 结论：
- 实现记录：待

### [ ] D7 §15 第 14 条那批「暂不修」的已知风险

- **是什么**：双进程共用同一个 `DSH_HOME` 不安全 · `unconfirmed` 行只在开机找回、运行期不重试 · `orphaned` 不计入并发数 · 中转站跨域产物会一直 401（需要时加 `artifactAuth`）· 在线测试只给一家 key 时另一家被静默跳过 等。
- **为什么单列**：它们都被明确标为「暂不修」，不是忘了。要修时从这里进。
- **谁定**：内部分批排期，遇到相关改动时顺手处理。
- **出处**：`docs/DESIGN.md` §15 第 14 条（行 651–660）
- 实现记录：待

### [ ] D8 你账号里实际开通了哪些音色

- **为什么**：默认音色取「流畅女声 2.0」`zh_female_liuchangnv_uranus_bigtts`，男声备选「儒雅逸辰 2.0」。它们在清单里，但**你账号实际开通了哪些**只有控制台能看到，这决定默认值落不落得住。
- **谁定**：你（控制台）。
- **出处**：`docs/TEACH-VIDEO.md` §11 组 A 第 2 条（行 281）· §10.1（行 197）
- 结果：
- 实现记录：待

### [ ] D9 三个只能实测的数字

- **是什么**：TTS 长文本上限与多句并行合成的限流 · Playwright 录屏在 1920×1080 下的真实丢帧率（决定 `fps` 滤镜是补帧还是改确定性逐帧截图）· Manim 首渲染耗时与 LaTeX 缓存（3.8 s，未预热）。
- **谁定**：写测试或压一次就能得到。
- **出处**：`docs/TEACH-VIDEO.md` §11 组 C（行 293–295）· `docs/DESIGN.md` §23「仍未决」（行 1589）
- 结果：
- 实现记录：待

---

### [x] D10 并行派发要不要做成插件能力

- **现状**：规程靠项目侧脚本 + 手工执行。三条脚本（C13–C15）写在哪个仓库、以什么形态分发，还没定。
- **要定什么**：三条路——① 留在项目里当 `script/*.py`（每个项目各写一份）；② 随插件分发成 `assets/teach/*.mjs` 脚手架（用户拷走改）；③ 提升成工具（例如 `video_teach_render` 接受多份稿本并发跑，插件自己管隔离与回收）。③ 会让工具面变复杂且与"一个会话一个工作区"的模型冲突，不推荐；①② 的差别只是分发方式。
- **谁定**：你。
- **出处**：[`docs/TEACH-PARALLEL-ACTS.md`](docs/TEACH-PARALLEL-ACTS.md) §10（脚手架）
- 结论：**2026-11-24 定 ②（随包脚手架），已落地**。实现是单个 `assets/teach/runs.py`，三个子命令 `prepare` / `drift` / `collect`，对应 C13 / C15 / C14。
  - 选 python 不选 node：`prepare` 要读写 `storyboard.yaml`，而随包分发的 node 脚本拿不到插件的 `node_modules`（`yaml` 是插件运行时依赖）；项目侧已依赖 PyYAML，缺它时明确报错退出 3。
  - 分发：`package.json` 的 `files` 已含 `assets`，`assets/teach/runs.py` 随包走，不用改打包配置。用法是拷进项目 `script/runs.py`，跟项目一起走版本控制。
  - 不选 ③（提升成工具）：会让工具面变复杂，且与「一个会话一个工作区」的模型冲突——并发调度属于项目侧编排，不属于工具。
- 实现记录：2026-11-24 · `assets/teach/runs.py`（`be684bb`）· 五幕 170 句 dry-run 全通过

---

## E. 明确不做（不是待办，别再开）

| 项 | 理由 | 出处 |
|---|---|---|
| 预算闸门（单次/每日上限、超额审批） | 2026-10-15 决定暂不做，优先级很低 | `docs/DESIGN.md` §15 第 3 条（行 640）· §16.5（行 773）· §16.8（行 804） |
| 会话附件 id（只做路径 + 文件头识别） | 附件落在 `$DSH_HOME/attachments`，模型拿到的路径可以直接当素材 | `docs/DESIGN.md` §17.5（行 861–867）· §15 第 12 条（行 649） |
| 面板动工作区（删 / 重命名 / 导出） | 面板只读，避免误操作真实文件 | `docs/DESIGN.md` §19.5（行 1146） |
| chip 里填自由文本参数、跨会话记住上次选择、带 `generateAudio` / `sizes` | 作用是会话级，供应商特有字段不进通用菜单 | `docs/DESIGN.md` §20.8（行 1251–1253） |
| 视频剪辑 / 时间线 / 多段拼接（通用路线） | `deepseek-ivideo` 的地盘；教学路线能拼，但那是另一条路 | `docs/DESIGN.md` §1 非目标（行 20） |

---

## F. 已关闭（曾经被写成「未做」，实际已完成，不要重做）

| 项 | 何时关闭 | 证据 |
|---|---|---|
| 隔离实例端到端验收 | 2026-11-20 | `docs/TEACH-VIDEO.md` §13（行 378）· 宿主起在 34798，插件接口 `ok:true`，真实 `~/.dsh` 未被触碰 |
| 3 分钟混合样片 | 2026-11-20 | `docs/TEACH-VIDEO.md` §16.3（行 411）· 25 句 / 165 192 ms，成片与旁白差 0 ms，3.78 MB（返工见 C3） |
| 文档里五处「未实现」类过时标签 | 2026-11-24 | 标题与状态行、§6 标题、两处「仍未做」、§9 里程碑表（补成四列并给 M0–M5 状态） |
| 本地 ffmpeg 的「未决」标签 | 2026-11-24 | 按现状重写在 `docs/DESIGN.md` §1 / §14 / §16.1 / §16.8 / §17.4 / §23；真正的未决降级为 D1 |
| README 里「fragment 按词触发」与「按词定时的 SRT」 | 2026-11-24 | 默认音色没有词级时间戳，改成按页 + 比例；中英两份同步 |

---

## 维护

- **新增项**按分区分号追加，写清「做什么 / 为什么 / 成本前提 / 出处 / 实现记录」。**没有出处的项不要进这份文件** —— 说明它还只是一个想法，先写进 `docs/`。
- **完成时**改 `[x]`、回填实现记录，**并把对应 docs 章节里的「未做」删掉或改成结论**。文档与清单不一致时以 `docs/` 的事实为准，清单跟着改。
- 每次动这份文件，顺手确认引用的行号还指得对（`docs/` 一改，行号就漂）。
