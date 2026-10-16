# Video Prompting — writing prompts that produce the shot the user asked for

Use this when composing or revising the `prompt` (and any `first_frame` /
`last_frame` / `reference_images`) for `video_generate`. Video models are not
image models: describe motion and time, not just a still frame.

## Prompt structure

A strong video prompt names, in order:

1. **Subject** — who or what is in frame, and what it looks like.
2. **Action & motion** — what changes over time. This is the part image prompts
   leave out and video models depend on.
3. **Camera** — shot size (close-up / medium / wide), angle (low / high /
   overhead), and movement (static, pan, tilt, dolly in, tracking, handheld).
4. **Setting & light** — location, time of day, light quality.
5. **Style** — photographic style, film look, or "3D render"; keep it short.

Example: "A red paper boat (subject) drifts downstream, rocking gently past
reeds (motion), low tracking shot at water level (camera), overcast morning
light on a quiet river (setting), soft film look (style)."

Keep the prompt one coherent paragraph. Do not use shot-list syntax or
comma-dumps; the model reads it as prose.

## Duration and aspect ratio

- Choose `duration_seconds` and `resolution` only from what the target model
  declares. Call `video_status` (no arguments) to see each provider's models and
  their allowed durations, resolutions and aspect ratios; the tool refuses
  anything else before it is paid.
- Match aspect ratio to the use: `9:16` for short-form vertical, `16:9` for
  landscape, `1:1` for square feeds.
- Shorter is cheaper and safer to iterate. Start at the shortest useful length;
  extend only when the user asks.

## Provider differences

- **Volcengine ARK Seedance**: strongest with cinematic motion and camera
  language; supports `return_last_frame`, so it is the only provider that can be
  continued with `from`. Prefer explicit camera movement wording.
- **MiniMax (Hailuo)**: strong with character/subject consistency and fast
  turnaround; it does **not** return a last frame, so `from` is refused for it.
  If the user wants to continue a MiniMax take, ask for a `first_frame` image
  instead.
- **OpenAI-compatible relays / Sora**: field names and behavior vary per relay;
  the plugin maps them, but keep prompts provider-neutral unless the user pinned
  one.

When the user has configured more than one provider, ask which one they want
(or read the manifest `defaults.provider`) rather than guessing — submitting to
the wrong endpoint costs money.

## Reference images and first/last frames

- A `first_frame` sets the opening image; a `last_frame` sets the ending image
  (first+last together is a start/end transition).
- `reference_images` (or a character's `refs` in the manifest) guide subject
  appearance in a `s2v` generation. Describe in the prompt how to use them
  ("keep the character's face and outfit exactly as in the reference").
- Reference images are read from the workspace or from `$DSH_HOME/attachments`;
  pass the path the user gave you. A dragged-in image has no extension — the
  plugin recognizes it by its file header, so pass its path as-is.

## Content review

Providers run content moderation and refuse some prompts. Avoid wording that
could read as violence, gore, explicit content, or real-person likeness without
consent. If a generation is refused as moderation, do **not** resend the same
prompt — the plugin blocks the identical request. Change the wording, the
materials, or both, then try again.
