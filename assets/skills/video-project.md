# Video Project — workspace layout and manifest

The `video-forge` plugin treats the current DSH workspace as a video project:
every generated video is saved into this workspace, so the files it writes are
as much "the project" as your scripts and notes.

## Default layout

```
<workspace>/
  video-project.yaml          # manifest: defaults, style, characters, path mapping
  script/                     # your script (optional, your own structure)
  storyboard/shots.yaml       # shot list (reference text — see the video-storyboard skill)
  materials/                  # character / scene reference images, audio
  renders/<shot>/v001.mp4     # generated videos, one folder per shot, numbered versions
  renders/<shot>/v001.json    # description beside each video (prompt, model, params, usage)
  .dsh-video/                 # the plugin's own cache — leave it alone
```

The plugin writes only `renders/` and `.dsh-video/`. It never moves or edits
your files; everything else is yours.

## The manifest (video-project.yaml)

The plugin reads `video-project.yaml` from the workspace root on every
generation. Recognized keys:

```yaml
version: 1
defaults:                 # used only for request fields the caller left out
  provider: ark           # provider id from the plugin settings
  model: seedance-2.0-mini
  resolution: 720p
  aspect_ratio: "16:9"
  duration_seconds: 5
style: "cinematic, warm color grade"    # appended to every prompt by the tool
characters:               # role registry, expanded by the `characters` parameter
  alice:
    refs: [materials/alice/*.png]       # * and ? globs in the file name only
    description: "short brown hair, red coat"
paths:                    # map the layout onto your own folders (all workspace-relative)
  script: script
  storyboard: storyboard
  materials: materials
  renders: renders
  cache: .dsh-video
```

Rules:
- `paths` values must be workspace-relative; absolute paths, `~`, and `..` are
  refused.
- Unknown **top-level** keys are ignored (room for future versions). Unknown
  keys *inside* `defaults`, `paths`, or a character are refused — treat them as
  typos (`render:` instead of `renders:`).
- A manifest that fails to parse is refused before anything is submitted (paid).
- `style` and `characters` are added to the prompt by the tool, not by you:
  keep the user's own prompt separate from the manifest style.

## Creating a project

There is no init command. Set a project up with your normal `write` tool:

1. Write `video-project.yaml`.
2. Create `materials/` and put reference images in it.
3. Optionally write `storyboard/shots.yaml`.

The first time a video lands in a workspace that has no manifest yet, the plugin
also writes a commented `video-project.yaml` and a `renders/.gitignore`
containing `*` (so generated videos are not committed by default). Delete that
`.gitignore` if you want to commit videos (for example with Git LFS). If the
user has already created either file, the plugin leaves it alone.

## Where a video lands

- Each generation goes to `renders/<shot>/vNNN.mp4`, numbered from `v001` up.
- The shot is the `shot` parameter of `video_generate`; it defaults to
  `untitled`. Allowed characters: letters, digits, `-`, `_`, `.` (no `..`).
- A version number is never reused — deleting `v003` does not make `v003` come
  back. Numbers are assigned by the host, so two conversations generating into
  the same shot do not clobber each other.
- A `vNNN.json` description sits beside each video. Read it with your normal
  read tool to recall how a video was made (prompt, model, params, whether it
  was continued with `from`, usage).

## Cross-cutting rules

- In a read-only conversation, or a remote (SSH) workspace, generation is
  refused before anything is paid. Do not promise a video in those cases.
- The plugin never concatenates clips. Combining several shots into one film is
  a known non-goal — do it outside the plugin.
- Call `video_status` with no arguments to see the current workspace's manifest
  state, registered characters, and whether a style is set.
