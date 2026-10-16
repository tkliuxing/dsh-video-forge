# Video Iterate — revising takes, continuing shots, keeping characters consistent

Use this when the user wants to redo a take, continue from the end of a
previous shot, or keep a character looking the same across several videos.

## Redo vs continue: pick the right move

- **Redo (new version)** — the shot is wrong and should be generated again from
  the same starting point. Call `video_generate` again with the same `shot` and
  a revised prompt. The host assigns the next version number (`v002`, …); the
  old take is not overwritten.
- **Continue (`from`)** — the shot is right and the next shot should begin where
  it ended. Pass `from: <task_id>` (or a path to a finished `vNNN.mp4`) and the
  tool uses that take's **last frame** as the new `first_frame`. Do not also
  pass `first_frame`, and do not set `mode` to `t2v`/`s2v` with `from`.

`from` rules (the tool enforces them and refuses before charging):

- Only a **succeeded take made by Volcengine ARK Seedance** can be continued —
  it is the only provider that returns a last frame. MiniMax and relay takes,
  takes made before last frames were kept, or takes whose last frame was not
  downloaded, are all refused with a hint to pass a `first_frame` image instead.
- The shot defaults to the source take's shot; give a new `shot` to branch.
- The source's last frame is saved next to it as `vNNN.last.jpg`; if the user
  moved or deleted that file, `from` is refused — ask for a `first_frame` image.

## Character consistency

The manifest registers characters under `characters:`. To keep a character
looking the same across shots:

1. Put reference images in `materials/<name>/…` and list them as
   `refs: [materials/<name>/*.png]` in the manifest.
2. Pass `characters: ["<name>"]` to `video_generate`. The tool expands the
   refs (globs in the file name only) and appends the character description to
   the prompt; with reference images the generation runs in `s2v` mode.
3. Keep the character's description short and factual (hair, outfit, build).
   Vague or contradictory descriptions make consistency worse, not better.

If a request carries reference images but names no `mode`, the tool switches to
`s2v` automatically; if the model does not support `s2v` it is refused, and you
should use `mode: t2v` with only the description.

## Self-check before you deliver

You cannot watch a video, but you can read images. An ARK take has its last
frame saved next to it as `vNNN.last.jpg`. Before telling the user a video is
ready, read that frame with your image tool and check it against the prompt:
is the subject right, the composition sensible, the frame intact? If it looks
wrong, iterate; if it looks right, say so and point at the video.

## Iterating cheaply

- Fix one thing per iteration; changing several variables at once hides which
  change helped.
- Prefer re-prompting at the shortest duration the user accepts; lengthen only
  after the content is right.
- Read the `vNNN.json` beside a take to recall exactly what prompt and
  parameters produced it, before you change something.
