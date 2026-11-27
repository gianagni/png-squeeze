// PNG squeezer: reads every screenshot under /input/<id>/image.png and
// writes its smallest lossless PNG to /output/<id>/image.png. Node 22,
// built-in modules only. Deterministic: no clock, no randomness, no
// environment read except the input and output directories, and every
// choice keeps the first candidate on a tie, so the same input always
// yields byte-identical outputs.
//
// Local run on the practice set:
//   mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './src/codec.ts';
import { formsOf } from './src/analyse.ts';
import { squeeze } from './src/encode.ts';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  // Only directories under the input dir are instances; a stray file in
  // the input root is not an instance and is skipped, not read.
  if (!statSync(join(INPUT_DIR, id)).isDirectory()) continue;
  const inputPath = join(INPUT_DIR, id, 'image.png');
  const decoded = decodePng(new Uint8Array(readFileSync(inputPath)));
  if (!decoded.ok) throw new Error(id + '/image.png: ' + decoded.why);
  const result = squeeze(decoded.width, decoded.height, formsOf(decoded));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), result.png);
}
