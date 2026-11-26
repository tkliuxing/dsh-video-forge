#!/usr/bin/env python3
"""按「页内变化次数」重算 at_progress，并写回稿本。

公式（skill `video-teach-storyboard` 的「页内节拍」）：
    一页 n 个 fragment → n+1 次画面变化，换页算第一次；
    第 k 个 fragment 落在这一句"说话时长"的 k/(n+1) 处。
    换算成 at_progress 时分母是含尾停留的 durationMs：
        spoken         = durationMs − holdMs
        at_progress(k) = (k/(m+1) × spoken) / durationMs
    m 是**这一句自己的**拍数：共享页上每句仍按自己那几拍铺，与
    fixtures/teach/shared-page 的做法一致（每句一拍、都写 0.4 量级）。

为什么要脚本而不是手写：补过页尾停留之后分母变了，手写的固定比例
（0.4 / 0.72 之类）会把动作整体往后推，最后一拍贴到句尾。

只处理页模式（deepseek）稿本：cue 模式（volcengine）的节拍是 at_word，
词级时间戳没有变，不需要重算。

用法：
    python3 demo/showcase/cues.py demo/showcase/runs/deepseek
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SENTENCE = re.compile(r'(?m)^(      - id: (\S+)\n)(.*?)(?=^      - id: |^  - id: |\Z)', re.S)
CUE = re.compile(r'\{ fragment: (\d+), at_progress: ([\d.]+) \}')


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    run = Path(sys.argv[1]).resolve()
    timings = {s['id']: s for s in json.loads((run / 'timings.json').read_text())['sentences']}
    sidecar = run / '.page-hold.json'
    hold = json.loads(sidecar.read_text())['holdMs'] if sidecar.is_file() else 0
    board = run / 'storyboard.yaml'
    text = board.read_text()

    rows = []

    def rewrite(match: re.Match[str]) -> str:
        head, sid, body = match.group(1), match.group(2), match.group(3)
        cues = CUE.findall(body)
        if not cues:
            return match.group(0)
        timed = timings.get(sid)
        if timed is None:
            raise SystemExit(f'{sid} is in the manuscript but not in timings.json; narrate first')
        duration = timed['durationMs']
        spoken = duration - hold
        count = len(cues)
        index = 0
        out = []
        for line in body.splitlines(keepends=True):
            def sub(cue: re.Match[str]) -> str:
                nonlocal index
                index += 1
                share = round((index / (count + 1) * spoken) / duration, 3)
                rows.append((sid, index, share, duration, hold))
                return f'{{ fragment: {cue.group(1)}, at_progress: {share} }}'
            out.append(CUE.sub(sub, line))
        return head + ''.join(out)

    new = SENTENCE.sub(rewrite, text)
    board.write_text(new)
    print(f'{"sentence":8s} {"beat":4s} {"at_progress":>11s}  duration  hold')
    for sid, index, share, duration, hold_ms in rows:
        print(f'{sid:8s} {index:<4d} {share:>11.3f}  {duration:6d} ms  {hold_ms} ms')
    print(f'\n{len(rows)} beat(s) rewritten in {board}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
