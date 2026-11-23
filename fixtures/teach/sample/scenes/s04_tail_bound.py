"""Scene C of the sample film: the tail between the last partial sum and the limit.

Draws the gap explicitly and labels its size, which is what the last three
sentences are about ("the tail is about 1/N", "it approaches an upper bound
instead of growing without limit").
"""

from manim import *


class TailBound(Scene):
    def construct(self):
        axes = Axes(x_range=[0, 6, 1], y_range=[0, 1.8, 0.5], x_length=9, y_length=4.5,
                    axis_config={"color": GREY_B, "stroke_width": 2})
        labels = axes.get_axis_labels(x_label="N", y_label="S_N")

        partial = []
        running = 0.0
        for n in range(1, 7):
            running += 1.0 / (n * n)
            partial.append(running)
        points = [axes.c2p(n, partial[n - 1]) for n in range(1, 7)]
        graph = VMobject(color=BLUE_B)
        graph.set_points_as_corners([points[0], *points[1:]])

        limit_value = 1.6449
        limit = DashedLine(axes.c2p(0, limit_value), axes.c2p(6, limit_value), color=YELLOW, stroke_width=2)
        # The tail at N = 6: how far the last partial sum still is from the limit.
        gap = DoubleArrow(
            axes.c2p(6, partial[-1]),
            axes.c2p(6, limit_value),
            buff=0, color=RED, stroke_width=2, tip_length=0.15,
        )
        gap_label = MathTex(r"\approx \frac{1}{N}").scale(0.7).next_to(gap, RIGHT, buff=0.18)

        self.play(Create(axes), Write(labels), run_time=0.9)
        self.play(Create(graph), run_time=0.9)
        self.play(Create(limit), run_time=0.5)
        self.play(Create(gap), Write(gap_label), run_time=0.9)
        self.wait(0.5)
