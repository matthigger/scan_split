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

/**
 * Decide whether each sheet's back was scanned too (pages pair up).
 *
 * Either blank pages sit on one parity of each file's pages (blank backs),
 * or pages 2 apart match far better than neighbours (every front alike).
 *
 * @param {number[]} lag from lagSim
 * @param {boolean[]} blank (N,) per page
 * @param {number[]} pos (N,) each page's index within its file
 */
export function isDuplex(lag, blank, pos) {
  const n = [0, 0];
  const b = [0, 0];
  pos.forEach((p, i) => { n[p % 2]++; b[p % 2] += blank[i]; });
  const gap = n[0] && n[1] ? Math.abs(b[0] / n[0] - b[1] / n[1]) : 0;
  return gap > 0.3 || lag[1] > 3 * Math.max(lag[0], 0.02);
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
 * Find the shift of b against a that maximizes their overlap dot product.
 *
 * Absorbs scanner feed offsets (a sheet placed a few mm off). r and the
 * returned dy, dx are in grid cells; b's content sits dy, dx cells further
 * down / right than a's.
 *
 * @returns {{dy: number, dx: number, s: number}}
 */
export function bestShift(a, b, r = 3, w = GRID_W, h = GRID_H) {
  let best = { dy: 0, dx: 0, s: -Infinity };
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
      if (s > best.s) best = { dy, dx, s };
    }
  }
  return best;
}

/** Compute the best NCC of two features over small shifts. */
export function shiftDot(a, b, r = 3) {
  return bestShift(a, b, r).s;
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
export function consensus(vs) {
  const c = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i];
  return unit(c);
}

/**
 * Split pages into two clusters by spherical k-means.
 *
 * Seeded by the sign of each page's projection on the members' principal
 * direction (Boley 1998, principal direction divisive partitioning): a
 * printed difference between versions is one consistent direction, while
 * handwriting spreads over many, so the seed follows printed content.
 */
function twoMeans(F, idx, S, n, nIter = 20) {
  const m = idx.length;
  const d = F[idx[0]].length;
  const mean = new Float32Array(d);
  for (const p of idx) for (let i = 0; i < d; i++) mean[i] += F[p][i] / m;
  // power iteration for the top principal direction, from the member
  // farthest from the mean
  let far = idx[0];
  let farD = -Infinity;
  for (const p of idx) {
    let q = 0;
    for (let i = 0; i < d; i++) q += (F[p][i] - mean[i]) ** 2;
    if (q > farD) { farD = q; far = p; }
  }
  let v = F[far].map((x, i) => x - mean[i]);
  const proj = new Float32Array(m);
  for (let it = 0; it < 25; it++) {
    const mv = dot(mean, v);
    idx.forEach((p, a) => { proj[a] = dot(F[p], v) - mv; });
    const w = new Float32Array(d);
    idx.forEach((p, a) => {
      const f = F[p];
      for (let i = 0; i < d; i++) w[i] += proj[a] * (f[i] - mean[i]);
    });
    const nrm = Math.sqrt(dot(w, w)) + 1e-12;
    v = w.map((x) => x / nrm);
  }
  const mv = dot(mean, v);
  const sub = new Int32Array(m);
  idx.forEach((p, a) => { sub[a] = dot(F[p], v) - mv > 0 ? 1 : 0; });
  const g = [[], []];
  idx.forEach((p, a) => g[sub[a]].push(F[p]));
  if (!g[0].length || !g[1].length) return { sub, c: [consensus(idx.map((p) => F[p])), mean] };
  let c = g.map(consensus);
  for (let it = 0; it < nIter; it++) {
    for (let a = 0; a < m; a++) {
      sub[a] = dot(F[idx[a]], c[1]) > dot(F[idx[a]], c[0]) ? 1 : 0;
    }
    const h = [[], []];
    idx.forEach((p, a) => h[sub[a]].push(F[p]));
    if (!h[0].length || !h[1].length) break;
    c = h.map(consensus);
  }
  return { sub, c };
}

// children whose plain NCCs differ by less than this get a shift-tolerant
// second look
const CLOSE = 0.1;

/**
 * Lazily built bisection tree of pages; page types are a cut through it.
 *
 * Each node holds a set of pages and their consensus. A node's children
 * split it by spherical 2-means, computed on first request and then fixed,
 * so moving the cut up (merge) or down (split) never reshuffles anything.
 * A node's score is the NCC between its children's consensus images:
 * handwriting averages out of a consensus, so the halves of one printed page
 * score near 1 and two different printed pages score low.
 *
 * Node: {id, members, cons, parent, children, score, first}; members are
 * page indices, children is undefined until computed and null for a node
 * that cannot split (one page, or identical pages), first is the earliest
 * member in the stack.
 */
export class TypeTree {
  /**
   * @param {Float32Array[]} F features by page index
   * @param {number[]} idx page indices to organize, none blank, non-empty
   */
  constructor(F, idx, S, n, minSize = 3) {
    Object.assign(this, { F, S, n, minSize });
    this.nodes = [];
    this.root = this.make(idx, null);
  }

  make(members, parent) {
    const node = {
      id: this.nodes.length,
      members,
      cons: consensus(members.map((p) => this.F[p])),
      parent,
      children: undefined,
      score: 1,
      first: Math.min(...members),
    };
    this.nodes.push(node);
    return node;
  }

  /** Return a node's two children, ordered by first page, or null. */
  children(node) {
    if (node.children !== undefined) return node.children;
    node.children = null;
    const mem = node.members;
    if (mem.length < 2) return null;
    const { sub, c } = twoMeans(this.F, mem, this.S, this.n);
    for (let a = 0; a < mem.length; a++) {
      const v = this.F[mem[a]];
      if (Math.abs(dot(v, c[0]) - dot(v, c[1])) < CLOSE) {
        sub[a] = shiftDot(v, c[1]) > shiftDot(v, c[0]) ? 1 : 0;
      }
    }
    const g = [[], []];
    mem.forEach((p, a) => g[sub[a]].push(p));
    if (!g[0].length || !g[1].length) return null;
    g.sort((x, y) => Math.min(...x) - Math.min(...y));
    node.children = g.map((m) => this.make(m, node));
    node.score = dot(node.children[0].cons, node.children[1].cons);
    return node.children;
  }

  /**
   * Cut the tree where a split would only separate handwriting.
   *
   * Splits leaving fewer than minSize pages on a side are outliers, not a
   * page type; they stay available to split by hand.
   */
  autoCut(splitNcc = 0.8, node = this.root) {
    const kids = this.children(node);
    if (!kids || node.score >= splitNcc ||
        Math.min(kids[0].members.length, kids[1].members.length) < this.minSize) {
      return [node];
    }
    return [...this.autoCut(splitNcc, kids[0]),
      ...this.autoCut(splitNcc, kids[1])];
  }

  /** Test whether node lies in the subtree under anc. */
  static within(node, anc) {
    for (let x = node; x; x = x.parent) if (x === anc) return true;
    return false;
  }
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
