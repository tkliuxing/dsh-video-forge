"""One Manim scene for the teaching pipeline's fixture project.

One sentence, one scene, one class: that is the convention a `manim` segment
relies on (src/teach/manim.ts discovers the single Scene subclass). The scene
declares its own timing, but the pipeline re-times it to the narration's real
length, so `run_time` here only decides how much of the animation the narration
gets to show.
"""

from manim import *


class PartialSums(Scene):
    def construct(self):
        axes = Axes(x_range=[0, 6, 1], y_range=[0, 1.8, 0.5], x_length=9, y_length=4.5,
                    axis_config={"color": GREY_B, "stroke_width": 2})
        axes_label = axes.get_axis_labels(x_label="n", y_label="S_n")
        eq = MathTex(r"\sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6}")
        eq.to_corner(UL).scale(0.9)

        running = 0.0
        points = []
        for n in range(1, 7):
            running += 1.0 / (n * n)
            points.append(axes.c2p(n, running))

        graph = VMobject(color=BLUE_B)
        graph.set_points_as_corners([points[0], *points[1:]])
        dots = VGroup(*[Dot(point, color=BLUE_B, radius=0.06) for point in points])
        limit = DashedLine(axes.c2p(0, 1.6449), axes.c2p(6, 1.6449), color=YELLOW, stroke_width=2)
        limit_label = MathTex(r"\pi^2/6").scale(0.6).next_to(limit, RIGHT)

        self.play(Create(axes), Write(axes_label), run_time=0.8)
        self.play(Write(eq), run_time=0.6)
        self.play(Create(graph), FadeIn(dots), run_time=1.2)
        self.play(Create(limit), Write(limit_label), run_time=0.6)
        self.wait(0.6)
