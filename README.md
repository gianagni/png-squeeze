# png-squeeze
[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/gianagni/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/gianagni/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG squeezer for 1280x720 screenshots, written in Node 22 with built-in modules only. For each image it picks the smallest exact form (palette with four entry orders, grey, grey plus alpha, RGB, RGBA, or a tRNS key instead of an alpha channel), then tries the PNG filter choices per row (fixed filters, minimum signed sum, fewest distinct byte pairs, and brute force by real deflate cost) and writes the winner at zlib level 9, keeping the smaller of the default and filtered strategies. Deterministic: no clock, no randomness, the first candidate wins every tie, so the same input always yields byte-identical output.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

In the grader it runs as `node /bot/main.ts`, reading `/input/<id>/image.png` and writing `/output/<id>/image.png` for every instance in the set.

<sub>Entered on [make.fun](https://make.fun/?ref=pdjgt9c9&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
