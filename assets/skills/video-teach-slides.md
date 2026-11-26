# Video Teach Slides — reveal.js 那一段怎么写

`engine: slides` 的句子由 reveal.js 画面配旁白。播放与录屏由插件负责，你只需要写一个能跑的 deck 和它的 fragment。

## 最小骨架

教学工具认的 deck 契约是三个全局，按需要至少两个（页模式 + 共享页时三个全用；cue 模式的母带契约下多页 deck 也要 `teachPage`）：

```html
<script>
  // 页模式：切到第 n 页，并且**这一页一个拍都不亮**（模板用 Reveal.slide(n, 0, -1)；
  // 传 0 会在切页时点亮第一拍，于是稿件的第一条 cue 永远不生效）
  window.teachPage = function teachPage(n) { /* 显示第 n 页，节拍全暗 */ }
  // 页内节拍：显示到第 n 步（从 1 开始，对应 cues 里的 fragment）
  window.teachCue = function teachCue(n) { /* 显示到第 n 步 */ }
  // 版式就绪后置 true，录屏要等这一帧
  window.teachReady = true
</script>
```

两种驱动模式对应两种 provider：

- **页模式 + 页内节拍（默认，`deepseek`）**：一句一页（稿件声明 `page` 时连续几句共用一页，见下文「一页承载多句」），句子开始切到该页，页内按 `at_progress` 依次显现。录制器先调 `teachPage(该句的页)`，再按时长比例调 `teachCue(fragment)`，共享页还会在开录前调一次 `teachCue(enter)`。一页 n 个 fragment → n+1 次画面变化（换页算第一次），节拍比例由这个数算出（见 `video-teach-storyboard` 的「页内节拍」）。
- **cue 模式（`volcengine`）**：一页或多页都行，`teachCue` 按词触发（`at_word`）。**注意 cue 模式 ≠ 母带契约**：cue 模式由词时间戳决定（`volcengine` 就有），是否"一个段一次连续录制"另由旁白契约决定——`merge: auto`（默认）是母带契约，一个段只加载一次 deck；`merge: none` 回到逐句加载，每句开录前就翻好页、页切换动画不进画面。节拍编号在段内一路递增，录制器按这个号翻页（翻页动画从那一拍开始播，所以别把跨页拍放在句尾）。**一个 slides 段只有一次页面加载**：跨句时 deck 不重载，上一句留下的状态就是下一句的开场；而且每句开录时录制器会先把页面翻到这一句的第一拍所在页，再按词推进节拍。不要把"上手状态"交给 deck 自己记，也**不要**依赖 `localStorage` 之类跨加载的手段。

页模式下 deck 的结构默认是"一个 `<section>` 对应一句"，顺序必须与稿件一致，页数不能少于该段的句数（少了后面几句会停在最后一页，`video_teach_plan` 会点名）。稿件写 `page` 时几句共用一个 `<section>`，此时页数以稿件声明的为准，见下文「一页承载多句」。

**fragment 编号按页算**，因为 reveal.js 的 fragment 是页内概念，模板的 `teachCue(n)` 数的是当前页的 fragment（并在页末夹住，保证一个 cue 永远不会翻页）：第 1 页写 1、2、3，第 2 页又从 1 开始。稿子里的 `fragment` 因此也是**每页从 1 起**（`video-teach-storyboard` 的编号规则同此）。纯 cue 模式下编号不分页重来，全片一路递增；多页 deck 照这个号跨页走，录制器负责翻到那一页。

页号有两份计数：plan 按 HTML 切 `<section>`，录制器数 `.slides > section`。纵向栈（`<section>` 套 `<section>`）让两者对不上，`video_teach_plan` 会警告；**多页的 cue 模式 deck 不要用纵向栈**。

reveal.js 版的实现（`Reveal` 没有"跳到第 n 个 fragment"的 API，循环是幂等的做法；`Reveal` 是单例，用 `Reveal.initialize` 而不是 `new Reveal`）：

```js
Reveal.initialize({ embedded: true, transition: 'fade', controls: false, progress: false })
  .then(() => { window.teachReady = true })
window.teachPage = function teachPage(n) { Reveal.slide(n, 0, -1) }   // -1 = 切页时一个拍都不亮
window.teachCue = function teachCue(n) {
  // 数当前页：页内编号从 1 起，且不越过本页最后一个 fragment
  const available = Reveal.getCurrentSlide().querySelectorAll('.fragment').length
  const target = Math.min(n, available)
  while ((Reveal.getIndices().f ?? -1) + 1 < target) Reveal.nextFragment()
}
```

包里带了一份现成的 reveal.js（6.0.2，MIT）与模板：`video_teach_export` 会把 deck 写成 `deck/<段 id>/index.html`，并把 HTML 里 `./名字` 引用的同目录文件（`reveal.js` / `reveal.css` / `theme.css`）一并拷过去，直接双击就能演示。

### 动效时长也可以声明：`teachPageTransition` 与 `teachTransition`

三个全局按需要都是必需项：`teachReady` 永远要，`teachCue` 只要有节拍、或这一页有 `enter > 0` 就要，`teachPage` 页模式与多页的 cue 模式都要。再有两个**可选**的，各写一个毫秒数。它们说的是"我的动画有多长"，只有 deck 知道：

```js
window.teachPageTransition = 500   // 切页动画播完要多久
window.teachTransition = 480       // 页内一拍动画播完要多久
```

- **`teachPageTransition`**：录制器在 `teachPage(n)` 之后等这么久才开始录。不写就是默认的 300 ms。**用 reveal 的 `fade` 就要写 500** —— reveal.css 里它是固定的 0.5 s，`transitionSpeed` 改不了它，按 300 ms 等会从转场中间开录（观众看不出错，只看到每句开头有一帧在动）。其它转场听 `transitionSpeed`：`fast` 0.4 s、`default` 0.8 s、**`slow` 1.2 s**，所以要声明的是那一档的数（用 `slow` 写了 900 就不够，这一点是照着实测发现的：样本片按 900 声明时，两页首帧与稳态差 2.2，改成 1300 后六句全部 ≤ 0.04）。写长了只是每句多等一会儿，不多录、不错位，因为 t=0 取的是等待之后的第一帧。
- **`teachTransition`**：它不决定节拍的时刻（录屏按拍触发，动画由 CSS 自己播），两处会读它：录制器录完后用它决定等多久再截末帧做自检，`video_teach_plan` 用它校验余量——某拍之后到下一拍（或到句末）的余量比它短时给一条 warning，说清是"会和下一拍重叠"还是"句尾会被切"。不写就不校验。声明得比实际动效短，末帧自检会在动画中途取样，报"末帧没播完"。模板的值是 `--teach-dur` 的 480 ms；页里用了 `count` 或 `draw`（这两个是 900 ms）就把这行写成 900。
- 缺这两个全局，契约仍然成立，行为与没有它们时完全一样。

## 排版约定

- **一页一个主题，一页不超过 6 个 fragment**（排版约定，不由代码强制）。fragment 太多，旁白和画面就会互相追。
- 字号按 1080p 的观看距离定：标题 44–48px，正文 32–40px，注释不小于 24px。默认 16:9，`reveal` 会把内容缩放填满，字号写小等于看不清。
- 字体栈带中文：`"PingFang SC", "Noto Sans SC", system-ui`。不指定就会在录制时回落到衬线字体。
- **公式优先用 HTML/CSS**（插件不带 MathJax/KaTeX；要 MathJax 就自己 vendored 一份脚本进 deck，不能引 CDN），不要把 LaTeX 塞进 reveal 的 Markdown 插件里再由插件去 shell 调用 —— 录屏进程不该有执行外部命令的路径。
- 动效按下面「动效：先定画面语言，再选类」一节的食谱挑类。判据是**它与时钟的关系**：由 `teachCue` 触发的过渡是确定的（起点由 cue 定、终点由 CSS 时长定），可以放心用；不确定的只有跟时钟无关的循环动画（相位从页面加载就开始算）。

## 动效：先定画面语言，再选类

一页只用一种画面语言。先选语言，再从表里挑类：

| 语言 | 句首那一帧长什么样 | 用什么 |
|---|---|---|
| **整页先在**（讲解默认） | 版面完整、要讲的要素压暗可见 | `dim` |
| **逐条出现** | 版面是空的，一条一条加上来 | `fade-up` / `zoom-in` / 默认 `fade` |

同一页里混用两种语言，观众分不清"先讲这块后讲那块"是节奏还是失误（不同页各用一种是可以的）。

### 时长：只改时长，不要覆盖 `transition`

模板给了 `--teach-dur: 480ms`，只改 `transition-duration`。**这一行是错的**：

```css
.reveal .fragment { transition: opacity 180ms ease; }   /* 别写 */
```

它与 reveal.css 的 `.reveal .fragment{transition:all .2s}` **特异性相同、后加载**，于是胜出：`transition` 只剩 opacity，`fade-up` 的位移、`grow` 的缩放全部变成瞬间跳变，而且没有任何报错——作者明明用了变体，看到的是"闪一下"。要改节奏就在 `<section>` 上覆盖变量：

```html
<section style="--teach-dur: 260ms">…</section>
```

480 ms 是实测选的：400 ms 的过渡在录屏里约 32 帧、200 ms 约 16 帧，低于 300 ms 观感仍是"闪一下"。想让人看清这个差别，就做一页负对照：同一批元素把 `--teach-dur` 设成 `0ms`，画面只剩一次跳变。

### 类清单

reveal 内置、不用写 CSS：出现型 `fade-up` / `fade-down` / `fade-left` / `fade-right` / `zoom-in` / `fade-in-then-out`；强调型 `grow` / `shrink` / `strike` / `highlight-blue|red|green` / `semi-fade-out`。

**强调型不能当出现型用**：`grow`、`shrink` 从一开始就可见（reveal 让它们 `opacity:1`），拿来做"逐条出现"会让整列一开始全在。它们的语义是"已经在场上，说到时变一下"。

模板额外给四个。它们写在随包模板 deck 的 `<style>` 里，所以**从 `assets/teach/deck/index.html` 起的 deck 自动就有**；老项目的 deck 是当初那一份拷贝，不会跟着更新，需要时从模板抄一段过来：

| 类 | 观感 | 用在哪 |
|---|---|---|
| `dim` | 压暗到 0.42，说到时点亮 | 整页构图、多块对照、要观众先看全局 |
| `draw` | SVG 路径描边画一次 | 曲线、流程线、坐标轴；`--teach-len` 要不小于路径实际长度 |
| `count` | 数字从 0 滚到目标值 | 指标、金额、占比；目标写 `style="--teach-to: 95"` |
| `bar` | 条形从左边生长 | 对比量级，比并排两个数字更快看出多和少 |

`count` 的数字由 CSS counter 打印，所以元素要留空：`<div class="fragment count" style="--teach-to: 95"></div>`。加 `custom` 就变"先亮着 0、说到时滚"，不加是"出现并滚动"。

### 同一元素连续变形：`data-teach-stage`

跨页 auto-animate 在逐句契约里拍不到（每句开录前才切页）——除非声明了 `meta.transition`，那时它就是被录进前一句尾部的那段页切换动画（见下文「跨句转场」）；母带契约里它自然发生在句首翻页处。页内想自己做连续变形：容器加 `data-teach-stage`，`teachCue` 会把它的 `data-step` 跟着拍数写进去，形状全交给 CSS。

```html
<div class="r-stack" data-teach-stage data-step="1"><div class="mover"></div></div>
```
```css
.mover { width: 120px; height: 120px; border-radius: 10px; background: #6b7280;
         transition: all 600ms cubic-bezier(.2, .7, .3, 1) }
[data-teach-stage][data-step="2"] .mover { width: 260px; height: 150px; background: #22d3ee }
[data-teach-stage][data-step="3"] .mover { width: 210px; height: 210px; border-radius: 50%; background: #e879f9 }
```

- **步号从 1 起，1 表示"第一拍之前"**。`data-step="1"` 就是 markup 里写的初态，第一拍把它推到 2。因此一个容器能表达"首拍前 + 每拍各一个"的状态，比这一页的拍数多一个（2 拍 → 3 种形状）。
- **容器本身不要当 fragment**：它靠同一页上的其他 fragment 数拍（文字条、标注）。页上一共 2 个 fragment，容器就走 1 → 2 → 3。
- 一个容器一个 `data-step`；要两处独立变形就开两个容器。
- **只在当前页有效**：独立成页时跨句不接续（每句都是一次新的页面加载），跨页的连续变形这一版做不到；共享页是例外，`enter` 会把 `data-step` 回放到上一句留下的拍号，所以同页上可以跨句连续变形（见下一条）。
- 共享页（`page` / `enter`）下拍号跨句递增，`data-step` 会继续往上数到 4、5、6；按整页编号写 CSS，或者让进页那几拍由 `enter` 先打到位。

### 依次聚焦

`class="fragment custom"` 不被 reveal 隐藏、也不被压暗，reveal 只负责数它和推进它，样式全归你。做"当前项高亮、其余压暗"只要两条规则：

```css
.beat { color: #9ca3af; transition: color 400ms ease, transform 400ms ease }
.beat.current-fragment { color: #ffd479; transform: translateX(14px) }
```

比 `highlight-*` 更可控：颜色、位移、字重可以同时改。模板里这套类就叫 `.beat`。

### 动效的禁用清单

- **无限循环的"信息型"动画**（转到某个角度时正好说到某句）：循环相位从页面加载就开始计，到开录之间还隔着截图自检等不确定耗时，对不上。纯装饰的循环允许，但只要有重绘，帧数就涨到约 90 fps（6 秒的句子从约 25 帧涨到约 560 帧），别全片铺开。
- **为了循环动画去改 `width` / `top` / `left`**：走 layout，帧率与帧大小都更差。循环部分只用 `transform` / `opacity`。
- **照抄 reveal 官方 demo 的 `cubic-bezier(0.77,0,0.175,1)`**：实测前 77% 的时间几乎不动（600 ms 的变形前 460 ms 只走 5 px），单元素变形看起来是"卡住然后突然变"。用 `ease-out` 或 `cubic-bezier(.2,.7,.3,1)`。
- **一页超过 6 个 fragment**：上一节的上限仍然成立，动效再多也不能超。

## 与时间轴的关系

- 有词时间戳（`volcengine`）时，`teachCue` 按**词**触发：稿子里 `at_word` 写哪个词，画面就在那个词发音时切换。
- 没有词时间戳（`deepseek`，默认）时，节拍按 `at_progress` × 该句实测时长触发。这个比例不是随手写的：一页 n 个 fragment → n+1 次变化（换页算第一次），第 k 个 fragment 落在说话时长的 k/(n+1)，并且分母含尾停留（算法见 `video-teach-storyboard`「页内节拍」）。它与发音不是逐字对齐的关系，**不要**据此承诺"讲到哪个字画面动到哪"。
- **母带契约（`volcengine`）下页面在句首就翻过去**：一句开始时录制器先把 deck 翻到这一句的页（`cueOpening` 的页与拍），节拍照旧按词触发。所以"这一句的页"在第一个字就出现在画面里，不等到第一个节拍；页切换动画录在这一句的开头。
- **所有动作要在这一句念完之前播完**，不要靠句尾去补。画面长度等于该句音频长度（`timings.json` 的 `durationMs`；声明了 `meta.transition` 的那句再多出 `exitMs`），DeepSeek 默认不补停顿；要让最后一屏停住约 1 秒，得给音频尾部补静默（见 `video-teach-iterate` 的「页尾停留」），再按新时长重算 cues。
- 每句结尾的版面必须是**完整构图**，不要留半截动画或空位；最后一屏要能独立看 1 秒以上。
- 一句话只录一次：句子内的 fragment 顺序错了，改稿子重跑 `sentences: [<id>]`。逐句契约只重录这一句（补过页尾停留的项目要全量重录，见 `video-teach-iterate`）；**母带契约下会扩到整段**（一句的代价是一段）。

## 静态资源：图标内联、位图外链

deck 引入外部素材只有两种方式，判据是**要不要被节拍点亮、要不要用 CSS 改色**：

| 内容 | 源文件放哪 | deck 里怎么写 |
|---|---|---|
| 图标、装饰矢量 | `materials/icons/<名字>.svg` | 构建时读文件、内联成 `<svg>` |
| 照片、插画、位图 | `materials/images/…` | `<img src="../../materials/images/…">` |

- 图标写成 `<img src="…svg">` 是错的：`<img class="fragment">` 虽然会被计数、也能整块点亮，但改不了色、没法只点亮图里的一部分（`<g class="fragment">`）。要这些能力就内联，源文件留在 `materials/icons/` 里以便替换与登记。
- 位图不要内联成 base64：deck 会涨到几十 MB，录屏与导出都受拖累。
- 路径只有一种形状：**往上两层再加 `materials/`**（deck 在 `slides/<幕>/index.html`，往上是项目根）。绝对路径、`~`、`http(s)`、`../../../` 都算错。原因不只是 deck 用 `file://` 加载：并行派发时 `materials/` 会被拷进 `runs/<幕>/`，只有这个形状在主项目与 run 副本里都解析得对。
- 引用前确认文件存在，然后跑项目自己的校验器（建项目时写的 `script/check-materials.py`，`python3` 跑）：引用缺失、路径形状不对、图标用 `<img>`、台账缺行，它一次报出来。
- 项目还没有 `materials/` 时，先按 `video-project` 的建项目第 2 步建（布局、`catalog.yaml`、`README.md`）。教学项目的 deck 走同一套目录，不另起一份。

## 一页承载多句（稿件里写了 `page`）

稿件的 `page` 让几句共用一个 `<section>`，deck 侧只需要把三件事做对（`video-teach-storyboard` 的「一页承载多句」是稿子那一侧）：

1. **`teachPage(n)` 要幂等，并且切到那一页时一个拍都不亮**。共用一页的几句都会调同一个 `n`，而每句都是一次新的 `page.goto`，所以 deck 每次都从第 0 页起来、再被切到 `n`。切换动画重放无所谓（它发生在开录之前），但"开页就亮着第一拍"是错的：稿件的第一条 cue 会因此永远不生效，`enter: 0` 也没法兑现。reveal.js 的写法是 `Reveal.slide(n, 0, -1)`，`-1` 表示停在第 0 个 fragment 之前。
2. **进页状态由录制器打，deck 不要自己记**。每句开录前录制器的顺序是：`teachPage(n)` → `teachCue(enter)` → 等 `teachPageTransition`（缺省 300 ms）过场 → 开录。所以第 2 句的 t=0 就已经是上一句结尾的那一屏，deck 不需要、也不该用 `localStorage`、`history.state` 或全局变量去"接着上一句"。`page.goto` 之后这些本来也不该被信任。
3. **编号跨句递增**。共享页内 `fragment` 从第 1 句一路数到第 3 句（1、2、3），所以 `teachCue(k)` 只要"点亮 `data-beat ≤ k`"就自然对。如果 deck 按 DOM 顺序数前 k 个元素（模板就是这么做的），而稿子让第二句从 1 重新编号，`teachCue(1)` 会把已经亮着的再确认一次，画面不动——问题出在稿子的编号，不在 deck 的计数方式。

另外：**共享页要求 deck 定义 `teachCue`，即使整段一条 cue 都没有**，因为录制器要用它把 `enter` 打回去。这条 `video_teach_plan` 在花钱前就会检查。

排版上没有新东西，但上限更快撞到：**一页两句、每句两拍**是这类页面的常态规划；三句各两拍就是 6，正好到顶，再多就该拆页（每页 6 个 fragment 的上限仍然成立）。

页数与节拍数有几处边界，`video_teach_plan` 会分别处理：稿件声明的页号**改变了句→页映射**且超过 deck 的页数会被**拒绝**（那一页根本不存在，句子会停在录制器上一次停的地方）；`enter` 超过该页的 fragment 数只是 warning（deck 会夹在页末，但页面一开就全亮，通常不是你要的）；页数**数不出来**（deck 没有 `<section>`，页在 JS 里生成）时也给一条 warning，说清页号没被核对过——别让它变成静默通过。

`page` / `enter` 只对**页模式**（没有词时间戳的 `deepseek`）的 slides 段有意义；Manim 段由场景自己的时长决定，cue 模式（`volcengine`）下这两个键静默失效。写上去不会有任何效果。

## 跨句转场：形态归 deck

稿件写了 `meta.transition` 之后，**转场动画是 deck 的事**，代码只管录多长（`video-teach-storyboard` 的「跨句转场」是稿子那一侧）。要在 deck 里做的只有一件：让"翻页"这件事本身值得看。两条路，都不要改录制契约：

- **页切换自带动画**：reveal 的 `transition`（`fade` / `slide` / `zoom` / `convex` …），或者自己写 CSS（模板的命令式 deck 就是给 `.page` 加 `transition: opacity/transform`，`teachPage` 切 `.on` 类）。转场长度就是 `teachPageTransition` 声明的那一个数。
- **跨页 Auto-Animate**：相邻两个 `<section>` 都写 `data-auto-animate`，元素用 `data-id` 对上，reveal 会把它们补间过去。**这时真正的时长是 `autoAnimateDuration`（默认 1 秒）**，所以要 `Reveal.configure({ autoAnimateDuration: 0.52 })` 并让稿件的 `meta.transition.durationMs` 不小于它 —— 补间比 `exitMs` 长就会在中间被切（观感是"滑到一半就断"）。

**母带契约（`volcengine`）不经过这套**：一个 slides 段一次连续录制，句子之间没有接缝，翻页直接录在它发生的时刻（句首换页、句中跨页的拍）。`meta.transition` 在这条路上不生效，`video_teach_plan` 会提示；deck 自己的页切换就是转场，所以真正要调的是 deck 的 `transition` / `transitionSpeed` 与 Auto-Animate 参数。

三条边界：

1. **`teachPage(n)` 会被在段尾再调一次**，就在录完正文之后、开录下一句之前。所以它必须能在**活页面**上工作、幂等，且带完整的切页动画（不要为了"稳"把动画关掉——那一段正是要录的东西）。
2. **转场落到的那一页，`enter` 状态就该看得见东西**。录制顺序是 `teachPage(next)` → `teachCue(enterNext)`，`enter` 通常是 0；如果那一页的标题、坐标轴也放在 fragment 里，接缝淡出的就是一张空页。常驻元素放在 fragment **外面**。（这条是约定，代码不判：从 HTML 看不出"整页内容是否都在 fragment 里"。）
3. **共享页之间没有转场**。两句同页时稿件侧不会被分配 `exitMs`，deck 不需要为此做任何事；也正是因此，`teachCue` 在段尾**不会**被调（只有真的换页时才调）。

代码会替你查这几件事（`video_teach_plan`）：`meta.transition.durationMs` 短于 `teachPageTransition` 会 warn（转场会被截断）、deck 里出现裸选择器的 `.reveal .fragment { transition: … }` 整体覆盖会 warn（D0 的坑，会吃掉所有变体的动效）、某一页里混用 `dim` 与默认 `fade` 会 warn（点明是第几页）；cue 模式还会查多页 deck 有没有 `teachPage`、有没有永远走不到的页、页数数不出来的情形。`transition-duration` 与 `.fragment.dim` 这类变体规则不算覆盖——模板自己就这么写。

## 检查清单

- `teachReady` 确实被置为 true（放在 `initialize()` 的 `then` 里，不要放在 `DOMContentLoaded`）。
- 首屏（`teachCue` 还没被调用时）就是可以直接开录的版面，不要空白页。
- 页模式下切到一页时**一个拍都不亮**（模板 `teachPage` 用 `Reveal.slide(n, 0, -1)`）：第一拍留给稿件的第一条 cue。传 `0` 会让每页的第一拍提前亮起，于是它对应的那条 cue 永远不生效（后面的节拍照常），`enter: 0` 也无法兑现。
- 三个全局都在：`video_teach_plan` 会读 HTML 检查 `teachReady`，检查 `teachCue`（稿件里有节拍或 `enter > 0` 时）、检查 `teachPage`（页模式，或多页的 cue 模式），缺了在**录音之前**就拒绝。
- 每页的 fragment 数不少于稿件里这一页用到的最大编号；多出来的 fragment 永远不显示（页末夹住），只是浪费。页内节拍数 = fragment 数 + 1（换页算第一次变化）。共享页按整页数，不是按句数。
- 最后一屏是完整版面，动作在念完之前播完；要停留就补音频尾部静默，别靠渲染器（仅逐句契约：`deepseek`，或 `volcengine` + `merge: none`；母带契约没有逐句音频可补）。
- 动效类来自模板（`dim` / `draw` / `count` / `bar`）或 reveal 内置变体，节奏靠 `--teach-dur` 覆盖；deck 里**没有** `.reveal .fragment { transition: … }` 这样的整体覆盖。
- `data-teach-stage` 的容器自己不是 fragment，但同一页要有足够多的 fragment 给它数拍（2 拍 → 3 种形状）；`data-step` 初值写成 `"1"`。
- 如果这条路是母带契约（跨句连续录制）：`teachPage` 必须幂等且带完整切页动画（动画会被录进画面），每一页的 fragment 数决定节拍落在哪一页。
- 声明了 `teachPageTransition`（用 reveal 的 `fade` 就是 500）与 `teachTransition`（等于这页实际最长的那段动效）；`video_teach_plan` 会因为后者报警，也会因为稿件声明的转场比前者短而报警。
- 稿件写了 `meta.transition` 时：切页动画是真的有（别在 `teachPage` 里关掉动画），Auto-Animate 的 `autoAnimateDuration` 与 `durationMs` 对齐，转场落点那一页在 `enter` 状态下不是空页。
- 用 `video_teach_render` 只渲染这一句时，页面上没有外部网络依赖（字体、CDN 图片都会在录屏时抖动）。

## 让每句话都改变画面

`volcengine` 下录屏器按 cue 推进，**一句话没有 cue 就等于这句话期间画面完全不动**。`deepseek` 下每句自动换页，句子之间一定有变化，需要注意的变成页内节拍。上一版样片就是这么出现四十秒静帧的：十六行正文塞在一页，后七句没有 cue，加上 `teachCue` 的下标算错，最后两档被裁成同一张画面。

写 deck 时守住五条：

1. **一句至少一个 fragment**。一句话讲三个要点就拆三个 fragment，别让一句只停在一个静态版面上。页模式下这句单独占一页时，换页本身就是那次变化，写不写节拍都行。
2. **每一页的 fragment 数 ≥ 稿件在这一页用到的最大编号**。cue 模式下 `video_teach_plan` 拿整份 deck 的 fragment 总数核对，越界直接拒绝；页模式下按页核对，越界给 warning 并指出是哪一页（此时编号要么改成按页从 1 起，要么让 deck 自己翻译编号）。只有真标记算数：注释与 `<script>` 里的 `class="fragment"` 不算节拍；整份 deck 数不出来时（节拍在 JS 里生成），**cue 模式**下 plan 会明说一句；页模式只在稿件声明过页号时才提这一句。
3. **同一页别塞超过 6 个 fragment**。reveal 会缩放适配，行数一多字号就被压到看不清；正文超过 10 行就该换页。
4. **`teachCue(n)` 是"显示到第 n 步"**，`Reveal.getIndices().f` 是零基下标，两者差一。模板里已经处理，自己写 deck 时注意别再把 `f` 直接当目标值。
5. **改了这一页的 fragment 数，就重算这一句的 cues**。节拍比例由变化次数算出（见 `video-teach-storyboard`「页内节拍」），重算后只需要重渲染，不用重录旁白。

改完跑 `video_teach_plan`：它会报出"哪句没有 cue""平均几秒才变一次画面"，这些都能在下一次录音之前发现。


## SVG 里的元素也能当节拍

`class="fragment"` 不限于 `<div>`：写在 SVG 的 `<g>` 上同样有效。`countDeckFragments` 数的是页面里的这个类名，`pageFragments` 按 `<section>` 切分，`<g>` 落在 section 内就算该页的节拍，`teachCue(k)` 对 `<g>` 与 `<div>` 一视同仁（SVG 的 `opacity` 也吃 CSS 类）。

所以"一页内三张卡依次亮"不必拆成三页：一张 `<svg>` 里给三个 `<g>` 各加 `class="fragment"`，就是三个节拍。

**顺序不要依赖 DOM。** 模板的 `teachCue(k)` 是按页内 DOM 顺序推拍的，所以图元排在文字前面时，点亮顺序会跟稿子对不上。要指定顺序就给每个节拍元素加 `data-beat="k"`，并让 `teachCue(k)` 点亮 `data-beat ≤ k`（这需要自己写 `teachCue`，模板不认这个属性）。
