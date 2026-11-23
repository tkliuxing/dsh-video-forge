# Video Teach Slides — reveal.js 那一段怎么写

`engine: slides` 的句子由 reveal.js 画面配旁白。播放与录屏由插件负责，你只需要写一个能跑的 deck 和它的 fragment。

## 最小骨架

教学工具认的 deck 契约是三个全局，按驱动模式用其中两个：

```html
<script>
  // 页模式：切到第 n 页（从 0 开始，与句子的顺序一一对应）
  window.teachPage = function teachPage(n) { /* 显示第 n 页 */ }
  // 页内节拍：显示到第 n 步（从 1 开始，对应 cues 里的 fragment）
  window.teachCue = function teachCue(n) { /* 显示到第 n 步 */ }
  // 版式就绪后置 true，录屏要等这一帧
  window.teachReady = true
</script>
```

两种驱动模式对应两种 provider：

- **页模式 + 页内节拍（默认，`deepseek`）**：一句一页，句子开始切到该页，页内按 `at_progress` 依次显现。录制器先调 `teachPage(句序号)`，再按时长比例调 `teachCue(fragment)`。
- **纯 cue 模式（`volcengine`）**：全片一个或少数几页，`teachCue` 按词触发（`at_word`）。

页模式下 deck 的结构就是"一个 `<section>` 对应一句"，顺序必须与稿件一致，页数不能少于该段的句数（少了后面几句会停在最后一页，`video_teach_plan` 会点名）。

**fragment 编号按页算**，因为 reveal.js 的 fragment 是页内概念，模板的 `teachCue(n)` 数的是当前页的 fragment（并在页末夹住，保证一个 cue 永远不会翻页）：第 1 页写 1、2、3，第 2 页又从 1 开始。稿子里的 `fragment` 因此也是**每页从 1 起**（`video-teach-storyboard` 的编号规则同此）。纯 cue 模式下全片只有一页，编号自然就是全片递增。

reveal.js 版的实现（`Reveal` 没有"跳到第 n 个 fragment"的 API，循环是幂等的做法；`Reveal` 是单例，用 `Reveal.initialize` 而不是 `new Reveal`）：

```js
Reveal.initialize({ embedded: true, transition: 'fade', controls: false, progress: false })
  .then(() => { window.teachReady = true })
window.teachPage = function teachPage(n) { Reveal.slide(n, 0, 0) }
window.teachCue = function teachCue(n) {
  // 数当前页：页内编号从 1 起，且不越过本页最后一个 fragment
  const available = Reveal.getCurrentSlide().querySelectorAll('.fragment').length
  const target = Math.min(n, available)
  while ((Reveal.getIndices().f ?? -1) + 1 < target) Reveal.nextFragment()
}
```

包里带了一份现成的 reveal.js（6.0.2，MIT）与模板：`video_teach_export` 会把 deck 连同 `reveal.js` / `reveal.css` / `theme.css` 一起抄进 `deck/`，直接双击就能演示。

## 排版约定

- **一页一个主题，一页不超过 5 个 fragment**。fragment 太多，旁白和画面就会互相追。
- 字号按 1080p 的观看距离定：标题 44–48px，正文 32–40px，注释不小于 24px。默认 16:9，`reveal` 会把内容缩放填满，字号写小等于看不清。
- 字体栈带中文：`"PingFang SC", "Noto Sans SC", system-ui`。不指定就会在录制时回落到衬线字体。
- **公式优先用 HTML/CSS 或 MathJax 独立脚本**，不要把 LaTeX 塞进 reveal 的 Markdown 插件里再由插件去 shell 调用 —— 录屏进程不该有执行外部命令的路径。
- 动效用 reveal 自带的 `fragment` 与 `fade` 就够；自定义 CSS 动画会让"这一帧该长什么样"变得不可预测，也就会让重录结果不一致。

## 与时间轴的关系

- 有词时间戳（`volcengine`）时，`teachCue` 按**词**触发：稿子里 `at_word` 写哪个词，画面就在那个词发音时切换。
- 没有词时间戳（`deepseek`，默认）时，节拍按 `at_progress` × 该句实测时长触发。它与发音不是逐字对齐的关系，只是作者按语义给的节拍，**不要**据此承诺"讲到哪个字画面动到哪"。
- 一句话结束后画面**停住**，直到下一句的第一帧，所以每句结尾的版面要是"能看一秒多"的状态，不要留半截动画。
- 一句话只录一次：句子内的 fragment 顺序错了，改稿子重跑 `sentences: [<id>]`，不会重录别的句子。

## 检查清单

- `teachReady` 确实被置为 true（放在 `initialize()` 的 `then` 里，不要放在 `DOMContentLoaded`）。
- 首屏（`teachCue` 还没被调用时）就是可以直接开录的版面，不要空白页。
- 三个全局都在：`video_teach_plan` 会读 HTML 检查 `teachReady`，检查 `teachCue`（稿件里有节拍时）、检查 `teachPage`（页模式下），缺了在**录音之前**就拒绝。
- 用 `video_teach_render` 只渲染这一句时，页面上没有外部网络依赖（字体、CDN 图片都会在录屏时抖动）。

## 让每句话都改变画面

`volcengine` 下录屏器按 cue 推进，**一句话没有 cue 就等于这句话期间画面完全不动**。`deepseek` 下每句自动换页，句子之间一定有变化，需要注意的变成页内节拍。上一版样片就是这么出现四十秒静帧的：十六行正文塞在一页，后七句没有 cue，加上 `teachCue` 的下标算错，最后两档被裁成同一张画面。

写 deck 时守住四条：

1. **一句至少一个 fragment**。一句话讲三个要点就拆三个 fragment，别让一句只停在一个静态版面上。
2. **每一页的 fragment 数 ≥ 稿件在这一页用到的最大编号**。cue 模式下 `video_teach_plan` 拿整份 deck 的 fragment 总数核对，越界直接拒绝；页模式下按页核对，越界给 warning 并指出是哪一页（此时编号要么改成按页从 1 起，要么让 deck 自己翻译编号）。
3. **同一页别塞超过 5 个 fragment**。reveal 会缩放适配，行数一多字号就被压到看不清；正文超过 10 行就该换页。
4. **`teachCue(n)` 是"显示到第 n 步"**，`Reveal.getIndices().f` 是零基下标，两者差一。模板里已经处理，自己写 deck 时注意别再把 `f` 直接当目标值。

改完跑 `video_teach_plan`：它会报出"哪句没有 cue""平均几秒才变一次画面"，这些都能在下一次录音之前发现。
