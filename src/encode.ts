// The squeeze: for every lossless form of an image, try the filter choices
// the PNG specification allows, weigh each by zlib, and keep the smallest
// file. Choices are weighed first at level 6 (fast, the way the scale
// compressor screens), then the winner is written at level 9 with the
// better of the default and filtered strategies. Every tie keeps the first
// candidate, so the same input always yields the same bytes.
import { constants, deflateSync } from 'node:zlib';
import { assemblePng, filterRow, ihdrData, signedSum } from './codec.ts';
import type { Form } from './analyse.ts';
import { zlibOptimal, verifyDeflate } from './deflate.ts';

const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
const FINAL_DEFAULT = Object.freeze({ level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY });
const FINAL_FILTERED = Object.freeze({ level: 9, memLevel: 9, strategy: constants.Z_FILTERED });

// How many bytes written before a row brute force compresses its trials
// after: the match window a row's filter choice can still lean on.
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

// The fewest-distinct-pairs heuristic's cost: how many distinct pairs of
// neighbouring bytes a filtered row holds. Rows with few distinct pairs
// usually compress small.
function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

export type FilterChoice = number | 'minsum' | 'pairs' | 'brute';

// The raw data of an image's samples (height rows of width x bpp samples),
// each row behind its filter byte, by choice: a fixed filter type for every
// row, or 'minsum' (least signed sum a row), 'pairs' (fewest distinct byte
// pairs a row), or 'brute' (each row the filter whose deflate, at level 4
// after the 32 KiB written before it, is smallest). The lower type wins a
// tie, so the result is fixed for a fixed input.
export function filteredData(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  choice: FilterChoice,
): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') {
        cost = signedSum(trial[t].subarray(1));
      } else if (choice === 'pairs') {
        cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      } else {
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: BRUTE_LEVEL, memLevel: 9 }
            : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// The filter choices each form is screened with. A palette ordered by count
// is tried unfiltered only: its indices already run in long flat stretches.
// A palette in another order is tried unfiltered, by the minimum sum and by
// brute force. A channel form is tried unfiltered, by each fixed filter, by
// the minimum sum, by the fewest pairs and by brute force.
const FILTERS: Record<string, FilterChoice[]> = {
  paletteCount: [0],
  paletteOther: [0, 'minsum', 'brute'],
  channels: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
};

export function formChoices(form: Form, order: number): FilterChoice[] {
  if (form.colourType === 3) return order === 0 ? FILTERS.paletteCount : FILTERS.paletteOther;
  return FILTERS.channels;
}

// The bytes a form's PLTE and tRNS chunks take in its file (12 bytes of
// length, type and CRC around each chunk's data).
const chunkBytes = (form: Form): number =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// The PNG of an image in `form` whose IDAT holds the zlib stream `idat`.
export function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrData(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return assemblePng(chunks);
}

export interface SqueezeResult {
  png: Uint8Array;
  bytes: number;
  colourType: number;
  formIndex: number;
  choice: FilterChoice;
}

// Squeeze one decoded image into the smallest PNG found. Each form is
// screened by its filter choices at level 6; the winner is then written at
// level 9 under both the default and the filtered strategies (and the level
// 6 stream that screened it stays a candidate, since level 9's lazier
// matching can lose to level 6 on some data). The winner's filtered data is
// also compressed by the optimal parser, and the smaller of the two wins,
// but only when the optimal stream decodes back to exactly the filtered
// data; a failed check keeps the zlib stream. The first candidate wins
// every tie, so the same input always yields the same bytes.
export function squeeze(width: number, height: number, forms: Form[]): SqueezeResult {
  let best: { png: Uint8Array; bytes: number; colourType: number; formIndex: number; choice: FilterChoice } | null = null;
  let bestData: Uint8Array | null = null;
  let bestForm: Form | null = null;
  let bestScreened = Infinity;
  for (let fi = 0; fi < forms.length; fi++) {
    const form = forms[fi];
    const chunks = chunkBytes(form);
    for (const choice of formChoices(form, fi)) {
      const data = filteredData(form.samples, width, height, form.bpp, choice);
      const screened = deflateSync(data, SCREEN);
      const screenedBytes = screened.length + chunks;
      // The screen ranks candidates; only a candidate that leads at level 6
      // is written at level 9, so the level-9 work stays bounded.
      if (screenedBytes >= bestScreened) continue;
      bestScreened = screenedBytes;
      const a = deflateSync(data, FINAL_DEFAULT);
      const b = deflateSync(data, FINAL_FILTERED);
      const idat = a.length <= b.length ? (a.length <= screened.length ? a : screened) : (b.length <= screened.length ? b : screened);
      const png = pngOfForm(width, height, form, new Uint8Array(idat));
      best = { png, bytes: png.length, colourType: form.colourType, formIndex: fi, choice };
      bestData = data;
      bestForm = form;
    }
  }
  if (best === null || bestData === null || bestForm === null) throw new Error('no form to squeeze');
  // The optimal parser is tried on the winner only, so its cost stays
  // bounded, and it is trusted only after a decode check.
  const optimal = zlibOptimal(bestData);
  if (verifyDeflate(optimal.subarray(2, optimal.length - 4), bestData)) {
    const optimalPng = pngOfForm(width, height, bestForm, optimal);
    if (optimalPng.length < best.bytes) {
      best = { png: optimalPng, bytes: optimalPng.length, colourType: best.colourType, formIndex: best.formIndex, choice: best.choice };
    }
  }
  return best;
}
