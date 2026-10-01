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
  const ink = inkOf(c, TW, TH);
  const { v, energy } = P.featurize(P.downsample(ink, TW, TH, DOWN));
  return { file, idx, thumb: URL.createObjectURL(blob), v, energy, ink };
}

/** Read a canvas, stretched to (h, w), as ink (255 - luma). */
function inkOf(src, w, h) {
  const f = document.createElement('canvas');
  f.width = w;
  f.height = h;
  const ctx = f.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) {
    ink[i] = 255 - Math.round(0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] +
      0.114 * rgba[4 * i + 2]);
  }
  return ink;
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
 * Each front goes to its nearest template. A tree over each template's
 * fronts is walked down its genuine splits (halves that differ in printed
 * content, as in autoCut); a resulting group big enough to judge is set
 * aside when its average matches the template poorly, or clearly worse than
 * the template's best group (another version of the same question). The
 * set-aside fronts are pooled and grouped by their own learned tree.
 *
 * @param {number[]} idx page indices of non-blank sheet fronts
 */
function templateCut(idx) {
  const pages = state.pages;
  const F = pages.map((p) => p.v);
  const T = state.templates;
  const groups = T.map(() => []);
  for (const p of idx) groups[nearest(F[p], T.map((t) => t.v))].push(p);
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
  const out = { id: `n${key}`, name, part: key };
  state.outputs.push(out);
  const m = { id: key, label, color, out: out.id, dest: discard ? DISCARD : out.id };
  state.meta.set(key, m);
  return m;
}

const letter = (k) => (k < 26 ? String.fromCharCode(65 + k) : `T${k}`);

/**
 * Give each sheet the shown layout holding its front and a match margin,
 * then gather the parts and cut the stack into copies.
 */
function assign() {
  const pages = state.pages;
  const cut = state.groups.flat();
  const owner = new Map();
  for (const node of cut) for (const p of node.members) owner.set(p, node);
  for (const s of state.sheets) {
    const node = owner.get(s.front);
    if (!node) { s.layout = BLANK; s.margin = 1; continue; }
    s.layout = node.id;
    const v = pages[s.front].v;
    const others = cut.filter((m) => m !== node);
    if (!others.length) { s.margin = P.dot(v, node.cons); continue; }
    s.margin = P.dot(v, node.cons) - Math.max(...others.map((m) => P.dot(v, m.cons)));
    if (s.margin < LOW_MARGIN) {
      s.margin = P.shiftDot(v, node.cons) - Math.max(...others.map((m) => P.shiftDot(v, m.cons)));
    }
  }
  state.parts = state.groups.map((nodes) => Object.assign(state.meta.get(keyOf(nodes)), {
    nodes, imgs: nodes.map((n) => (n.template ? n.template.thumb : nodeImage(n))),
  }));
  const blanks = state.sheets.filter((s) => s.layout === BLANK);
  if (blanks.length) {
    state.parts.push(Object.assign(state.blankMeta, {
      nodes: [], imgs: [consensusImage(blanks.map((s) => pages[s.front]))] }));
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

function* permutations(xs) {
  if (xs.length <= 1) { yield xs; return; }
  for (let i = 0; i < xs.length; i++) {
    for (const r of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) yield [xs[i], ...r];
  }
}

/**
 * Put a would-be part's layouts in page order.
 *
 * Template pages keep the templates' order. Otherwise the order is read off
 * the stack: steps[a][b] counts sheets of layout b directly after one of
 * layout a (blank sheets skipped), and the order with the most steps
 * between neighbouring pages wins, ties going to stack order.
 *
 * @returns {{order: object[], steps: number}} steps is Infinity for templates
 */
function pageOrder(nodes) {
  if (nodes.every((n) => n.template)) {
    const T = state.templates;
    return { order: [...nodes].sort((a, b) => T.indexOf(a.template) - T.indexOf(b.template)),
      steps: Infinity };
  }
  const byFirst = [...nodes].sort((a, b) => (a.first - b.first) || 0);
  const at = new Map(byFirst.map((n, k) => [n.id, k]));
  const steps = byFirst.map(() => byFirst.map(() => 0));
  let prev = null;
  for (const s of state.sheets) {
    if (s.layout === BLANK) continue;
    const j = at.get(s.layout) ?? null;
    if (prev !== null && j !== null && j !== prev) steps[prev][j]++;
    prev = j;
  }
  const score = (p) => p.slice(1).reduce((sc, k, i) => sc + steps[p[i]][k], 0);
  const ids = byFirst.map((_, k) => k);
  let best = { order: ids, steps: score(ids) };
  // a part longer than this keeps stack order
  if (ids.length <= 8) {
    for (const p of permutations(ids)) {
      const sc = score(p);
      if (sc > best.steps) best = { order: p, steps: sc };
    }
  }
  return { order: best.order.map((k) => byFirst[k]), steps: best.steps };
}

/**
 * Join two parts into one multi-page part, its pages in stack order.
 *
 * A part's pages must sit together in the scanned input, so parts whose
 * sheets never neighbour each other are refused. A new joined part takes
 * the earlier part's label and color and gets its own output (routed where
 * both parts went, if they agreed); joined before, it keeps its old name
 * and routing.
 */
function joinParts(a, b) {
  const [ga, gb] = [groupOf(a), groupOf(b)];
  const [ma, mb] = [state.meta.get(a), state.meta.get(b)];
  const { order, steps } = pageOrder([...ga, ...gb]);
  if (!steps) {
    alert(`Parts ${ma.label} and ${mb.label} never sit next to each other in the scans. ` +
      'The pages of a multi-page part must be consecutive in the input.');
    renderParts();
    return;
  }
  const key = keyOf(order);
  if (!state.meta.has(key)) {
    const ms = state.groups.indexOf(ga) < state.groups.indexOf(gb) ? [ma, mb] : [mb, ma];
    const m = newMeta(order, ms[0].label, ms[0].color, ms.map((x) => outputName(x.out)).join('+'));
    if (ma.dest === mb.dest) m.dest = ma.dest;
  }
  const at = Math.min(state.groups.indexOf(ga), state.groups.indexOf(gb));
  state.groups = state.groups.filter((g) => g !== ga && g !== gb);
  state.groups.splice(at, 0, order);
  assign();
  renderPartsAndBelow();
}

/** Split a multi-page part into one-page parts; ones shown before keep their name and routing. */
function separatePart(key) {
  const g = groupOf(key);
  const m = state.meta.get(key);
  g.forEach((n, j) => {
    if (!state.meta.has(keyOf([n]))) {
      newMeta([n], `${m.label}-${j + 1}`, j ? unusedColor() : m.color,
        `${outputName(m.out)}_p${j + 1}`, m.dest === DISCARD);
    }
  });
  state.groups.splice(state.groups.indexOf(g), 1, ...g.map((n) => [n]));
  assign();
  renderPartsAndBelow();
}

/* ---------- routing helpers ---------- */

const partOf = (s) => state.parts.find((t) => t.id === s.part);
const destOf = (s) => s.dest ?? partOf(s).dest;
const outputName = (d) => (d === DISCARD ? 'discard'
  : state.outputs.find((o) => o.id === d)?.name ?? '?');
const incomplete = (s) => s.copy >= 0 && !state.copies[s.copy].complete;
const flagged = (s) => s.flipped || incomplete(s) || (s.layout !== BLANK && s.margin < LOW_MARGIN);
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
  h += '<option value="__new">+ new output…</option>';
  return h;
}

/** Resolve a destination select value, creating an output on request. */
function resolveDest(value) {
  if (value !== '__new') return value;
  const name = prompt('Name for the new output PDF', `output_${state.outputs.length + 1}`);
  if (!name) return null;
  const id = `o${Date.now()}`;
  state.outputs.push({ id, name: name.replace(/\.pdf$/i, '') });
  return id;
}

/* ---------- rendering ---------- */

function renderAll() {
  for (const id of ['summary', 'parts', 'review', 'export']) $(`#${id}`).hidden = false;
  renderSummary();
  renderPartsAndBelow();
}

function renderPartsAndBelow() {
  renderParts();
  renderReview();
  renderExport();
  renderSummaryStats();
}

function renderFiles() {
  $('#files').innerHTML = state.files.map((f) =>
    `<li>${esc(f.name)} · ${f.nPages} p</li>`).join('');
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
  const nParts = state.parts.filter((t) => t.id !== BLANK_PART && t.nSheets).length;
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

function renderParts() {
  $('#reset-parts').hidden = !state.tree;
  $('#parts-hint').textContent = state.templates.length
    ? 'Sheets no template matches form parts ?1, ?2, …'
    : 'Each image averages the sheets sorted to it; split one that hides ' +
      'two versions.';
  const unused = state.parts.filter((t) => !t.nSheets);
  $('#parts-unused').hidden = !unused.length;
  $('#parts-unused').textContent = unused.length
    ? `No sheets matched ${plural(unused.length, 'template part')}: ` +
      unused.map((t) => outputName(t.out)).join(', ') + '.' : '';
  const shown = state.parts.filter((t) => t.nSheets);
  const joinable = shown.filter((t) => t.id !== BLANK_PART);
  $('#part-cards').innerHTML = shown.map((t) => {
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
      const mergeTip = blocked ? `Unstaple part ${blocked} first`
        : partners.length ? `Same printed page as ${partners.join(', ')}`
          : 'Nothing to merge with';
      tree = `<div class="tree-actions">
        <button class="btn ghost small" data-split="${esc(t.id)}" title="${esc(splitTip)}"${kids ? '' : ' disabled'}>split${kids ? ` <span class="score">${kids[0].members.length}+${kids[1].members.length}</span>` : ''}</button>
        <button class="btn ghost small" data-merge="${esc(t.id)}" title="${esc(mergeTip)}"${canMerge ? '' : ' disabled'}>merge${canMerge ? ` with ${esc(partners.join(', '))}` : ''}</button>
      </div>`;
    }
    const others = joinable.filter((x) => x !== t);
    const join = t.id !== BLANK_PART && others.length
      ? `<select class="join" data-join="${esc(t.id)}" aria-label="staple part ${esc(t.label)} to another part"
          title="each student's pages in order, one PDF">
          <option value="">staple to…</option>
          ${others.map((x) => `<option value="${esc(x.id)}">${esc(x.label)} · ${esc(outputName(x.out))}</option>`).join('')}
        </select>` : '';
    const sep = multi ? `<button class="btn ghost small" data-separate="${esc(t.id)}"
      title="back into one-page parts">unstaple</button>` : '';
    const thumbs = (multi ? t.nodes : [t.nodes[0] ?? null]).map((n, j) => `<div class="thumb">
        <img src="${t.imgs[j]}" alt="average of part ${esc(t.label)}${multi ? ` page ${j + 1}` : ''}">
        ${multi ? `<span class="pg">p${j + 1}</span>` : ''}
        <button class="zoom" data-inspect="${n ? n.id : BLANK}" title="inspect">&#10530;</button></div>`).join('');
    const count = multi
      ? `<span class="hint" title="complete copies">${plural(t.n, 'copy', 'copies')}</span>`
      : `<span class="hint" title="sheets">${t.nSheets}</span>`;
    return `<div class="part-card${multi ? ' wide' : ''}" style="--c:${t.color}">
      <div class="pages" style="--k:${Math.min(t.nodes.length || 1, 4)}">${thumbs}</div>
      <div class="row"><span class="tag">${esc(t.label)}</span>
        ${t.out ? `<input type="text" class="name" data-out="${t.out}" value="${esc(outputName(t.out))}"
          aria-label="name of part ${esc(t.label)}" title="output file name">` : '<span class="name">blank pages</span>'}
        ${count}</div>
      ${t.nIncomplete ? `<p class="warn-line">${plural(t.nIncomplete, 'incomplete copy', 'incomplete copies')}</p>` : ''}
      <label class="dest">send to <select data-part="${esc(t.id)}">${destOptions(t.dest)}</select></label>
      ${tree}
      ${join || sep ? `<div class="tree-actions">${join}${sep}</div>` : ''}
    </div>`;
  }).join('');
  const byKey = (k) => state.parts.find((x) => x.id === k);
  for (const sel of document.querySelectorAll('#part-cards select[data-part]')) {
    sel.onchange = () => {
      const d = resolveDest(sel.value);
      if (d) byKey(sel.dataset.part).dest = d;
      renderPartsAndBelow();
    };
  }
  for (const inp of document.querySelectorAll('#part-cards input.name')) {
    inp.onchange = () => {
      const o = state.outputs.find((x) => x.id === inp.dataset.out);
      o.name = inp.value.trim().replace(/\.pdf$/i, '') || o.name;
      renderPartsAndBelow();
    };
  }
  for (const sel of document.querySelectorAll('#part-cards select[data-join]')) {
    sel.onchange = () => { if (sel.value) joinParts(sel.dataset.join, sel.value); };
  }
  for (const b of document.querySelectorAll('#part-cards [data-separate]')) {
    b.onclick = () => separatePart(b.dataset.separate);
  }
  for (const b of document.querySelectorAll('#part-cards [data-split]')) {
    b.onclick = () => splitPart(b.dataset.split);
  }
  for (const b of document.querySelectorAll('#part-cards [data-merge]')) {
    b.onclick = () => mergePart(b.dataset.merge);
  }
  for (const b of document.querySelectorAll('#part-cards [data-inspect]')) {
    b.onclick = () => openInspector(+b.dataset.inspect);
  }
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
    const d = v === '__default' ? null : resolveDest(v);
    if (v !== '__default' && !d) return;
    for (const i of state.selected) routeCopy(i, d);
    state.selected.clear();
    renderReview();
    renderExport();
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
    const d = resolveDest(sel.value);
    if (d) routeCopy(i, d === t.dest ? null : d);
    renderReview();
    renderExport();
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
    let ink = inkOf(tmp, HI_W, h);
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

function pagesFor(outId) {
  const order = [];
  for (const s of state.sheets) {
    if (destOf(s) !== outId) continue;
    order.push(s.front);
    if (s.back !== null && !(state.omitBlankBacks && state.pages[s.back].blank)) order.push(s.back);
  }
  return order;
}

function renderExport() {
  const inUse = (o) => state.parts.some((t) => t.dest === o.id) || pagesFor(o.id).length;
  const rows = liveOutputs().filter(inUse).map((o) => {
    const n = state.sheets.filter((s) => destOf(s) === o.id).length;
    const colors = state.parts.filter((t) => t.dest === o.id).map((t) => t.color);
    return `<div class="out-row" style="--c:${colors[0] ?? 'var(--line)'}">
      <span class="dot"></span>
      ${o.part === undefined
    ? `<input type="text" value="${esc(o.name)}" data-o="${o.id}" aria-label="output name">`
    : `<span class="out-name" title="rename on its part card">${esc(o.name)}.pdf</span>`}
      <span class="count">${plural(n, 'sheet')} · ${pagesFor(o.id).length} pages</span>
      <button class="btn" data-dl="${o.id}"${n ? '' : ' disabled'}>download .pdf</button>
    </div>`;
  }).join('');
  const nd = state.sheets.filter((s) => destOf(s) === DISCARD).length;
  $('#outputs').innerHTML = `${rows}
    <p class="hint">${plural(nd, 'sheet')} discarded.</p>
    <div class="out-actions">
      <button class="btn" id="dl-all">download all</button>
      ${blankBacks() ? `<label><input type="checkbox" id="omit-blank"${state.omitBlankBacks ? ' checked' : ''}>
        leave out blank backs (Gradescope expects 2 pages per sheet)</label>` : ''}
    </div>`;
  for (const inp of document.querySelectorAll('#outputs input[type=text]')) {
    inp.onchange = () => {
      state.outputs.find((o) => o.id === inp.dataset.o).name = inp.value.replace(/\.pdf$/i, '') || 'output';
      renderParts();
      renderReview();
    };
  }
  for (const b of document.querySelectorAll('#outputs [data-dl]')) {
    b.onclick = () => exportOutput(b.dataset.dl, b);
  }
  $('#dl-all').onclick = async () => {
    for (const o of state.outputs) if (pagesFor(o.id).length) await exportOutput(o.id);
  };
  if ($('#omit-blank')) {
    $('#omit-blank').onchange = (e) => { state.omitBlankBacks = e.target.checked; renderExport(); };
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
  if (button) { button.disabled = true; button.textContent = 'building…'; }
  const out = await PDFLib.PDFDocument.create();
  const byFile = new Map();
  for (const pi of order) {
    const f = state.pages[pi].file;
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(pi);
  }
  const copied = new Map();
  for (const [f, pis] of byFile) {
    const got = await out.copyPages(await libDoc(f), pis.map((pi) => state.pages[pi].idx));
    pis.forEach((pi, j) => copied.set(pi, got[j]));
  }
  for (const pi of order) out.addPage(copied.get(pi));
  const bytes = await out.save();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  a.download = `${o.name}.pdf`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  state.lastExport = { name: o.name, pages: order.length, bytes: bytes.length };
  if (button) { button.disabled = false; button.textContent = 'download .pdf'; }
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
$('#reset-parts').onclick = () => { autoCut(); renderPartsAndBelow(); };

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
    `<li>${esc(t.name)} <button class="icon small" data-rm="${k}" aria-label="remove">&times;</button></li>`).join('');
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

/** Load the bundled fictional quiz scans, optionally with its templates. */
async function loadExample(withTemplates) {
  if (state.pages.length || state.templates.length) {
    location.href = `${location.pathname}?example=${withTemplates ? 'templates' : 'scans'}`;
    return;
  }
  const m = await (await fetch('demo/manifest.json')).json();
  if (withTemplates) await addTemplates(await fetchItems(m.templates));
  await addFiles(await fetchItems(m.scans));
}
$('#demo-scans').onclick = () => loadExample(false);
$('#demo-tpl').onclick = () => loadExample(true);
$('#clear-all').onclick = () => { location.href = location.pathname; };

const params = new URLSearchParams(location.search);
(async () => {
  if (params.get('tpl')) await addTemplates(await fetchItems(params.get('tpl').split(',')));
  if (params.get('src')) await addFiles(await fetchItems(params.get('src').split(',')));
  if (params.get('example')) await loadExample(params.get('example') === 'templates');
})();
