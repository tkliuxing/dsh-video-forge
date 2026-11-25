#!/usr/bin/env python3
"""多幕并行派发的脚手架：prepare / drift / collect。

规则与理由见 `docs/TEACH-PARALLEL-ACTS.md`。三个子命令对应 TODO 的 C13 / C15 / C14：

    python3 runs.py prepare --act a05        # 派发前：建 runs/a05/，记基线
    python3 runs.py drift   --act a05        # 渲染前：deck 副本与主项目是否一致
    python3 runs.py collect --act a05        # 回收：音频 / 逐句段 / timings 拷回主项目并校验

## 为什么是 python 而不是 node

`prepare` 要读写 `storyboard.yaml`，而随包分发的 node 脚本拿不到插件的
`node_modules`（`yaml` 是插件的运行时依赖，不在用户工作区的解析链上）。项目侧
已经依赖 PyYAML（`spread-page-beats.py` 同样），所以这里沿用 python。缺 PyYAML
时 `prepare` 明确报错，不静默降级。

## 三个子命令的共同前提

目录契约（`docs/TEACH-PARALLEL-ACTS.md` §3）：

    <workspace>/storyboard.yaml           主线，并行期间只读
    <workspace>/runs/<act>/              本幕独占：稿本、deck 副本、audio、timings
    <workspace>/renders/<shot>/          成片（工具按 workspace root 落盘）

`drift` 与 `collect` 都只读本幕的东西，不碰其他幕。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - depends on the machine
    yaml = None

# Mirrors of the plugin's defaults (`src/teach/pipeline.ts` DEFAULT_TEACH_PATHS).
AUDIO_DIR = 'audio'
TIMINGS = 'timings.json'
WORK_DIR = '.dsh-video/teach'          # segmentPath(): <work>/<sentence>/segment.mp4
SEGMENTS_SUBDIR = 'segment.mp4'
SHARED_DIRS = ('materials', 'script')
SHARED_FILES = ('video-project.yaml',)
BASELINE = '.baseline.json'
DEFAULT_PY_VERSION = '3.11.12'
# A segment may differ from its narration by a frame or two; anything larger means
# the picture was rendered before the line was re-recorded.
FRAME_TOLERANCE_SECONDS = 2 / 30


def die(message: str, code: int = 2) -> 'NoReturn':  # noqa: F821 - string annotation keeps 3.9 quiet
    print(f'error: {message}', file=sys.stderr)
    raise SystemExit(code)


def warn(message: str) -> None:
    print(f'  ! {message}')


def ok(message: str) -> None:
    print(f'  ok {message}')


def sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def need_yaml() -> None:
    if yaml is None:
        die(
            'PyYAML is missing, so the manuscript cannot be read or written here. '
            'Install it (pip install pyyaml, or run with the interpreter named by '
            '.python-version) and try again.',
            3,
        )


def read_board(path: Path) -> dict:
    need_yaml()
    if not path.exists():
        die(f'no manuscript at {path}')
    loaded = yaml.safe_load(path.read_text(encoding='utf-8'))
    if not isinstance(loaded, dict):
        die(f'{path} is not a mapping; expected meta/segments')
    return loaded


def find_segment(board: dict, act: str) -> dict:
    segments = board.get('segments')
    if not isinstance(segments, list):
        die('the manuscript has no segments list')
    for segment in segments:
        if isinstance(segment, dict) and segment.get('id') == act:
            return segment
    known = ', '.join(str(s.get('id')) for s in segments if isinstance(s, dict)) or '(none)'
    die(f'no segment "{act}" in the manuscript; it has: {known}')


def copy_tree(source: Path, target: Path) -> int:
    """Copy a directory over another, returning how many files landed."""
    if not source.is_dir():
        return 0
    count = 0
    for item in source.rglob('*'):
        if not item.is_file():
            continue
        destination = target / item.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, destination)
        count += 1
    return count


def deck_directory(segment: dict) -> str | None:
    deck = segment.get('deck')
    if not isinstance(deck, str) or not deck:
        return None
    return str(Path(deck).parent)


def scene_directory(segment: dict) -> str | None:
    scene = segment.get('scene')
    if not isinstance(scene, str) or not scene:
        return None
    return str(Path(scene).parent)


# --------------------------------------------------------------------------- prepare


def cmd_prepare(args: argparse.Namespace) -> int:
    project = args.project.resolve()
    board_path = project / 'storyboard.yaml'
    board = read_board(board_path)
    segment = find_segment(board, args.act)

    run = project / 'runs' / args.act
    run.mkdir(parents=True, exist_ok=True)

    # 1. The manuscript: meta plus this act only. The title gains the act id so a
    #    render's sidecar JSON says which act it came from.
    meta = dict(board.get('meta') or {})
    title = meta.get('title')
    if isinstance(title, str) and not title.endswith(f'· {args.act}'):
        meta['title'] = f'{title} · {args.act}'
    derived = {'meta': meta, 'segments': [segment]}
    header = (
        f'# {args.act} 单幕稿本（主项目 storyboard.yaml 的派生；只含这一幕，产物落在本目录）\n'
        f'# 由 assets/teach/runs.py prepare 生成，改台词请改主项目那份再重跑。\n'
    )
    need_yaml()
    (run / 'storyboard.yaml').write_text(
        header + yaml.safe_dump(derived, allow_unicode=True, sort_keys=False, width=100000),
        encoding='utf-8',
    )
    ok(f'storyboard.yaml（{len(segment.get("sentences") or [])} 句）')

    # 2. The deck copy. The recorder reads this one, not the project's.
    copied = 0
    for source_rel in (deck_directory(segment), scene_directory(segment)):
        if source_rel is None:
            continue
        copied += copy_tree(project / source_rel, run / source_rel)
    if copied == 0:
        warn('稿件里没有 deck/scene，或对应目录不存在；渲染前确认 deck 副本在位')
    else:
        ok(f'deck/scene 副本（{copied} 个文件）')

    # 3. Whatever the deck or the scripts need beside the manuscript.
    for name in SHARED_DIRS:
        count = copy_tree(project / name, run / name)
        if count:
            ok(f'{name}/（{count} 个文件）')
    for name in SHARED_FILES:
        source = project / name
        if source.exists():
            shutil.copy2(source, run / name)
            ok(name)

    # 4. Pin the interpreter: a system 3.9 has no PyYAML and throws on import.
    version_file = run / '.python-version'
    if not version_file.exists():
        version_file.write_text(f'{args.python_version}\n', encoding='utf-8')
        ok(f'.python-version = {args.python_version}')
    else:
        ok(f'.python-version 已存在（{version_file.read_text().strip()}）')

    # 5. Baseline of the shared state, so "the main project was untouched" is a
    #    measured fact rather than a claim in a report.
    baseline = {
        'act': args.act,
        'storyboard': {'sha256': sha256(board_path), 'mtime': board_path.stat().st_mtime if board_path.exists() else None},
        'timings': {'sha256': sha256(project / TIMINGS), 'mtime': (project / TIMINGS).stat().st_mtime if (project / TIMINGS).exists() else None},
        'createdAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    }
    (run / BASELINE).write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    ok(f'{BASELINE}（主稿本 sha256 {str(baseline["storyboard"]["sha256"])[:12]}…）')

    print(f'\nruns/{args.act} 就绪。下一步：')
    print(f'  video_teach_plan storyboard=runs/{args.act}/storyboard.yaml')
    print(f'  然后 plan → narrate → apply-page-hold → spread-page-beats --only {args.act} --write')
    print(f'       → render shot={args.act} → assemble-act {args.act}')
    return 0


# ------------------------------------------------------------------------------ drift


def cmd_drift(args: argparse.Namespace) -> int:
    project = args.project.resolve()
    run = project / 'runs' / args.act
    if not run.is_dir():
        die(f'{run} does not exist; run prepare --act {args.act} first')

    board = read_board(run / 'storyboard.yaml')
    segment = find_segment(board, args.act)

    drifted: list[str] = []
    checked = 0
    for source_rel in (deck_directory(segment), scene_directory(segment)):
        if source_rel is None:
            continue
        live_root = project / source_rel
        copy_root = run / source_rel
        if not live_root.is_dir():
            warn(f'{source_rel}/ 在主项目里不存在')
            continue
        for item in sorted(live_root.rglob('*')):
            if not item.is_file():
                continue
            relative = item.relative_to(live_root)
            mirror = copy_root / relative
            checked += 1
            live_hash, copy_hash = sha256(item), sha256(mirror)
            if copy_hash is None:
                drifted.append(f'{relative}：副本缺失')
            elif live_hash != copy_hash:
                drifted.append(f'{relative}：主项目与副本不一致')

    if checked == 0:
        warn('没有可比对的 deck/scene 文件')
    if drifted:
        print(f'runs/{args.act} 与主项目不一致（渲染读的是副本，先同步再渲染）：', file=sys.stderr)
        for line in drifted:
            print(f'  ✗ {line}', file=sys.stderr)
        print(f'\n修法：重新跑 prepare --act {args.act}（会覆盖副本，不动主项目）', file=sys.stderr)
        return 1
    ok(f'{checked} 个文件与主项目一致')
    return 0


# ---------------------------------------------------------------------------- collect


def probe_duration(path: Path) -> float | None:
    try:
        finished = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
            capture_output=True, text=True, check=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    text = finished.stdout.strip().splitlines()
    if not text:
        return None
    try:
        return float(text[0])
    except ValueError:
        return None


def cmd_collect(args: argparse.Namespace) -> int:
    project = args.project.resolve()
    run = project / 'runs' / args.act
    if not run.is_dir():
        die(f'{run} does not exist; nothing to collect')

    timings_path = run / TIMINGS
    if not timings_path.exists():
        die(f'{timings_path} does not exist; run narrate before collecting')
    try:
        timings = json.loads(timings_path.read_text(encoding='utf-8'))
        sentences = timings.get('sentences') or []
    except (json.JSONDecodeError, AttributeError):
        die(f'{timings_path} is not valid timings JSON')
    if not sentences:
        die(f'{timings_path} carries no sentences')

    prefix = f'{args.act}-'
    ids = [s.get('id') for s in sentences if isinstance(s, dict) and isinstance(s.get('id'), str)]
    foreign = [sid for sid in ids if not sid.startswith(prefix)]
    if foreign:
        die(f'{timings_path} carries sentences outside this act: {", ".join(foreign[:5])}')

    missing: list[str] = []
    mismatched: list[str] = []
    planned: list[tuple[Path, Path]] = []

    for sentence in sentences:
        sid = sentence['id']
        duration_ms = sentence.get('durationMs')
        audio = run / AUDIO_DIR / f'{sid}.wav'
        picture = run / WORK_DIR / sid / SEGMENTS_SUBDIR
        if not audio.exists():
            missing.append(f'{sid}：缺 audio/{sid}.wav')
        if not picture.exists():
            missing.append(f'{sid}：缺 {WORK_DIR}/{sid}/{SEGMENTS_SUBDIR}')
        if audio.exists():
            planned.append((audio, project / AUDIO_DIR / audio.name))
        if picture.exists():
            planned.append((picture, project / WORK_DIR / sid / SEGMENTS_SUBDIR))

        if isinstance(duration_ms, (int, float)) and audio.exists() and picture.exists():
            audio_seconds = probe_duration(audio)
            picture_seconds = probe_duration(picture)
            expected = float(duration_ms) / 1000
            for label, measured in (('音频', audio_seconds), ('画面段', picture_seconds)):
                if measured is None:
                    continue
                if abs(measured - expected) > FRAME_TOLERANCE_SECONDS:
                    mismatched.append(
                        f'{sid}：{label} {measured:.3f}s 与 timings 的 {expected:.3f}s 差 '
                        f'{abs(measured - expected) * 1000:.0f}ms（重录了但没重渲？）'
                    )

    # Refuse before writing: a half-collected act is worse than none, because the
    # main project then holds a mix of old and new files and nothing says which.
    problems = missing + [line for line in mismatched]
    if problems and not args.force:
        print('回收前校验没通过，主项目未被改动：', file=sys.stderr)
        for line in missing:
            print(f'  ✗ {line}', file=sys.stderr)
        for line in mismatched:
            print(f'  ✗ {line}', file=sys.stderr)
        print(f'\n确认要照现状收集，加 --force（不会修好任何一个问题，只是先拷过去）', file=sys.stderr)
        return 1

    if missing and args.force:
        for line in missing:
            warn(f'{line}（--force：这一项不会拷过去）')

    overwritten = [f'{target} 将被覆盖' for _source, target in planned if target.exists()]
    if args.dry_run:
        print(f'（dry-run）将回收 {len(planned)} 个文件，另拷 timings 与稿本：')
        for source, target in planned:
            print(f'  {source.relative_to(project)} → {target.relative_to(project)}')
        if overwritten:
            print(f'\n其中 {len(overwritten)} 个已存在，会被覆盖')
        return 0

    for source, target in planned:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    audio_count = sum(1 for source, _ in planned if source.parent == run / AUDIO_DIR)
    picture_count = len(planned) - audio_count
    ok(f'回收 {len(planned)} 个文件（音频 {audio_count}、画面段 {picture_count}）')
    if overwritten:
        warn(f'覆盖了 {len(overwritten)} 个已存在的文件')

    for source, target in ((timings_path, project / f'timings-{args.act}.json'), (run / 'storyboard.yaml', project / f'storyboard-{args.act}.yaml')):
        shutil.copy2(source, target)
        ok(f'{target.name}')

    if mismatched:
        print('\n段长校验有偏差（--force 已按现状拷过去，拼片前必须处理）：', file=sys.stderr)
        for line in mismatched:
            print(f'  ✗ {line}', file=sys.stderr)
        return 1
    ok(f'段长校验通过（{len(sentences)} 句，容差 {FRAME_TOLERANCE_SECONDS * 1000:.0f}ms）')

    print(f'\n下一步（合并由主线做，见 docs/TEACH-PARALLEL-ACTS.md §6）：')
    print(f'  把 timings-{args.act}.json 按幕序拼进主项目 timings.json，')
    print(f'  storyboard-{args.act}.yaml 的 cues 补进主项目 storyboard.yaml，再 assemble-act --all --join')
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description='多幕并行派发的脚手架（prepare / drift / collect）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument('--project', type=Path, default=Path.cwd(), help='主项目根（默认当前目录）')
    sub = parser.add_subparsers(dest='command', required=True)

    prepare = sub.add_parser('prepare', help='派发前：建 runs/<act>/ 并记基线')
    prepare.add_argument('--act', required=True)
    prepare.add_argument('--python-version', default=DEFAULT_PY_VERSION)
    prepare.set_defaults(func=cmd_prepare)

    drift = sub.add_parser('drift', help='deck/scene 副本与主项目是否一致')
    drift.add_argument('--act', required=True)
    drift.set_defaults(func=cmd_drift)

    collect = sub.add_parser('collect', help='回收音频/逐句段/timings，并校验段长')
    collect.add_argument('--act', required=True)
    collect.add_argument('--dry-run', action='store_true')
    collect.add_argument('--force', action='store_true', help='校验没通过也照现状拷贝')
    collect.set_defaults(func=cmd_collect)

    args = parser.parse_args()
    return args.func(args)


if __name__ == '__main__':
    raise SystemExit(main())
