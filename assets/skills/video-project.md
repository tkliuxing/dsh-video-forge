# Video Project — 工作区布局与清单

`video-forge` 插件把当前 DSH 工作区当成视频项目：每段生成的视频都存进这个工作区，所以它写的文件和你的脚本、笔记一样，都是"项目"的一部分。

## 默认布局

```
<工作区>/
  video-project.yaml          # 清单：默认参数、风格、角色、目录映射
  script/                     # 你的剧本（可选，结构自定）
  storyboard/shots.yaml       # 分镜表（参考文本——见 video-storyboard 技能）
  materials/                  # 角色 / 场景参考图、音频
  renders/<镜头>/v001.mp4     # 生成成片，每个镜头一个文件夹，版本递增
  renders/<镜头>/v001.json    # 每条视频旁的说明（prompt、模型、参数、用量）
  .dsh-video/                 # 插件自己的缓存——别动它
```

插件只写 `renders/` 和 `.dsh-video/`，从不移动或改写你的文件；其余都归你。

## 清单（video-project.yaml）

插件每次生成都会读工作区根目录的 `video-project.yaml`。可识别的键：

```yaml
version: 1
defaults:                 # 只在请求漏填时才用
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
paths:                    # 把布局映射到你自己的目录（都是工作区相对路径）
  script: script
  storyboard: storyboard
  materials: materials
  renders: renders
  cache: .dsh-video
```

规则：
- `paths` 的值必须是工作区相对路径；绝对路径、`~`、`..` 都会被拒绝。
- 不认识的**顶层**键会被忽略（给未来版本留余地）；`defaults`、`paths`、某个角色**里面**的不认识键会被拒绝——当拼写错误处理（`render:` 写成了 `renders:`）。
- 解析不了的清单在提交前就被拒绝（不会花钱）。
- `style` 和 `characters` 由工具加进 prompt，不是你加：把用户自己的 prompt 和清单风格分开。

## 建项目

没有 init 命令。用你常规的 `write` 工具来搭：

1. 写 `video-project.yaml`。
2. 建 `materials/`，放参考图。
3. 可选写 `storyboard/shots.yaml`。

视频第一次落进一个还没有清单的工作区时，插件也会自动写一份带注释的 `video-project.yaml` 和一个内容为 `*` 的 `renders/.gitignore`（让成片默认不进 git）。想把成片提交（比如用 Git LFS）就删掉那个 `.gitignore`。如果用户已经建过这两个文件，插件不动它们。

## 成片落在哪

- 每次生成落到 `renders/<镜头>/vNNN.mp4`，从 `v001` 往上编号。
- 镜头名就是 `video_generate` 的 `shot` 参数，默认 `untitled`。允许的字符：字母、数字、`-`、`_`、`.`（不含 `..`）。
- 版本号永不复用——删掉 `v003` 也不会再冒出 `v003`。编号由宿主分配，两个对话同时给同一镜头生成也不会互相覆盖。
- 每条视频旁有 `vNNN.json` 说明。用常规 read 工具读它，就能回溯这条视频怎么做出来的（prompt、模型、参数、是否 `from` 续拍、用量）。

## 跨场景规则

- 只读会话、或远程（SSH）工作区，生成在提交前就被拒绝（不花钱）。这些情况下不要承诺能做视频。
- 插件从不拼接片段。把多段合成为一条成片是明确的非目标——去插件外做。
- 不带参数调 `video_status` 能看到当前工作区的清单状态、已登记角色、是否设了风格。
