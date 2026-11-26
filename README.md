# dsh-video-forge

Online-model video generation inside a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) workspace conversation. Ask for a shot, and the finished video lands in
the workspace as `renders/<shot>/vNNN.mp4`; every generation is tracked in a
durable ledger, so a timeout or a restart never means paying twice.

There is no local inference path by design: this plugin is a client of online
models only.

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

## Requirements

- **DSH 0.2.x**, release candidates included. The package declares
  `engines.dsh` (`^0.2.0-rc.1 || ^0.2.1-rc.2`), and DSH refuses to install a
  plugin whose declared range the running build does not satisfy; no silent
  loading of a plugin built against API the host does not have.
- **Node** `^22.19.0 || >=24.0.0`.
- An account and API key with at least one supported provider (Volcengine ARK
  Seedance, MiniMax, or an OpenAI-Videos-compatible gateway). Nothing is
  generated (and nothing is billed) before you configure one.
- No ffmpeg, no model weights, no GPU for **generated** videos: the vendor
  renders, and this plugin moves the bytes.
- **Teaching videos** (the four `video_teach_*` tools) render on this machine
  instead of at a vendor, so they need local tools. The list is tiered, and only
  the first tier is needed for every manuscript:
  - **Every teaching video**: `ffmpeg` and `ffprobe` on `PATH`. Without them
    `video_teach_plan` reports a blocker, and `video_teach_render` refuses to
    start either.
  - **Slide segments** (`engine: slides`): a Chromium. `playwright-core` ships
    with the plugin but the browser itself does not, so either let Playwright's
    cache answer or point `TEACH_CHROMIUM` at a binary. This tier never blocks:
    the steps before recording work without it, and the failure only shows up
    when a deck is actually recorded.
  - **Manim segments** (`engine: manim`): a Python with the `manim` module, plus
    `latex` and `dvisvgm`. Only a manuscript with real manim sentences needs
    this, and when it does, a missing tool is refused before anything is
    narrated or rendered, with two ways out. There is one trap here.
    **BasicTeX ships `latex` but not `dvisvgm`**, so a BasicTeX-only install
    fails with `latex error converting to dvi`. Use TinyTeX, or install
    `dvisvgm` separately.

  Three environment variables say where those tools live on your machine. They
  describe topology, not secrets:
  - `TEACH_PYTHON`: the interpreter that has `manim` (a dedicated venv is fine).
  - `TEACH_TEXBIN`: a bin directory holding **both** `latex` and `dvisvgm`.
  - `TEACH_CHROMIUM`: the Chromium executable.

  **Manim is optional.** Without it, set every segment to `engine: slides` and
  the route needs only ffmpeg and a Chromium. The `video-teach-storyboard` skill
  covers the manuscript format, and `video-teach-manim` covers the install steps
  and when animation is worth the trouble. Generated videos never touch any of
  this.

## Install

```bash
dsh plugin --profile web add dsh-video-forge
```

`web` is the profile you boot (`dsh web`); use `desktop`, `tui`, or whatever
profile you actually run. Restart that profile afterwards.

## Configure a provider

The usual way is the plugin's own page in the GUI: **Sidebar → Plugins → Video
Forge**. It offers the protocols this build supports as a pick list: Volcengine
ARK (Seedance), MiniMax (H3), OpenAI (Sora), or a custom OpenAI-Videos-compatible
gateway. It fills in the base URL, credential reference and the vendor's
documented models, and lets you add several providers. The API key is stored
through the harness credential service and only a masked tail is ever shown.

The same configuration by hand, in the profile's `cordis.patch.yml`:

```yaml
- id: video-forge
  name: dsh-video-forge
  config:
    providers:
      - id: ark
        protocol: ark-seedance
        baseUrl: https://ark.cn-beijing.volces.com/api/v3
        authRef: ARK_API_KEY
        models:
          - id: doubao-seedance-2-0-fast-260128
            modes: [t2v, i2v, flf2v, s2v]
            resolutions: ['480p', '720p']
            aspectRatios: ['16:9', '9:16', '1:1']
    defaultProvider: ark
    defaultModel: doubao-seedance-2-0-fast-260128
```

Models are referenced as `providerId::modelId`. Credentials resolve through the
host's credential service first and the environment second
(`<PROVIDER>_API_KEY`); a loopback gateway may run without one.

The teaching route's narration uses a credential that is not a provider key, and
each speech provider has its own: `DEEPSEEK_API_KEY` for DeepSeek and
`ARK_VOICE_API_KEY` for volcengine. Both are ordinary credential references —
store the key on the settings page (the collapsible "Teaching videos" section has
one row per provider, and the header says whether each is set) or export it under
that name. `ARK_API_KEY` cannot drive speech, and the endpoint rejects it with a
401 that reads like an unactivated model.

Two speech providers are supported, and the manuscript picks one with
`meta.voice.provider`:

- `deepseek` (default): the official DeepSeek speech endpoint, and the voice a
  blind listening test preferred on the same script: sentences held together as
  one speaker, and the un-padded joins still sounded natural. Two voices
  (`stella`, `tide`), no speed control, **no word timestamps** — the picture is
  therefore driven by page: one slide page per sentence, with beats inside it
  placed by `at_progress` (a 0–1 share of the sentence's measured length). Those
  beats ride on meaning, not on syllables. A manuscript can also give several
  consecutive sentences one page with `page` and `enter`, so the layout holds
  still while the picture evolves on it. Credential reference
  `DEEPSEEK_API_KEY`.
- `volcengine`: the only provider that returns word-level timestamps, so the
  only one that can fire a fragment on the word that is being spoken
  (`at_word`). Credential reference `ARK_VOICE_API_KEY`. Reach for it when a
  line needs "say this word, change that picture".

The settings card's teaching section also holds the three machine paths
(`teachPythonPath`, `teachTexBinPath`, `teachChromiumPath`); a setting wins over
its environment variable, which wins over discovery.

## In a conversation

- "Make a 5-second shot of a lighthouse at dusk" → `video_generate`; the card in
  the chat follows the task live and plays the result when it is ready.
- "Make the cat in `materials/cat.png` turn to the camera" → first-frame (i2v)
  generation from a workspace image. A file dragged into the chat works too: the
  model passes the path it sees, and the plugin recognises the image by its
  bytes.
- "Continue that shot" → `from` takes the last frame of an earlier take (ARK) as
  the next take's first frame, in the same shot folder.
- "Alice walks in" → `characters: ['alice']` adds Alice's registered description
  and reference images, so she looks the same in every shot.
- "Did it finish?" after a timeout or a restart → `video_status`. A task the
  plugin had to take over after a restart also announces itself to the
  conversation once it is done.
- `/video-prompting a courier who cannot find the door at night, tense and
  quick` → rewrites the brief into what the target model wants (three sections
  and a `[Shot N]` timeline for MiniMax H3) and returns the prompt only.

## Tools

| Tool | Purpose |
|---|---|
| `video_generate` | Submit one generation (t2v / i2v / flf2v / s2v) and return at once with a task id and a background job id. `shot` names the folder under `renders/`; `from` continues an earlier take; `characters` applies characters registered in `video-project.yaml`. Refusals (read-only conversation, remote workspace, bad manifest, duplicate request) happen before anything is paid for |
| `video_status` | The recovery entry point: recent tasks, progress, where each video is, failures, content-review refusals, provider-reported usage. Without a task id it also reports the setup: providers, whether their keys are set, models and modes, and this workspace's manifest, permission mode and characters. Check here after a timeout; never re-submit |
| `video_cancel` | Ask the provider to stop (distinct from `job_kill`, which only stops watching while the provider keeps working and billing) |
| `video_teach_plan` | Validate a teaching manuscript (`storyboard.yaml`), estimate its spoken length, and report which local tools are missing. Free and offline |
| `video_teach_narrate` | Synthesize the narration (DeepSeek speech by default, `DEEPSEEK_API_KEY`; volcengine optionally, the only provider with word timings) and write `timings.json`; `sentences` re-synthesizes only those lines |
| `video_teach_render` | Render one segment per sentence from reveal.js slides and/or Manim scenes, then assemble `renders/<shot>/vNNN.mp4` with the narration burned into the picture; `sentences` re-records only those lines and leaves the other segments untouched |
| `video_teach_export` | Write the SRT and `timeline.json` next to the film, copy the decks under `deck/`, and screenshot `meta.cover` at 16:9 and 4:3. The SRT is cut on word timings; the default voice has none, so it gets one cue per sentence. It is the same cue text that was burned into the picture |

### Teaching videos

A teaching video is narrated by TTS and drawn on this machine, so it needs no
provider key and costs nothing to render. The narration is the clock: each
sentence's audio sets that sentence's length. The default voice reports no word
timings, so the picture advances one page per sentence (or one page shared by
several, when the manuscript says `page`) and the beats inside a page are placed
by proportion (see the two voice providers above); only `volcengine` can fire a
beat on a given word.

| Use it for | Do not use it for |
|---|---|
| formula derivations, coordinate systems, numbers accumulating step by step | live-action feel, camera work, character performance |
| slide-style explanation where points appear one at a time | complex scene blocking and lighting changes |
| a re-recordable script where changing one line re-renders one line | anything that has to look photographed |

Sentences join with a hard cut by default. A manuscript that declares `meta.transition`
(`mode: deck` plus a duration of 100–1200 ms) records the deck's own page switch — including
reveal's Auto-Animate morphs across pages — at the **end of the earlier sentence**, so the first
frame of every sentence is still the complete picture and the closing hold is still whole. The
manuscript owns the duration, the deck owns the shape. Only two adjacent sentences inside one deck,
on two different pages, get one: a shared page, a segment boundary, an act boundary and cue mode
(`volcengine`) are all hard cuts. No narration plays during a transition, so a segment is
`duration + transition` long, and the film length, the SRT offsets and the per-act check all use that
one account. Changing a page's layout means re-recording the sentence before it, and the render
result says so.

The bundled deck template carries an in-page motion library: brighten-what-is-said
(`dim`), stroke-draw (`draw`), rolling numbers (`count`) and growing bars (`bar`),
on top of reveal's own fade-up and zoom-in; one element can also morph through
several shapes inside a page (mark the wrapper `data-teach-stage` and keep the
shapes in CSS). Pacing is one variable, `--teach-dur`, 480 ms by default, and a
page that wants another pace overrides it on that page instead of re-declaring
the fragment `transition`. Whether a motion is safe to use is a question of its
relation to the clock: what a beat triggers is deterministic, a loop that ignores
the clock is not. Recipes and the ban list are in the `video-teach-slides` skill.

`video_teach_plan` checks more than the file format: every slide sentence has to
bring at least one picture change, the average gap between changes must stay
under 8 s, a sentence should run 2 to 8 s, cue numbers must fit the deck's real
fragment count, and two sentences must not share one Manim scene (the animation
would repeat). Findings name the sentence. A cue beyond the deck's fragments is
refused outright, and so is a deck missing the `teachReady` / `teachCue` /
`teachPage` contract; that one is caught before any narration is paid for.

Artifacts: the film lands at `renders/<shot>/vNNN.mp4` with `vNNN.json` beside
it, and appears in the video panel. The narration is burned into the picture, so
the film can be posted as it is; burning needs an ffmpeg built with libass, and a
build without it assembles the film unsubtitled and says so rather than failing.
`video_teach_export` adds the rest: an `.srt` next to the film (the same cues,
as a sidecar), a `vNNN.timeline.json`, the interactive decks under `deck/`, and
`vNNN.cover-16x9.png` + `vNNN.cover-4x3.png` rendered from the cover page the
manuscript names in `meta.cover`. The manuscript (`storyboard.yaml`),
`slides/<segment>/`, `scenes/*.py`, `timings.json` and `audio/` belong to the
project and are worth committing; `.dsh-video/`, `deck/` and `renders/` are
regenerable. The `video-teach-*` skills cover the manuscript format, the
per-engine rules, and how to re-record one line.

## Cost, and what leaves your machine

`video_status` answers money questions: `cost: true` sums settled usage times a
price table (grouped by provider/model/shot, with the price-table date and any
task whose usage is still unknown), and `estimate` prices a request before it is
submitted. Every figure is labelled an estimate; **the provider's bill is
authoritative**, and vendors have changed prices without notice before.

Prices come from a public feed ([LiteLLM's price database](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json),
converted at 7.0 CNY/USD and split per resolution tier) instead of being typed
into this source, where they were wrong the day they were written. The feed is
fetched in the background (never on a tool call), validated whole, cached under
`$DSH_HOME/dsh-video-forge/price-cache.json`, and composed as *your own rows >
fresh fetch > cache > built-in snapshot*. Every amount carries `price_source`
(`remote` / `cache` / `bundled` / `none`, its age and the last failure), and a
model no table prices is reported as "not priced" rather than as 0. Point
`priceSourceUrl` at a mirror (jsDelivr, npmmirror) when raw GitHub is
unreachable; empty disables the feed.

What leaves your machine: the prompt, the reference images you name, the
character descriptions from `video-project.yaml`, and (for `from`) the last frame
of the previous take, all uploaded to the provider you configured, under
your key, and subject to that vendor's terms. Nothing is sent to the plugin
author; the plugin carries no telemetry. A provider's content review can refuse
a task outright: the refusal is recorded, the identical request is not retried,
and a changed one is let through.

## Bundled skills

Five skills ship with the plugin (loaded by the model with the `skill` tool, or
four of them as `/name` commands). They guide the workflow; the tools stay
self-contained and never depend on a skill having been loaded.

| Skill | What it covers |
|---|---|
| `video-project` (`/video-project`) | Workspace layout and `video-project.yaml`: paths, defaults, style, characters, version numbering |
| `video-prompting` (`/video-prompting`) | Writing and revising prompts: generic structure, duration and aspect ratio, provider differences; MiniMax H3 gets its official format (three sections, `[Shot N]` timeline, image-mode instruction line) |
| `video-storyboard` (`/video-storyboard`) | Breaking a script into `storyboard/shots.yaml` and generating it one shot at a time |
| `video-iterate` | Redo vs continue (`from`), character consistency, and a last-frame self-check before delivery |
| `video-guide` (`/video-guide`) | End-to-end usage: setup, what it can and cannot do, cost, where videos land |

## The workspace as a project

```
<workspace>/
  video-project.yaml        # optional: defaults, style, characters, folder mapping
  materials/                # reference images (any layout; paths are workspace-relative)
  renders/<shot>/v001.mp4   # each take, never overwritten
  renders/<shot>/v001.json  # what produced it: prompt, model, materials, usage
  renders/<shot>/v001.last.jpg  # its last frame (ARK), for `from`
```

The first video in a workspace also writes a commented `video-project.yaml` and
a `renders/.gitignore` containing `*` (delete it to commit renders, e.g. with
LFS). A manifest might look like:

```yaml
version: 1
defaults: { provider: ark, model: doubao-seedance-2-0-fast-260128, resolution: 720p, aspect_ratio: "16:9" }
style: warm film grain, soft daylight
characters:
  alice: { refs: [materials/alice/*.png], description: "red scarf, short black hair" }
paths: { renders: renders }
```

A manifest that does not parse, or a misspelled key inside a section, is refused
before anything is submitted. The plugin writes only `renders/` (and the two
first-output files); it respects the conversation's permission mode: a
read-only conversation is refused, and under workspace-write a `renders/` that is
really a link out of the workspace is refused. If the workspace cannot take a
finished, paid video after all, it stays in `$DSH_HOME` and `video_status` says
why.

## Protocols

| Protocol | Covers |
|---|---|
| `ark-seedance` | 火山方舟 Seedance (`POST/GET/DELETE {base}/contents/generations/tasks`), with the free last frame (`return_last_frame`) |
| `minimax-video` | MiniMax video generation V2 (`POST /v2/video_generation`, `GET /v2/query/video_generation/{id}`); no cancel, no last frame |
| `generic-openai-videos` | OpenAI-Videos-shaped gateways (`/v1/videos`), every path and status word configurable |

## Surfaces

| Where | What |
|---|---|
| Composer tool row | **Video model** chip: the model this conversation generates with, plus length / resolution / aspect ratio. It outranks the defaults in `video-project.yaml`, and those outrank the plugin settings' default provider and model; an argument you (or the model) pass still wins. "Auto" hands the decision back. Session-scoped: a new conversation starts at Auto. A model this build knows keeps its documented options even when the stored row predates the capability lists; the chip says when it filled them in |
| Chat | One card per `video_generate` call that follows its task live: status and progress, a real `<video>` player once it finishes, where the file is (or that it was moved or deleted), a cancel button while the provider may still stop it, and two ways out: **Open in file viewer** on that video, **All videos** in the panel |
| Right sidebar → **Videos** | Every video **in this workspace**, newest shot first: a row per take with its status, size and duration, the newest one open and playable. Work in flight and failures sit at the bottom; a clip found in `renders/` that the ledger does not know is listed as "file only". A video the plugin delivered outside the workspace is not listed at all: the panel is this project's videos, and the chat card still says where that one went. Read-only; it never submits or deletes anything |
| Right sidebar → file viewer | Opening an `.mp4` (from the panel, the files tree, or a path in the conversation) plays it in the same tab as text and images, with the harness's own toolbar above it (reload, open in your video player) |
| Guide page (the "+" in the right sidebar) | Picks the Videos panel |
| Bottom-right badge | How many tasks are in flight (hidden when none are) |
| Sidebar → Plugins → Video Forge | Providers and models as a form; the API key is stored through the harness credential service and only a masked tail is ever shown |

There is no separate workbench page, and the Videos panel is not one: nothing in
the browser can submit a paid generation or write a file. The browser side talks
to `/video-forge/api/{overview,cancel}`, which is loopback-only unless the
browser is a paired device; the harness does not gate plugin routes, so this
plugin does.

## Where things live

- Videos: the workspace's `renders/` (see above). A call made outside any
  workspace conversation keeps its video in `$DSH_HOME/dsh-video-forge/outputs/`.
- Ledger: `$DSH_HOME/dsh-video-forge/tasks.json`. Nothing is ever deleted
  automatically; `retain` only reports pressure on the plugin's own folder.
- Media: `GET|HEAD /video-forge/media/<taskId>/<token>/<name>`. The path comes
  from the ledger, never from the request; a 128-bit token authorizes it, and a
  workspace video is served only while it is still the file that was written.
- Streaming: `GET|HEAD /api/video-forge/stream?path=…[&sessionId=…]` serves an mp4
  with HTTP ranges, so a long clip seeks without being read whole. It hangs off
  the harness's own authenticated `/api` channel (owner-only, same origin) and
  reads a file the same user could already open through `/api/file`; adding
  ranges grants no new reach. The plugin's own trust-gated route above cannot do
  this: it only knows files the ledger recorded.

## Upgrading and removing

```bash
dsh plugin --profile web add dsh-video-forge@latest   # upgrade to the newest release
dsh plugin --profile web remove dsh-video-forge       # uninstall
```

Restart the profile after either. Removing the plugin does **not** delete
`$DSH_HOME/dsh-video-forge/` (ledger, outputs, price cache) or a workspace's
`renders/`. Those are your data; delete them yourself when you want them gone.

## Development

```bash
pnpm install
pnpm check     # tsc --noEmit, tsdown build, vitest
```

`fixtures/provider.ts` is an offline double of the ARK, MiniMax and
OpenAI-compatible protocols over a real socket, so the whole submit → poll →
download → deliver path runs with no key and no network.
`fixtures/litellm-video-sample.json` is a frozen slice of the upstream price
feed, so the bundled snapshot is asserted equal to the normalization of a frozen
sample and the two cannot drift.

Live checks against the real vendors are separate and never part of
`pnpm check`. `free` makes only requests that cannot create a billable task;
`paid` also runs one cheapest generation per provider:

```bash
VIDEO_FORGE_LIVE=free ARK_API_KEY=… MINIMAX_API_KEY=… pnpm test:live
```

Design notes (Chinese, one section per milestone, mistakes included) live in
[docs/DESIGN.md](docs/DESIGN.md); the release procedure is in
[docs/RELEASING.md](docs/RELEASING.md).

## License

MIT. See [LICENSE](LICENSE).

The bundled price snapshot is derived from [LiteLLM's price database](https://github.com/BerriAI/litellm)
(MIT). Vendor names and model ids are used descriptively; this project is not
affiliated with any of those vendors.
