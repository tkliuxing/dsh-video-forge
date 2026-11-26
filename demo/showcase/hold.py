#!/usr/bin/env python3
"""页尾停留：给每句音频尾部补静默，并用 ffprobe 实测改写 timings.json。

为什么需要它：教学路线里画面长度**等于该句音频长度**（`timings.json` 的
`durationMs`），渲染器没有"尾停留"参数。DeepSeek 语音是自然停顿策略、不补
停顿，所以一句念完画面立刻切页，最后一屏几乎不停。做法是给音频补静默，
让 `durationMs` 自己变长（docs 与 skill `video-teach-iterate` 的「页尾停留」）。

三条硬约束（都是踩过的坑）：
1. `timings.json` 是严格白名单，不能塞 `tailHoldMs`；标记写旁车文件。
2. 判断"补过没有"用 timings.json 的 sha256，不用 mtime（精度差会重复补）。
3. 补过的音频再补会叠加。所以除了 sha 之外还有一道保险：逐句比对
   "音频实测长度 vs timings 里记的长度"，两者不等说明音频已被别的流程
   改过（或只重录了一部分），直接拒绝，不猜。

用法：
    python3 demo/showcase/hold.py demo/showcase/runs/deepseek
    python3 demo/showcase/hold.py demo/showcase/runs/deepseek --hold-ms 900
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

SIDECAR = '.page-hold.json'


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audio_ms(path: Path) -> int:
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return round(float(out) * 1000)


def probe(path: Path, entry: str) -> str:
    return subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', f'stream={entry}',
         '-of', 'csv=p=0', str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip().split(',')[0]


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    hold_ms = 900
    for a in sys.argv[1:]:
        if a.startswith('--hold-ms='):
            hold_ms = int(a.split('=', 1)[1])
    if len(args) != 1:
        print(__doc__)
        return 2

    run = Path(args[0]).resolve()
    timings_path = run / 'timings.json'
    if not timings_path.is_file():
        print(f'no timings.json in {run}; run video_teach_narrate first')
        return 1

    current = sha256(timings_path)
    sidecar = run / SIDECAR
    if sidecar.is_file():
        recorded = json.loads(sidecar.read_text())
        if recorded.get('timingsSha256') == current:
            print(f'{run.name}: already padded ({recorded["holdMs"]} ms), nothing to do')
            return 0

    timings = json.loads(timings_path.read_text())
    rate = str(timings.get('sampleRate') or 24000)
    plan = []
    for sentence in timings['sentences']:
        path = run / sentence['audio']
        if not path.is_file():
            print(f'missing audio {path}; re-run video_teach_narrate')
            return 1
        measured = audio_ms(path)
        if abs(measured - sentence['durationMs']) > 120:
            # 音频和 timings 已经不一致：多半是"只重录了一句"，此时统一补静默
            # 会让其余句子叠加一次。交给人决定，不猜。
            print(f'{sentence["id"]}: audio is {measured} ms but timings says {sentence["durationMs"]} ms')
            print('  a partial re-narrate leaves the other files already padded; re-narrate the whole film instead of padding again')
            return 1
        plan.append((sentence, path, measured))

    for sentence, path, measured in plan:
        suffix = path.suffix.lower()
        codec = ['-c:a', 'libmp3lame', '-b:a', f'{probe(path, "bit_rate") or 128000}' ] if suffix == '.mp3' else ['-c:a', 'pcm_s16le']
        # 临时文件必须保留同一个扩展名：ffmpeg 靠扩展名选封装格式。
        tmp = path.with_name(path.stem + '.hold' + path.suffix)
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-y', '-i', str(path),
             '-af', f'apad=pad_dur={hold_ms / 1000}', *codec, '-ar', rate,
             '-ac', probe(path, 'channels'), str(tmp)],
            check=True,
        )
        tmp.replace(path)
        padded = audio_ms(path)
        print(f'{sentence["id"]:7s} {measured:5d} → {padded:5d} ms')
        sentence['durationMs'] = padded

    timings_path.write_text(json.dumps(timings, ensure_ascii=False, indent=2) + '\n')
    sidecar.write_text(json.dumps({
        'holdMs': hold_ms,
        'timingsSha256': sha256(timings_path),
        'note': 'written by demo/showcase/hold.py; delete it AND re-narrate to pad again from clean audio',
    }, ensure_ascii=False, indent=2) + '\n')
    print(f'{run.name}: padded {len(plan)} sentence(s) by {hold_ms} ms; cues must be recomputed (cues.py)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
