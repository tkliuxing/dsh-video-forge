# Video Storyboard — breaking a script into shots

Use this when the user wants to plan a video as a sequence of shots, or when a
script needs to be turned into a shot list. The shot list is **reference text
you write and read** — the plugin generates one shot at a time and never reads
`shots.yaml` to batch-generate.

## Breaking a script into shots

A shot is one continuous piece of footage — one camera position, one subject
focus, one beat of action. Split a script at every change of:

- **place or time** (new location, cut to later),
- **camera** (wide establishing shot → close-up → reverse angle),
- **subject focus** (who or what the camera follows).

Give each shot a short slug and a one-sentence description that says what is
seen *and* what moves. Number them in story order.

## The shots.yaml format

Keep it simple — the fields below are for you and the user, not parsed by the
plugin. The plugin only cares about the `shot` *name* you pass to
`video_generate` (it becomes the `renders/<shot>/` folder).

```yaml
shots:
  - id: establishing       # becomes the `shot` folder: renders/establishing/
    description: "Wide low shot of a river at dawn, mist over the water, a red boat enters from the left"
    duration_seconds: 5
    aspect_ratio: "16:9"
  - id: closeup
    description: "Close-up of the boat's paper hull creasing against a ripple, soft morning light"
    duration_seconds: 5
    aspect_ratio: "16:9"
  - id: reveal
    description: "Overhead shot as the boat rounds a bend into open water"
    duration_seconds: 5
    aspect_ratio: "16:9"
```

The `id` is the `shot` parameter; keep it short and filesystem-safe (letters,
digits, `-`, `_`, `.`).

## Generating from a shot list

Generate **one shot per `video_generate` call** — the tool takes a single
prompt and produces a single video. Work through the list in order:

1. Read the shot's description.
2. Expand it into a full prompt using the `video-prompting` skill (add motion,
   camera, light, style; the manifest `style` is appended automatically).
3. Call `video_generate` with `shot: <id>` and the prompt.
4. Wait for the result (or check `video_status`), then move to the next shot.

For consistency across shots, reuse the same `characters` from the manifest and
keep the wording of shared elements (character, location, palette) identical
from shot to shot.

## What the plugin will not do

- It will **not** read `shots.yaml` and generate the whole list — that is a
  known non-goal (one generation at a time, paid).
- It will **not** concatenate the shots into a film. Sequencing and editing are
  done outside the plugin. Say this plainly if the user expects an assembled
  video.
