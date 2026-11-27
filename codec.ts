// PNG reading and writing primitives for the squeezer, written from the PNG
// specification. Only the chunk types the contest accepts are written:
// IHDR, PLTE, tRNS, IDAT, IEND. Decoding handles every colour type the
// contest accepts so an input of any of those forms reads back exactly.
import { inflateSync } from 'node:zlib';

export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

const asciiBytes = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

export function assemblePng(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let size = PNG_SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let at = PNG_SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(asciiBytes(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

export function ihdrData(width: number, height: number, colourType: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8;
  data[9] = colourType;
  return data;
}

export function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// True when the bytes start with the PNG signature. A cheap guard before
// decoding, so a non-PNG input fails fast with a clear reason.
export function startsWithSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

// Filter one row of samples into out. type 0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth.
export function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
    return;
  }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
    return;
  }
  if (type === 2) {
    if (prev === null) {
      out.set(cur);
      return;
    }
    for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
    return;
  }
  if (type === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((left + up) >> 1);
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const left = i >= bpp ? cur[i - bpp] : 0;
    const up = prev === null ? 0 : prev[i];
    const upLeft = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paethPredictor(left, up, upLeft);
  }
}

// Sum of a filtered row's bytes read as signed values, absolute. The PNG
// specification's minimum-sum heuristic: the row filter with the least sum
// usually compresses best.
export function signedSum(row: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

type Fail = { ok: false; why: string };

function fail(why: string): Fail {
  return { ok: false, why };
}

// Decode a PNG the contest accepts into RGBA bytes, or explain why it does
// not read. Only the accepted chunk types are allowed, and a palette index
// past the palette is unread.
export function decodePng(bytes: Uint8Array): DecodedImage | Fail {
  if (bytes.length < PNG_SIGNATURE.length) return fail('file is shorter than the PNG signature');
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return fail('file does not start with the PNG signature');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = PNG_SIGNATURE.length;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  let idatClosed = false;
  const accepted = ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'];
  while (at < bytes.length) {
    if (ended) return fail('bytes follow IEND');
    if (at + 12 > bytes.length) return fail('a chunk is cut short');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return fail('a chunk claims bytes the file does not hold');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return fail('a chunk fails its CRC');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!accepted.includes(type)) return fail('chunk ' + type + ' is not read');
    if (header === null && type !== 'IHDR') return fail('first chunk is ' + type + ', not IHDR');
    if (type !== 'IDAT' && idat.length > 0) idatClosed = true;
    if (type === 'IHDR') {
      if (header !== null) return fail('IHDR appears twice');
      if (len !== 13) return fail('IHDR is not 13 bytes');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      const colourType = data[9];
      if (data[8] !== 8) return fail('bit depth is not 8');
      if (!(colourType in CHANNELS)) return fail('colour type ' + colourType + ' is not read');
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return fail('compression, filter or interlace is not 0');
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType };
      if (header.width === 0 || header.height === 0) return fail('width or height is 0');
    } else if (type === 'PLTE') {
      if (palette !== null) return fail('PLTE appears twice');
      if (header!.colourType !== 3) return fail('PLTE with colour type ' + header!.colourType);
      if (idat.length > 0) return fail('PLTE follows IDAT');
      if (len === 0 || len % 3 !== 0 || len > 768) return fail('PLTE is not 1 to 256 entries');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) return fail('tRNS appears twice');
      if (idat.length > 0) return fail('tRNS follows IDAT');
      const ct = header!.colourType;
      if (ct === 3) {
        if (palette === null) return fail('tRNS comes before PLTE');
        if (len > palette.length / 3) return fail('tRNS holds more entries than the palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) return fail('tRNS is the wrong length for colour type ' + ct);
      } else {
        return fail('tRNS with colour type ' + ct);
      }
      trns = data;
    } else if (type === 'IDAT') {
      if (idatClosed) return fail('IDAT chunks are not in a row');
      if (header!.colourType === 3 && palette === null) return fail('IDAT comes before PLTE');
      idat.push(data);
    } else {
      if (len !== 0) return fail('IEND is not empty');
      ended = true;
    }
  }
  if (!ended) return fail('no IEND');
  if (idat.length === 0) return fail('no IDAT');
  const { width, height, colourType } = header!;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw: Uint8Array;
  try {
    const joined = idat.length === 1 ? idat[0] : Buffer.concat(idat);
    raw = inflateSync(joined, { maxOutputLength: expected + 1 });
  } catch (err) {
    return fail('IDAT is not one whole zlib stream: ' + String((err as Error).message).split('\n')[0]);
  }
  if (raw.length !== expected) return fail('IDAT inflates to ' + raw.length + ' bytes, not ' + expected);

  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    if (filterType > 4) return fail('row ' + y + ' has filter type ' + filterType);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (filterType === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (filterType === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (filterType === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (filterType === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredictor(a, b, c);
      }
    }
  }

  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette!.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette![e * 3];
      lut[e * 4 + 1] = palette![e * 3 + 1];
      lut[e * 4 + 2] = palette![e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return fail('pixel ' + i + ' names palette entry ' + e + ' of ' + entries);
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, rgba };
}
