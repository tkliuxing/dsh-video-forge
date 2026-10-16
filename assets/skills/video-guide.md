# Video Forge — usage guide

Use this when the user asks how to use the video plugin ("怎么用", "how do I
make a video", "help with video", etc.). Answer in the user's language. Never
volunteer this guide when the user has not asked for it.

## How to answer

1. **Diagnose first.** Call `video_status` with no arguments to read the live
   state: whether the plugin is enabled, the default provider/model, whether
   each provider has a key set, which models are available, and the current
   workspace's manifest, permission mode and registered characters.
2. **Then give at most three next steps**, matched to what the diagnosis found.
   Do not dump the whole guide. Hold detail until the user asks a follow-up.
3. **Answer only the part they asked about.** If they ask about cost, talk
   about cost; if they ask about continuing a shot, talk about `from`.

## Getting started (three steps)

1. **Configure a provider and key.** Open the plugin settings (sidebar →
   Plugins → Video Forge), add a provider (Volcengine ARK Seedance, MiniMax, or
   an OpenAI-compatible relay), and set its API key. This is the only step the
   model cannot do for the user.
2. **Open a conversation in a project workspace.** The workspace is the video
   project; finished videos land in its `renders/<shot>/vNNN.mp4`.
3. **Just say what you want.** For example: "Make a 5-second shot of a sunset
   over the sea, wide shot, gentle waves."

If `video_status` reports a provider with no key, tell the user to set it in
the plugin settings and point there — do not pretend you can do it.

## What you can ask for (with example phrasings)

- **One-shot generation**: "Make a 5-second video of …"
- **Animate a material**: "Make materials/cat.png come alive — the cat turns to
  look at the camera." (Dragged-in files also work: pass the path you were
  given.)
- **Iterate / continue**: "Shot 3, brighter" or "Continue from the last shot"
  (the latter uses `from`, ARK Seedance only).
- **Embed in a larger task**: while building a site or deck, generate a video
  clip; it lands in the workspace alongside the other files.
- **Ask the cost**: "How much have the videos in this project cost?" (an
  estimate — see below).

## What it cannot do

- **Batch-generate a shot list** — one generation per call, one video at a time.
- **Concatenate clips into a film** — there is no joining/editing; do it
  outside the plugin.
- **Continue a MiniMax or relay take with `from`** — only ARK Seedance returns a
  last frame; pass a `first_frame` image instead.

## Things to say when relevant

- **Every generation is paid.** It spends real provider quota.
- **Amounts are estimates.** Cost = usage × an editable price table, labelled
  "estimate, the provider bill is authoritative". The real bill is only in the
  provider's console.
- **After a timeout or restart, check `video_status` — never resubmit.** A task
  that was sent may already be running and billing; resubmitting the same
  request is blocked for a while anyway.
- **Videos live in `renders/<shot>/`** in the workspace; a `vNNN.json` beside
  each one records how it was made.
- **Project-wide settings live in `video-project.yaml`** (default model,
  resolution, style, characters), not in the plugin settings.

## When a tool call fails

A failure is a response to an action, not an invitation to lecture — still say
plainly how to fix it: "no provider configured" points to the plugin settings;
"read-only conversation" means the user must allow writing; "content review
refused" means change the prompt or the materials, not resend.
