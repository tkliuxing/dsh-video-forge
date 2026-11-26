# demo/showcase — 一条片子，两个音色，全部能力

这一份是 teach 路线的能力样片，也是 `docs/TEACH-VIDEO.md` §28 的实物：同一批 deck、同一对 Manim 场景、同一张封面，**两份稿本只差旁白与驱动模式**。

| 版本 | 旁白 | 驱动模式 | 成片 |
|---|---|---|---|
| DeepSeek | `tide`（男声） | 页模式：一句一页（共享页除外），`at_progress` 按实测时长比例点节拍；有跨句转场 | `renders/showcase-deepseek/v003.mp4` · 107.3 s |
| 火山（ark） | `zh_female_liuchangnv_uranus_bigtts` | 纯 cue 模式：`at_word` 在那个词被念出来时切画面；没有转场 | `renders/showcase-ark/v003.mp4` · 105.8 s |

两版都是 15 句 / 465 字，6 段：页内动效库（6 句）· 转场与硬切对照（3 句）· 共享页（2 句）· Manim 公式推导（1 句）· Manim 坐标系（1 句）· 封面与产物（2 句）。

## 目录

```
demo/showcase/
  slides/            deck 源（s01 页内动效、s02 转场、s03 共享页、s06 交付物）
  scenes/            Manim 场景，一句一个文件
  cover/             封面页，同一份版面出 16:9 与 4:3
  runs/deepseek/     稿本 + 上面三样的副本 + audio/ + timings.json + .dsh-video/
  runs/volcengine/   同上，火山版
  sync.sh            把 slides/ scenes/ cover/ 同步进两个 run
  hold.py            页尾停留：补静音并实测改写 durationMs
  cues.py            按页内变化次数重算 at_progress
  words.py           把合并合成的词级时间戳换算成句内偏移（见下面的已知问题）
```

**为什么每份稿本都要一套副本**：稿本里的每条路径都被 `src/teach/storyboard.ts` 的 `projectPath()` 校验，出现 `..` 直接拒绝（项目根取稿本所在目录）。改完 `slides/`、`scenes/`、`cover/` 要跑一次 `./sync.sh`，否则渲染读的还是旧图，而且不会报错。

## 复现

```bash
./sync.sh                                           # 只改了稿本时不用跑

# 一、校验（免费，报错指到行号与键）
video_teach_plan    storyboard: demo/showcase/runs/deepseek/storyboard.yaml
video_teach_plan    storyboard: demo/showcase/runs/volcengine/storyboard.yaml

# 二、旁白（付费；deepseek 逐句 15 次请求，火山 merge: auto 合并成 1 次）
video_teach_narrate storyboard: demo/showcase/runs/deepseek/storyboard.yaml
video_teach_narrate storyboard: demo/showcase/runs/volcengine/storyboard.yaml

# 三、页尾停留 + 重算节拍（本机、免费）
#   deepseek 版：逐句音频文件，补静音后要按新时长重算 at_progress
#   火山版：2026-11-26 起是单文件母带（`audio/narration.mp3` + 每句 beginMs），
#   没有逐句文件可补、也没有接缝可停，hold.py / cues.py 都不再适用
python3 demo/showcase/hold.py demo/showcase/runs/deepseek
python3 demo/showcase/cues.py demo/showcase/runs/deepseek

# 四、渲染与导出
video_teach_render  storyboard: demo/showcase/runs/deepseek/storyboard.yaml   shot: showcase-deepseek
video_teach_export  storyboard: demo/showcase/runs/deepseek/storyboard.yaml   shot: showcase-deepseek
video_teach_render  storyboard: demo/showcase/runs/volcengine/storyboard.yaml shot: showcase-ark
video_teach_export  storyboard: demo/showcase/runs/volcengine/storyboard.yaml shot: showcase-ark
```

顺序不能换：**定稿 → narrate → 补停留 → 重算 cues → render → export**。cues 的分母是含停留的实测时长，先算后补会整体后移。

只改一页版面时只重录那一句（本片就是这么迭代的：`video_teach_render sentences: ["s01-4"]`）；但**改了某一页的版面，要连带重录它前一句**，因为前一句的尾转场落在这页上，`seam_findings` 会点名。

## 两个版本差在哪，为什么不能补齐

| 能力 | DeepSeek 版 | 火山版 | 为什么 |
|---|---|---|---|
| 页内 `at_progress` 节拍 | ✓ | — | 页模式专属 |
| `at_word` 按词切换 | — | ✓ | 需要词级时间戳 |
| `meta.transition` 跨句转场 | ✓ 7 处 / 3 640 ms | ✓ 7 处 / 3 640 ms | 2026-11-26 起 cue 模式也支持：落点由 `cueOpening()` 按 deck 每页 fragment 数算出 |
| 共享页 `page` / `enter` | ✓ | 不声明 | 同上；火山版靠 `cueStartFragments()` 开录前点亮前置拍，画面效果相同 |
| SRT 切分 | 一句一条（15 条） | 按词切（24 条） | 词时间戳有就有 |
| Manim 段 / 封面 / 六种产物 | ✓ | ✓ | 与旁白无关 |

## 已知问题

- **火山版的旁白是 `merge: none` 重录的。** 合并合成路径上有两个缺陷（绝对偏移、以及空白导致的句子边界漂移——后者会静默切错句子，`s05-1` 的"曲线"整段被切掉），两个都在 2026-11-26 修了，但要重启宿主后的新合成才会生效。为了现在就能听对的音频，这一版按 `merge: none` 逐句请求重录：15 句的词拼起来必须等于该句 `say`（去掉空白），全过。修复生效后若想回到合并合成的韵律连续性，重跑一次 `video_teach_narrate` 即可。`words.py` 是更早那次合并合成留下的数据侧补救，现在不再需要。
- **v008 是工具产物**（`video_teach_render` + `video_teach_export`，台账行 `v-20261126-0009`）。在此之前宿主一直跑着改动前的构建，所以同内容先由同一批函数渲过一版 `v007` 作为对照：两者四个时间点抽帧差 0.00%–0.45%。细节与逐缝核对见 `docs/TEACH-VIDEO.md` §28.6。
- **`deck/` 导出物。** 当前构建把 deck 拷成 `deck/<段 id>`（无扩展名、缺 `reveal.js`），浏览器打开是源码；修好后的形状是 `deck/<段 id>/index.html` 加同目录运行时。重启宿主后重跑 `video_teach_export` 才会得到可用目录。想看现在的 deck，直接开 `runs/<版>/slides/s01/index.html`（同一份文件，运行时齐全）。
- **`renders/` 与 `deck/` 都已被忽略**，成片是机器本地产物；重跑会生成 `v004`、`v005`，旧版不覆盖。
