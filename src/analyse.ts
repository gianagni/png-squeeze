// Colour analysis and the lossless forms an image can be written in, each
// holding every pixel exactly: a palette when the image has at most 256
// colours, a grey or grey-plus-alpha form when every pixel is grey, an RGB
// or RGBA form otherwise, and a tRNS key instead of an alpha channel when
// the image has exactly one fully transparent value no opaque pixel uses.
import type { DecodedImage } from './codec.ts';

export interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
  word: number;
  count: number;
  first: number;
}

export interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null;
}

const wordOf = (r: number, g: number, b: number, a: number): number =>
  ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

// Read the image once: whether every pixel is opaque, whether every pixel
// is grey, and its distinct colours while there are at most 256 of them.
export function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map<number, { count: number; first: number }>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const w = wordOf(r, g, b, a);
      const hit = counts.get(w);
      if (hit === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(w, { count: 1, first: i });
      } else {
        hit.count++;
      }
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours: Colour[] = [];
  for (const [word, hit] of counts) {
    colours.push({
      r: word & 0xff,
      g: (word >>> 8) & 0xff,
      b: (word >>> 16) & 0xff,
      a: (word >>> 24) & 0xff,
      word,
      count: hit.count,
      first: hit.first,
    });
  }
  return { opaque, grey, colours };
}

// The one fully transparent value (grey sample or RGB triple) the image may
// key by tRNS instead of an alpha channel: every pixel is opaque or that
// exact value at alpha 0, and no opaque pixel holds that value. Null when
// there is none, or when the image is fully opaque.
export function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

export interface PaletteForm {
  colourType: 3;
  bpp: 1;
  samples: Uint8Array;
  plte: Uint8Array;
  trns: Uint8Array | null;
}

export interface ChannelForm {
  colourType: 0 | 2 | 4 | 6;
  bpp: number;
  samples: Uint8Array;
  plte: null;
  trns: Uint8Array | null;
}

export type Form = PaletteForm | ChannelForm;

const luminance = (c: Colour): number => 299 * c.r + 587 * c.g + 114 * c.b;

// Order a palette's entries: the transparent ones first (by alpha, so tRNS
// stays short), then by the named order. Ties break by the colour word, so
// the order is fixed whatever the image holds.
function orderEntries(colours: Colour[], order: 'count' | 'luminance' | 'first' | 'lex'): Colour[] {
  return [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return luminance(x) - luminance(y) || x.word - y.word;
    if (order === 'first') return x.first - y.first || x.word - y.word;
    if (order === 'lex') return x.r - y.r || x.g - y.g || x.b - y.b || x.a - y.a || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function buildPalette(rgba: Uint8Array, colours: Colour[], order: 'count' | 'luminance' | 'first' | 'lex'): PaletteForm {
  const entries = orderEntries(colours, order);
  const index = new Map<number, number>();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get(wordOf(rgba[d], rgba[d + 1], rgba[d + 2], rgba[d + 3]))!;
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// The image's samples in a channel colour type (0, 2, 4 or 6) from its RGBA.
export function channelSamples(rgba: Uint8Array, colourType: 0 | 2 | 4 | 6): Uint8Array {
  const n = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const ch = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (colourType === 0) {
      out[s] = rgba[d];
    } else if (colourType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// Every lossless form the image can take, palette forms first. A palette
// form holds the image in a third of the bytes of RGB or less, so when the
// image has at most 256 colours the channel form is not tried at all unless
// the image is grey, where the grey form is as small as a palette.
export function formsOf(image: DecodedImage): Form[] {
  const { rgba } = image;
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance', 'first', 'lex'] as const) {
      forms.push(buildPalette(rgba, colours, order));
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let colourType: 0 | 2 | 4 | 6;
  let trns: Uint8Array | null = null;
  if (grey) {
    colourType = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    colourType = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  forms.push({
    colourType,
    bpp,
    samples: channelSamples(rgba, colourType),
    plte: null,
    trns,
  });
  return forms;
}
