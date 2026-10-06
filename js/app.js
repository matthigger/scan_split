/**
 * scan_split UI: load scanned PDFs, match pages, route copies, export.
 *
 * Flow: render every page small (pdf.js) -> features (pipeline.js) ->
 * layouts, one per printed page: a cut through a layout tree learned from
 * the scans (the user moves it by splitting or merging) or, when page
 * templates are loaded, one per template page plus any groups no template
 * matches -> parts, each one or more layouts in page order (the user joins
 * and separates them) -> copies: runs of consecutive sheets stepping
 * through a part's pages, one per student -> parts, and single copies, are
 * routed to named outputs or discarded -> export copies the original pages
 * (pdf-lib), so scan quality is untouched.
 *
 * A sheet is {front, back} page indices; back is null unless the stack is
 * in blank-back mode (each sheet's blank back scanned after its front).
 * Loading ?src=a.pdf,b.pdf fetches those URLs instead of waiting for a drop.
 */
import * as pdfjsLib from '../vendor/pdf.min.mjs';
import * as P from './pipeline.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../vendor/pdf.worker.min.mjs', import.meta.url).href;

// thumbnail / render size; features are this shrunk by DOWN
const TW = 256;
const TH = 332;
const DOWN = TW / P.GRID_W;
// high-resolution consensus for the inspector: width, and pages averaged
const HI_W = 800;
const HI_N = 10;
const COLORS = ['#3b73d9', '#e0762b', '#3f9d58', '#d64550', '#8a5cc7',
  '#1f9e9e', '#c49a1a', '#d45fa6', '#7a6a58', '#5d7a8c'];
// layout of a blank sheet, and the part holding blank sheets
const BLANK = -1;
const BLANK_PART = 'blank';
const DISCARD = 'discard';
const LOW_MARGIN = 0.1;
const AUTO_SPLIT = 0.8;
// a group of sheets does not match its template when its average scores
// below MATCH_LO, or MATCH_GAP below the template's best group (real and
// example scans: true template 0.73+, other version of the question up to
// 0.64, other questions up to 0.52)
const MATCH_LO = 0.65;
const MATCH_GAP = 0.12;
// smaller groups are not judged: their average still carries handwriting
const MIN_JUDGE = 5;
// layouts correlating above this are the same printed page (a cover shared
// by two versions of a quiz): no image can tell them apart
const TWIN = 0.99;
// ink levels below the paper tone kept in features (see clip): above a
// tinted paper's texture, below the white of a colored sheet's cut corner
const PAPER_SLACK = 16;
const TPL_BASE = 100000;
const STRAY_BASE = 200000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  // {name, bytes, doc, nPages, start}
  files: [],
  // {file, idx, thumb, v, energy, ink, blank}
  pages: [],
  // {front, back, layout, margin, flipped, dest, part, copy, page}; layout
  // is the id of the shown layout holding the front, or BLANK; dest null =
  // the part's default; copy indexes state.copies (-1 for a blank sheet)
  // and page is the sheet's place in its part
  sheets: [],
  // P.LayoutTree over non-blank sheet fronts, or null (also with templates)
  tree: null,
  // {name, stem, file, idx, v, thumb}: blank page templates to sort against
  templates: [],
  // the shown parts in display order, each an array of its layout nodes
  // (tree nodes, or template and stray nodes) in page order; together they
  // hold every shown layout once
  groups: [],
  // part key (keyOf) -> {id, label, color, out, dest}; out is the part's
  // own output, dest where its copies go; kept when the part is undone
  meta: new Map(),
  blankMeta: { id: BLANK_PART, label: 'Blank', color: '#9a9aa2', dest: DISCARD },
  // shown parts: meta entries plus {nodes, imgs, n, nIncomplete, nSheets};
  // n and nIncomplete count complete and incomplete copies
  parts: [],
  // {part, start, next, sheets, complete}: a run of consecutive sheets
  // holding a part's pages start .. next - 1, in stack order
  copies: [],
  // {id, name, part?}; part set for a part's own output, unset for one
  // made with "+ new output"
  outputs: [],
  S: null,
  typ: null,
  blankBackAuto: false,
  blankBackMode: 'auto',
  period: null,
  selected: new Set(),
  anchor: null,
  filter: 'all',
  omitBlankBacks: false,
  // fill a copy's missing pages with blank ones on export
  padMissing: true,
  // a notice shown once above the parts
  partsMsg: null,
  inContext: new Set(),
  pdfLib: new Map(),
  imgCache: new Map(),
  hiCache: new Map(),
};
window.scanSplit = state;

/* ---------- loading ---------- */

async function addFiles(items) {
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  showProgress(true, 'Opening files…', 0);
  const opened = [];
  for (const it of items) {
    try {
      // pdf.js may detach the buffer it is given; keep the original for export
      const doc = await pdfjsLib.getDocument({ data: it.bytes.slice() }).promise;
      opened.push({ name: it.name, bytes: it.bytes, doc, nPages: doc.numPages });
    } catch (e) {
      alert(`Could not open ${it.name}: ${e.message}`);
    }
  }
  const total = opened.reduce((s, f) => s + f.nPages, 0);
  let done = 0;
  const t0 = performance.now();
  for (const file of opened) {
    file.start = state.pages.length;
    state.files.push(file);
    for (let i = 0; i < file.nPages; i++) {
      state.pages.push(await renderPage(file, i));
      done++;
      if (done % 4 === 0 || done === total) {
        const eta = (performance.now() - t0) / done * (total - done) / 1000;
        showProgress(true, `Reading page ${done} of ${total}` +
          (done < total ? ` · ~${Math.ceil(eta)} s left` : ''), done / total);
      }
    }
  }
  renderFiles();
  showProgress(true, 'Comparing pages…', 1);
  await new Promise((r) => setTimeout(r, 20));
  const t1 = performance.now();
  analyze();
  state.timing = { renderMs: t1 - t0, analyzeMs: performance.now() - t1 };
  showProgress(false);
  renderAll();
  document.body.dataset.state = 'ready';
}

/** Render one page to a thumbnail and its (GRID_H, GRID_W) feature. */
async function renderPage(file, idx) {
  const page = await file.doc.getPage(idx + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: TW / vp1.width });
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = Math.round(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  // stretch to a fixed grid so every page's feature has the same length
  const { ink: raw, paper } = inkOf(c, TW, TH);
  const ink = clip(raw, paper - PAPER_SLACK);
  const { v } = P.featurize(P.downsample(ink, TW, TH, DOWN));
  const { energy } = P.featurize(P.downsample(clip(raw, paper), TW, TH, DOWN));
  return { file, idx, thumb: URL.createObjectURL(blob), v, energy, ink };
}

/**
 * Subtract a floor from ink, so anything lighter is no ink.
 *
 * On colored paper, the white scanner bed past a cut corner and the
 * scanner's light shading bands would otherwise read as ink: blank backs
 * look inked and every page matches white templates poorly. Features clip
 * PAPER_SLACK below the paper tone, keeping faint paper texture (white
 * paper is untouched); blank detection clips at the paper tone itself, as a
 * page is blank when nothing on it is darker than its paper.
 */
const clip = (ink, floor) => ink.map((x) => Math.max(0, x - Math.max(0, floor)));

/**
 * Read a canvas, stretched to (h, w), as ink (255 - luma).
 * @returns {{ink: Uint8Array, paper: number}} ink (h * w,); paper, the
 *   page's median ink, is its paper tone
 */
function inkOf(src, w, h) {
  const f = document.createElement('canvas');
  f.width = w;
  f.height = h;
  const ctx = f.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0; i < ink.length; i++) {
    ink[i] = 255 - Math.round(0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] +
      0.114 * rgba[4 * i + 2]);
    hist[ink[i]]++;
  }
  let paper = 0;
  for (let c = hist[0]; c < ink.length / 2; c += hist[++paper]);
  return { ink, paper };
}

/* ---------- analysis ---------- */

function analyze() {
  const pages = state.pages;
  const blank = P.blankMask(Float32Array.from(pages, (p) => p.energy));
  pages.forEach((p, i) => { p.blank = blank[i]; });
  state.S = P.simMatrix(pages.map((p) => (p.blank ? null : p.v)));
  state.blankBackAuto = P.hasBlankBacks(pages.map((p) => p.blank), pages.map((p) => p.idx));
  state.typ = P.typicality(state.S, pages.length);
  cluster();
}

const blankBacks = () => (state.blankBackMode === 'auto'
  ? state.blankBackAuto : state.blankBackMode === 'on');

/**
 * Make sheets from pages: in blank-back mode each page and the one after it
 * (within a file) form a sheet; otherwise every page stands alone.
 */
function buildSheets() {
  const sheets = [];
  if (blankBacks()) {
    for (const f of state.files) {
      for (let i = 0; i < f.nPages; i += 2) {
        const a = f.start + i;
        const b = i + 1 < f.nPages ? a + 1 : null;
        // the front is the side with ink; when both have some (work on the
        // back), the side that best matches a template or, without
        // templates, the side with near-copies elsewhere in the stack
        let flip = false;
        if (b !== null) {
          const [ba, bb] = [state.pages[a].blank, state.pages[b].blank];
          flip = ba !== bb ? ba : frontScore(b) > frontScore(a);
        }
        sheets.push({ front: flip ? b : a, back: flip ? a : b, flipped: flip });
      }
    }
  } else {
    state.pages.forEach((_, i) => sheets.push({ front: i, back: null, flipped: false }));
  }
  state.sheets = sheets.map((s) => ({ ...s, layout: BLANK, margin: 1, dest: null }));
}

function frontScore(i) {
  const p = state.pages[i];
  if (!state.templates.length) return state.typ[i];
  return p.blank ? 0 : Math.max(...state.templates.map((t) => P.dot(p.v, t.v)));
}

/** Pair sheets and find layouts and parts, from templates or a learned tree. */
function cluster() {
  buildSheets();
  const pages = state.pages;
  const idx = state.sheets.filter((s) => !pages[s.front].blank).map((s) => s.front);
  state.tree = idx.length && !state.templates.length
    ? new P.LayoutTree(pages.map((p) => p.v), idx, state.S, pages.length) : null;
  state.meta.clear();
  state.inContext = new Set();
  state.outputs = [];
  state.imgCache.clear();
  state.hiCache.clear();
  state.selected.clear();
  state.filter = 'all';
  if (state.templates.length) templateCut(idx); else autoCut();
}

/** Return the index of the candidate feature closest to v, shift-tolerant. */
function nearest(v, cands) {
  const top = cands.map((c, i) => [P.dot(v, c), i]).sort((a, b) => b[0] - a[0]).slice(0, 3);
  let best = -Infinity;
  let k = 0;
  for (const [, i] of top) {
    const sc = P.shiftDot(v, cands[i]);
    if (sc > best) { best = sc; k = i; }
  }
  return k;
}

/**
 * Sort sheet fronts to templates, setting aside groups no template matches.
 *
 * Each front goes to its nearest template; among twin templates (TWIN),
 * to the one its neighbouring sheets continue, as a copy's pages are
 * consecutive. A tree over each template's fronts is walked down its
 * genuine splits (halves that differ in printed content, as in autoCut); a
 * resulting group big enough to judge is set aside when its average matches
 * the template poorly, or clearly worse than the template's best group
 * (another version of the same question). The set-aside fronts are pooled
 * and grouped by their own learned tree.
 *
 * @param {number[]} idx page indices of non-blank sheet fronts, stack order
 */
function templateCut(idx) {
  const pages = state.pages;
  const F = pages.map((p) => p.v);
  const T = state.templates;
  const near = idx.map((p) => nearest(F[p], T.map((t) => t.v)));
  const twins = T.map((t) => T.flatMap((u, j) => (P.shiftDot(t.v, u.v) > TWIN ? [j] : [])));
  // template k is the page after template j of the same file
  const follows = (j, k) => k === j + 1 && T[k].file === T[j].file;
  near.forEach((k, a) => {
    if (twins[k].length < 2) return;
    const fit = (j) => (a + 1 < idx.length && follows(j, near[a + 1])) +
      (a > 0 && follows(near[a - 1], j));
    near[a] = twins[k].reduce((b, j) => (fit(j) > fit(b) ? j : b), k);
  });
  // a front next to the neighbouring page of its own template file is
  // vouched for, whatever parts it is later stapled into (see flagged)
  state.inContext = new Set(idx.filter((p, a) =>
    (a > 0 && follows(near[a - 1], near[a])) ||
    (a + 1 < idx.length && follows(near[a], near[a + 1]))));
  const groups = T.map(() => []);
  idx.forEach((p, a) => groups[near[a]].push(p));
  const aside = new Set();
  // per template, the groups judged and their scores (for inspection)
  state.tplLeaves = [];
  groups.forEach((mem, k) => {
    if (!mem.length) return;
    const tree = new P.LayoutTree(F, mem, state.S, pages.length);
    const leaves = [];
    const walk = (node) => {
      const kids = node.members.length >= 2 * MIN_JUDGE ? tree.children(node) : null;
      const real = kids && node.score < AUTO_SPLIT &&
        Math.min(kids[0].members.length, kids[1].members.length) >= MIN_JUDGE;
      if (real) kids.forEach(walk); else leaves.push(node);
    };
    walk(tree.root);
    const sc = leaves.map((n) => P.shiftDot(n.cons, T[k].v));
    const best = Math.max(...sc);
    state.tplLeaves.push(...leaves.map((n, j) => ({ template: T[k].name, n: n.members.length, score: sc[j] })));
    leaves.forEach((n, j) => {
      if (n.members.length >= MIN_JUDGE && (sc[j] < MATCH_LO || sc[j] < best - MATCH_GAP)) {
        n.members.forEach((p) => aside.add(p));
      }
    });
  });
  const tplNodes = T.map((t, k) => ({
    id: TPL_BASE + k, members: groups[k].filter((p) => !aside.has(p)), cons: t.v, template: t,
  }));
  let strayNodes = [];
  if (aside.size) {
    const tree = new P.LayoutTree(F, [...aside], state.S, pages.length);
    strayNodes = tree.autoCut(AUTO_SPLIT).map((n, j) => ({
      id: STRAY_BASE + j, members: n.members, cons: n.cons }));
  }
  const cut = [...tplNodes, ...strayNodes];
  for (const n of cut) {
    n.parent = null;
    n.children = null;
    n.first = n.members.length ? Math.min(...n.members) : Infinity;
  }
  // a part per template file (a PDF per question) or, from a single file
  // (the whole exam), a part per page, for the user to join
  const byFile = new Set(T.map((t) => t.file)).size > 1;
  state.groups = [];
  for (const n of tplNodes) {
    const last = state.groups.at(-1);
    if (byFile && last && last[0].template.file === n.template.file) last.push(n);
    else state.groups.push([n]);
  }
  for (const n of strayNodes) state.groups.push([n]);
  let k = 0;
  for (const g of state.groups) {
    if (g[0].template) {
      // parts nothing matched get no letter; their cards are hidden
      const label = g.some((n) => n.members.length) ? letter(k++) : '';
      newMeta(g, label, COLORS[(k + COLORS.length - 1) % COLORS.length],
        g.length > 1 ? g[0].template.stem : g[0].template.name);
    } else {
      const j = g[0].id - STRAY_BASE + 1;
      newMeta(g, `?${j}`, '#8d8d94', `no_template_${j}`);
    }
  }
  assign();
}

/** Show the tree's automatic cut as one-page parts; keeps names and per-sheet routing. */
function autoCut() {
  const cut = state.tree ? state.tree.autoCut(AUTO_SPLIT) : [];
  state.groups = cut.map((n) => [n]);
  cut.forEach((node, k) => {
    const m = state.meta.get(keyOf([node])) ??
      newMeta([node], letter(k), COLORS[k % COLORS.length], `part_${letter(k)}`);
    m.dest = m.out;
    // look ahead so each card knows whether it can split
    state.tree.children(node);
  });
  assign();
}

/** Key a part by its layouts, in page order. */
const keyOf = (nodes) => nodes.map((n) => n.id).join('+');

/** Create a part's display entry and its own output, routed there. */
function newMeta(nodes, label, color, name, discard = false) {
  const key = keyOf(nodes);
  // a key can recur (a page moved out and back) after its old output stays
  const used = (id) => state.outputs.some((o) => o.id === id);
  let id = `n${key}`;
  for (let k = 2; used(id); k++) id = `n${key}~${k}`;
  const out = { id, name, part: key };
  state.outputs.push(out);
  const m = { id: key, label, color, out: out.id, dest: discard ? DISCARD : out.id };
  state.meta.set(key, m);
  return m;
}

const letter = (k) => (k < 26 ? String.fromCharCode(65 + k) : `T${k}`);

/**
 * Give each sheet the shown layout holding its front and a match margin,
 * then gather the parts (see regroup).
 */
function assign() {
  const pages = state.pages;
  const cut = state.groups.flat();
  const owner = new Map();
  for (const node of cut) for (const p of node.members) owner.set(p, node);
  // a sheet's margin is over the other layouts, twins aside (TWIN)
  const rivals = new Map(cut.map((n) => [n,
    cut.filter((m) => m !== n && P.dot(n.cons, m.cons) <= TWIN)]));
  for (const s of state.sheets) {
    const node = owner.get(s.front);
    if (!node) { s.layout = BLANK; s.margin = 1; continue; }
    s.layout = node.id;
    const v = pages[s.front].v;
    const others = rivals.get(node);
    if (!others.length) { s.margin = P.dot(v, node.cons); continue; }
    s.margin = P.dot(v, node.cons) - Math.max(...others.map((m) => P.dot(v, m.cons)));
    if (s.margin < LOW_MARGIN) {
      s.margin = P.shiftDot(v, node.cons) - Math.max(...others.map((m) => P.shiftDot(v, m.cons)));
    }
  }
  const blanks = state.sheets.filter((s) => s.layout === BLANK);
  state.blankImg = blanks.length ? consensusImage(blanks.map((s) => pages[s.front])) : null;
  regroup();
}

/**
 * Gather the parts from the groups and cut the stack into copies.
 *
 * Margins depend only on which layouts are shown, not on how they are
 * grouped, so moving pages between parts needs this alone, not assign.
 */
function regroup() {
  state.parts = state.groups.map((nodes) => Object.assign(state.meta.get(keyOf(nodes)), {
    nodes, imgs: nodes.map((n) => (n.template ? n.template.thumb : nodeImage(n))),
  }));
  if (state.blankImg) {
    state.parts.push(Object.assign(state.blankMeta, { nodes: [], imgs: [state.blankImg] }));
  }
  cutCopies();
  for (const t of state.parts) {
    const cs = state.copies.filter((c) => c.part === t);
    t.n = cs.filter((c) => c.complete).length;
    t.nIncomplete = cs.length - t.n;
    t.nSheets = state.sheets.filter((s) => s.part === t.id).length;
  }
  state.period = P.period(state.sheets.map((s) => s.layout));
}

/**
 * Cut the stack into copies: runs of consecutive sheets stepping through a
 * part's pages in order, one per student.
 *
 * Blank sheets between pages are skipped over. A run starting past a
 * part's first page, or stopping before its last, is an incomplete copy;
 * in a one-page part every sheet is a complete copy.
 */
function cutCopies() {
  const at = new Map();
  for (const t of state.parts) t.nodes.forEach((n, j) => at.set(n.id, [t, j]));
  const copies = [];
  let open = null;
  const close = () => {
    if (!open) return;
    open.complete = open.start === 0 && open.next === open.part.nodes.length;
    copies.push(open);
    open = null;
  };
  state.sheets.forEach((s, i) => {
    s.copy = -1;
    s.page = 0;
    if (s.layout === BLANK) { s.part = BLANK_PART; return; }
    const [t, j] = at.get(s.layout);
    s.part = t.id;
    s.page = j;
    if (!(open && open.part === t && open.next === j)) {
      close();
      open = { part: t, start: j, next: j, sheets: [] };
    }
    // the index open gets once closed
    s.copy = copies.length;
    open.sheets.push(i);
    open.next++;
    if (open.next === t.nodes.length) close();
  });
  close();
  state.copies = copies;
}

function nodeImage(node) {
  if (!state.imgCache.has(node.id)) {
    state.imgCache.set(node.id, consensusImage(node.members.map((p) => state.pages[p])));
  }
  return state.imgCache.get(node.id);
}

/** Average member pages into a picture of the printed template. */
function consensusImage(pages) {
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(TW, TH);
  const acc = new Float32Array(TW * TH);
  const use = sample(pages, 80);
  for (const p of use) for (let i = 0; i < acc.length; i++) acc[i] += p.ink[i];
  for (let i = 0; i < acc.length; i++) {
    const g = 255 - (use.length ? acc[i] / use.length : 0);
    img.data.set([g, g, g, 255], 4 * i);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** Move a (h, w) ink image by (dy, dx) pixels, filling with no ink. */
function shifted(ink, w, h, dy, dx) {
  if (!dy && !dx) return ink;
  const out = new Uint8Array(w * h);
  for (let y = Math.max(0, dy); y < Math.min(h, h + dy); y++) {
    const src = (y - dy) * w;
    for (let x = Math.max(0, dx); x < Math.min(w, w + dx); x++) out[y * w + x] = ink[src + x - dx];
  }
  return out;
}

/** Pick up to k items spread evenly through xs. */
function sample(xs, k) {
  if (xs.length <= k) return xs;
  return Array.from({ length: k }, (_, i) => xs[Math.floor(i * xs.length / k)]);
}

/* ---------- split / merge / join / separate ---------- */

const node = (id) => state.tree.nodes[id];
const groupOf = (key) => state.groups.find((g) => keyOf(g) === key);
const layoutNode = (id) => state.groups.flat().find((n) => n.id === id);

function unusedColor() {
  const used = new Set(state.groups.map((g) => state.meta.get(keyOf(g)).color));
  return COLORS.find((c) => !used.has(c)) ?? COLORS[state.groups.length % COLORS.length];
}

/** Replace a one-page part by its layout's two children, each a part with its own output. */
function splitPart(key) {
  const g = groupOf(key);
  const kids = state.tree.children(g[0]);
  if (!kids) return;
  const m = state.meta.get(key);
  kids.forEach((k, j) => {
    if (!state.meta.has(keyOf([k]))) {
      newMeta([k], `${m.label}.${j + 1}`, j ? unusedColor() : m.color,
        `${outputName(m.out)}_${j + 1}`, m.dest === DISCARD);
    }
    state.tree.children(k);
  });
  state.groups.splice(state.groups.indexOf(g), 1, ...kids.map((k) => [k]));
  assign();
  renderPartsAndBelow();
}

/**
 * Find what merging a one-page part folds together: every shown layout
 * under its layout's parent.
 *
 * @returns {{under: object[][], blocked: string|null}} under: the parts'
 *   groups, this one included (empty without a parent); blocked: the label
 *   of a multi-page part among them, which must be separated first
 */
function mergeSet(key) {
  const parent = groupOf(key)[0].parent;
  if (!parent) return { under: [], blocked: null };
  const under = state.groups.filter((g) => g.some((n) => P.LayoutTree.within(n, parent)));
  const multi = under.find((g) => g.length > 1);
  return { under, blocked: multi ? state.meta.get(keyOf(multi)).label : null };
}

/** Labels of the other parts a merge would fold in with this one. */
function mergePartners(key) {
  return mergeSet(key).under.filter((g) => keyOf(g) !== key)
    .map((g) => state.meta.get(keyOf(g)).label);
}

/**
 * Replace every part under a layout's parent by the parent, as one part.
 *
 * A parent shown before keeps its old name and routing; a new one is named
 * after the parts it merges.
 */
function mergePart(key) {
  const { under, blocked } = mergeSet(key);
  if (under.length < 2 || blocked) return;
  const parent = groupOf(key)[0].parent;
  const at = state.groups.indexOf(under[0]);
  if (!state.meta.has(keyOf([parent]))) {
    const ms = under.map((g) => state.meta.get(keyOf(g)));
    newMeta([parent], ms.map((m) => m.label).join('+'), ms[0].color,
      ms.map((m) => outputName(m.out)).join('+'), ms.every((m) => m.dest === DISCARD));
  }
  state.groups = state.groups.filter((g) => !under.includes(g));
  state.groups.splice(at, 0, [parent]);
  assign();
  renderPartsAndBelow();
}

/**
 * Put a would-be part's layouts in page order.
 *
 * steps[a][b] counts sheets of layout b directly after one of layout a
 * (blank sheets skipped). An order is linked when every page follows the
 * one before it in at least half the sheets of the rarer of the two, as
 * copies are cut from runs of consecutive sheets; a stray neighbour (say,
 * across a missing sheet) is not enough. Template pages keep the templates' order; otherwise
 * the linked order with the most steps wins, ties going to stack order.
 *
 * @returns {{order: object[], linked: boolean}}
 */
function pageOrder(nodes) {
  const byFirst = [...nodes].sort((a, b) => (a.first - b.first) || 0);
  const at = new Map(byFirst.map((n, k) => [n.id, k]));
  const steps = byFirst.map(() => byFirst.map(() => 0));
  const count = byFirst.map(() => 0);
  let prev = null;
  for (const s of state.sheets) {
    if (s.layout === BLANK) continue;
    const j = at.get(s.layout) ?? null;
    if (j !== null) count[j]++;
    if (prev !== null && j !== null && j !== prev) steps[prev][j]++;
    prev = j;
  }
  const link = (a, b) =>
    steps[a][b] > 0 && 2 * steps[a][b] >= Math.min(count[a], count[b]);
  const ids = byFirst.map((_, k) => k);
  const linked = (p) => p.slice(1).every((k, i) => link(p[i], k));
  const pick = (p) => ({ order: p.map((k) => byFirst[k]), linked: linked(p) });
  if (nodes.every((n) => n.template)) {
    const T = state.templates;
    return pick([...ids].sort((a, b) =>
      T.indexOf(byFirst[a].template) - T.indexOf(byFirst[b].template)));
  }
  // a part longer than this keeps stack order
  if (ids.length > 8) return pick(ids);
  let best = null;
  const walk = (p, rest, sc) => {
    if (!rest.length) {
      if (!best || sc > best.sc) best = { p, sc };
      return;
    }
    for (const k of rest) {
      if (p.length && !link(p.at(-1), k)) continue;
      const st = p.length ? steps[p.at(-1)][k] : 0;
      walk([...p, k], rest.filter((x) => x !== k), sc + st);
    }
  };
  walk([], ids, 0);
  return pick(best ? best.p : ids);
}

/** Move a part's display entry and output to a new set of layouts. */
function rekey(m, nodes) {
  const key = keyOf(nodes);
  state.meta.delete(m.id);
  m.id = key;
  state.meta.set(key, m);
  state.outputs.find((o) => o.id === m.out).part = key;
  return m;
}

/** Cut layouts into runs that can stay stapled, in page order. */
function runs(nodes) {
  const { order, linked } = pageOrder(nodes);
  if (linked) return [order];
  const out = [[order[0]]];
  for (const n of order.slice(1)) {
    if (pageOrder([out.at(-1).at(-1), n]).linked) out.at(-1).push(n);
    else out.push([n]);
  }
  return out;
}

/**
 * Why a layout cannot be dropped on each target, or null where it can.
 *
 * Targets are lane keys, 'new' and 'trash'; a drop that would change
 * nothing (onto its own lane, a one-page lane onto 'new') is left out.
 * A lane accepts a page only if its pages still run consecutively in the
 * scans (pageOrder).
 *
 * @returns {Map<string, string|null>}
 */
function dropTargets(id) {
  const n = layoutNode(id);
  const src = state.groups.find((g) => g.includes(n));
  const trashed = state.meta.get(keyOf(src)).dest === DISCARD;
  const why = new Map();
  for (const t of state.parts) {
    if (t.id === BLANK_PART || t.dest === DISCARD || t.nodes === src || !t.nSheets) continue;
    why.set(t.id, pageOrder([...t.nodes, n]).linked ? null
      : 'not consecutive with these pages in the scans');
  }
  if (trashed || src.length > 1) why.set('new', null);
  if (!trashed) why.set('trash', null);
  return why;
}

/**
 * Move one layout (a page tile) to a lane, a new lane ('new') or the trash.
 *
 * A lane keeps its name and output as pages come and go; a lane left
 * unable to stay stapled (its middle page taken) falls apart into runs
 * (see runs), the first keeping the name. A page leaving a multi-page lane
 * gets its own output, named after its template or its old lane and page.
 *
 * @returns {string|null} a notice for the user, or null
 */
function movePage(id, target) {
  const n = layoutNode(id);
  const src = state.groups.find((g) => g.includes(n));
  const sm = state.meta.get(keyOf(src));
  const rest = src.filter((x) => x !== n);
  // labels and colors in use, read before any lane is rekeyed
  const ms = state.groups.map((g) => state.meta.get(keyOf(g)));
  const taken = new Set(ms.map((m) => m.label));
  const label = () => {
    let k = 0;
    while (taken.has(letter(k))) k++;
    taken.add(letter(k));
    return letter(k);
  };
  const tints = new Set(ms.map((m) => m.color));
  const color = () => {
    const c = COLORS.find((x) => !tints.has(x)) ?? COLORS[tints.size % COLORS.length];
    tints.add(c);
    return c;
  };
  const srcName = outputName(sm.out);
  const pieces = rest.length ? runs(rest) : [];
  if (pieces.length) rekey(sm, pieces[0]);
  pieces.slice(1).forEach((g, j) => newMeta(g, label(), color(),
    g.length === 1 && g[0].template ? g[0].template.name : `${srcName}_${j + 2}`,
    sm.dest === DISCARD));
  let moved = [n];
  let dst = null;
  if (target === 'new' || target === 'trash') {
    const m = rest.length
      ? newMeta(moved, label(), color(),
        n.template ? n.template.name : `${srcName}_p${src.indexOf(n) + 1}`)
      : rekey(sm, moved);
    m.dest = target === 'trash' ? DISCARD : m.out;
  } else {
    dst = groupOf(target);
    moved = pageOrder([...dst, n]).order;
    rekey(state.meta.get(target), moved);
  }
  const groups = [];
  for (const g of state.groups) {
    if (g === src) {
      groups.push(...pieces);
      if (!dst) groups.push(moved);
    } else groups.push(g === dst ? moved : g);
  }
  state.groups = groups;
  regroup();
  return pieces.length > 1
    ? `The pages left in ${sm.label} no longer run consecutively, so they ` +
      `became ${pieces.length} outputs.` : null;
}

/* ---------- routing helpers ---------- */

const partOf = (s) => state.parts.find((t) => t.id === s.part);
const destOf = (s) => s.dest ?? partOf(s).dest;
const outputName = (d) => (d === DISCARD ? 'discard'
  : state.outputs.find((o) => o.id === d)?.name ?? '?');
const incomplete = (s) => s.copy >= 0 && !state.copies[s.copy].complete;
// a sheet sorted to the wrong version of its page would break the run of
// its student's pages, so a complete multi-page copy, or a template page
// next to its neighbouring page (templateCut), vouches for it
const vouched = (s) => state.inContext.has(s.front) || (s.copy >= 0 &&
  state.copies[s.copy].complete && state.copies[s.copy].part.nodes.length > 1);
const flagged = (s) => s.flipped || incomplete(s) ||
  (s.layout !== BLANK && s.margin < LOW_MARGIN && !vouched(s));
const workOnBack = (s) => s.back !== null && !state.pages[s.back].blank;
/** Label a page of a part: the part's label, plus the page if it has several. */
const pageLabel = (t, page) => (t.nodes.length > 1 ? `${t.label} p${page + 1}` : t.label);

/** Route a sheet's whole copy (one student's pages of a part); null restores the default. */
function routeCopy(i, d) {
  const s = state.sheets[i];
  for (const j of s.copy >= 0 ? state.copies[s.copy].sheets : [i]) state.sheets[j].dest = d;
}

/** List outputs worth offering: shown parts' own, custom, and any in use. */
function liveOutputs() {
  const ids = new Set();
  for (const t of state.parts) {
    if (t.out) ids.add(t.out);
    if (t.dest !== DISCARD) ids.add(t.dest);
  }
  for (const s of state.sheets) if (s.dest && s.dest !== DISCARD) ids.add(s.dest);
  // parts' own outputs in card order, then the rest
  const rank = new Map(state.parts.map((t, k) => [t.out, k]));
  return state.outputs.filter((o) => ids.has(o.id) || o.part === undefined)
    .sort((a, b) => ((rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)) || 0);
}

function destOptions(selected, { includeDefault = false } = {}) {
  let h = includeDefault ? '<option value="">(part default)</option>' : '';
  for (const o of liveOutputs()) {
    h += `<option value="${o.id}"${o.id === selected ? ' selected' : ''}>&rarr; ${esc(o.name)}.pdf</option>`;
  }
  h += `<option value="${DISCARD}"${selected === DISCARD ? ' selected' : ''}>discard</option>`;
  return h;
}

/* ---------- rendering ---------- */

function renderAll() {
  for (const id of ['summary', 'parts', 'review']) $(`#${id}`).hidden = false;
  renderSummary();
  renderPartsAndBelow();
}

function renderPartsAndBelow() {
  renderParts();
  renderReview();
  renderExport();
  renderSummaryStats();
}

/** Return a cached object URL for an input file's original bytes. */
const fileUrl = (f) => f.url ??=
  URL.createObjectURL(new Blob([f.bytes], { type: 'application/pdf' }));

/** Render a link that views an input file, plus one that downloads it. */
const fileLinks = (f, label, page = 1) => {
  const u = fileUrl(f);
  return `<a href="${u}#page=${page}" target="_blank" rel="noopener"
    title="view">${esc(label)}</a>
    <a class="dl" href="${u}" download="${esc(f.name)}"
    title="download ${esc(f.name)}">&#8595;</a>`;
};

function renderFiles() {
  $('#files').innerHTML = state.files.map((f) =>
    `<li>${fileLinks(f, f.name)} · ${f.nPages} p</li>`).join('');
  $('#clear-all').hidden = !state.files.length;
}

function renderSummary() {
  $('#summary').innerHTML = `<dl class="stats" id="stats"></dl>
    <div class="settings">
      <label>Blank-back mode
        <select id="blank-back-mode">
          <option value="auto">auto (detected: ${state.blankBackAuto ? 'on' : 'off'})</option>
          <option value="on">on: each page and the blank back after it are one sheet</option>
          <option value="off">off: every page stands alone</option>
        </select></label>
      <span class="hint">Off if backs carry questions or work.
        Changing this re-sorts from scratch.</span>
    </div>`;
  $('#blank-back-mode').value = state.blankBackMode;
  $('#blank-back-mode').onchange = (e) => {
    state.blankBackMode = e.target.value;
    cluster();
    renderAll();
  };
  renderSummaryStats();
}

function renderSummaryStats() {
  const sh = state.sheets;
  const nParts = state.parts.filter((t) => t.id !== BLANK_PART && t.dest !== DISCARD && t.nSheets).length;
  const nLayouts = state.groups.flat().filter((n) => n.members.length).length;
  const per = state.period;
  const label = (id) => {
    if (id === BLANK) return state.blankMeta.label;
    const t = state.parts.find((x) => x.nodes.some((n) => n.id === id));
    return t ? pageLabel(t, t.nodes.findIndex((n) => n.id === id)) : '?';
  };
  let exam = '—';
  if (nLayouts > 1 && per.p > 1 && per.agree > 0.5) {
    exam = per.window.map(label).join(' → ');
  } else if (nLayouts > 1) {
    exam = 'not collated';
  } else if (nLayouts === 1) {
    exam = 'one page';
  }
  const stat = (k, v) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`;
  $('#stats').innerHTML = `
    ${stat('pages', state.pages.length)}
    ${stat('sheets', sh.length)}
    ${stat('blank-back mode', blankBacks() ? 'on' : 'off')}
    ${stat('blank pages', state.pages.filter((p) => p.blank).length)}
    ${stat('parts', nParts)}
    ${stat('sorted by', state.templates.length ? `${state.templates.length} template pages` : 'learned from scans')}
    ${stat('one exam', exam)}
    ${stat('flagged', sh.filter(flagged).length)}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// inline icons, drawn in currentColor
const ICON = {
  grip: '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor">' +
    '<circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/>' +
    '<circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></g></svg>',
  download: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>',
  basket: '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.5h6V7m-9 0 1 13h10l1-13' +
    'M10 11v5.5M14 11v5.5"/></svg>',
};

function renderParts() {
  $('#reset-parts').hidden = !state.tree && !state.templates.length;
  $('#parts-hint').textContent = state.templates.length
    ? 'Sheets no template matches form parts ?1, ?2, …'
    : 'Each image averages the sheets sorted to it; split one that hides ' +
      'two versions.';
  const unused = state.parts.filter((t) => !t.nSheets);
  $('#parts-unused').hidden = !unused.length;
  $('#parts-unused').textContent = unused.length
    ? `No sheets matched ${plural(unused.length, 'template part')}: ` +
      unused.map((t) => outputName(t.out)).join(', ') + '.' : '';
  $('#parts-msg').hidden = !state.partsMsg;
  $('#parts-msg').textContent = state.partsMsg ?? '';
  state.partsMsg = null;
  const shown = state.parts.filter((t) => t.nSheets);
  const lanes = shown.filter((t) => t.id !== BLANK_PART && t.dest !== DISCARD);
  const trash = shown.filter((t) => t.id === BLANK_PART || t.dest === DISCARD);
  $('#part-cards').innerHTML = lanes.map(cardHtml).join('');
  const nd = state.sheets.filter((s) => destOf(s) === DISCARD).length;
  const tiles = trash.flatMap((t) => (t.nodes.length ? t.nodes : [null]).map((n, j) => `
    <div class="thumb mini" style="--c:${t.color}"${n ? ` data-node="${n.id}"
      title="drag onto a card or empty space to use it again"` : ' title="blank pages"'}>
      <img src="${t.imgs[j]}" draggable="false" alt="average of ${n ? `part ${esc(t.label)}` : 'blank pages'}">
      <span class="pg">${esc(t.label)} · ${t.nSheets}</span>
      <button class="zoom" data-inspect="${n ? n.id : BLANK}" title="inspect">&#10530;</button></div>`)).join('');
  $('#part-trash').innerHTML = `<div class="basket">${ICON.basket}
      <span>discard${nd ? ` · ${plural(nd, 'sheet')}` : ''}</span></div>
    <div class="trash-tiles">${tiles}</div>`;
  for (const inp of document.querySelectorAll('#part-cards input.name')) {
    inp.onchange = () => {
      const o = state.outputs.find((x) => x.id === inp.dataset.out);
      o.name = inp.value.trim().replace(/\.pdf$/i, '') || o.name;
      renderPartsAndBelow();
    };
  }
  for (const b of document.querySelectorAll('#part-cards [data-split]')) {
    b.onclick = () => splitPart(b.dataset.split);
  }
  for (const b of document.querySelectorAll('#part-cards [data-merge]')) {
    b.onclick = () => mergePart(b.dataset.merge);
  }
  for (const b of document.querySelectorAll('#part-cards [data-dl]')) {
    b.onclick = () => exportOutput(b.dataset.dl, b);
  }
  for (const b of document.querySelectorAll('#parts [data-inspect]')) {
    b.onclick = () => openInspector(+b.dataset.inspect);
  }
  wireDrag();
}

/** Render one lane: an output PDF's card, its pages in staple order. */
function cardHtml(t) {
  const multi = t.nodes.length > 1;
  const one = t.nodes.length === 1 && state.tree ? t.nodes[0] : null;
  let tree = '';
  if (one) {
    const kids = one.children;
    const { blocked } = mergeSet(t.id);
    const partners = mergePartners(t.id);
    const canMerge = partners.length && !blocked;
    const splitTip = kids
      ? `halves correlate ${one.score.toFixed(2)} (near 1: same page)`
      : 'Cannot split: one sheet, or identical sheets';
    const mergeTip = blocked ? `Drag the other pages out of part ${blocked} first`
      : partners.length ? `Same printed page as ${partners.join(', ')}`
        : 'Nothing to merge with';
    tree = `<span class="tree-actions">
      <button class="btn ghost small" data-split="${esc(t.id)}" title="${esc(splitTip)}"${kids ? '' : ' disabled'}>split${kids ? ` <span class="score">${kids[0].members.length}+${kids[1].members.length}</span>` : ''}</button>
      <button class="btn ghost small" data-merge="${esc(t.id)}" title="${esc(mergeTip)}"${canMerge ? '' : ' disabled'}>merge${canMerge ? ` with ${esc(partners.join(', '))}` : ''}</button>
    </span>`;
  }
  const tiles = t.nodes.map((n, j) => `<div class="thumb" data-node="${n.id}"
      title="drag onto another card, empty space, or the basket">
      <img src="${t.imgs[j]}" draggable="false" alt="average of part ${esc(t.label)}${multi ? ` page ${j + 1}` : ''}">
      ${multi ? `<span class="pg">p${j + 1}</span>` : ''}
      <button class="zoom" data-inspect="${n.id}" title="inspect">&#10530;</button></div>`).join('');
  const name = outputName(t.out);
  const nPages = pagesFor(t.out).length;
  const nOut = state.sheets.filter((s) => destOf(s) === t.out).length;
  return `<div class="part-card" data-drop="${esc(t.id)}" style="--c:${t.color}">
    <div class="card-head">
      <span class="grip" title="drag to reorder">${ICON.grip}</span>
      <span class="tag">${esc(t.label)}</span>
      <input type="text" class="name" data-out="${t.out}" value="${esc(name)}"
        aria-label="name of part ${esc(t.label)}" title="output file name">
      <button class="icon dl" data-dl="${t.out}"${nPages ? '' : ' disabled'}
        title="download ${esc(name)}.pdf: ${plural(nOut, 'sheet')}, ${plural(nPages, 'page')}"
        aria-label="download ${esc(name)}.pdf">${ICON.download}</button>
    </div>
    <div class="pages">${tiles}</div>
    <div class="card-foot">
      <span>${multi ? plural(t.n, 'copy', 'copies') : plural(t.nSheets, 'sheet')}</span>
      ${t.nIncomplete ? `<span class="warn">${t.nIncomplete} incomplete</span>` : ''}
      ${tree}
    </div>
  </div>`;
}

/* ---------- dragging pages and cards ---------- */

// pointer travel, in px, before a press becomes a drag
const DRAG_PX = 4;

/**
 * Make page tiles and card grips draggable.
 *
 * Pointer events rather than HTML5 drag and drop, so the stand-in follows
 * the pointer, the preview updates every frame, and touch works too.
 */
function wireDrag() {
  for (const el of document.querySelectorAll('#parts [data-node]')) {
    el.onpointerdown = (e) => press(e, () => dragPage(el, e));
  }
  for (const c of document.querySelectorAll('#part-cards .part-card')) {
    c.querySelector('.grip').onpointerdown = (e) => press(e, () => dragCard(c, e));
  }
}

/** Start a drag once a primary press moves DRAG_PX; a still press stays a click. */
function press(e, start) {
  if (e.button !== 0 || e.target.closest('button, input')) return;
  e.preventDefault();
  const [x0, y0] = [e.clientX, e.clientY];
  const move = (m) => {
    if (Math.hypot(m.clientX - x0, m.clientY - y0) < DRAG_PX) return;
    stop();
    start(m);
  };
  const stop = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', stop);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', stop);
}

/**
 * Run one drag: a ghost follows the pointer and over(x, y) updates the
 * preview once per frame; release calls drop(target), Escape cancel().
 * Near the window's top or bottom edge the page scrolls.
 */
function session(e, ghost, { over, drop, cancel }) {
  document.body.append(ghost);
  document.body.classList.add('dragging');
  let [x, y] = [e.clientX, e.clientY];
  let raf = 0;
  let target = null;
  const frame = () => {
    raf = 0;
    ghost.style.transform = `translate(${x}px, ${y}px)`;
    target = over(x, y);
    const edge = y < 48 ? -12 : y > innerHeight - 48 ? 12 : 0;
    if (edge) {
      scrollBy(0, edge);
      raf = requestAnimationFrame(frame);
    }
  };
  const move = (m) => {
    [x, y] = [m.clientX, m.clientY];
    if (!raf) raf = requestAnimationFrame(frame);
  };
  const end = () => {
    cancelAnimationFrame(raf);
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('keydown', key);
    ghost.remove();
    document.body.classList.remove('dragging');
    // the release must not also click what it lands on; that click, if
    // any, comes in this same input task, before the timeout
    addEventListener('click', swallow, true);
    setTimeout(() => removeEventListener('click', swallow, true), 0);
  };
  const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
  const up = () => { end(); drop(target); };
  const key = (k) => { if (k.key === 'Escape') { end(); cancel(); } };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('keydown', key);
  frame();
}

/**
 * Drag a page tile: its card closes up behind it, and a small stand-in
 * shows where it would land (in a card at its scan-order place, in a new
 * card at the end, or in the basket); cards it cannot join are dimmed.
 */
function dragPage(el, e) {
  const id = +el.dataset.node;
  const n = layoutNode(id);
  const why = dropTargets(id);
  // where the page would sit in each card it can join
  const at = new Map([...why].filter(([k, w]) => w === null && k !== 'new' && k !== 'trash')
    .map(([k]) => [k, pageOrder([...groupOf(k), n]).order.indexOf(n)]));
  const cards = [...document.querySelectorAll('#part-cards .part-card')];
  for (const c of cards) c.classList.toggle('cannot', typeof why.get(c.dataset.drop) === 'string');
  const img = el.querySelector('img').src;
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.innerHTML = `<img src="${img}" alt=""><span></span>`;
  const caption = ghost.querySelector('span');
  const stand = document.createElement('div');
  stand.className = 'thumb stand';
  stand.innerHTML = `<img src="${img}" alt="">`;
  const newCard = document.createElement('div');
  newCard.className = 'part-card stand-card';
  let shown;
  const show = (t) => {
    if (t === shown) return;
    shown = t;
    stand.remove();
    newCard.remove();
    el.classList.toggle('lifted', t !== null);
    for (const c of cards) c.classList.toggle('over', c.dataset.drop === t);
    $('#part-trash').classList.toggle('over', t === 'trash');
    if (t === 'trash') $('#part-trash .trash-tiles').append(stand);
    else if (t === 'new') {
      newCard.innerHTML = '<div class="pages"></div><div class="card-foot">new part</div>';
      newCard.querySelector('.pages').append(stand);
      $('#part-cards').append(newCard);
    } else if (t !== null) {
      const pages = cards.find((c) => c.dataset.drop === t).querySelector('.pages');
      pages.insertBefore(stand, pages.children[at.get(t)] ?? null);
    }
  };
  const restore = () => {
    show(null);
    for (const c of cards) c.classList.remove('cannot', 'over');
  };
  session(e, ghost, {
    over(x, y) {
      const hit = document.elementFromPoint(x, y);
      const card = hit?.closest('#part-cards .part-card:not(.stand-card)');
      let t = null;
      let note = '';
      if (card) {
        const w = why.get(card.dataset.drop);
        if (w === null) t = card.dataset.drop;
        else if (w) note = `can't staple here: ${w}`;
      } else if (hit?.closest('#part-trash')) t = why.has('trash') ? 'trash' : null;
      else if (hit?.closest('#parts, .stand-card')) t = why.has('new') ? 'new' : null;
      show(t);
      caption.textContent = t === 'trash' ? 'discard' : t === 'new' ? 'new part'
        : t ? `staple into ${outputName(state.meta.get(t).out)}` : note;
      ghost.classList.toggle('no', !!note);
      return t;
    },
    drop(t) {
      restore();
      if (t === null) return;
      state.partsMsg = movePage(id, t);
      renderPartsAndBelow();
    },
    cancel: restore,
  });
}

/**
 * Drag a card by its grip to reorder the cards (and so the downloads); a
 * gap the card's size opens where it would land.
 */
function dragCard(card, e) {
  const box = $('#part-cards');
  const gap = document.createElement('div');
  gap.className = 'part-card stand-card';
  gap.style.width = `${card.offsetWidth}px`;
  gap.style.height = `${card.offsetHeight}px`;
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost card-ghost';
  ghost.style.setProperty('--c', card.style.getPropertyValue('--c'));
  ghost.innerHTML = `<span class="tag">${esc(card.querySelector('.tag').textContent)}</span>
    <span>${esc(card.querySelector('input.name').value)}</span>`;
  card.before(gap);
  card.classList.add('lifted-card');
  const restore = () => {
    gap.remove();
    card.classList.remove('lifted-card');
  };
  session(e, ghost, {
    over(x, y) {
      const hit = document.elementFromPoint(x, y)?.closest('#part-cards .part-card');
      if (hit && hit !== gap) {
        const r = hit.getBoundingClientRect();
        const before = x < r.left + r.width / 2;
        if (before && hit.previousElementSibling !== gap) hit.before(gap);
        if (!before && hit.nextElementSibling !== gap) hit.after(gap);
      }
      return true;
    },
    drop() {
      const keys = [...box.children].filter((c) => c !== card)
        .map((c) => (c === gap ? card.dataset.drop : c.dataset.drop));
      restore();
      const lanes = keys.map(groupOf);
      state.groups = [...lanes, ...state.groups.filter((g) => !lanes.includes(g))];
      regroup();
      renderPartsAndBelow();
    },
    cancel: restore,
  });
}

function visibleSheets() {
  const f = state.filter;
  return state.sheets.map((s, i) => [s, i]).filter(([s]) => (
    f === 'all' ? true
      : f === 'flagged' ? flagged(s)
        : f === 'incomplete' ? incomplete(s)
          : f === 'back' ? workOnBack(s)
            : f === 'discard' ? destOf(s) === DISCARD
              : s.part === f.slice(2)));
}

function tileHtml(s, i) {
  const t = partOf(s);
  const d = destOf(s);
  const badges = [];
  if (s.flipped) badges.push('<span class="badge warn" title="scanned back-first; front detected">flipped</span>');
  if (incomplete(s)) badges.push('<span class="badge warn" title="this copy\'s pages are not all here, in order">incomplete</span>');
  if (s.layout !== BLANK && s.margin < LOW_MARGIN) badges.push('<span class="badge warn" title="close to another page">unsure</span>');
  if (s.dest !== null) badges.push(`<span class="badge">&rarr; ${esc(outputName(d))}</span>`);
  const back = workOnBack(s) ? `<img class="back" src="${state.pages[s.back].thumb}" alt="" title="back has writing">` : '';
  return `<div class="tile${state.selected.has(i) ? ' sel' : ''}${d === DISCARD ? ' discard' : ''}"
      data-i="${i}" style="--c:${t.color}" tabindex="0">
    <img class="front" src="${state.pages[s.front].thumb}" alt="" loading="lazy">${back}
    <button class="zoom" title="inspect">&#10530;</button>
    <div class="meta"><span class="tag">${esc(pageLabel(t, s.page))}</span>#${i + 1} ${badges.join(' ')}</div>
  </div>`;
}

function renderReview() {
  if (state.filter.startsWith('p:') && !state.parts.some((t) => `p:${t.id}` === state.filter)) {
    state.filter = 'all';
  }
  const sh = state.sheets;
  const chips = [['all', `all ${sh.length}`], ['flagged', `flagged ${sh.filter(flagged).length}`],
    ...(state.parts.some((t) => t.nodes.length > 1)
      ? [['incomplete', `incomplete copies ${sh.filter(incomplete).length}`]] : []),
    ['back', `work on back ${sh.filter(workOnBack).length}`],
    ...state.parts.filter((t) => t.nSheets).map((t) => [`p:${t.id}`, `${t.label} ${t.nSheets}`]),
    ['discard', `discarded ${sh.filter((s) => destOf(s) === DISCARD).length}`]];
  $('#filters').innerHTML = chips.map(([k, l]) =>
    `<button class="chip${state.filter === k ? ' on' : ''}" data-f="${esc(k)}">${esc(l)}</button>`).join('');
  for (const b of document.querySelectorAll('#filters .chip')) {
    b.onclick = () => { state.filter = b.dataset.f; renderReview(); };
  }
  $('#grid').innerHTML = visibleSheets().map(([s, i]) => tileHtml(s, i)).join('') ||
    '<p class="hint">No sheets match this filter.</p>';
  wireTiles($('#grid'));
  renderBulk();
}

function wireTiles(root) {
  for (const el of root.querySelectorAll('.tile')) {
    const i = +el.dataset.i;
    el.onclick = (e) => {
      if (e.target.closest('.zoom')) { openPreview(i); return; }
      select(i, e.shiftKey);
    };
    el.ondblclick = () => openPreview(i);
    el.onkeydown = (e) => {
      if (e.key === 'Enter') openPreview(i);
      if (e.key === ' ') { e.preventDefault(); select(i, e.shiftKey); }
    };
  }
}

function select(i, range) {
  const sel = state.selected;
  if (range && state.anchor !== null) {
    const vis = visibleSheets().map(([, j]) => j);
    const [a, b] = [vis.indexOf(state.anchor), vis.indexOf(i)].sort((x, y) => x - y);
    if (a >= 0) vis.slice(a, b + 1).forEach((j) => sel.add(j));
  } else {
    if (sel.has(i)) sel.delete(i); else sel.add(i);
    state.anchor = i;
  }
  renderReview();
}

function renderBulk() {
  const n = state.selected.size;
  const bar = $('#bulk');
  bar.hidden = n === 0;
  if (!n) return;
  bar.innerHTML = `<b>${n} selected</b>
    <label>send to <select id="bulk-dest"><option value="" selected disabled>choose…</option>
      ${destOptions(null, { includeDefault: true }).replace('value=""', 'value="__default"')}</select></label>
    <button class="btn ghost" id="bulk-swap">swap front / back</button>
    <button class="btn ghost" id="bulk-all">select all shown</button>
    <button class="btn ghost" id="bulk-clear">clear selection</button>`;
  $('#bulk-dest').onchange = (e) => {
    const v = e.target.value;
    const d = v === '__default' ? null : v;
    for (const i of state.selected) routeCopy(i, d);
    state.selected.clear();
    renderPartsAndBelow();
  };
  $('#bulk-swap').onclick = () => {
    for (const i of state.selected) swap(state.sheets[i]);
    renderReview();
  };
  $('#bulk-all').onclick = () => {
    visibleSheets().forEach(([, i]) => state.selected.add(i));
    renderReview();
  };
  $('#bulk-clear').onclick = () => { state.selected.clear(); renderReview(); };
}

function swap(s) {
  if (s.back === null) return;
  [s.front, s.back] = [s.back, s.front];
  s.flipped = !s.flipped;
}

/* ---------- magnifying lens ---------- */

const LENS = 240;
const ZOOM = 2.5;
const lens = document.createElement('canvas');
lens.className = 'loupe';
lens.width = LENS;
lens.height = LENS;
lens.hidden = true;

/** Show a magnifying lens over a canvas while the pointer is on it. */
function attachLoupe(canvas) {
  canvas.classList.add('zoomable');
  canvas.addEventListener('pointerenter', () => canvas.closest('dialog')?.append(lens));
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const span = LENS / ZOOM * sx;
    const cx = (e.clientX - r.left) * sx;
    const cy = (e.clientY - r.top) * sx;
    const ctx = lens.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, LENS, LENS);
    ctx.drawImage(canvas, cx - span / 2, cy - span / 2, span, span, 0, 0, LENS, LENS);
    lens.style.left = `${e.clientX - LENS / 2}px`;
    lens.style.top = `${e.clientY - LENS / 2}px`;
    lens.hidden = false;
  });
  canvas.addEventListener('pointerleave', () => { lens.hidden = true; });
}

/* ---------- sheet preview ---------- */

let pvIndex = 0;

async function openPreview(i) {
  pvIndex = i;
  const dlg = $('#preview');
  if (!dlg.open) dlg.showModal();
  const s = state.sheets[i];
  const p = state.pages[s.front];
  const t = partOf(s);
  const c = s.copy >= 0 && t.nodes.length > 1 ? state.copies[s.copy] : null;
  const pageNums = [s.front, s.back].filter((x) => x !== null)
    .map((x) => state.pages[x].idx + 1).sort((a, b) => a - b).join('–');
  $('#pv-title').innerHTML = `<span class="tag" style="--c:${t.color}">${esc(pageLabel(t, s.page))}</span>
    Sheet ${i + 1} of ${state.sheets.length} · ${esc(p.file.name)} p${pageNums}
    · match margin ${s.layout === BLANK ? '—' : s.margin.toFixed(2)}${s.flipped ? ' · scanned back-first' : ''}
    ${c ? ` · ${c.complete ? '' : 'incomplete '}copy of ${plural(c.sheets.length, 'sheet')}` : ''}`;
  $('#pv-dest-label').textContent = c ? `Send this copy (${plural(c.sheets.length, 'sheet')}) to` : 'Send to';
  const sel = $('#pv-dest');
  sel.innerHTML = destOptions(destOf(s));
  sel.onchange = () => {
    routeCopy(i, sel.value === t.dest ? null : sel.value);
    renderPartsAndBelow();
    openPreview(i);
  };
  $('#pv-back').parentElement.hidden = s.back === null;
  await drawLarge(s.front, $('#pv-front'));
  if (s.back !== null) await drawLarge(s.back, $('#pv-back'));
}

/** Render a page (index into state.pages, or any {file, idx}) large. */
async function drawLarge(pi, canvas, width = 1000) {
  const p = typeof pi === 'number' ? state.pages[pi] : pi;
  const page = await p.file.doc.getPage(p.idx + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / vp1.width });
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
}

$('#pv-prev').onclick = () => openPreview(Math.max(0, pvIndex - 1));
$('#pv-next').onclick = () => openPreview(Math.min(state.sheets.length - 1, pvIndex + 1));
$('#pv-swap').onclick = () => {
  swap(state.sheets[pvIndex]);
  renderReview();
  openPreview(pvIndex);
};
$('#preview').addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowLeft') $('#pv-prev').click();
  if (e.key === 'ArrowRight') $('#pv-next').click();
});

/* ---------- page inspector ---------- */

let inspectToken = 0;

/** Open the inspector on one page of a part: its average, large, and its split preview. */
async function openInspector(id) {
  const token = ++inspectToken;
  const dlg = $('#inspect');
  if (!dlg.open) dlg.showModal();
  const n = id === BLANK ? null : layoutNode(id);
  const t = n ? state.parts.find((x) => x.nodes.includes(n)) : state.blankMeta;
  const j = n ? t.nodes.indexOf(n) : 0;
  const fronts = state.sheets.filter((s) => s.layout === id).map((s) => s.front);
  $('#in-title').innerHTML = `<span class="tag" style="--c:${t.color}">${esc(pageLabel(t, j))}</span>
    ${t.nodes.length > 1 ? `page ${j + 1} of ${t.nodes.length} · ` : ''}${plural(fronts.length, 'sheet')}
    · &rarr; ${esc(outputName(t.dest))}`;
  // split and merge act on the one-page parts of a learned tree
  const one = n && state.tree && t.nodes.length === 1;
  const kids = one && n.children;
  $('#in-split-box').hidden = !kids;
  $('#in-tpl-box').hidden = !(n && n.template);
  if (n && n.template) drawLarge(n.template, $('#in-tpl'), HI_W);
  const partners = one && !mergeSet(t.id).blocked ? mergePartners(t.id) : [];
  $('#in-merge').hidden = !partners.length;
  $('#in-merge').textContent = `merge with ${partners.join(', ')}`;
  $('#in-merge').title = `Same printed page as ${partners.join(', ')}`;
  $('#in-merge').onclick = () => { dlg.close(); mergePart(t.id); };
  if (kids) {
    $('#in-score').textContent = `Halves correlate ${n.score.toFixed(2)} ` +
      '(near 1: same printed page, only handwriting differs).';
    $('#in-k0-cap').textContent = plural(kids[0].members.length, 'sheet');
    $('#in-k1-cap').textContent = plural(kids[1].members.length, 'sheet');
    $('#in-split').onclick = () => { dlg.close(); splitPart(t.id); };
  }
  inView = { img: t.imgs[j], node: n, fronts };
  showInspectPos(0);
  const previews = kids ? [[$('#in-k0'), kids[0]], [$('#in-k1'), kids[1]]] : [];
  for (const [cv, nd] of previews) placeholder(cv, nodeImage(nd), () => token === inspectToken);
  for (const [cv, nd] of previews) {
    const hi = await hiConsensus(nd.id, nd.members, nd.cons);
    if (token !== inspectToken) return;
    copyTo(cv, hi);
  }
}

// the inspector's main view: {img, node, fronts, pos}; pos 0 is the
// average, pos i the i-th sheet of the page
let inView = null;
let mainToken = 0;

/** Show the page's average (pos 0) or one of its sheets, full resolution. */
async function showInspectPos(pos) {
  const { img, node: n, fronts } = inView;
  const token = ++mainToken;
  const cv = $('#in-cons');
  inView.pos = pos;
  $('#in-pos').textContent = pos ? `sheet ${pos} of ${fronts.length}` : 'average';
  $('#in-prev').disabled = !fronts.length;
  $('#in-next').disabled = !fronts.length;
  if (pos === 0) {
    $('#in-cap').textContent = `average of up to ${HI_N} sheets`;
    placeholder(cv, n && !n.template ? nodeImage(n) : img, () => token === mainToken);
    const hi = await hiConsensus(n ? n.id : 'blank', n ? n.members : fronts, n && n.cons);
    if (token === mainToken) copyTo(cv, hi);
    return;
  }
  const pi = fronts[pos - 1];
  const p = state.pages[pi];
  const k = state.sheets.findIndex((s) => s.front === pi);
  $('#in-cap').textContent = `sheet #${k + 1} · ${p.file.name} page ${p.idx + 1}`;
  // render off-screen: pdf.js refuses two renders into one canvas at once
  const off = document.createElement('canvas');
  await drawLarge(pi, off, 1100);
  if (token === mainToken) copyTo(cv, off);
}

function stepInspect(d) {
  if (!inView || !inView.fronts.length) return;
  const n = inView.fronts.length + 1;
  showInspectPos((inView.pos + d + n) % n);
}

$('#in-prev').onclick = () => stepInspect(-1);
$('#in-next').onclick = () => stepInspect(1);
$('#inspect').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepInspect(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); stepInspect(1); }
});

function copyTo(canvas, src) {
  canvas.width = src.width;
  canvas.height = src.height;
  canvas.getContext('2d').drawImage(src, 0, 0);
}

/** Draw a low-resolution image while the real one renders, unless stale. */
function placeholder(canvas, url, current) {
  const img = new Image();
  img.onload = () => {
    if (!current()) return;
    canvas.width = HI_W;
    canvas.height = Math.round(HI_W * TH / TW);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = url;
}

/**
 * Render a readable average of up to HI_N member pages (cached).
 *
 * Each page is first shifted onto the layout's consensus (cons, a feature
 * vector) so feed offsets between scans do not ghost the printed text.
 */
async function hiConsensus(key, members, cons) {
  if (state.hiCache.has(key)) return state.hiCache.get(key);
  const h = Math.round(HI_W * TH / TW);
  const acc = new Float32Array(HI_W * h);
  const use = sample(members, HI_N);
  const tmp = document.createElement('canvas');
  for (const pi of use) {
    const p = state.pages[pi];
    const page = await p.file.doc.getPage(p.idx + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: HI_W / vp1.width });
    tmp.width = HI_W;
    tmp.height = Math.round(vp.height);
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tmp.width, tmp.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const { ink: raw, paper } = inkOf(tmp, HI_W, h);
    let ink = clip(raw, paper - PAPER_SLACK);
    if (cons) {
      // page content sits (dy, dx) grid cells from the consensus; undo it
      const { dy, dx } = P.bestShift(cons, p.v, 4);
      ink = shifted(ink, HI_W, h, Math.round(-dy * h / P.GRID_H), Math.round(-dx * HI_W / P.GRID_W));
    }
    for (let i = 0; i < acc.length; i++) acc[i] += ink[i];
  }
  const out = document.createElement('canvas');
  out.width = HI_W;
  out.height = h;
  const octx = out.getContext('2d');
  const img = octx.createImageData(HI_W, h);
  for (let i = 0; i < acc.length; i++) {
    const g = 255 - acc[i] / Math.max(1, use.length);
    img.data.set([g, g, g, 255], 4 * i);
  }
  octx.putImageData(img, 0, 0);
  state.hiCache.set(key, out);
  return out;
}

attachLoupe($('#in-cons'));
attachLoupe($('#in-k0'));
attachLoupe($('#in-k1'));

/* ---------- export ---------- */

// stands in for a missing page in an export order
const PAD = -1;

/**
 * List the pages an output exports, in stack order.
 *
 * With padMissing, an incomplete copy exports at its part's full length, a
 * blank page (and in blank-back mode its blank back) standing in for each
 * missing page, so every copy has the same page count.
 *
 * @returns {number[]} page indices, PAD for a blank stand-in
 */
function pagesFor(outId) {
  const order = [];
  const here = (k) => destOf(state.sheets[k]) === outId;
  const push = (s) => {
    order.push(s.front);
    if (s.back !== null && !(state.omitBlankBacks && state.pages[s.back].blank)) order.push(s.back);
  };
  state.sheets.forEach((s, i) => {
    if (!here(i)) return;
    const c = state.copies[s.copy];
    if (!state.padMissing || !c || c.complete) { push(s); return; }
    if (i !== c.sheets.find(here)) return;
    for (let j = 0; j < c.part.nodes.length; j++) {
      const k = c.sheets.find((x) => state.sheets[x].page === j);
      if (k !== undefined) {
        if (here(k)) push(state.sheets[k]);
      } else {
        order.push(PAD);
        if (blankBacks() && !state.omitBlankBacks) order.push(PAD);
      }
    }
  });
  return order;
}

/**
 * List the incomplete copies bound for an output, with what each lacks.
 * @returns {{c: object, missing: number[]}[]} missing: page indices in
 *   the copy's part
 */
function missingCopies() {
  return state.copies
    .filter((c) => !c.complete && destOf(state.sheets[c.sheets[0]]) !== DISCARD)
    .map((c) => ({ c, missing: c.part.nodes.map((_, j) => j).filter((j) => j < c.start || j >= c.next) }));
}

/** Name where a copy sits in the input, e.g. "2b.pdf p13-16". */
function copyWhere(c) {
  const ps = c.sheets.flatMap((i) => [state.sheets[i].front, state.sheets[i].back])
    .filter((p) => p !== null).map((p) => state.pages[p]);
  const f = ps[0].file;
  const idx = ps.filter((p) => p.file === f).map((p) => p.idx + 1);
  const lo = Math.min(...idx);
  const hi = Math.max(...idx);
  return `${f.name} p${lo}${hi > lo ? `-${hi}` : ''}${ps.some((p) => p.file !== f) ? ' …' : ''}`;
}

/** Render what sits under the cards: missing pages, download all, export options. */
function renderExport() {
  const miss = missingCopies();
  const rows = miss.map(({ c, missing }) => `<li>
      <button class="link" data-sheet="${c.sheets[0]}">${esc(copyWhere(c))}</button>
      ${esc(outputName(destOf(state.sheets[c.sheets[0]])))}: missing
      ${missing.map((j) => `p${j + 1}`).join(', ')} of ${c.part.nodes.length}</li>`).join('');
  $('#part-export').innerHTML = `
    ${miss.length ? `<div class="missing"><b>Missing pages</b>
      <span class="hint">${plural(miss.length, 'incomplete copy', 'incomplete copies')}; click one to see it</span>
      <ul>${rows}</ul></div>` : ''}
    <div class="out-actions">
      <button class="btn" id="dl-all">${ICON.download} download all</button>
      ${miss.length ? `<label><input type="checkbox" id="pad-missing"${state.padMissing ? ' checked' : ''}>
        fill each missing page with a blank one (every copy the same length)</label>` : ''}
      ${blankBacks() ? `<label><input type="checkbox" id="omit-blank"${state.omitBlankBacks ? ' checked' : ''}>
        leave out blank backs (Gradescope expects 2 pages per sheet)</label>` : ''}
    </div>`;
  for (const b of document.querySelectorAll('#part-export [data-sheet]')) {
    b.onclick = () => openPreview(+b.dataset.sheet);
  }
  $('#dl-all').onclick = async () => {
    const b = $('#dl-all');
    b.disabled = true;
    for (const o of liveOutputs()) if (pagesFor(o.id).length) await exportOutput(o.id);
    b.disabled = false;
  };
  // page counts on the cards' download buttons change with these
  if ($('#pad-missing')) {
    $('#pad-missing').onchange = (e) => { state.padMissing = e.target.checked; renderParts(); renderExport(); };
  }
  if ($('#omit-blank')) {
    $('#omit-blank').onchange = (e) => { state.omitBlankBacks = e.target.checked; renderParts(); renderExport(); };
  }
}

async function libDoc(file) {
  if (!state.pdfLib.has(file)) {
    state.pdfLib.set(file, await PDFLib.PDFDocument.load(file.bytes, { ignoreEncryption: true }));
  }
  return state.pdfLib.get(file);
}

/** Build one output PDF from the original pages and download it. */
async function exportOutput(outId, button) {
  const o = state.outputs.find((x) => x.id === outId);
  const order = pagesFor(outId);
  if (button) { button.disabled = true; button.classList.add('busy'); }
  const out = await PDFLib.PDFDocument.create();
  const byFile = new Map();
  for (const pi of order) {
    if (pi === PAD) continue;
    const f = state.pages[pi].file;
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(pi);
  }
  const copied = new Map();
  for (const [f, pis] of byFile) {
    const got = await out.copyPages(await libDoc(f), pis.map((pi) => state.pages[pi].idx));
    pis.forEach((pi, j) => copied.set(pi, got[j]));
  }
  // a stand-in takes the size of the first real page
  const first = order.find((pi) => pi !== PAD);
  const { width, height } = first === undefined
    ? { width: 612, height: 792 } : copied.get(first).getSize();
  for (const pi of order) out.addPage(pi === PAD ? [width, height] : copied.get(pi));
  const bytes = await out.save();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  a.download = `${o.name}.pdf`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  state.lastExport = { name: o.name, pages: order.length, bytes: bytes.length };
  if (button) { button.disabled = false; button.classList.remove('busy'); }
}

/* ---------- wiring ---------- */

function showProgress(on, text = '', frac = 0) {
  $('#progress').hidden = !on;
  $('#progress-text').textContent = text;
  $('#progress .bar span').style.width = `${Math.round(frac * 100)}%`;
}

async function readFiles(list) {
  const pdfs = [...list].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) return;
  const items = await Promise.all(pdfs.map(async (f) => ({
    name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  await addFiles(items);
}

const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  readFiles(e.dataTransfer.files);
});
$('#file').addEventListener('change', (e) => readFiles(e.target.files));
$('#reset-parts').onclick = () => {
  if (state.templates.length) { cluster(); renderAll(); } else { autoCut(); renderPartsAndBelow(); }
};

/* ---------- templates ---------- */

/**
 * Load blank template PDFs; every non-blank page becomes a template.
 *
 * One PDF may hold the whole exam (its pages start as one-page parts) or
 * several PDFs one question each (each file starts as one part).
 */
async function addTemplates(items) {
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const found = [];
  for (const it of items) {
    let doc;
    try {
      doc = await pdfjsLib.getDocument({ data: it.bytes.slice() }).promise;
    } catch (e) {
      alert(`Could not open ${it.name}: ${e.message}`);
      continue;
    }
    const file = { name: it.name, bytes: it.bytes, doc, nPages: doc.numPages };
    for (let i = 0; i < doc.numPages; i++) found.push({ file, idx: i, ...await renderPage(file, i) });
  }
  // blank pages (the back of a one-sided template) are not templates
  const ref = Math.max(...state.templates.map((t) => t.energy), ...found.map((t) => t.energy));
  const kept = found.filter((t) => t.energy >= 0.1 * ref);
  for (const t of kept) {
    const stem = t.file.name.replace(/\.pdf$/i, '');
    const many = kept.filter((u) => u.file === t.file).length > 1;
    state.templates.push({ ...t, stem, name: many ? `${stem}_p${t.idx + 1}` : stem });
  }
  renderTemplates();
  if (state.pages.length) { cluster(); renderAll(); }
}

function renderTemplates() {
  $('#tpls').innerHTML = state.templates.map((t, k) =>
    `<li>${fileLinks(t.file, t.name, t.idx + 1)} <button class="icon small" data-rm="${k}" aria-label="remove">&times;</button></li>`).join('');
  $('#tpl-clear').hidden = !state.templates.length;
  for (const b of document.querySelectorAll('#tpls [data-rm]')) {
    b.onclick = () => {
      state.templates.splice(+b.dataset.rm, 1);
      renderTemplates();
      if (state.pages.length) { cluster(); renderAll(); }
    };
  }
}

async function readTemplates(list) {
  const pdfs = [...list].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) return;
  await addTemplates(await Promise.all(pdfs.map(async (f) => ({
    name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
}

const tplDrop = $('#tpl-drop');
tplDrop.addEventListener('dragover', (e) => { e.preventDefault(); tplDrop.classList.add('over'); });
tplDrop.addEventListener('dragleave', () => tplDrop.classList.remove('over'));
tplDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  tplDrop.classList.remove('over');
  readTemplates(e.dataTransfer.files);
});
$('#tpl-file').addEventListener('change', (e) => readTemplates(e.target.files));
$('#tpl-clear').onclick = () => {
  state.templates = [];
  renderTemplates();
  if (state.pages.length) { cluster(); renderAll(); }
};

/* ---------- example ---------- */

const fetchItems = (urls) => Promise.all(urls.map(async (u) => ({
  name: decodeURIComponent(u.split('/').pop()),
  bytes: new Uint8Array(await (await fetch(u)).arrayBuffer()) })));

/** Load a bundled fictional quiz stack, named as in demo/manifest.json. */
async function loadExample(name) {
  if (state.pages.length || state.templates.length) {
    location.href = `${location.pathname}?example=${name}`;
    return;
  }
  const m = await (await fetch('demo/manifest.json')).json();
  await addFiles(await fetchItems(m.examples[name].scans));
}
document.querySelectorAll('[data-example]').forEach((b) => {
  b.onclick = () => loadExample(b.dataset.example);
});
$('#clear-all').onclick = () => { location.href = location.pathname; };

/* ---------- footer ---------- */

// BUILD comes from js/version.js, which the Pages workflow stamps at deploy
if (BUILD) {
  const when = new Date(BUILD.time).toLocaleString('en-US',
    { dateStyle: 'medium', timeStyle: 'short' });
  $('#build').innerHTML = `build <a href="https://github.com/matthigger/` +
    `scan_split/commit/${BUILD.sha}">${BUILD.sha.slice(0, 7)}</a>, ${when}`;
} else {
  $('#build').textContent = 'local copy';
}

const params = new URLSearchParams(location.search);
(async () => {
  if (params.get('tpl')) await addTemplates(await fetchItems(params.get('tpl').split(',')));
  if (params.get('src')) await addFiles(await fetchItems(params.get('src').split(',')));
  // scans and templates: aliases of one-sided, for existing links
  const ex = params.get('example');
  if (ex) await loadExample(['scans', 'templates'].includes(ex) ? 'one-sided' : ex);
})();
