# dsh-video-forge

Online-model video generation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
used entirely from a workspace conversation: ask for a shot, and the finished
video lands in the workspace as `renders/<shot>/vNNN.mp4`. Every generation is
tracked in a durable ledger, so a timeout or a restart never means paying twice.

> **Status: M4 complete (2026-10-16).** Three model tools, two vendor protocols
> plus an OpenAI-compatible one, the workspace as a video project, live chat
> cards, restart recovery with a notice to the conversation, five bundled
> `video-*` skills, and cost visibility (a price-table estimate and a "how much
> did this cost" summary in `video_status`). Verified against an offline
> provider double and a live isolated DSH instance; real generations with ARK
> Seedance and MiniMax were run in M2.5. Next: the public release (M5). See
> `DESIGN.md` §14, §17 and §18. There is no local inference path by design —
> this plugin is a client of online models only.

## In a conversation

- "Make a 5-second shot of a lighthouse at dusk" → `video_generate`; the card in
  the chat follows the task live and plays the result when it is ready.
- "Make the cat in `materials/cat.png` turn to the camera" → first-frame (i2v)
  generation from a workspace image. A file dragged into the chat works too:
  the model passes the path it sees, and the plugin recognises the image by its
  bytes.
- "Continue that shot" → `from` takes the last frame of an earlier take (ARK)
  as the next take's first frame, in the same shot folder.
- "Alice walks in" → `characters: ['alice']` adds Alice's registered
  description and reference images, so she looks the same in every shot.
- "Did it finish?" after a timeout or a restart → `video_status`. A task the
  plugin had to take over after a restart also announces itself to the
  conversation once it is done.

## Tools

| Tool | Purpose |
|---|---|
| `video_generate` | Submit one generation (t2v / i2v / flf2v / s2v) and return at once with a task id and a background job id. `shot` names the folder under `renders/`; `from` continues an earlier take; `characters` applies characters registered in `video-project.yaml`. Refusals (read-only conversation, remote workspace, bad manifest, duplicate request) happen before anything is paid for |
| `video_status` | The recovery entry point: recent tasks, progress, where each video is, failures, content-review refusals, provider-reported usage. Without a task id it also reports the setup — providers, whether their keys are set, models and modes, and this workspace's manifest, permission mode and characters. Check here after a timeout — never re-submit |
| `video_cancel` | Ask the provider to stop (distinct from `job_kill`, which only stops watching while the provider keeps working and billing) |

`video_status` also answers money questions: `cost: true` sums settled usage
times an editable price table (grouped by provider/model/shot, with the
price-table date and any task whose usage is still unknown), and an `estimate`
parameter prices a request before it is submitted. Every figure is labelled an
estimate — the provider bill is authoritative.

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
first-output files); it respects the conversation's permission mode — a
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

Models are referenced as `providerId::modelId`. Credentials resolve through the
host's credential service first and the environment second
(`<PROVIDER>_API_KEY`); a loopback gateway may run without one.

## Install

```bash
dsh plugin --profile web add dsh-video-forge
```

Then configure at least one provider. The usual way is the plugin's page in the
GUI (**Sidebar → Plugins → Video Forge**), which offers the providers this build
supports — Volcengine ARK (Seedance), MiniMax (H3), OpenAI (Sora), or a custom
OpenAI-Videos-compatible gateway — as a pick list, fills in the base URL,
credential reference and the vendor's documented models, and lets you add
several. The same config can be written by hand:

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

## Surfaces

| Where | What |
|---|---|
| Chat | One card per `video_generate` call that follows its task live: status and progress, a real `<video>` player once it finishes, where the file is (or that it was moved or deleted), and a cancel button while the provider may still stop it |
| Bottom-right badge | How many tasks are in flight (hidden when none are) |
| Sidebar → Plugins → Video Forge | Providers and models as a form; the API key is stored through the harness credential service and only a masked tail is ever shown |

There is no separate workbench page: nothing in the browser can submit a paid
generation. The browser side talks to `/video-forge/api/{overview,cancel}`,
which is loopback-only unless the browser is a paired device — the harness does
not gate plugin routes, so this plugin does.

## Where things live

- Videos: the workspace's `renders/` (see above). A call made outside any
  workspace conversation keeps its video in `$DSH_HOME/dsh-video-forge/outputs/`.
- Ledger: `$DSH_HOME/dsh-video-forge/tasks.json`. Nothing is ever deleted
  automatically — `retain` only reports pressure on the plugin's own folder.
- Media: `GET|HEAD /video-forge/media/<taskId>/<token>/<name>`. The path comes
  from the ledger, never from the request; a 128-bit token authorizes it, and a
  workspace video is served only while it is still the file that was written.

## Development

```bash
pnpm install
pnpm check     # tsc --noEmit, tsdown build, vitest
```

`fixtures/provider.ts` is an offline double of the ARK, MiniMax and
OpenAI-compatible protocols over a real socket, so the whole submit → poll →
download → deliver path runs with no key and no network.

Live checks against the real vendors are separate and never part of
`pnpm check`. `free` makes only requests that cannot create a billable task;
`paid` also runs one cheapest generation per provider:

```bash
VIDEO_FORGE_LIVE=free ARK_API_KEY=… MINIMAX_API_KEY=… pnpm test:live
```

## License

MIT
