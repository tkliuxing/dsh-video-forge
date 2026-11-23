"""Scene B of the sample film: the limit the partial sums approach.

Same axes and polyline as scene A, then the dashed line at pi^2/6 and its
label. The point of the split is that these three sentences talk about the
limit, so the picture shows the limit being drawn rather than replaying the
partial sums for the fourteenth time.
"""

from manim import *


class LimitLine(Scene):
    def construct(self):
        axes = Axes(x_range=[0, 6, 1], y_range=[0, 1.8, 0.5], x_length=9, y_length=4.5,
                    axis_config={"color": GREY_B, "stroke_width": 2})
        labels = axes.get_axis_labels(x_label="n", y_label="S_n")

        points = []
        running = 0.0
        for n in range(1, 7):
            running += 1.0 / (n * n)
            points.append(axes.c2p(n, running))
        graph = VMobject(color=BLUE_B)
        graph.set_points_as_corners([points[0], *points[1:]])

        limit = DashedLine(axes.c2p(0, 1.6449), axes.c2p(6, 1.6449), color=YELLOW, stroke_width=2)
        formula = MathTex(r"\frac{\pi^2}{6}").scale(0.8).next_to(limit, RIGHT)
        caption = Text("极限", font="PingFang SC").scale(0.5).next_to(formula, DOWN, buff=0.15)

        self.play(Create(axes), Write(labels), run_time=0.9)
        self.play(Create(graph), run_time=1.0)
        self.play(Create(limit), Write(formula), Write(caption), run_time=1.0)
        self.wait(0.6)
