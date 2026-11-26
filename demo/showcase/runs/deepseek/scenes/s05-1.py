from manim import *

LIMIT = 1.6449  # pi^2 / 6，直接写数值比让 MathTex 求值省事，也省一次 TeX 编译


class Converge(Scene):
    """坐标系里的连续动画：部分和一条条逼近同一根水平线。

    构图按 1080p 定：标题顶到上边，坐标轴整体下移留出呼吸位，字号与点半径
    都放大一档（默认值在 1920×1080 里偏小）。时长约 5.5 s，落在该句旁白
    （7.68 s）的 70%–100% 里。
    """

    def construct(self):
        axes = Axes(
            x_range=[0, 6, 1], y_range=[0, 2, 0.5],
            x_length=7.8, y_length=3.9,
            axis_config={"color": GREY_B, "stroke_width": 3},
        ).shift(DOWN * 0.45)
        labels = axes.get_axis_labels(MathTex("n"), MathTex("S_n"))
        title = Text("部分和逼近同一根线", font="PingFang SC").scale(0.55).to_edge(UP, buff=0.5)
        limit = DashedLine(
            axes.c2p(0, LIMIT), axes.c2p(6, LIMIT), color=YELLOW, stroke_width=3,
        )
        limit_label = MathTex(r"\frac{\pi^2}{6}").scale(1.0).next_to(axes.c2p(5.15, LIMIT), UP, buff=0.16)

        partials = []
        running = 0.0
        for n in range(1, 7):
            running += 1 / n ** 2
            partials.append(axes.c2p(n, running))
        dots = VGroup(*[Dot(p, color=BLUE_B, radius=0.085) for p in partials])
        steps = VMobject(color=BLUE_B, stroke_width=2, stroke_opacity=0.55)
        steps.set_points_as_corners(partials)

        self.play(Create(axes), FadeIn(labels), run_time=1.0)
        self.play(Write(title), run_time=0.7)
        self.play(Create(limit), FadeIn(limit_label), run_time=0.8)
        self.play(LaggedStart(*[GrowFromCenter(dot) for dot in dots], lag_ratio=0.3), run_time=1.3)
        self.play(Create(steps), run_time=0.8)
        self.wait(0.9)
