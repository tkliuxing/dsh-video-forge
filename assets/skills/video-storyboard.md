# Video Storyboard — 把剧本拆成分镜

当用户想把视频规划成一串镜头，或要把剧本拆成分镜表时使用。分镜表是**你写、你读的参考文本**——插件一次只生成一个镜头，从不读 `shots.yaml` 做批量生成。

## 把剧本拆成镜头

一个镜头是一段连续的素材——一个机位、一个主体焦点、一拍动作。在下列变化处切分：

- **地点或时间**变化（换场景、切到稍后），
- **机位**变化（远景交代 → 特写 → 反打），
- **主体焦点**变化（镜头跟着谁/什么）。

给每个镜头起个短标识，再写一句描述，说明"看到什么"+"什么在动"。按故事顺序编号。

## shots.yaml 格式

保持简单——下面这些字段是给你和用户看的，插件不解析。插件只关心你传给 `video_generate` 的 `shot` 名（它会成为 `renders/<镜头>/` 文件夹）。

```yaml
shots:
  - id: establishing       # 成为 shot 文件夹：renders/establishing/
    description: "黎明河面的低机位远景，薄雾笼罩水面，一艘红船从左侧入画"
    duration_seconds: 5
    aspect_ratio: "16:9"
  - id: closeup
    description: "纸船船体在涟漪里折皱的特写，柔和的晨光"
    duration_seconds: 5
    aspect_ratio: "16:9"
  - id: reveal
    description: "俯拍镜头，纸船绕过河湾驶入开阔水面"
    duration_seconds: 5
    aspect_ratio: "16:9"
```

`id` 就是 `shot` 参数；保持简短、文件系统安全（字母、数字、`-`、`_`、`.`）。

## 从分镜表生成

**每次 `video_generate` 只生成一个镜头**——工具收一条 prompt、出条一条视频。按顺序走：

1. 读这个镜头的描述。
2. 用 video-prompting 技能把它扩成完整 prompt（加上运动、镜头、光线、风格；清单 `style` 会自动追加）。
3. 调 `video_generate`，带 `shot: <id>` 和 prompt。
4. 等结果（或查 `video_status`），再进下一个镜头。

跨镜头保持一致：复用清单里同样的 `characters`，共享元素（角色、地点、色调）的措辞每个镜头保持一字不差。

## 插件不会做的事

- **不会**读 `shots.yaml` 然后整批生成——这是明确的非目标（一次一条、每条付费）。
- **不会**把镜头拼成一条成片。排序和剪辑在插件外做。如果用户期待一条组装好的成片，明确说清楚这一点。
