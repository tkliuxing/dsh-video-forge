"""Scene A of the sample film: the partial sums, drawn one term at a time.

One scene file per picture idea (assets/skills/video-teach-manim.md). This one
covers three sentences — the same animation is re-timed to each of them — and
the next two scenes carry the limit line and the tail so the picture never
repeats for a whole minute.
"""

from manim import *


class PartialSums(Scene):
    def construct(self):
        axes = Axes(x_range=[0, 6, 1], y_range=[0, 1.8, 0.5], x_length=9, y_length=4.5,
                    axis_config={"color": GREY_B, "stroke_width": 2})
        labels = axes.get_axis_labels(x_label="n", y_label="S_n")
        title = Text("部分和", font="PingFang SC").scale(0.6).to_corner(UL)

        points = []
        running = 0.0
        for n in range(1, 7):
            running += 1.0 / (n * n)
            points.append(axes.c2p(n, running))

        graph = VMobject(color=BLUE_B)
        graph.set_points_as_corners([points[0], *points[1:]])
        dots = VGroup(*[Dot(point, color=BLUE_B, radius=0.06) for point in points])

        self.play(Create(axes), Write(labels), Write(title), run_time=1.0)
        self.play(Create(graph), FadeIn(dots), run_time=1.6)
        self.wait(0.6)
