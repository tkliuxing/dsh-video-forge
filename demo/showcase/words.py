#!/usr/bin/env python3
"""把合并合成写下的词级时间戳换算成"每句自己的时钟"。

背景（实测 2026-11-26，`video_teach_narrate` 默认 `merge: auto`）：
合并合成把相邻几句**一次请求**发出去，服务端返回的词级时间戳是**整段音频**
的绝对偏移；插件按 `segmentTiming()` 把每句切出来存成 `audio/<id>.mp3`，
但写进 `timings.json` 的 `words` 没有减掉切片起点。于是：

- `video_teach_render` 在解析阶段就拒绝：`words ends at 12715 ms, past the
  audio's 7464 ms`；
- 即便放过，`cueOffsetMs()` 会把 `at_word` 当成句内偏移，纯 cue 模式的每一拍
  都会晚一整段。

切片起点是可证的：合并路径下 `trimLead` 恒为真，`startMs = max(0, 第一个词的 b)`，
所以换算就是逐句减去本句第一个词的 `b`。这不是猜的：减完之后每句第一个词都是
0，末词不晚于该句音频实测长度，脚本两个条件都断言。

这个脚本是**数据侧**的补救，让已经花钱合成好的音频不必重录。代码侧的修法在
`src/teach/pipeline.ts` 的 `rebaseWords()`（同一轮补的），下次宿主重启后新录的
片子不再需要它。

用法：
    python3 demo/showcase/words.py demo/showcase/runs/volcengine
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    run = Path(sys.argv[1]).resolve()
    path = run / 'timings.json'
    timings = json.loads(path.read_text())

    rebased = 0
    for sentence in timings['sentences']:
        words = sentence.get('words') or []
        if not words:
            continue
        offset = words[0]['b']
        if offset == 0:
            continue
        for word in words:
            begin = max(0, word['b'] - offset)
            word['b'] = begin
            word['e'] = max(begin + 1, word['e'] - offset)
        rebased += 1

        # 两条断言：换算后落在本句自己的时钟里，且不乱序。
        assert words[0]['b'] == 0, sentence['id']
        assert words[-1]['e'] <= sentence['durationMs'], (sentence['id'], words[-1]['e'], sentence['durationMs'])
        for previous, current in zip(words, words[1:]):
            assert current['b'] >= previous['e'] - 1, (sentence['id'], previous, current)

    path.write_text(json.dumps(timings, ensure_ascii=False, indent=2) + '\n')
    print(f'{run.name}: rebased {rebased} sentence(s) of word timings onto their own audio')
    if rebased == 0:
        print('  (nothing to rebase: every sentence already starts at 0 ms)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
