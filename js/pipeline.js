/**
 * Page-matching pipeline: features, blank pages, sheets, page types.
 *
 * Port of proto/validate.py (see its docstring for the method and the
 * validation). Pure functions on Float32Array; no DOM.
 *
 * Shapes: a page feature is (d,) with d = GRID_W * GRID_H, unit norm, or
 * null for a blank page. S is the (N, N) all-pairs NCC matrix, row-major.
 */

export const GRID_W = 128;
export const GRID_H = 166;

/** Build a normalized 1-D Gaussian kernel, radius 4 sigma (as scipy). */
function kernel(sigma) {
  const r = Math.floor(4 * sigma + 0.5);
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2);
    s += k[i + r];
  }
  return k.map((x) => x / s);
}

/** Map index i into 0..n-1 by half-sample reflection (scipy 'reflect'). */
function reflect(i, n) {
  const p = 2 * n;
  i = ((i % p) + p) % p;
  return i < n ? i : p - 1 - i;
}

/**
 * Blur a (h, w) row-major image with a separable Gaussian.
 * @returns {Float32Array} (h, w)
 */
export function blur(x, w, h, sigma) {
  const k = kernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < w; c++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += k[j + r] * x[y * w + reflect(c + j, w)];
      tmp[y * w + c] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < w; c++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += k[j + r] * tmp[reflect(y + j, h) * w + c];
      out[y * w + c] = s;
    }
  }
  return out;
}

/**
 * Shrink a (h, w) image by an integer factor using block means.
 * @returns {Float32Array} (h / f, w / f)
 */
export function downsample(x, w, h, f) {
  const w2 = Math.floor(w / f);
  const h2 = Math.floor(h / f);
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2 * f; y++) {
    for (let c = 0; c < w2 * f; c++) {
      out[Math.floor(y / f) * w2 + Math.floor(c / f)] += x[y * w + c];
    }
  }
  return out.map((v) => v / (f * f));
}

/**
 * Build a unit-norm feature from a (GRID_H, GRID_W) ink image.
 *
 * The high-pass (subtract a wide blur) removes paper tint and scanner
 * shading, which would otherwise correlate across all pages.
 *
 * @returns {{v: Float32Array, energy: number}} v is (d,) zero-mean unit
 *   norm; energy is the std of the filtered image, near zero on blank paper
 */
export function featurize(ink, w = GRID_W, h = GRID_H) {
  const lo = blur(ink, w, h, 1.0);
  const bg = blur(lo, w, h, 8.0);
  const n = w * h;
  const v = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += lo[i] - bg[i];
  mean /= n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    v[i] = lo[i] - bg[i] - mean;
    ss += v[i] * v[i];
  }
  const norm = Math.sqrt(ss) + 1e-12;
  for (let i = 0; i < n; i++) v[i] /= norm;
  return { v, energy: Math.sqrt(ss / n) };
}

/**
 * Flag pages with almost no ink structure as blank.
 *
 * Relative threshold: under frac of the median energy among the more-inked
 * half of the stack. Blank paper carries faint, repeatable scanner texture,
 * so unflagged blank pages look like near-copies of each other.
 *
 * @param {Float32Array} energy (N,)
 * @returns {boolean[]} (N,)
 */
export function blankMask(energy, frac = 0.1) {
  const sorted = Float32Array.from(energy).sort();
  const upper = sorted.slice(Math.floor(sorted.length / 2));
  const ref = upper[Math.floor(upper.length / 2)];
  return Array.from(energy, (e) => e < frac * ref);
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Compute all-pairs NCC; null (blank) features match nothing.
 * @param {(Float32Array|null)[]} F (N,) features
 * @returns {Float32Array} S (N, N)
 */
export function simMatrix(F) {
  const n = F.length;
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    if (!F[i]) continue;
    S[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      if (!F[j]) continue;
      const s = dot(F[i], F[j]);
      S[i * n + j] = s;
      S[j * n + i] = s;
    }
  }
  return S;
}

/**
 * Compute mean NCC between pages k apart, k = 1..maxLag.
 * @returns {number[]} (maxLag,)
 */
export function lagSim(S, n, maxLag = 12) {
  const out = [];
  for (let k = 1; k <= maxLag; k++) {
    let s = 0;
    for (let i = 0; i + k < n; i++) s += S[i * n + i + k];
    out.push(n > k ? s / (n - k) : 0);
  }
  return out;
}

/** Decide duplex: pages 2 apart match far better than neighbours. */
export function isDuplex(lag) {
  return lag[1] > 3 * Math.max(lag[0], 0.02);
}

/**
 * Score how much each page resembles others: mean of its top-k NCCs.
 *
 * A printed page has many near-copies in the stack; a blank or free-hand
 * back has none. Used to pick which side of a sheet is its front.
 *
 * @returns {Float32Array} (N,)
 */
export function typicality(S, n, k = 5) {
  const out = new Float32Array(n);
  const top = new Float32Array(k);
  for (let i = 0; i < n; i++) {
    top.fill(-Infinity);
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const s = S[i * n + j];
      if (s > top[k - 1]) {
        let m = k - 1;
        while (m > 0 && top[m - 1] < s) {
          top[m] = top[m - 1];
          m--;
        }
        top[m] = s;
      }
    }
    let sum = 0;
    let cnt = 0;
    for (const t of top) if (t > -Infinity) { sum += t; cnt++; }
    out[i] = cnt ? sum / cnt : 0;
  }
  return out;
}

/**
 * Compute the best NCC of two (GRID_H, GRID_W) features over small shifts.
 *
 * Absorbs scanner feed offsets (a sheet placed a few mm off) that would
 * otherwise cost a page its match. r is in grid cells.
 */
export function shiftDot(a, b, r = 3, w = GRID_W, h = GRID_H) {
  let best = -Infinity;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      let s = 0;
      const y0 = Math.max(0, -dy);
      const y1 = Math.min(h, h - dy);
      const x0 = Math.max(0, -dx);
      const x1 = Math.min(w, w - dx);
      for (let y = y0; y < y1; y++) {
        const ra = y * w;
        const rb = (y + dy) * w + dx;
        for (let x = x0; x < x1; x++) s += a[ra + x] * b[rb + x];
      }
      if (s > best) best = s;
    }
  }
  return best;
}

/** Center and normalize a vector in place. */
function unit(c) {
  let m = 0;
  for (const x of c) m += x;
  m /= c.length;
  let ss = 0;
  for (let i = 0; i < c.length; i++) {
    c[i] -= m;
    ss += c[i] * c[i];
  }
  const nrm = Math.sqrt(ss) + 1e-12;
  for (let i = 0; i < c.length; i++) c[i] /= nrm;
  return c;
}

/** Average features into a unit-norm consensus vector. */
function consensus(vs) {
  const c = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i];
  return unit(c);
}

/** Split pages into two clusters by spherical k-means. */
function twoMeans(F, idx, S, n, nIter = 20) {
  let lo = Infinity;
  let seed = [0, 1];
  for (let a = 0; a < idx.length; a++) {
    for (let b = a + 1; b < idx.length; b++) {
      const s = S[idx[a] * n + idx[b]];
      if (s < lo) { lo = s; seed = [a, b]; }
    }
  }
  let c = seed.map((a) => F[idx[a]]);
  const sub = new Int32Array(idx.length);
  for (let it = 0; it < nIter; it++) {
    for (let a = 0; a < idx.length; a++) {
      sub[a] = dot(F[idx[a]], c[1]) > dot(F[idx[a]], c[0]) ? 1 : 0;
    }
    const g = [[], []];
    idx.forEach((p, a) => g[sub[a]].push(F[p]));
    if (!g[0].length || !g[1].length) break;
    c = g.map(consensus);
  }
  return { sub, c };
}

/**
 * Cluster pages into types by bisecting spherical k-means.
 *
 * A cluster splits when its two halves' consensus images correlate below
 * splitNcc: handwriting averages out of a consensus, so halves of one
 * printed page stay correlated while different printed pages do not.
 *
 * @param {Float32Array[]} F features by page index
 * @param {number[]} idx (m,) page indices to cluster, none blank
 * @returns {{labels: Int32Array, cons: Float32Array[]}} labels (m,),
 *   numbered by first appearance in idx; cons (k,) consensus per type
 */
export function pageTypes(F, idx, S, n, splitNcc = 0.8, minSize = 3) {
  const m = idx.length;
  let lab = new Int32Array(m);
  if (!m) return { labels: lab, cons: [] };
  let next = 1;
  const queue = [0];
  while (queue.length) {
    const k = queue.pop();
    const mem = [];
    for (let a = 0; a < m; a++) if (lab[a] === k) mem.push(a);
    if (mem.length < 2 * minSize) continue;
    const { sub, c } = twoMeans(F, mem.map((a) => idx[a]), S, n);
    const n1 = sub.reduce((s, x) => s + x, 0);
    if (Math.min(n1, mem.length - n1) < minSize) continue;
    if (dot(c[0], c[1]) < splitNcc) {
      mem.forEach((a, j) => { if (sub[j]) lab[a] = next; });
      queue.push(k, next);
      next++;
    }
  }
  let cons = [];
  for (let k = 0; k < next; k++) {
    const vs = idx.filter((_, a) => lab[a] === k).map((p) => F[p]);
    if (vs.length) cons.push(consensus(vs));
  }
  // final assignment to nearest consensus, shift-tolerant, relabelled by
  // first appearance
  const raw = idx.map((p) => argmax(cons.map((c) => shiftDot(F[p], c))));
  const order = [];
  for (const r of raw) if (!order.includes(r)) order.push(r);
  lab = Int32Array.from(raw, (r) => order.indexOf(r));
  cons = order.map((k) => {
    const vs = idx.filter((_, a) => lab[a] === order.indexOf(k)).map((p) => F[p]);
    return consensus(vs);
  });
  return { labels: lab, cons };
}

export function argmax(xs) {
  let b = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[b]) b = i;
  return b;
}

/**
 * Estimate exam length (in sheets) from the sheet-type sequence.
 *
 * Picks the smallest lag whose label agreement is within 90% of the best,
 * so multiples of the true period are not preferred; window is the most
 * common run of that many labels, phased from the stack start (a stack
 * starts on an exam's first sheet).
 *
 * @param {number[]} labels (n,) type per sheet in stack order
 * @returns {{p: number, agree: number, window: number[]}}
 */
export function period(labels, maxP = 8) {
  const n = labels.length;
  const agree = [];
  for (let p = 1; p < Math.min(maxP, n); p++) {
    let s = 0;
    for (let i = 0; i + p < n; i++) s += labels[i] === labels[i + p];
    agree.push(s / (n - p));
  }
  if (!agree.length) return { p: 1, agree: 1, window: labels.slice(0, 1) };
  const best = Math.max(...agree);
  const p = agree.findIndex((a) => a >= 0.9 * best) + 1;
  const counts = new Map();
  for (let i = 0; i + p <= n; i += p) {
    const key = labels.slice(i, i + p).join(',');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { p, agree: agree[p - 1], window: top.split(',').map(Number) };
}
