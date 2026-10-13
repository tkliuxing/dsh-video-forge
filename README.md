# dsh-video-forge

Online-model video generation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
four model-facing tools plus inline playback, with every generation tracked in a
durable ledger so a timeout or a restart never means paying twice.

> **Status: M1.** Tools, ledger, two online protocols, artifact storage, the
> Range-capable media route and the chat playback card are implemented and
> verified against an offline provider double plus a live isolated DSH instance.
> The workbench overlay and the settings card are M2. There is no local
> inference path by design — this plugin is a client of online models only.

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

Models are referenced as `providerId::modelId`. Credentials resolve through the
host's credential service first and the environment second
(`<PROVIDER>_API_KEY`); a loopback gateway may run without one.

## Install

```bash
dsh plugin --profile web add dsh-video-forge
```

Then configure at least one provider (Settings → the `video-forge` row):

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
