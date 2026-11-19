# MiniMax H3 提示词规范（按官方格式改写）

给 `provider` 的协议是 `minimax-video`、模型是 `MiniMax-H3` 或 `MiniMax-H3-Max` 的
`video_generate` 调用使用（插件目前只注册了这两个；官方还有 Highspeed 与 Lite 两个变体，
没进预设，别在提示词里按它们写）。这是按模型原生格式改写后的提示词写法，不是通用视频提示词那套
"主体 + 动作 + 运镜 + 光线"的散文。

依据是 MiniMax 官方仓库的提示词技能（`MiniMax-AI/MiniMax-H3`，`skills/h3-prompt-writing/`，
main 分支 2026-10-28 的 `199b7d0`）。厂商会改格式，本文与官方对不上时以官方为准：
<https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md>。
API 字段与机型限制见 <https://platform.minimax.cn/docs/api-reference/video-generation-v2-create>。

## H3 的硬事实（决定提示词怎么写）

- 原生输出 32 kHz 立体声音频，不需要开关。所以**你不写声音，模型自己挑一个**；不想要配乐
  就显式写 `non_diegetic_music: N/A`，不要留空。
- 稳定支持 11 种对白语言：阿拉伯语、中文、英语、法语、德语、意大利语、日语、韩语、
  葡萄牙语、俄语、西班牙语；其他语种也能出，稳定性没那么好。对白的语种由 `<d>` 里的语言
  标签决定。
- 单个 text 项最多 7000 字符。正常改写不会接近这个上限，超了先砍形容词，不要砍时间轴。
- 分辨率只有厂商给的几档：`MiniMax-H3` 768P / 2K、4–15 秒；`MiniMax-H3-Max` 480P / 768P、
  5–15 秒（官方管它叫"fast generation variant"，它是快的那个，不是画质最高的那个）。工具已经
  按机型校验，提示词里不要再许愿"4K""60 帧"。
- `MiniMax-H3-Max` 有一个提示词扩写开关（`extra.prompt_expansion_mode`：`disabled` /
  `balanced` / `quality`，默认 `balanced`），插件目前没有把它暴露成参数。已经按本规范写
  到位的提示词，扩写是锦上添花；效果不稳时记得这一点是变量。

## 提示词的三段结构

按下面的顺序和字段名写，字段名保持英文，不要翻译、不要加别的小标题：

```text
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

图生视频（首帧 / 首尾帧）在最前面多一行固定指令，与三个字段之间空一行。纯文生视频没有这
一行，直接从 `integrated_multimodal_description` 开始。

### 首帧（i2v）

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
```

之后 `[Shot 1]` 从这张图的状态接着往下写：先立住风格、主体、构图、场景锚点，再写动作怎么
发展。人物的长相、服装、颜色、关键物件、空间关系都要与图一致。

### 首尾帧（flf2v）

```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.
```

`N` 是实际最后一个镜头的序号，`S.SS` 是成片真实时长，写两位小数（8 秒就写 `8.00`）。首尾帧
一般只用一个镜头，让模型从首帧连续插值到尾帧；不要重复描述两张静态图，要写连起来的那条
路径：首帧状态 → 可见的中间变化 → 逐渐收窄的差异 → 尾帧状态。

### 尾帧（l2v）

```text
How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
```

图是终点不是起点。先编一个说得通的前序状态，再写怎么一步步收敛到这张图，最后落点在
构图、机位、光线、人物姿势上都与图对齐。

## integrated_multimodal_description

这是主体部分，沿时间轴写视觉、动作、镜头、说话人、对白、歌唱和画内音。每句话都要对应画面
上看得见或听得见的东西。

`[Shot 1]` 开头先交代整体风格和初始构图，风格词可直接取：`Cinematic`、`live-action`、
`2D-animated`、`3D CG`、`claymation`、`watercolor`、`vintage film`。图生视频从参考图里
读风格，文生视频从用户的话里选。

```text
[Shot 1] Live-action, cinematic, a medium-wide shot frames a baker opening the shutters of a small street bakery before sunrise.
```

### 分镜与切点

第一个镜头不写时间戳。后续镜头编号递增，并且每个镜头以落在成片时长内的切点开头，格式
`[Shot 2] At 00:03.500, the camera cuts to...`。

普通切用 `the camera cuts to`、`the shot cuts to`、`the shot transitions to`、
`the shot changes to`、`the shot switches to`；用户明确要溶解、淡入淡出、划像时才用对应的
说法。切一次要有新信息（主体、空间、状态、视角、时间变了），只想换景别或角度一点，用运镜。

### 运镜：动作 + 幅度 + 速度

完整表达有三层：**动作类型**定义镜头怎么动，**幅度**定义构图变化多大，**速度**定义快慢。
幅度和速度只在有意义时写，中等幅度和常速通常省略。

| 维度 | 可用的写法 |
|---|---|
| 动作 | `Zoom In / Zoom Out`、`Push In / Pull Out`、`Pan Left / Pan Right`、`Truck Left / Truck Right`、`Tilt Up / Tilt Down`、`Pedestal Up / Pedestal Down`、`Arc Shot`、`Tracking Shot`、`Static Shot`、`Shake Slightly / Shake Strongly`、`POV`、`Roll Clockwise / Roll Counterclockwise` |
| 幅度 | `with small amplitude`、`with large amplitude` |
| 速度 | `at slow speed`、`at fast speed` |

运镜写成句子里的自然动作，不要堆成标签放在句尾：

```text
The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.
The camera pans right with large amplitude at fast speed, revealing the open doorway.
```

### 说话人、对白、歌唱

会说话、会唱、或有画外人声的主体给稳定编号 `(S1)`、`(S2)`；多人同时说话用 `(S1,S2)`。
同一个说话人跨镜头保持同一个编号。从不出声的角色不给编号。

说话人第一次出现时，用视觉或听觉信息把他的身份立起来（人物类型、年龄、性别、是否在画内、
音高、音色、语速、口音）。编号、动作、语气放在 `<d>` 外面，`<d>` 里只放语言标签和用户给
的原话，一字不改、不翻译：

```text
The young woman with a quiet, breathy voice (S1) says: <d>[English] I get off at the next station.</d>
The two children (S1,S2) shout together, <d>[English] Wait for us!</d>
```

旁白必须用固定说法 `says in an off-screen voiceover`，并在每个旁白 `<d>` 之后紧接着说明画内
人物嘴唇没动：`while his lips remain completely closed.`。

一句台词或歌词跨切点时，在接缝两侧都用 `<scenetrans>`，并写明声音继续；被片尾截断的对白用
`<cutoff>`。连贯的说法可用 `continues seamlessly across the cut`、
`continues uninterrupted into the next shot`、`remains audible across the transition`。

### 屏幕文字

画面上真实可见的招牌、横幅、字幕、霓虹字，用英文双引号原样括起来，不翻译：

```text
A red neon sign reading "营业中" glows above the doorway.
```

## overall_soundscape

用 1–4 句英文，一整段，概括整条片子的环境声、动作声、非语言人声（风、雨、车流、脚步、布料
摩擦、碰撞、呼吸、笑、喘）。对白、歌唱、画内音乐已经在主体里写过了，这里不要重复。用户明确
要求全程无声时才写 `N/A`。

```text
overall_soundscape: Steady rain taps against the café windows while low room ambience continues underneath. The entrance bell rings once, followed by wet footsteps and the soft scrape of a chair.
```

## non_diegetic_music

用 1–3 句英文，写只有观众听得到、角色听不到的背景音乐。写乐器、速度、节奏、力度变化，
**不要**写"紧张""温暖"这类抽象情绪词，也不要解释配乐想表达什么。角色能听到的音乐（唱歌、
乐器、收音机、电视、手机外放）属于画内音，写在主体里。

没有非画内音乐就写 `N/A`：

```text
non_diegetic_music: N/A
```

## 参考素材（只有插件支持参考图时才用）

插件目前只送参考**图**（`reference_images` / 清单里的 `characters[].refs`），不送参考视频和
参考音频。所以只能用到其中的图片类标签：`<Subject N>` 与 `<Picture N>`。

- `<Subject N>`：从参考素材里抽出来的、可复用的可见内容，人和动物、场景与背景、服装道具、
  界面与特效、风格动作表情姿势都算。一个主体可以由多张素材共同定义，一张素材也可以提供多个
  主体。它代表"要在成片里用的内容"，不是源文件本身。
- `<Picture N>`：参考图本身被当作某个镜头的首帧、关键帧、尾帧、构图锚点时，才单列一条。

只用来定义角色、场景、服装、风格时，不单列 `<Picture N>`，在对应的 `<Subject N>` 定义里
引用图片编号即可：

```text
<Subject 1> is the young woman in <Picture 1>, with long dark hair, a blue cardigan, and a thin silver necklace.
<Subject 2> is the woman whose appearance comes from <Picture 1> and whose walking motion comes from <Video 1>.
```

编号一旦分配，全篇含义不变。每个参考在提示词里要明确"它管什么"：图 1 管脸和服装，图 2 只
管光线。没分配用途的参考照样影响输出，只是影响的是模型觉得该影响的地方，身份漂移大多从这
里来。

## 负向清单

H3 对"不要什么"很敏感，负面清单是主要风格控制手段，不是补丁。用户对画面有洁癖（不要字幕、
不要水印、不要多余人物、不要身份漂移、不要拼错字、不要软溶解）时，把这些直接写进提示词，
原话照抄最省事。官方的一个标题序列提示词里，分给负面清单的篇幅比"好看"多得多。

## 常见错误

| 写成这样 | 问题 | 改成 |
|---|---|---|
| 一段散文，没有字段名 | 模型当普通描述读，时间轴和声音都丢了 | 三段字段 + `[Shot N]` 时间轴 |
| `non_diegetic_music:` 留空 | 模型自己挑配乐 | 显式 `N/A` 或写清乐器与节奏 |
| "希望有 4K 60 帧电影感" | 分辨率帧率不是提示词能决定的 | 删掉，段位在 `resolution` / `duration_seconds` |
| 只写"镜头缓慢推进" | 只给了动作，没有幅度速度 | `pushes in with small amplitude at slow speed` |
| 首尾帧提示词把两张图各描述一遍 | 没有路径，模型只能硬切 | 写中间的连续变化，最后落在尾帧 |
| 对白翻译成英文写进 `<d>` | 原话被改动，语种也跟着变 | `<d>[Chinese] 原话</d>` |
| 把情绪词堆进配乐字段 | 抽象词对生成无指导意义 | 写乐器、速度、力度变化 |

## 两个完整示例

下面两个示例是照上面的规则自己写的，不是官方样片：字段顺序、时间戳格式、说话人编号、声音
三段都齐，可以直接当骨架换内容。

### 文生视频，两镜头

```text
integrated_multimodal_description: [Shot 1] Cinematic, live-action, a low-angle wide shot follows a motorcycle courier braking into a narrow alley after dark. The camera tracks right at medium speed as the rear wheel skids on wet asphalt and the courier in a damp yellow raincoat (S1) lifts the visor and says: <d>[Chinese] 地址不对，我再打一次。</d> [Shot 2] At 00:06.200, the shot cuts to a close-up of a phone screen glowing green in his wet glove while the sound of rain continues underneath.

overall_soundscape: Rain drums on the alley's metal awnings and the engine idles with a low uneven note. Tires hiss through standing water, then a glove squeaks against the phone case.

non_diegetic_music: A single distorted electric-guitar note at a slow tempo, sustained under sparse kick-drum hits, ending abruptly on the cut to the close-up.
```

### 首帧，单镜头

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Cinematic, live-action, the orange tabby cat shown in <Picture 1> keeps its exact markings, posture, and position on the sunlit windowsill, with the same wooden frame and houseplant behind it. The camera pushes in with small amplitude at slow speed as the cat's ears rotate toward a pigeon landing on the railing; its pupils narrow, the tail tip flicks twice, and the whole body shifts one step forward without leaving the sill.

overall_soundscape: Distant street traffic and a light breeze through an open window. The pigeon's wings beat once as it settles, followed by a low, quiet rumble from the cat.

non_diegetic_music: N/A
```

## 跑过一次之后

2026-11-17 用一段单镜头"沙丘风光"实跑过一次（`v-20261117-0002`，768P / 16:9 / 5 秒）：
三段字段被原样吃下，成片带 32 kHz 立体声音轨，构图、`pedestals up with small amplitude at
slow speed`、负向清单都照着做了；沙色没按 `ochre-ash` 走，远处"贴地移动的沙幕"没出现，
"半埋入沙的巨构"读成了"立碑"。规律是**形容词密集又不可数的地方最容易丢**，所以尽量给可数
的锚点（几个人、几块、多大、在画面哪个位置、占多少画面）。

还缺的是 A/B：同一段需求再写一版普通散文交给模型，比较时间轴、对白、声音三项谁更听话。
做完把结论回写 `docs/DESIGN.md`，不要只留在对话里。
