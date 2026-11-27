// A small optimal-parsing DEFLATE encoder, in the manner of zopfli but
// with a single cost-model iteration, written from RFC 1951. It finds LZ77
// matches with hash chains, runs a greedy parse to learn symbol costs,
// re-parses with dynamic programming (literal or the full longest match at
// each position), and writes the symbols in dynamic Huffman blocks. It is
// used only when it beats zlib on the same data, and its output is always
// decoded and checked before it is trusted.
//
// The encoder is deterministic: every tie keeps the first candidate, the
// hash chains walk in a fixed order, and no clock or randomness is read.
import { inflateRawSync } from 'node:zlib';

// Length code tables (RFC 1951 section 3.2.5): for a match length, the
// symbol, how many extra bits follow it, and the length the symbol's base
// covers.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
// Distance code tables: for a match distance, the symbol, its extra bits,
// and the distance the symbol's base covers.
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

export interface LengthCode { symbol: number; extraBits: number; extra: number }
export interface DistanceCode { symbol: number; extraBits: number; extra: number }

const LEN_TABLE: LengthCode[] = (() => {
  const table: LengthCode[] = new Array(259);
  for (let s = 0; s < 29; s++) {
    const base = LEN_BASE[s];
    const count = s === 28 ? 1 : LEN_BASE[s + 1] - base;
    for (let k = 0; k < count; k++) {
      table[base + k] = { symbol: 257 + s, extraBits: LEN_EXTRA[s], extra: k };
    }
  }
  return table;
})();

const DIST_TABLE: DistanceCode[] = (() => {
  const table: DistanceCode[] = new Array(32769);
  for (let s = 0; s < 30; s++) {
    const base = DIST_BASE[s];
    const count = s === 29 ? 32769 - base : DIST_BASE[s + 1] - base;
    for (let k = 0; k < count; k++) {
      table[base + k] = { symbol: s, extraBits: DIST_EXTRA[s], extra: k };
    }
  }
  return table;
})();

export function lengthCodeOf(len: number): LengthCode {
  return LEN_TABLE[len];
}

export function distanceCodeOf(dist: number): DistanceCode {
  return DIST_TABLE[dist];
}

// Huffman code lengths from symbol frequencies, limited to maxLen bits.
// Builds a Huffman tree with a heap, then repairs any over-long codes the
// way zlib's gen_bitlen does: the deepest codes are moved up two at a time
// until none exceeds the limit.
export function huffmanLengths(freqs: Uint32Array | number[], maxLen: number): Uint8Array {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  // Symbols that occur: at least two are needed for a code, so a lone
  // symbol gets a dummy partner of frequency 1.
  let used = 0;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (freqs[i] > 0) {
      used++;
      last = i;
    }
  }
  if (used === 0) return lengths;
  if (used === 1) {
    lengths[last] = 1;
    return lengths;
  }
  // Heap of tree nodes, smallest frequency first, ties by the smaller
  // symbol, so the tree is fixed for fixed input.
  interface Node { freq: number; symbol: number; left: Node | null; right: Node | null; depth: number }
  const heap: Node[] = [];
  const push = (node: Node): void => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].freq < heap[i].freq || (heap[p].freq === heap[i].freq && heap[p].symbol <= heap[i].symbol)) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): Node => {
    const top = heap[0];
    const lastNode = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = lastNode;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && (heap[l].freq < heap[m].freq || (heap[l].freq === heap[m].freq && heap[l].symbol < heap[m].symbol))) m = l;
        if (r < heap.length && (heap[r].freq < heap[m].freq || (heap[r].freq === heap[m].freq && heap[r].symbol < heap[m].symbol))) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) {
    if (freqs[i] > 0) push({ freq: freqs[i], symbol: i, left: null, right: null, depth: 0 });
  }
  let nextSymbol = n;
  while (heap.length > 1) {
    const a = pop();
    const b = pop();
    push({ freq: a.freq + b.freq, symbol: nextSymbol++, left: a, right: b, depth: 0 });
  }
  const root = pop();
  const assign = (node: Node, depth: number): void => {
    if (node.left === null) {
      lengths[node.symbol] = depth;
      return;
    }
    assign(node.left, depth + 1);
    assign(node.right!, depth + 1);
  };
  assign(root, 0);
  // Repair over-long codes: count lengths, then move the deepest pair up.
  const blCount = new Array(maxLen + 2).fill(0);
  let overflow = 0;
  for (let i = 0; i < n; i++) {
    if (lengths[i] === 0) continue;
    if (lengths[i] > maxLen) {
      overflow++;
      blCount[maxLen]++;
    } else {
      blCount[lengths[i]]++;
    }
  }
  if (overflow > 0) {
    // Each repair moves one code from the deepest non-empty level up and
    // takes two codes from the limit level, until the overflow is gone.
    let bits = maxLen - 1;
    while (overflow > 0) {
      while (blCount[bits] === 0) bits--;
      blCount[bits]--;
      blCount[bits + 1] += 2;
      blCount[maxLen]--;
      overflow -= 2;
    }
    // Rebuild lengths from the counts, longest codes to the least
    // frequent symbols, so the assignment stays near-optimal.
    const order = [...Array(n).keys()]
      .filter((i) => freqs[i] > 0)
      .sort((a, b) => freqs[b] - freqs[a] || a - b);
    let at = 0;
    for (let len = 1; len <= maxLen; len++) {
      for (let k = 0; k < blCount[len]; k++) {
        lengths[order[at++]] = len;
      }
    }
  }
  return lengths;
}

// Canonical Huffman codes from lengths: codes of the same length are
// consecutive, in symbol order (RFC 1951 section 3.2.2).
export function canonicalCodes(lengths: Uint8Array): { code: number; len: number }[] {
  const n = lengths.length;
  const blCount = new Array(16).fill(0);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Array(16).fill(0);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const out: { code: number; len: number }[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (len === 0) {
      out[i] = { code: 0, len: 0 };
    } else {
      out[i] = { code: nextCode[len]++, len };
    }
  }
  return out;
}

// A bit writer: bits go in least-significant-bit first, as DEFLATE wants.
export class BitWriter {
  bytes: number[] = [];
  private acc = 0;
  private nbits = 0;

  writeBits(value: number, count: number): void {
    this.acc |= (value & ((1 << count) - 1)) << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }

  // Write a Huffman code: its bits go out most-significant first, unlike
  // every other value in the stream, which goes least-significant first.
  writeCode(code: number, len: number): void {
    for (let b = len - 1; b >= 0; b--) {
      this.writeBits((code >> b) & 1, 1);
    }
  }

  // Flush to a byte boundary, padding with zero bits.
  finish(): Uint8Array {
    if (this.nbits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.nbits = 0;
    }
    return new Uint8Array(this.bytes);
  }
}

// Adler-32 of the raw data, for the zlib stream's trailer.
export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Verify a deflate payload inflates back to exactly `raw`. True only when
// the stream is whole and the bytes match. The payload is raw DEFLATE, so
// it is inflated without a zlib header.
export function verifyDeflate(payload: Uint8Array, raw: Uint8Array): boolean {
  try {
    const out = inflateRawSync(payload, { maxOutputLength: raw.length + 1 });
    if (out.length !== raw.length) return false;
    for (let i = 0; i < raw.length; i++) if (out[i] !== raw[i]) return false;
    return true;
  } catch {
    return false;
  }
}

// ---- LZ77 matching -------------------------------------------------------

// How far back a match may reach (the DEFLATE window), and how many chain
// links the search walks before it stops looking for a longer match.
const WINDOW = 32768;
const MAX_CHAIN = 256;
const GOOD_LENGTH = 32;
const MAX_MATCH = 258;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;

// The longest match starting at each position, and its distance. Positions
// with no match of length 3 or more hold length 0.
export function findMatches(data: Uint8Array): { lengths: Uint16Array; distances: Uint16Array } {
  const n = data.length;
  const lengths = new Uint16Array(n);
  const distances = new Uint16Array(n);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (i + 3 > n) break;
    const hash = (((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1)) >>> 0;
    let bestLen = 0;
    let bestDist = 0;
    let cand = head[hash];
    let steps = 0;
    const maxLen = Math.min(MAX_MATCH, n - i);
    while (cand >= 0 && steps < MAX_CHAIN) {
      const dist = i - cand;
      if (dist > WINDOW) break;
      // The byte past the best length so far decides quickly whether this
      // candidate can beat it; when it can, the whole match is measured
      // from the start, because only the first three bytes are known to
      // match from the hash.
      let len = 0;
      if (bestLen < maxLen && data[cand + bestLen] === data[i + bestLen]) {
        while (len < maxLen && data[cand + len] === data[i + len]) len++;
      }
      if (len > bestLen) {
        bestLen = len;
        bestDist = dist;
        if (len >= GOOD_LENGTH || len === maxLen) break;
      }
      cand = prev[cand];
      steps++;
    }
    if (bestLen >= 3) {
      lengths[i] = bestLen;
      distances[i] = bestDist;
    }
    prev[i] = head[hash];
    head[hash] = i;
  }
  return { lengths, distances };
}

// ---- Greedy parse (for the cost model) -----------------------------------

export interface SymbolFreq {
  litLen: Uint32Array;
  dist: Uint32Array;
}

// A lazy greedy parse: at each position take the longest match unless the
// next position starts a longer one, in which case emit a literal and move
// one byte. Counts the literal/length and distance symbols it emits.
export function greedyFrequencies(
  data: Uint8Array,
  lengths: Uint16Array,
  distances: Uint16Array,
): SymbolFreq {
  const litLen = new Uint32Array(286);
  const dist = new Uint32Array(30);
  const n = data.length;
  let i = 0;
  while (i < n) {
    const len = lengths[i];
    if (len >= 3 && !(i + 1 < n && lengths[i + 1] > len)) {
      const lc = LEN_TABLE[len];
      litLen[lc.symbol]++;
      dist[DIST_TABLE[distances[i]].symbol]++;
      i += len;
    } else {
      litLen[data[i]]++;
      i++;
    }
  }
  litLen[256]++;
  return { litLen, dist };
}

// ---- Dynamic programming parse -------------------------------------------

export interface ParsedSymbol {
  literal: number;
  length: number;
  distance: number;
}

// Re-parse with dynamic programming, using the symbol costs from the greedy
// parse's frequencies. At each position the choice is a literal or the full
// longest match; the cheapest total wins. The predecessor of every position
// is recorded so the walk back from the end recovers the optimal sequence.
export function dpParse(
  data: Uint8Array,
  lengths: Uint16Array,
  distances: Uint16Array,
  litLenLengths: Uint8Array,
  distLengths: Uint8Array,
): ParsedSymbol[] {
  const n = data.length;
  const litCost = new Float64Array(256);
  for (let i = 0; i < 256; i++) litCost[i] = litLenLengths[i] === 0 ? 15 : litLenLengths[i];
  const lenCost = new Float64Array(286);
  for (let s = 257; s < 286; s++) {
    lenCost[s] = litLenLengths[s] === 0 ? 15 : litLenLengths[s];
  }
  const distCost = new Float64Array(30);
  for (let s = 0; s < 30; s++) distCost[s] = distLengths[s] === 0 ? 15 : distLengths[s];
  const cost = new Float64Array(n + 1);
  cost.fill(Infinity);
  cost[0] = 0;
  // For each position, how the cheapest path reached it: the previous
  // position, and whether that step was a match (with its length and
  // distance) or a literal.
  const prevPos = new Int32Array(n + 1);
  const prevIsMatch = new Uint8Array(n + 1);
  const prevLen = new Uint16Array(n + 1);
  const prevDist = new Uint16Array(n + 1);
  for (let i = 0; i < n; i++) {
    const base = cost[i];
    if (!Number.isFinite(base)) continue;
    const lit = base + litCost[data[i]];
    if (lit < cost[i + 1]) {
      cost[i + 1] = lit;
      prevPos[i + 1] = i;
      prevIsMatch[i + 1] = 0;
    }
    const len = lengths[i];
    if (len >= 3) {
      const lc = LEN_TABLE[len];
      const dc = DIST_TABLE[distances[i]];
      const mc = base + lenCost[lc.symbol] + lc.extraBits + distCost[dc.symbol] + dc.extraBits;
      const j = i + len;
      if (mc < cost[j]) {
        cost[j] = mc;
        prevPos[j] = i;
        prevIsMatch[j] = 1;
        prevLen[j] = len;
        prevDist[j] = distances[i];
      }
    }
  }
  const symbols: ParsedSymbol[] = [];
  let j = n;
  while (j > 0) {
    const i = prevPos[j];
    if (prevIsMatch[j] === 1) {
      symbols.push({ literal: -1, length: prevLen[j], distance: prevDist[j] });
    } else {
      symbols.push({ literal: data[i], length: 0, distance: 0 });
    }
    j = i;
  }
  symbols.reverse();
  return symbols;
}

// ---- Dynamic Huffman block encoding --------------------------------------

// The order the code-length code's lengths are written in (RFC 1951).
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Write one dynamic Huffman block: the header, the code-length code, and
// the symbols, using the tables built from this block's own frequencies.
// `final` marks the last block of the stream.
export function writeBlock(
  out: BitWriter,
  symbols: ParsedSymbol[],
  final: boolean,
): void {
  const litLenFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  for (const s of symbols) {
    if (s.literal >= 0) litLenFreq[s.literal]++;
    else {
      litLenFreq[LEN_TABLE[s.length].symbol]++;
      distFreq[DIST_TABLE[s.distance].symbol]++;
    }
  }
  litLenFreq[256]++;
  const litLenLengths = huffmanLengths(litLenFreq, 15);
  const distLengths = huffmanLengths(distFreq, 15);
  // Trim trailing zero lengths: HLIT counts literal/length codes down to
  // the last used one (at least 257), HDIST the same for distances.
  let hlit = 286;
  while (hlit > 257 && litLenLengths[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLengths[hdist - 1] === 0) hdist--;
  const litLenCodes = canonicalCodes(litLenLengths);
  const distCodes = canonicalCodes(distLengths);
  // The code lengths of both tables, run-length coded: 16 repeats the
  // previous length 3-6 times, 17 repeats zero 3-10 times, 18 repeats zero
  // 11-138 times. Build the run sequence first, then its own code.
  const runs: { symbol: number; extra: number; extraBits: number }[] = [];
  const pushRun = (value: number, count: number): void => {
    if (value === 0) {
      let left = count;
      while (left >= 11) {
        const take = Math.min(left, 138);
        runs.push({ symbol: 18, extra: take - 11, extraBits: 7 });
        left -= take;
      }
      while (left >= 3) {
        const take = Math.min(left, 10);
        runs.push({ symbol: 17, extra: take - 3, extraBits: 3 });
        left -= take;
      }
      for (let k = 0; k < left; k++) runs.push({ symbol: 0, extra: 0, extraBits: 0 });
    } else {
      runs.push({ symbol: value, extra: 0, extraBits: 0 });
      let left = count - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        runs.push({ symbol: 16, extra: take - 3, extraBits: 2 });
        left -= take;
      }
      for (let k = 0; k < left; k++) runs.push({ symbol: value, extra: 0, extraBits: 0 });
    }
  };
  const allLengths: number[] = [];
  for (let i = 0; i < hlit; i++) allLengths.push(litLenLengths[i]);
  for (let i = 0; i < hdist; i++) allLengths.push(distLengths[i]);
  {
    let i = 0;
    while (i < allLengths.length) {
      const v = allLengths[i];
      let j = i + 1;
      while (j < allLengths.length && allLengths[j] === v) j++;
      pushRun(v, j - i);
      i = j;
    }
  }
  const clFreq = new Uint32Array(19);
  for (const r of runs) clFreq[r.symbol]++;
  const clLengths = huffmanLengths(clFreq, 7);
  const clCodes = canonicalCodes(clLengths);
  let hclen = 19;
  while (hclen > 4 && clLengths[CL_ORDER[hclen - 1]] === 0) hclen--;
  out.writeBits(final ? 1 : 0, 1);
  out.writeBits(2, 2);
  out.writeBits(hlit - 257, 5);
  out.writeBits(hdist - 1, 5);
  out.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) out.writeBits(clLengths[CL_ORDER[k]], 3);
  for (const r of runs) {
    const c = clCodes[r.symbol];
    out.writeCode(c.code, c.len);
    if (r.extraBits > 0) out.writeBits(r.extra, r.extraBits);
  }
  for (const s of symbols) {
    if (s.literal >= 0) {
      const c = litLenCodes[s.literal];
      out.writeCode(c.code, c.len);
    } else {
      const lc = LEN_TABLE[s.length];
      const c = litLenCodes[lc.symbol];
      out.writeCode(c.code, c.len);
      if (lc.extraBits > 0) out.writeBits(lc.extra, lc.extraBits);
      const dc = DIST_TABLE[s.distance];
      const d = distCodes[dc.symbol];
      out.writeCode(d.code, d.len);
      if (dc.extraBits > 0) out.writeBits(dc.extra, dc.extraBits);
    }
  }
  const end = litLenCodes[256];
  out.writeCode(end.code, end.len);
}

// ---- Whole-stream encoder -------------------------------------------------

// How many input bytes a dynamic block covers at most. Blocks stay small
// enough that their Huffman tables track local statistics without the
// tables themselves costing more than they save.
const BLOCK_BYTES = 262144;

// Compress `data` with the optimal parser and return the DEFLATE payload
// (no zlib header or trailer). The caller wraps it in a zlib stream.
export function deflateOptimal(data: Uint8Array): Uint8Array {
  if (data.length === 0) {
    // An empty stream is one fixed-Huffman block holding only the end.
    const out = new BitWriter();
    out.writeBits(1, 1);
    out.writeBits(1, 2);
    out.writeBits(0, 7);
    return out.finish();
  }
  const { lengths, distances } = findMatches(data);
  const freqs = greedyFrequencies(data, lengths, distances);
  const litLenLengths = huffmanLengths(freqs.litLen, 15);
  const distLengths = huffmanLengths(freqs.dist, 15);
  let symbols = dpParse(data, lengths, distances, litLenLengths, distLengths);
  // A second pass with costs learned from the first parse's own symbols:
  // the greedy parse's frequencies can mislead the DP on data where the
  // optimal parse uses a very different mix of symbols.
  const freqs2 = { litLen: new Uint32Array(286), dist: new Uint32Array(30) };
  for (const s of symbols) {
    if (s.literal >= 0) freqs2.litLen[s.literal]++;
    else {
      freqs2.litLen[LEN_TABLE[s.length].symbol]++;
      freqs2.dist[DIST_TABLE[s.distance].symbol]++;
    }
  }
  freqs2.litLen[256]++;
  const litLenLengths2 = huffmanLengths(freqs2.litLen, 15);
  const distLengths2 = huffmanLengths(freqs2.dist, 15);
  symbols = dpParse(data, lengths, distances, litLenLengths2, distLengths2);
  // Split the symbols into blocks by the input bytes they cover.
  const blocks: ParsedSymbol[][] = [];
  let current: ParsedSymbol[] = [];
  let covered = 0;
  let blockStart = 0;
  for (const s of symbols) {
    const span = s.literal >= 0 ? 1 : s.length;
    if (covered - blockStart >= BLOCK_BYTES && current.length > 0) {
      blocks.push(current);
      current = [];
      blockStart = covered;
    }
    current.push(s);
    covered += span;
  }
  if (current.length > 0) blocks.push(current);
  const out = new BitWriter();
  for (let b = 0; b < blocks.length; b++) {
    writeBlock(out, blocks[b], b === blocks.length - 1);
  }
  return out.finish();
}

// The zlib stream of `data` compressed by the optimal parser: the 0x78 0x9C
// header, the deflate payload, and the Adler-32 trailer.
export function zlibOptimal(data: Uint8Array): Uint8Array {
  const payload = deflateOptimal(data);
  const out = new Uint8Array(2 + payload.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(payload, 2);
  const adler = adler32(data);
  out[2 + payload.length] = (adler >>> 24) & 0xff;
  out[2 + payload.length + 1] = (adler >>> 16) & 0xff;
  out[2 + payload.length + 2] = (adler >>> 8) & 0xff;
  out[2 + payload.length + 3] = adler & 0xff;
  return out;
}
