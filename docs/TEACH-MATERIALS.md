# 素材体系：放哪、怎么引用、怎么登记（2026-11-25）

本文回答一件事：**agent 在做片子时，素材从哪来、放到哪、怎么被用上**。

它覆盖两条路线与两侧行为：

- **消费侧**：做 slide 时用图、用图标；抽卡生成视频时用角色立绘、参考图、首尾帧。
- **生产侧**：agent 自己生成素材时（文生图、手写 SVG、界面截图），产物落在哪个目录、要登记什么。

只管方案，不写代码。页内节拍的契约在 `docs/TEACH-VIDEO.md` 的「画面契约：一句一页 + 句内可分步」与「一条契约修正：页模式下 fragment 编号按页算」两节（那份文档有两个 `## 22`，所以这里按子节名引用，不按编号）；§25 是尚未实现的 `page` / `enter` 提案，§25.8 的「SVG 也能当节拍」正好是本规范里图标要内联的佐证。并行派发的目录契约在 `docs/TEACH-PARALLEL-ACTS.md`。

## 0. 主旨

**素材是输入，`renders/` 是输出。** 任何 agent 要用的东西都必须先落在项目里的素材目录，并在一张表里有名字；任何 agent 产出的素材也必须落在那儿并登记来源。不能出现"路径在我脑子里"或"临时目录里有个文件"。

## 1. 现状：两个问题

### 1.1 截图有七处抄本，且已经漂移

`video-hypatia` 的 a04/a06 是实测样本。同一张截图的状态散在七个地方：

| 事实源 | 现在写什么 | 与别处的矛盾 |
|---|---|---|
| `materials/shots/README.md` 行 8–16 的表格 | S07 一栏写「⏳ 待拍」 | `slides/build.py:1522` 的 note 写「批量删除不拍真截图（2026-11-23 定）」。一处说待拍，一处说决定不拍 |
| 同文件行 18–20「待拍的一张」 | S07 需要勾选后按批量按钮 | 同上 |
| `slides/build.py` 的 `shot=(path, w, h)` 共 9 处（1441 / 1446 / 1458 / 1466 / 1485 / 1498 / 1506 / 1510 / 1514） | 显示尺寸硬编码 | 这是唯一记录「入片宽度」的地方 |
| `slides/build.py` 的 `note='界面示意：…'` 共 3 处（1483 / 1493 / 1522） | 人写的降级说明 | 与 README 行 53–56 的「两个必须知道的缺口」重复 |
| `slides/art_frozen.py:124–125` | `<span class="shotflag">真实截图 · S01</span>` | 角标与状态无关。S03 明明「搜索没真的执行」（README:53），仍标「真实截图」 |
| `script/spec/00-system.md:110–120` 的素材表 | 第三份清单 | 唯一写了留档规则（`raw/` 不发布、`final/` 脱敏，行 143） |
| `script/spec/a04.md` 每页的「素材」行（113 / 127 / 143 / 162 等，全文 26 条） | S01 那页仍写「`S01（待拍摄）`」 | README 行 8 写「✅ 已拍」 |

另有一处没有出处可查的漂移：`slides/acts/a06_art.py:293` 用了 `crops/S01-rows.png`，而 README 的裁切表只登记 `S01-sidebar.png`。

### 1.2 抽卡侧的素材几乎没有约定

通用路线只有一条硬约定：角色参考图走 `characters.<名字>.refs` 的 glob（`docs/DESIGN.md` §4 末尾、§17.8）。其余全靠 skill 里零散的提醒，缺口是：

| 缺口 | 后果 |
|---|---|
| 首帧 / 尾帧图放哪没规定 | 每次由模型临时传个路径，下次找不到同一张 |
| 非角色参考图（风格板、场景板、道具）放哪没规定 | 与角色目录混在一起，或被随手丢在项目根 |
| 立绘本身的规格没规定（位图/SVG、尺寸、底色、多视角命名） | 一致性靠运气；SVG 立绘其实**不被接受**（参考图只认 png/jpg/jpeg/webp/gif） |
| 立绘的来源没记录 | 抽卡出来的立绘既是产物又是输入，说不清它怎么来的 |
| 没有台账 | 换了一张立绘没有任何东西会发现 |
| `materials/README.md` 与事实矛盾 | 它写着「教学路线不需要素材文件、deck 不引外部图片」，而 a02-1 实际引了 `materials/images/hypatia-head-tight.jpg` |

## 2. 素材必须住在项目根

这条不是风格偏好，是两条并发要求推出来的：

1. **deck 用 `file://` 加载**（`script/shot-cover.mjs` 的同一套机制），资源只能靠文件系统相对路径解析，`slides/<幕>/index.html` 往上两层就是项目根，所以引用固定写成 `../../materials/…`。
2. **并行派发时 deck 会被拷进 `runs/<幕>/`**。`assets/teach/runs.py` 的 `SHARED_DIRS = ('materials', 'script')` 会把这两目录一起拷进 `runs/<幕>/`，于是 `runs/<幕>/slides/<幕>/` 的 `../../` 正好落在 `runs/<幕>/materials/`。**只要素材在项目根、且路径是"往上两层"，主项目与 run 副本就同构。**

由此推出三条硬约束：

- 素材目录必须在项目根（不能指到项目外、不能是绝对路径）。`materials/<角色>/` 是最深的一层。
- 引用路径只有一种形状：`../../materials/<目录>/<文件>`。绝对路径、`~`、`http(s)://`、第三层相对路径一律算错。
- **`video-project.yaml` 的 `paths.materials` 目前不参与解析**：`characters.<名字>.refs` 是按**工作区根**展开的（`src/compose.ts` 的 `expandRef(runtime, session.cwd, …)`），清单里只有 `paths.renders` 真被用到（`src/operations.ts`）。所以别以为改名 `paths.materials` 就能搬家。它现在只是一句声明，写进文档是为了不让人误信。

## 3. 目录布局与保留名

按**用途**分目录，不按来源分（来源写进台账字段，见 §7）：

```
<项目>/
  materials/
    README.md            # 人看：这张表 + 引用方式（初始化时生成，见 §11）
    catalog.yaml         # 机器读：每个素材的出处、许可、来源、用在哪儿
    alice/               # 抽卡：角色立绘与参考图（目录名 = 角色名）
    frames/<shot>/       # 抽卡：first.png / last.png，与 renders/<shot>/ 对齐
    style/               # 抽卡：风格板、场景板、构图参考
    images/              # deck：位图（照片、插画、油画扫描）
    icons/               # deck：图标与矢量图元的 .svg 源文件（构建时内联）
    shots/               # deck：界面截图（raw/ final/ crops/ + shots.yaml）
  slides/<幕>/index.html
  storyboard.yaml
  renders/<shot>/vNNN.*
```

**`materials` 下一层目录名是共享命名空间**，角色名与固定目录抢位置，所以定一份保留名清单。以下名字**不能当角色名**，登记了要报错：

`README.md`、`catalog.yaml`、`shots`、`images`、`icons`、`frames`、`style`

选这套（而不是更干净的 `materials/characters/<名字>/`）是为了兼容既有写法：`characters` 的 `refs` 已经是 `materials/<名字>/*.png`（`docs/DESIGN.md` §17.8、`assets/skills/video-iterate.md`），换目录会让已有项目失效。代价就是这份保留名清单。

## 4. 生产侧：agent 生成的素材放哪

| 生成方式 | 落到哪 | 台账要记什么 |
|---|---|---|
| 界面截图（隔离实例里拍） | `shots/raw/`（原图）→ `shots/final/`（脱敏）→ `shots/crops/`（证据区） | 见 §7.2 的 `shots.yaml`：`status` 由脚本算、`must_show`/`forbidden` 在拍摄时对 DOM 断言 |
| 手写 / 程序生成的 SVG 图标 | `icons/<名字>.svg` | `kind: icon`、`origin: authored`、用途 `used_by` |
| 文生图得到的位图（用本插件之外的能力） | `images/<名字>.png`；若是一致性用的立绘，放 `alice/` | `kind: image`、`origin: generated`、**`prompt` 与 `model` 必填** |
| 用户提供的图 | 同上，按用途 | `origin: supplied`，`license`/`source` 必填 |
| 从成片里截的一帧（当首帧续拍，或沉淀成长期立绘） | 直接引用 `renders/<shot>/vNNN.last.jpg`，或拷一份进 `frames/<shot>/` | `origin: derived` + `source: renders/<shot>/vNNN.mp4`；**允许长期复用**（2026-11-25 决定） |

两条纪律：

- **不许把素材写进 deck HTML 里当作唯一副本**。图标源文件放 `icons/`，deck 由构建脚本内联；否则换一个图标就要改 deck，也没法在台账里登记。
- **不许把素材留在项目外**（临时目录、桌面、下载目录）。规则见记忆 `rule-no-tmp-asset-references`：`/tmp` 会被清理，等于这套素材没人能重做。

## 5. 消费侧 A：deck 的静态资源

判据只有一条：**这个元素要不要被节拍点亮、要不要用 CSS 改色。**

| 内容 | 放哪 | deck 里怎么写 | 为什么 |
|---|---|---|---|
| 图标、装饰矢量 | `icons/*.svg` | 构建脚本读文件、**内联**成 `<svg>` | `<img class="fragment">` 其实会被 `countDeckFragments` 数到、也能整块点亮，但改不了色、没法只点亮图里的一部分（`<g class="fragment">`），也跟不上主题色。要这些能力就必须内联 |
| 照片、插画、油画扫描 | `images/*` | `<img src="../../materials/images/xxx.jpg">` | 内联 base64 会让 deck 涨到几十 MB，录屏与导出都受拖累 |
| 界面截图 | `shots/`（经 `crops/`） | 见 §9 | 它是"事实证据"，有真伪状态，另一套规则 |

"源文件在 `materials`、产物内联"是关键：图标既能在 `icons/` 里替换与版本管理，又保留片中的节拍能力。

## 6. 消费侧 B：抽卡的参考图、立绘、首尾帧

| 用途 | 位置 | 传给工具的参数 |
|---|---|---|
| 角色一致性 | `alice/front.png`、`alice/side.png`… | `characters: ["alice"]`（走清单的 `refs` glob） |
| 首帧（`i2v`） | `frames/<shot>/first.png` | `first_frame` |
| 首尾帧（`flf2v`） | 同上 `first.png` / `last.png` | `first_frame` + `last_frame` |
| 参考图引导（`s2v`） | `style/`、`alice/` | `reference_images` |

立绘规格（写死，因为它直接决定抽卡稳定性）：

- **位图，不是 SVG**：参考图只认 png/jpg/jpeg/webp/gif，SVG 会在文件头识别那一步被当成不认识。
- 单角色单目录，长边 ≥ 1024（经验值，未实测；低于它细节丢失明显），背景干净（透明或纯色），多视角固定命名 `front` / `side` / `back`；`refs: [materials/alice/*.png]` 一次带齐。
- 一次请求的参考图合并去重后**上限 9 张**（`src/compose.ts` 的 `MAX_CHARACTER_REFS`，方舟最多收 9 张）。通配很容易一下匹配一整个文件夹，所以别在角色目录里堆草稿。
- 首尾帧与参考图**只接受工作区相对路径或绝对路径或 http(s)**，但规范上只允许工作区相对路径：`http(s)` 在录屏与复现时都会抖，绝对路径在并行派发时落到别的机器上。

## 7. 两本台账

### 7.1 为什么是两本而不是一本

| 文件 | 管什么 | 字段重心 |
|---|---|---|
| `materials/catalog.yaml` | 除截图以外的全部素材：图标、位图、角色立绘、首尾帧、风格板 | 出处、许可、来源、被谁引用 |
| `materials/shots/shots.yaml` | 界面截图 | 真伪状态（§8 的七行矩阵）、证据区裁切 |

不合并的理由：截图有一套**状态机**（拍不到 / 与旁白矛盾 / 不能整图上镜），其余素材只有"存在、出处、许可"三件事。硬合并会让简单的东西背上七态矩阵，校验器也会变成两个语义挤在一个文件里。两本用同一个校验器读，`file` 都**相对 `materials/`**——deck 里的 `../../materials/…` 去掉前缀就是台账里的写法。

### 7.2 `catalog.yaml` 的字段

```yaml
version: 1
entries:
  - file: alice/front.png
    kind: image                  # image | icon | frame | style
    origin: authored             # generated | supplied | derived | authored
    used_by: ["characters.alice"]  # 角色名、shot 名、或 deck 句子 id
    license: "内部自产"           # PD / CC0 / CC-BY（要署名页）/ 内部自产 / 用户提供
    source: null                 # supplied 填 URL 或"用户提供"；derived 填 materials/… 或 renders/<shot>/vNNN.mp4
    prompt: "..."                # generated 必填：当时用的提示词
    model: "..."                 # generated 必填
    at: "2026-11-25"
    sha256: "…"                  # 由脚本算，用于发现"换掉了但没人知道"
```

`origin` 四个值分别对应：agent 生成、人提供、从别的素材或成片派生、手写或程序生成。**`generated` 不带 `prompt` 就是不可复现**，校验直接报错；`authored`（例如手写的 SVG 图标）不要求提示词，但许可照填。

### 7.3 `shots.yaml` 的字段

```yaml
version: 1
shots:
  - id: S03
    file: shots/final/S03.png
    used_by: [a04-6, a04-7]
    role: structure                   # evidence | structure | decor
    readable_because: >               # role: structure 时必填；evidence 时留空
      观众只需看清「结果是几行」，不读行内文字
    crop:
      box: [x, y, w, h]               # 2x 原图坐标，脚本据此生成 crops/
      design_width: 1400              # 入片显示宽度，等于 build.py 的 shot= 第二项
      min_text_px: 28                 # 要讲的文字在原图里的物理字号，capture 时取
    evidence:
      source: capture                 # capture | manual
      at: "2026-11-23T15:28"
      instance: "isolated instance, port 3099, 2026-11-23"   # 只记重建要素，不记临时 HOME
      dom:                            # capture 时由脚本写入，不手写
        - {selector: '.search input', text: '缓存'}
    blocker: null                     # 非空 = 拍不到或决定不拍，必须带日期与原因
    must_show:
      - {selector: '.result-count', text: '命中'}
    forbidden:
      - {selector: 'body', text: '输出预算'}
      - {text: 'hypatia-demo-home'}
    spec_ref: "00-system.md §7.2"
```

`instance` 记的是**怎么重建这次拍摄**（隔离实例、端口、日期），不是 `$DSH_HOME` 的临时路径。`/tmp` 会被系统清理，写进台账的路径等于一条迟早失效的指针；重建按 `docs/DESIGN.md` 的验证纪律做。

字段按来源分开，这是整套设计的核心：

| 字段 | 谁写 | 能不能机器判 | 缺失时 |
|---|---|---|---|
| `file` / `used_by` / `role` / `spec_ref` | 人 | 能（存在性、范围、句子 id 是否存在） | 报错 |
| `crop.box` / `design_width` | 人 | 能（生成 crops、算缩放） | 报错 |
| `crop.min_text_px` | **脚本**，capture 时从 DOM 取 | 是它给字号判据提供事实 | `source: manual` 时人填，视为未复核 |
| `readable_because` | 人 | 不能，只检查非空 | `role: structure` 时必填 |
| `evidence.dom` | **脚本**，capture 时写 | 是它给断言提供事实 | `source: manual` 时为空 |
| `blocker` | 人 | 不能（"为什么拍不到"只有人知道） | 与 `file` 至少给一个 |
| `must_show` / `forbidden` | 人 | 能，但只在 `source: capture` 时 | 报错（不留空跑） |
| `status` | **脚本**，派生 | 是 | 不许手写 |

`must_show` / `forbidden` 是 `{selector, text}` 而不是裸字符串：裸字符串只能靠 OCR 或人眼判断；带 selector 才能在拍摄时用 DOM 断言。`forbidden` 里不带 selector 的项表示"任何可见文本里都不许出现"，capture 时扫 `body.innerText`。

## 8. 截图的状态由脚本算

`file` 是否在、`blocker` 是否给、`evidence.source` 是什么，三者决定状态：

| `file` | `blocker` | `evidence.source` | 判定 | 角标 |
|---|---|---|---|---|
| 在 | 空 | capture，`must_show` 全中、`forbidden` 全不中 | `shot` | 真实截图 |
| 在 | 空 | capture，`forbidden` 命中 | `leaky` | 真实截图（已裁到证据区） |
| 在 | 空 | capture，`must_show` 未中 | `mismatch` | 界面示意 |
| 在 | 空 | manual | `unverified` | 真实截图（未复核） |
| 在 | 非空 | — | `error` | — |
| 不在 | 非空 | — | `blocked` | 界面示意 |
| 不在 | 空 | — | `error` | — |

三条规则：

- `status` 是派生字段。脚本写回时加注释 `# generated`；读到与计算结果不符的手写值直接报错，不静默覆盖。手改状态就是让台账撒谎。
- `unverified` 是最重要的一格。现有裁切全是历史截图、没有 DOM 快照，重拍之前只能是 `unverified`，角标也只能是「真实截图（未复核）」。这比标成「真实截图」准确（记忆 `unknown-value-must-be-explicit-rule`：未知必须显式可判）。
- `blocker` 必须带日期与原因，收口 S07 现在两处矛盾的说法。

## 9. 证据区与字号判据

1. **证据区优先**。`crop.box` 是生成 `crops/` 的唯一来源，高度 ≤ 620、宽度 ≤ 1728（1728 是内容区宽：画布 1920 减两侧各 96 的 `padding`，见 `slides/build.py` 的 `section.page`；586–620 的理由见 `slides/README.md:248`）。整屏截图只在"必须看三栏结构"这类页出现，且要显式写 `role: structure`。
2. **按字号判可读性，且有无条件下限**。判据是 `min_text_px × design_width / box.w`：`role: evidence` 要求 ≥ 24 px，`role: structure` 要求 ≥ 10 px（2026-11-25 决定要加下限），低于就必须重排（收窄标签列、拆两行、删文案）或改 role，不许靠缩小硬塞。`structure` 另要写 `readable_because` 说清"观众只需分辨几块、不读字"。

   把 `materials/shots/README.md` 裁切表里能算出字号的 7 张按 28 物理像素算一遍（表里第 8 张 `S03-controls` 没有 `design_width`；磁盘上另有 3 张没进表的裁切，见 §10 第 4 条）：

   | 裁切图 | 源宽 | 显示宽 | 缩放 | 字号 28 入片后 | 判定 |
   |---|---|---|---|---|---|
   | `S06-dialog` | 940 | 866 | 0.921 | **25.8 px** | evidence ✅ |
   | `S01-sidebar` | 600 | 429 | 0.715 | 20.0 px | structure ✅ |
   | `S04-inspector` | 1080 | 688 | 0.637 | 17.8 px | structure ✅ |
   | `S03-search` | 2670 | 1400 | 0.524 | 14.7 px | structure ✅ |
   | `S05-dangling` | 1430 | 555 | 0.388 | 10.9 px | structure ✅ |
   | `S05-graph` | 1650 | 620 | 0.376 | 10.5 px | structure ✅ |
   | `S04-board` | 3200 | 897 | 0.280 | 7.8 px | **不合格** |

   只有 `S06-dialog` 够 24 px。这也解释了两处历史决定：a04-6 用 `S03-search` 时只能写「结果行」而回避「命中 N 条」（14.7 px 读不出数字）；a04-4 用 `S04-board` 讲的是"三栏"，字糊掉不影响这个结论，所以它只能是 `structure`。

   **已知影响**：10 px 的下限把 `S04-board`（7.8）拦在门外，而 a04-4 现在正用它对位讲三栏。这条决策落地后 a04-4 必须重排（把三栏裁紧、拆成两页、或重拍到字号达标）才能继续用。门槛卡在 8–10 之间是为了让"整屏缩进来"的图进不来，不是给结构图放水。
3. **裁切表由脚本渲染**。`materials/shots/README.md` 现在手写的 8 行裁切表由脚本从 `crop.box` 生成；磁盘上另有 `S01-rows`、`S03-bar`、`S08-config` 三张裁切不在表里，正是"抄本会漂"的实例。

## 10. 校验：能机器判的六条

脚本放**项目侧** `script/check-materials.py`（2026-11-25 决定；实现时从 `.mjs` 改成 `.py`：它要读两份 YAML，而项目侧拿不到插件的 `yaml` 依赖，理由与 `assets/teach/runs.py` 相同）。规则虽然来自插件的目录契约，但保留名、台账字段、deck 结构都会随项目变，放项目侧改起来不用发版；新项目由项目的 agent 按 `video-project` skill 第 4 步自己实现（§11）。六条全部离线、不花钱：

1. **引用完整**：deck 里每个 `<img src>` 指向的文件存在。
2. **路径形状**：只允许 `../../materials/<目录>/<文件>`；出现绝对路径、`~`、`http(s)`、或第三层相对路径即报错。
3. **图标必须内联**：deck 里出现 `<img src="...svg">` 就报错——写进 `<img>` 的 SVG 不能被节拍点亮、不能改色。
4. **台账双向一致**：磁盘上 `materials/` 的文件都能在 `catalog.yaml`（或 `shots.yaml`）里找到一行，反之表里每一行都得指向真实文件。孤儿文件与幽灵条目都报。
5. **来源可复现**：`generated` 必须有 `prompt` 与 `model`；`supplied` 必须有 `license` 与 `source`；`authored`（手写或程序生成）必须有 `license`；`derived` 必须有 `source`（`materials/…` 或 `renders/<shot>/vNNN.mp4`，也接受不带扩展名的 `vNNN`），且那个文件存在；`CC-BY` 及以上还必须有署名页。
6. **截图状态自洽**：`shots.yaml` 的七行矩阵按 §8 计算，手写 `status` 与计算结果不符即报错；`evidence` 的判据按 §9。

`characters.<名字>.refs` 匹配不到文件时插件本来就报错（`docs/DESIGN.md` §17.8），不重复实现；但保留名冲突（§3）要在同一个脚本里报。

## 11. 初始化：README 与 catalog 从哪来

插件**只写 `renders/` 与 `.dsh-video/`**，不碰 `materials/`。所以这两份文件由初始化时的 skill 指令让模型写，模板固定：

- `materials/README.md`：§3 的布局表、§2 的路径算式（"往上两层"）、§5 的内联/外链判据、以及一句"新建素材先在这里和 `catalog.yaml` 各加一行"。
- `materials/catalog.yaml`：`version: 1` + `entries: []` + 字段注释。

触发时机：

- 通用路线：`video-project` skill 的「建项目」是四步（写清单、按用途建 `materials/` 并写 `catalog.yaml` 与 `README.md`、可选写分镜表、写校验器），其中第 2、4 步就是这份规范落地的位置。
- 教学路线：`video-teach-slides` 的「静态资源」一节已写明——项目还没有 `materials/` 时，按 `video-project` 的建项目第 2 步建，教学 deck 走同一套目录。`video-hypatia` 的 `materials/README.md` 里原来那句"教学路线不需要素材文件、deck 不引外部图片"已随这次重写删掉（它与 a02-1 引外部位图的事实相反）。

**校验器同样不在插件里。** 新项目按 §10 的六条自己实现一个（`script/check-materials.py` 只是 `video-hypatia` 的叫法）：2026-11-25 决定，规则由 skill 在建项目时约定，实现归项目的 agent。理由是规则会随项目演进（保留名、台账字段、deck 结构都可能变），把脚本钉进插件就多一份要同步的真值。

## 12. 划界：不做什么

- **不做 OCR、不做图像识别**。截图判定在 capture 时对 DOM 做（§9）。
- **不做自动重拍**。`blocked` 要靠人造 demo 数据。
- **不改插件**。`video_teach_plan` 不读 `shots.yaml`；`missingAssets`（`src/teach/tools.ts`）只查稿子点名的 deck/scene/cover 文件，不查 deck 里的 `<img>`。理由：`projectRoot` 与 workspace root 可能是两个目录（`docs/TEACH-PARALLEL-ACTS.md` §2），路径解析会变成第二个真值源。
- **不判断素材是否过期**。`at` 与 `spec_ref` 只记录，不做比对。
- **不给 `/tmp` 留复现材料**。台账、README、spec 里能写的只有"怎么重建"。历史记录里保留当时的临时路径可以，但要标明已清理。

## 13. 验收（全部离线）

1. 用 `final/` 原图 + `crop.box` 重生成 `crops/`，与 README 裁切表里的 8 张逐张比对尺寸，证明裁切可复现。
2. 按现有裁切写 `shots.yaml`：S03 标 `role: evidence` 且 `must_show: 命中` 时，必须同时报「14.7 px 不够 24」与「判定 mismatch」；标 `role: structure` 且 `readable_because` 非空时通过。字号判据与 DOM 断言各管一段。
3. S09 的 `forbidden: 输出预算 20000` 必须报 `leaky` 或要求裁到证据区。
4. 删掉 S07 的 `blocker` 必须报 `error`，补上必须变成 `blocked`。
5. 拿 a02 的 deck 跑校验：`materials/images/hypatia-head-tight.jpg` 被正确识别为外链位图；人为把某个图标改成 `<img src="…svg">` 必须报错。
6. 造一个未登记的 `materials/images/x.png`（台账里写作 `images/x.png`）：孤儿检查必须报；补进 `catalog.yaml` 后通过。
7. `video_teach_plan` 的结果不因 `catalog.yaml` 或 `shots.yaml` 存在与否而改变，证明没碰插件。

## 14. 三件事已定（2026-11-25 拍板）

结论写在这里，理由保留，方便以后回看为什么这么定；上一轮列出的问题与备选一并保留。

1. **字号：`evidence` ≥ 24 px，`structure` ≥ 10 px。** 原问题是"`structure` 用声明还是也测量"，决定要加下限。依据 §9 那张表：7.8 px 的 `S04-board` 是唯一被拦下的，10.5 与 10.9 通过，门槛落在 8–10 之间是为了拦住"整屏缩进来"的图，不是给结构图放水。代价是 a04-4 必须重排（§9「已知影响」）。`readable_because` 仍然必填，但它解释的是"为什么这个缩放够用"，不能用来豁免下限。
2. **校验脚本放项目侧，实现归项目的 agent** `script/check-materials.py`（最初写成 `.mjs`，实现时改为 python：要读两份 YAML）。2026-11-25 进一步明确：**规则由 skill 在建项目时约定，校验器不随插件分发，由项目的 agent 按 §10 的六条实现**。否决"随插件的 `assets/teach/` 脚手架"：规则会随项目变，脚本一旦随插件发版就成了第二份要同步的真值。
3. **允许从成片派生并长期复用**：`origin: derived` + `source: renders/<shot>/vNNN.mp4`。抽卡出一张满意的立绘或首帧，本该沉淀成素材，否则每次重抽。`derived` 的 `source` 必须指向仍然存在的产物（§10 第 5 条）。

## 15. 与 TODO 的对应

- **B4** 截图台账（`shots.yaml`）与状态判定：本文 §7.3、§8
- **B5** 拍摄脚本：capture 时取 DOM 证据与字号、生成 crops、写回台账：本文 §9、§12
- **B6** deck 侧的截图入片契约（证据区、字号、三档角标）：本文 §9
- **B7** `materials` 布局 + `catalog.yaml` + 保留名清单：本文 §3、§4、§7.2
- **B8** deck 静态资源（图标内联、位图外链）与六条校验：本文 §5、§10
- **B9** 抽卡素材（立绘规格、参考图、首尾帧）与初始化模板：本文 §6、§11
