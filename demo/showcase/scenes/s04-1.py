from manim import *


class Derivation(Scene):
    """一句一段推导：同一块 TeX 在三个状态之间长出来，中间不跳。

    字号按 1080p 观看距离定，1.5–1.9 倍是实测可读的下限：默认 1.0 在
    1920×1080 里只占屏幕宽度的一小条。时长配到该句旁白（7.26 s）的
    70%–100%，动画合计约 5.4 s，剩下交给插件重定时补最后一屏。
    """

    def construct(self):
        title = Text("公式一步一步长出来", font="PingFang SC").scale(0.55).to_edge(UP, buff=0.55)

        line1 = MathTex(r"\sum_{n=1}^{\infty} \frac{1}{n^2}").scale(1.55)
        line2 = MathTex(r"= 1 + \frac{1}{4} + \frac{1}{9} + \cdots").scale(1.25)
        line3 = MathTex(r"= \frac{\pi^2}{6}").scale(1.45)
        lines = VGroup(line1, line2, line3).arrange(DOWN, aligned_edge=LEFT, buff=0.4)
        lines.next_to(title, DOWN, buff=0.42)

        self.play(Write(title), run_time=0.8)
        self.play(Write(line1), run_time=1.0)
        self.play(Write(line2), run_time=1.1)
        self.play(Write(line3), run_time=1.0)
        # 结论用命名色，主题调整时能一起变，不写死十六进制。
        self.play(line3.animate.set_color(YELLOW), run_time=0.5)
        self.wait(1.0)
