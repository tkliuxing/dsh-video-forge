#!/usr/bin/env bash
# 把 demo/showcase/ 下的共享素材同步进两个 run 目录。
#
# 为什么要同步，而不是让两份稿本引用同一批文件：稿本里的每条路径都会被
# `src/teach/storyboard.ts` 的 `projectPath()` 校验，出现 `..` 直接拒绝 ——
# 项目根取的是稿本所在目录，所以 deck / scene / cover 必须落在这个目录里。
# 这也正是多幕并行的 run 目录约定（每个 run 一份副本，互不覆盖）。
#
# 改了 slides/ scenes/ cover/ 之后跑一次；只改稿本与旁白时不用跑。
set -euo pipefail
cd "$(dirname "$0")"
for run in deepseek volcengine; do
  mkdir -p "runs/$run"
  rsync -a --delete slides scenes cover "runs/$run/"
  echo "synced → runs/$run/{slides,scenes,cover}"
done
