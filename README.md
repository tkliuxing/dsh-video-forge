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
- No ffmpeg, no model weights, no GPU: the vendor renders, and this plugin moves
  the bytes.

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

## Tools

| Tool | Purpose |
|---|---|
| `video_generate` | Submit one generation (t2v / i2v / flf2v / s2v) and return at once with a task id and a background job id. `shot` names the folder under `renders/`; `from` continues an earlier take; `characters` applies characters registered in `video-project.yaml`. Refusals (read-only conversation, remote workspace, bad manifest, duplicate request) happen before anything is paid for |
| `video_status` | The recovery entry point: recent tasks, progress, where each video is, failures, content-review refusals, provider-reported usage. Without a task id it also reports the setup: providers, whether their keys are set, models and modes, and this workspace's manifest, permission mode and characters. Check here after a timeout; never re-submit |
| `video_cancel` | Ask the provider to stop (distinct from `job_kill`, which only stops watching while the provider keeps working and billing) |

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
three of them as `/name` commands). They guide the workflow; the tools stay
self-contained and never depend on a skill having been loaded.

| Skill | What it covers |
|---|---|
| `video-project` (`/video-project`) | Workspace layout and `video-project.yaml`: paths, defaults, style, characters, version numbering |
| `video-prompting` | Writing and revising prompts (subject, motion, camera, style), duration and aspect ratio, provider differences |
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
| Composer tool row | **Video model** chip: the model this conversation generates with, plus length / resolution / aspect ratio. It outranks `video-project.yaml` and the plugin settings; an argument you (or the model) pass still wins. "Auto" hands the decision back. Session-scoped: a new conversation starts at Auto |
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
