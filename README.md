# dsh-video-forge

Online-model video generation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
four model-facing tools plus inline playback, with every generation tracked in a
durable ledger so a timeout or a restart never means paying twice.

> **Status: M2.1.** Tools, ledger, two online protocols, artifact storage, the
> Range-capable media route, the chat playback cards, the workbench page and the
> configuration card are implemented and verified against an offline provider
> double plus a live isolated DSH instance (the configuration card was driven in
> a real browser there). There is no local inference path by design — this plugin
> is a client of online models only.

## What it does

| Tool | Purpose |
|---|---|
| `video_generate` | Submit a generation (t2v / i2v / flf2v / s2v) and return at once with a task id and a background job id |
| `video_status` | The recovery entry point: recent tasks, progress, artifacts, failures. Check here after a timeout — never re-submit |
| `video_cancel` | Ask the provider to stop (distinct from `job_kill`, which only stops watching) |
| `video_export` | Copy a finished artifact into the workspace so `present` can deliver it |

Finished artifacts are served over a token-gated route with real `Range` / `206`
support, so the chat card plays and seeks like any other video.

## Protocols

| Protocol | Covers |
|---|---|
| `ark-seedance` | 火山方舟 Seedance (`POST/GET/DELETE {base}/contents/generations/tasks`) |
| `generic-openai-videos` | OpenAI-Videos-shaped gateways (`/v1/videos`), every path and status word configurable |
| `minimax-video` | MiniMax video generation V2 (`POST /v2/video_generation`, `GET /v2/query/video_generation/{id}`); no cancel |

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
credential reference and the vendor's documented models, and lets you add several. The same
config can be written by hand:

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
          - id: doubao-seedance-1-0-pro-250528
            modes: [t2v, i2v, flf2v]
            durations: [5, 10]
            resolutions: ['720p', '1080p']
            aspectRatios: ['16:9', '9:16', '1:1']
    defaultProvider: ark
    defaultModel: doubao-seedance-1-0-pro-250528
```

## Surfaces

| Where | What |
|---|---|
| Chat | Result cards with a real `<video>` player, per tool call |
| Sidebar → Video workbench | Submit a generation, watch tasks, cancel, play, export |
| Bottom-right badge | How many tasks are in flight (hidden when none are) |
| Sidebar → Plugins → Video Forge | Providers and models as a form — the supported providers are a pick list, several can be added, and the protocol, default provider and default model are all choices rather than text; the API key is stored through the harness credential service and only a masked tail is ever shown |

The browser side talks to `/video-forge/api/…`, which is loopback-only unless the
browser is a paired device — the harness does not gate plugin routes, so this
plugin does.

## Where things live

- Ledger and artifacts: `$DSH_HOME/dsh-video-forge/` (`tasks.json`, `outputs/`).
  Artifacts are written `0600` inside a `0700` directory and are **never deleted
  automatically** — `retain` only reports pressure.
- Media: `GET|HEAD /video-forge/media/<taskId>/<token>/<name>`. The path comes
  from the ledger, never from the request; a 128-bit token authorizes it.

## Development

```bash
pnpm install
pnpm check     # tsc --noEmit, tsdown build, vitest
```

`fixtures/provider.ts` is an offline double of both protocols over a real socket,
so the whole submit → poll → download path runs with no key and no network.

## License

MIT
