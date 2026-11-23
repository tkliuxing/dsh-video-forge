# Video Teach Manim — 数学动画那一段怎么写

`engine: manim` 的句子由一段 Manim CE 场景配旁白。场景文件一句一个，类名由插件从文件里发现。

## 先判断：需要 Manim 吗

**Manim 不是必须的。** 一份稿件全部用 `engine: slides` 是完全合法的路线，只需要 `ffmpeg`/`ffprobe` 和一个 Chromium，不必装 Python、不必装 TeX。

只有在下面这些情况才值得装 Manim：

- **公式推导**要一项项长出来、符号要变形（`MathTex` 的变换、逐行推导）；
- **坐标系里的连续动画**：曲线生长、部分和逼近极限、参数扫描；
- **同一对象在多个状态间连续变化**，幻灯片的分步显示做不出中间过程。

下面这些**用 slides 就够**，不要为了它们装 Manim：要点分步出现、结论对比、图片与截图讲解、数据图表（静态图或 SVG 即可）、纯文字排版。

公式排版目前只有两条路：Manim 的 `MathTex`（需要 TeX），或者幻灯片里用 HTML/CSS 和图片。**插件没有内置 MathJax/KaTeX**，所以没装 Manim 时公式请做成图片或纯 HTML。

如果装不动 Manim，把那几句改成 `engine: slides` 并从段落里删掉 `scene` 即可，路线照样能出片。

## 装 Manim 要装三样

1. **Python + Manim**：`python3 -m venv ~/.local/venvs/teach-video && ~/.local/venvs/teach-video/bin/pip install manim`，然后把 `TEACH_PYTHON` 指到 `~/.local/venvs/teach-video/bin/python3`（不指定就用 `PATH` 上的 `python3`）。
2. **TeX**：macOS 上推荐 TinyTeX（用户可写、自带 `dvisvgm`）：`curl -sL https://yihui.org/tinytex/install-bin-unix.sh | sh`，二进制在 `~/Library/TinyTeX/bin/universal-darwin`。
3. **`dvisvgm`**：**BasicTeX 有 `latex` 但没有 `dvisvgm`**，只装 basictex 会在首次渲染报 `latex error converting to dvi`。用 TinyTeX，或在可写的 TeX 上 `tlmgr install dvisvgm`。把 `TEACH_TEXBIN` 指到含 `latex` 与 `dvisvgm` 的 bin 目录（两个分属不同安装时，插件会建 shim 目录把两者拼到同一 `PATH`）。

`video_teach_plan` 会把依赖按「必需 / 仅幻灯 / 仅 Manim」分开报，并在缺 Manim 依赖时**在花钱前拒绝**，同时给出上面这些命令与「改用 slides」这条路。

## 文件约定

- 一句一个 `.py`：`scenes/<sentence-id>.py`（路径写进 `storyboard.yaml` 的 `scene`）。
- **一个文件里只放一个 `Scene` 子类**。插件取第一个 `class X(Scene)`；放两个说明稿件结构出了问题，不是特性。
- 场景**不需要**自己算时长对齐旁白：插件会把它重定时到这句旁白的真实长度。反过来，场景写得太短会在尾部停顿（补最后一帧），写得太长会被截断并报告超长量。

## 一个能用的模板

```python
from manim import *

class PartialSums(Scene):
    def construct(self):
        axes = Axes(x_range=[0, 6, 1], y_range=[0, 1.8, 0.5], x_length=9, y_length=4.5)
        eq = MathTex(r"\sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6}").to_corner(UL)
        self.play(Create(axes), run_time=0.8)
        self.play(Write(eq), run_time=0.6)
        self.wait(0.5)
```

## 时长怎么配

一句话大约 3–8 秒。经验做法是**先估这句旁白的长度**（实测中文约每秒 5 字，即每分钟 300 字），再把 `run_time` 之和写到它的 90% 左右，最后留一点 `self.wait()`。不要试图精确对秒：插件的重定时会兜住误差，真正会被看见的是"动画演完了旁白还在讲"或"旁白没说完动画已经停了"。

## 环境

- Python 侧要装 `manim`（本机实测在专用 venv 里，路径用 `TEACH_PYTHON` 指定）。
- 公式要 LaTeX，且必须有 `dvisvgm`。缺 `standalone` / `preview` / `amsmath` / `doublestroke` / `babel-english` 时会在首渲染报 `latex error converting to dvi`。TinyTeX 装法最省事（用户可写、自带 dvisvgm）；用 `TEACH_TEXBIN` 指到它的 `bin/universal-darwin`。
- 首次渲染会编译 TeX，比后续慢一个量级。`video_teach_plan` 会报告 `python3` / `latex` / `dvisvgm` 在不在。

## 风格约定

- 颜色只用 Manim 的命名色（`BLUE_B`、`GREY_B`、`YELLOW`），不要手写十六进制：主题调整时它们能一起变。
- 坐标系 `x_length` 控制在 9 以内，1080p 下左右各留 1.5 的呼吸位。
- 数字与公式用 `MathTex`，中文用 `Text(..., font="PingFang SC")`；`Text` 里不要塞公式。
- 一个场景只讲一件事。要讲第二件事就新开一句、新开一个文件，否则重录一句的代价会扩散。

## 出问题先看哪里

- `latex error converting to dvi` → TeX 缺包或缺 `dvisvgm`，看 `media/Tex/*.log` 里第一个 `!` 开头的行。
- 画面比旁白短一截 → 这是正常的补帧，但动画在句子中途结束观感会断；把最后一段 `run_time` 拉长或补 `wait`。
- 报超长 → 场景实际长度超过旁白，插件裁在旁白结束处。要么缩短动画，要么把那句话写长。

## 一句一场景，别复用

`scenes/` 下的文件与句子是一对一关系。同一场景被三句引用，渲染器会把它渲三次，成片里就是同一段动画连播三遍——时长对了，内容重复了。上一版样片的 Manim 段就是这样丢了近一分钟。

三条做法：

1. **一句一个 `.py`**，文件名用句子 id（`scenes/s02-1.py`），改哪句的重录代价就锁在那一句。
2. **场景时长配到该句旁白的 70%–100%**。太短，尾部会补最后一帧，看着像卡住；太长，会被裁在旁白结束处，动画断在半截。
3. 真要复用同一段画面（比如同一坐标系下讲两句），把这两句**并成一句**，比留两个引用更诚实。

`video_teach_plan` 会列出所有共用场景的句子 id；渲染完后 `video_teach_render` 还会抽样帧颜色，把"看着像静帧"的段点名。
