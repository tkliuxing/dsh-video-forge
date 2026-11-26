# Video Project — 工作区布局与清单

`video-forge` 插件把当前 DSH 工作区当成视频项目：每段生成的视频都存进这个工作区，所以它写的文件和你的脚本、笔记一样，都是"项目"的一部分。

## 默认布局

```
<工作区>/
  video-project.yaml          # 清单：默认参数、风格、角色、目录映射
  script/                     # 你的剧本（可选，结构自定）
  storyboard/shots.yaml       # 分镜表（参考文本——见 video-storyboard 技能）
  materials/                  # 素材：角色立绘 / 首尾帧 / 风格板 / 位图 / 图标 / 截图（布局见建项目第 2 步）
  renders/<镜头>/v001.mp4     # 生成成片，每个镜头一个文件夹，版本递增
  renders/<镜头>/v001.json    # 每条视频旁的说明（prompt、模型、参数、用量）
  .dsh-video/                 # 插件自己的缓存——别动它
```

在线生成路线只写 `renders/`、`.dsh-video/`（首次另加根目录的清单与 `renders/.gitignore`），不改写你的文件；教学路线另写 `audio/`、`timings.json`（在稿本所在目录）与 `deck/<段 id>`（在工作区根，`renders/` 旁边）。其余都归你。

## 清单（video-project.yaml）

插件每次生成都会读工作区根目录的 `video-project.yaml`。可识别的键：

```yaml
version: 1
defaults:                 # 只在请求（和对话栏 chip）漏填时才用
  provider: ark           # 插件设置里的供应商 id
  model: seedance-2.0-mini
  resolution: 720p
  aspect_ratio: "16:9"
  duration_seconds: 5
style: "cinematic, warm color grade"    # 由工具自动拼到每条 prompt 后面
characters:               # 角色登记，由 `characters` 参数展开
  alice:
    refs: [materials/alice/*.png]       # 文件名里可用 * 和 ? 通配
    description: "短发，红色外套"
paths:                    # 把布局映射到你自己的目录（都是工作区相对路径；目前只有 renders 生效）
  script: script
  storyboard: storyboard
  materials: materials
  renders: renders
  cache: .dsh-video
```

规则：
- **优先级**：`video_generate` 的显式参数 > 对话栏的「视频模型」chip（会话级选择）> 清单 `defaults` > 插件设置的默认供应商/模型。所以本会话若在 chip 里选过模型，清单的 `defaults.provider`/`model` 不生效；工具结果会写明哪个值来自 chip。
- `paths` 的值必须是工作区相对路径；绝对路径、`~`、`..` 都会被拒绝。目前**只有 `paths.renders` 真正生效**，而且只影响在线生成路线；其余四个键是声明：`characters` 的 `refs` 按工作区根解析，改 `paths.materials` 不会搬家。
- 不认识的**顶层**键会被忽略（给未来版本留余地）；`defaults`、`paths`、某个角色**里面**的不认识键会被拒绝——当拼写错误处理（`render:` 写成了 `renders:`）。
- 解析不了的清单在提交前就被拒绝（不会花钱）。
- `style` 和 `characters` 由工具加进 prompt，不是你加：把用户自己的 prompt 和清单风格分开。

## 建项目

没有 init 命令。用你常规的 `write` 工具来搭：

1. 写 `video-project.yaml`。
2. 建 `materials/`，按用途放素材：角色立绘进 `materials/<角色名>/`（目录名就是清单里的角色名），首帧尾帧进 `materials/frames/<镜头>/`，风格板进 `materials/style/`，其余位图进 `materials/images/`。同时写两份文件：
   - `materials/catalog.yaml`：每个素材一行，记 `file`（相对 `materials/`）、`kind`、`origin`（`generated` / `supplied` / `derived` / `authored`）、`used_by`、`license`、`source`；agent 生成的还必须记 `prompt` 与 `model`，否则这张图不可复现；手写的 SVG 图标记 `authored`，不要求提示词。
   - 立绘规格：位图（SVG 不被接受），长边 ≥ 1024（经验值），背景干净（透明或纯色），多视角固定命名 `front` / `side` / `back`；一次请求的参考图合并去重后最多 9 张，别在角色目录里堆草稿。
   - `materials/README.md`：布局表、引用路径的算式（deck 引素材写成 `../../materials/…`，只有这一种形状）、内联与位图的判据，以及"新建素材先在这里和 catalog 各加一行"。
3. 可选写 `storyboard/shots.yaml`。
4. 写项目内的校验器 `script/check-materials.py`（`python3` 跑，要 PyYAML；先 `python3 -c 'import yaml'` 确认这个解释器带着它）。**插件不随包发这个脚本**，规则就是下面这几条，实现归项目：
   - deck 里每个 `<img src>` 指向的文件存在；
   - 引用路径只有 `../../materials/<目录>/<文件>` 一种形状；绝对路径、`~`、`http(s)`、`../../../` 都算错；
   - `<img src="…svg">` 直接算错——图标必须内联，否则改不了色、也不能只点亮其中一部分；
   - 磁盘上 `materials/` 里每个文件在 `catalog.yaml` 有一行（截图除外，它走 `materials/shots/shots.yaml`），反之每一行指向真实文件（孤儿与幽灵条目都报）；
   - `generated` 必须有 `prompt` 与 `model`，`supplied` 必须有 `license` 与 `source`，`authored` 要有 `license`，`derived` 的来源文件必须存在（`renders/<shot>/vNNN.mp4`）；
   - `materials/shots/shots.yaml` 存在时，截图的状态、入片字号（`evidence` ≥ 24 px、`structure` ≥ 10 px）与断言一起校验；
   - 角色目录名撞保留名要报。

角色目录名不能是 `images`、`icons`、`frames`、`style`、`shots`、`catalog.yaml`、`README.md`。这些是保留名：角色目录与它们共用 `materials` 下一层，混用会让 `characters` 的 `refs` 把整个目录扫进参考图。

插件不构建也不改写 `materials/`，所以这两份文件要你自己建、自己维护。

视频第一次落进一个还没有清单的工作区时，插件也会自动写一份带注释的 `video-project.yaml` 和一个内容为 `*` 的 `renders/.gitignore`（让成片默认不进 git）。想把成片提交（比如用 Git LFS）就删掉那个 `.gitignore`。如果用户已经建过这两个文件，插件不动它们。

## 成片落在哪

- 每次生成落到 `renders/<镜头>/vNNN.mp4`，从 `v001` 往上编号。
- 镜头名就是 `video_generate` 的 `shot` 参数，默认 `untitled`。允许的字符：字母、数字、`-`、`_`、`.`（不含 `..`）。
- 版本号永不复用（在线生成路线）——删掉 `v003` 也不会再冒出 `v003`。编号由宿主分配，两个对话同时给同一镜头生成也不会互相覆盖。教学路线的编号取该镜头文件夹里的最大号 +1，别手删最新一条。
- 每条视频旁有 `vNNN.json` 说明。用常规 read 工具读它，就能回溯这条视频怎么做出来的（prompt、模型、参数、是否 `from` 续拍、用量）。

## 跨场景规则

- 只读会话、或远程（SSH）工作区，生成在提交前就被拒绝（不花钱）。这些情况下不要承诺能做视频。
- 在线生成路线从不拼接片段，把多段合成为一条成片在这条路线上是明确的非目标——去插件外做。教学路线的 `video_teach_render` 会把分段拼成一条完整成片——逐句契约是逐句段，母带契约是"每段一个连续录制段 + 每个 Manim 句一段"。
- 不带参数调 `video_status` 能看到当前工作区的清单状态、已登记角色、是否设了风格。
- 用户问"这项目都生成了些什么"，界面上的答案是右侧栏「视频」面板：它把 `renders/` 下的成片按镜头列出来（台账里没有的文件也会列，标「仅文件」）。你不需要替它维护清单。
