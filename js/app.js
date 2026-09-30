/**
 * scan_split UI: load scanned PDFs, match pages, route sheets, export.
 *
 * Flow: render every page small (pdf.js) -> features and a type tree
 * (pipeline.js) -> page types are a cut through the tree, which the user
 * moves by splitting or merging types -> types, and single sheets, are
 * routed to named outputs or discarded -> export copies the original pages
 * (pdf-lib), so scan quality is untouched.
 *
 * A sheet is {front, back} page indices; back is null when the stack has
 * no scanned backs (the pairing setting, labelled "blank backs scanned").
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
const BLANK = -1;
const DISCARD = 'discard';
const LOW_MARGIN = 0.1;
const AUTO_SPLIT = 0.8;
const MAG = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
  <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/>
  <path d="M15 15l5.5 5.5M10 7v6M7 10h6" stroke="currentColor" stroke-width="2.2"
    stroke-linecap="round"/></svg>`;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  // {name, bytes, doc, nPages, start}
  files: [],
  // {file, idx, thumb, v, energy, ink, blank}
  pages: [],
  // {front, back, type, margin, flipped, dest}; dest null = type default
  sheets: [],
  // P.TypeTree over non-blank sheet fronts, or null
  tree: null,
  // tree nodes currently shown as page types, in display order
  cut: [],
  // node id -> {id, label, color, out, dest}; out is the node's own output,
  // dest where its sheets go; kept when a node leaves the cut
  meta: new Map(),
  blankMeta: { id: BLANK, label: 'Blank', color: '#9a9aa2', dest: DISCARD },
  // shown types: meta entries plus {node, n, img}
  types: [],
  // {id, name, node?}; node set for a type's own output, unset for one
  // made with "+ new output"
  outputs: [],
  S: null,
  lag: null,
  typ: null,
  duplexAuto: false,
  duplexMode: 'auto',
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
  state.lag = P.lagSim(state.S, pages.length);
  state.duplexAuto = P.isDuplex(state.lag);
  state.typ = P.typicality(state.S, pages.length);
  cluster();
}

const isDuplex = () => (state.duplexMode === 'auto'
  ? state.duplexAuto : state.duplexMode === 'duplex');

/** Pair pages into sheets (within each file) and pick each front. */
function buildSheets() {
  const sheets = [];
  if (isDuplex()) {
    for (const f of state.files) {
      for (let i = 0; i < f.nPages; i += 2) {
        const a = f.start + i;
        const b = i + 1 < f.nPages ? a + 1 : null;
        // the front is the side with near-copies elsewhere in the stack
        const flip = b !== null && state.typ[b] > state.typ[a];
        sheets.push({ front: flip ? b : a, back: flip ? a : b, flipped: flip });
      }
    }
  } else {
    state.pages.forEach((_, i) => sheets.push({ front: i, back: null, flipped: false }));
  }
  state.sheets = sheets.map((s) => ({ ...s, type: BLANK, margin: 1, dest: null }));
}

/** Pair sheets, build the type tree and apply the automatic cut. */
function cluster() {
  buildSheets();
  const pages = state.pages;
  const idx = state.sheets.filter((s) => !pages[s.front].blank).map((s) => s.front);
  state.tree = idx.length
    ? new P.TypeTree(pages.map((p) => p.v), idx, state.S, pages.length) : null;
  state.meta.clear();
  state.outputs = [];
  state.imgCache.clear();
  state.hiCache.clear();
  state.selected.clear();
  state.filter = 'all';
  autoCut();
}

/** Show the tree's automatic cut; keeps names and per-sheet routing. */
function autoCut() {
  state.cut = state.tree ? state.tree.autoCut(AUTO_SPLIT) : [];
  state.cut.forEach((node, k) => {
    const m = state.meta.get(node.id) ??
      newMeta(node, letter(k), COLORS[k % COLORS.length], `type_${letter(k)}`);
    m.dest = m.out;
    // look ahead so each card knows whether it can split
    state.tree.children(node);
  });
  assign();
}

/** Create a node's display entry and its own output, routed there. */
function newMeta(node, label, color, name, discard = false) {
  const out = { id: `n${node.id}`, name, node: node.id };
  state.outputs.push(out);
  const m = { id: node.id, label, color, out: out.id, dest: discard ? DISCARD : out.id };
  state.meta.set(node.id, m);
  return m;
}

const letter = (k) => (k < 26 ? String.fromCharCode(65 + k) : `T${k}`);

/** Give each sheet the shown type holding its front, and a match margin. */
function assign() {
  const pages = state.pages;
  const owner = new Map();
  for (const node of state.cut) for (const p of node.members) owner.set(p, node);
  for (const s of state.sheets) {
    const node = owner.get(s.front);
    if (!node) { s.type = BLANK; s.margin = 1; continue; }
    s.type = node.id;
    const v = pages[s.front].v;
    const others = state.cut.filter((m) => m !== node);
    if (!others.length) { s.margin = P.dot(v, node.cons); continue; }
    s.margin = P.dot(v, node.cons) - Math.max(...others.map((m) => P.dot(v, m.cons)));
    if (s.margin < LOW_MARGIN) {
      s.margin = P.shiftDot(v, node.cons) - Math.max(...others.map((m) => P.shiftDot(v, m.cons)));
    }
  }
  state.types = state.cut.map((node) => Object.assign(state.meta.get(node.id), {
    node, n: node.members.length, img: nodeImage(node),
  }));
  if (state.sheets.some((s) => s.type === BLANK)) {
    state.types.push(Object.assign(state.blankMeta, {
      node: null, n: state.sheets.filter((s) => s.type === BLANK).length,
      img: consensusImage(state.sheets.filter((s) => s.type === BLANK).map((s) => pages[s.front])),
    }));
  }
  state.period = P.period(state.sheets.map((s) => s.type));
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

/* ---------- split / merge ---------- */

const node = (id) => state.tree.nodes[id];

function unusedColor() {
  const used = new Set(state.cut.map((n) => state.meta.get(n.id).color));
  return COLORS.find((c) => !used.has(c)) ?? COLORS[state.cut.length % COLORS.length];
}

/** Replace a shown type by its two children, each with its own output. */
function splitType(id) {
  const n = node(id);
  const kids = state.tree.children(n);
  if (!kids) return;
  const m = state.meta.get(id);
  kids.forEach((k, j) => {
    if (!state.meta.has(k.id)) {
      newMeta(k, `${m.label}.${j + 1}`, j ? unusedColor() : m.color,
        `${outputName(m.out)}_${j + 1}`, m.dest === DISCARD);
    }
    state.tree.children(k);
  });
  state.cut.splice(state.cut.indexOf(n), 1, ...kids);
  assign();
  renderTypesAndBelow();
}

/**
 * Replace every shown type under a node's parent by the parent.
 *
 * A parent shown before keeps its old name and routing; a new one is named
 * after the types it merges.
 */
function mergeType(id) {
  const parent = node(id).parent;
  if (!parent) return;
  const under = state.cut.filter((n) => P.TypeTree.within(n, parent));
  const at = state.cut.indexOf(under[0]);
  if (!state.meta.has(parent.id)) {
    const ms = under.map((n) => state.meta.get(n.id));
    newMeta(parent, ms.map((m) => m.label).join('+'), ms[0].color,
      ms.map((m) => outputName(m.out)).join('+'), ms.every((m) => m.dest === DISCARD));
  }
  state.cut = state.cut.filter((n) => !under.includes(n));
  state.cut.splice(at, 0, parent);
  assign();
  renderTypesAndBelow();
}

/** Labels of the other shown types a merge would fold in with this one. */
function mergePartners(id) {
  const parent = node(id).parent;
  if (!parent) return [];
  return state.cut.filter((n) => n.id !== id && P.TypeTree.within(n, parent))
    .map((n) => state.meta.get(n.id).label);
}

/* ---------- routing helpers ---------- */

const typeOf = (s) => state.types.find((t) => t.id === s.type);
const destOf = (s) => s.dest ?? typeOf(s).dest;
const outputName = (d) => (d === DISCARD ? 'discard'
  : state.outputs.find((o) => o.id === d)?.name ?? '?');
const flagged = (s) => s.flipped || (s.type !== BLANK && s.margin < LOW_MARGIN);
const workOnBack = (s) => s.back !== null && !state.pages[s.back].blank;

/** List outputs worth offering: shown types' own, custom, and any in use. */
function liveOutputs() {
  const ids = new Set();
  for (const t of state.types) {
    if (t.out) ids.add(t.out);
    if (t.dest !== DISCARD) ids.add(t.dest);
  }
  for (const s of state.sheets) if (s.dest && s.dest !== DISCARD) ids.add(s.dest);
  return state.outputs.filter((o) => ids.has(o.id) || o.node === undefined);
}

function destOptions(selected, { includeDefault = false } = {}) {
  let h = includeDefault ? '<option value="">(page type default)</option>' : '';
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
  for (const id of ['summary', 'types', 'review', 'export']) $(`#${id}`).hidden = false;
  renderSummary();
  renderTypesAndBelow();
}

function renderTypesAndBelow() {
  renderTypes();
  renderReview();
  renderExport();
  renderSummaryStats();
}

function renderFiles() {
  $('#files').innerHTML = state.files.map((f) =>
    `<li>${esc(f.name)} · ${f.nPages} p</li>`).join('');
}

function renderSummary() {
  $('#summary').innerHTML = `<dl class="stats" id="stats"></dl>
    <div class="settings">
      <label>Blank backs scanned
        <select id="duplex-mode">
          <option value="auto">auto (detected: ${state.duplexAuto ? 'yes' : 'no'})</option>
          <option value="duplex">yes: each page pairs with the back after it</option>
          <option value="simplex">no: every page stands alone</option>
        </select></label>
      <span class="hint">Changing this re-sorts from scratch.</span>
    </div>`;
  $('#duplex-mode').value = state.duplexMode;
  $('#duplex-mode').onchange = (e) => {
    state.duplexMode = e.target.value;
    cluster();
    renderAll();
  };
  renderSummaryStats();
}

function renderSummaryStats() {
  const sh = state.sheets;
  const nTypes = state.types.filter((t) => t.id !== BLANK).length;
  const per = state.period;
  const label = (id) => state.types.find((t) => t.id === id)?.label ?? '?';
  let exam = '—';
  if (nTypes > 1 && per.p > 1 && per.agree > 0.5) {
    exam = per.window.map(label).join(' → ');
  } else if (nTypes > 1) {
    exam = 'not collated';
  } else if (nTypes === 1) {
    exam = 'one type';
  }
  const stat = (k, v) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`;
  $('#stats').innerHTML = `
    ${stat('pages', state.pages.length)}
    ${stat('sheets', sh.length)}
    ${stat('blank backs scanned', isDuplex() ? 'yes' : 'no')}
    ${stat('blank pages', state.pages.filter((p) => p.blank).length)}
    ${stat('page types', nTypes)}
    ${stat('one exam', exam)}
    ${stat('flagged', sh.filter(flagged).length)}`;
}

function renderTypes() {
  $('#type-cards').innerHTML = state.types.map((t) => {
    const n = t.node;
    const kids = n && n.children;
    const partners = n ? mergePartners(t.id) : [];
    const splitTip = kids
      ? `Split into ${kids[0].members.length} + ${kids[1].members.length} sheets; their averages correlate ${n.score.toFixed(2)} (near 1: same printed page, only handwriting differs)`
      : 'Cannot split: one sheet, or identical sheets';
    const mergeTip = partners.length ? `Merge with ${partners.join(', ')}` : 'Nothing to merge with';
    const tree = n ? `<div class="tree-actions">
        <button class="btn ghost small" data-split="${t.id}" title="${esc(splitTip)}"${kids ? '' : ' disabled'}>split${kids ? ` <span class="score">${kids[0].members.length}+${kids[1].members.length}</span>` : ''}</button>
        <button class="btn ghost small" data-merge="${t.id}" title="${esc(mergeTip)}"${partners.length ? '' : ' disabled'}>merge${partners.length ? ` with ${esc(partners.join(', '))}` : ''}</button>
      </div>` : '';
    return `<div class="type-card" style="--c:${t.color}">
      <div class="thumb"><img src="${t.img}" alt="average of type ${esc(t.label)}">
        <button class="mag" data-inspect="${t.id}" title="examine this type">${MAG}</button></div>
      <div class="row"><span class="tag">${esc(t.label)}</span>
        ${t.out ? `<input type="text" class="name" data-out="${t.out}" value="${esc(outputName(t.out))}"
          aria-label="name of type ${esc(t.label)}" title="name; also its output file name">` : '<span class="name">blank pages</span>'}
        <span class="hint">${t.n}</span></div>
      <label class="dest">send to <select data-type="${t.id}">${destOptions(t.dest)}</select></label>
      ${tree}
    </div>`;
  }).join('');
  for (const sel of document.querySelectorAll('#type-cards select')) {
    sel.onchange = () => {
      const t = state.types.find((x) => x.id === +sel.dataset.type);
      const d = resolveDest(sel.value);
      if (d) t.dest = d;
      renderTypesAndBelow();
    };
  }
  for (const inp of document.querySelectorAll('#type-cards input.name')) {
    inp.onchange = () => {
      const o = state.outputs.find((x) => x.id === inp.dataset.out);
      o.name = inp.value.trim().replace(/\.pdf$/i, '') || o.name;
      renderTypesAndBelow();
    };
  }
  for (const b of document.querySelectorAll('#type-cards [data-split]')) {
    b.onclick = () => splitType(+b.dataset.split);
  }
  for (const b of document.querySelectorAll('#type-cards [data-merge]')) {
    b.onclick = () => mergeType(+b.dataset.merge);
  }
  for (const b of document.querySelectorAll('#type-cards [data-inspect]')) {
    b.onclick = () => openInspector(+b.dataset.inspect);
  }
}

function visibleSheets() {
  const f = state.filter;
  return state.sheets.map((s, i) => [s, i]).filter(([s]) => (
    f === 'all' ? true
      : f === 'flagged' ? flagged(s)
        : f === 'back' ? workOnBack(s)
          : f === 'discard' ? destOf(s) === DISCARD
            : s.type === +f.slice(1)));
}

function tileHtml(s, i) {
  const t = typeOf(s);
  const d = destOf(s);
  const badges = [];
  if (s.flipped) badges.push('<span class="badge warn" title="scanned back-first; front detected">flipped</span>');
  if (s.type !== BLANK && s.margin < LOW_MARGIN) badges.push('<span class="badge warn" title="close to another type">unsure</span>');
  if (s.dest !== null) badges.push(`<span class="badge">&rarr; ${esc(outputName(d))}</span>`);
  const back = workOnBack(s) ? `<img class="back" src="${state.pages[s.back].thumb}" alt="" title="back has writing">` : '';
  return `<div class="tile${state.selected.has(i) ? ' sel' : ''}${d === DISCARD ? ' discard' : ''}"
      data-i="${i}" style="--c:${t.color}" tabindex="0">
    <img class="front" src="${state.pages[s.front].thumb}" alt="" loading="lazy">${back}
    <button class="zoom" title="inspect">&#10530;</button>
    <div class="meta"><span class="tag">${esc(t.label)}</span>#${i + 1} ${badges.join(' ')}</div>
  </div>`;
}

function renderReview() {
  if (!state.types.some((t) => `t${t.id}` === state.filter)) {
    if (state.filter.startsWith('t')) state.filter = 'all';
  }
  const sh = state.sheets;
  const chips = [['all', `all ${sh.length}`], ['flagged', `flagged ${sh.filter(flagged).length}`],
    ['back', `work on back ${sh.filter(workOnBack).length}`],
    ...state.types.map((t) => [`t${t.id}`, `${t.label} ${t.n}`]),
    ['discard', `discarded ${sh.filter((s) => destOf(s) === DISCARD).length}`]];
  $('#filters').innerHTML = chips.map(([k, l]) =>
    `<button class="chip${state.filter === k ? ' on' : ''}" data-f="${k}">${esc(l)}</button>`).join('');
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
    for (const i of state.selected) state.sheets[i].dest = d;
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
  const t = typeOf(s);
  const pageNums = [s.front, s.back].filter((x) => x !== null)
    .map((x) => state.pages[x].idx + 1).sort((a, b) => a - b).join('–');
  $('#pv-title').innerHTML = `<span class="tag" style="--c:${t.color}">${esc(t.label)}</span>
    Sheet ${i + 1} of ${state.sheets.length} · ${esc(p.file.name)} p${pageNums}
    · match margin ${s.type === BLANK ? '—' : s.margin.toFixed(2)}${s.flipped ? ' · scanned back-first' : ''}`;
  const sel = $('#pv-dest');
  sel.innerHTML = destOptions(destOf(s));
  sel.onchange = () => {
    const d = resolveDest(sel.value);
    if (d) s.dest = d === typeOf(s).dest ? null : d;
    renderReview();
    renderExport();
    openPreview(i);
  };
  $('#pv-back').parentElement.hidden = s.back === null;
  await drawLarge(s.front, $('#pv-front'));
  if (s.back !== null) await drawLarge(s.back, $('#pv-back'));
}

async function drawLarge(pi, canvas) {
  const p = state.pages[pi];
  const page = await p.file.doc.getPage(p.idx + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 1000 / vp1.width });
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

/* ---------- type inspector ---------- */

let inspectToken = 0;

/** Open the inspector: a type's average, large, and its split preview. */
async function openInspector(id) {
  const token = ++inspectToken;
  const dlg = $('#inspect');
  if (!dlg.open) dlg.showModal();
  const t = state.types.find((x) => x.id === id);
  const n = t.node;
  $('#in-title').innerHTML = `<span class="tag" style="--c:${t.color}">${esc(t.label)}</span>
    ${t.n} sheet${t.n === 1 ? '' : 's'} · &rarr; ${esc(outputName(t.dest))}`;
  const kids = n && n.children;
  $('#in-split-box').hidden = !kids;
  const partners = n ? mergePartners(id) : [];
  $('#in-merge').hidden = !partners.length;
  $('#in-merge').textContent = `merge with ${partners.join(', ')}`;
  $('#in-merge').onclick = () => { dlg.close(); mergeType(id); };
  if (kids) {
    $('#in-score').textContent = `If split, the two halves' averages correlate ${n.score.toFixed(2)}. ` +
      'Near 1 means the same printed page (only handwriting differs); ' +
      'lower means different pages or versions. Compare the two below.';
    $('#in-k0-cap').textContent = `${kids[0].members.length} sheets`;
    $('#in-k1-cap').textContent = `${kids[1].members.length} sheets`;
    $('#in-split').onclick = () => { dlg.close(); splitType(id); };
  }
  const fronts = state.sheets.filter((s) => s.type === id).map((s) => s.front);
  const canvases = [[$('#in-cons'), n, fronts]];
  if (kids) canvases.push([$('#in-k0'), kids[0]], [$('#in-k1'), kids[1]]);
  for (const [cv, nd, members] of canvases) placeholder(cv, nd ? nodeImage(nd) : t.img);
  for (const [cv, nd, members] of canvases) {
    const hi = await hiConsensus(nd ? nd.id : 'blank', members ?? nd.members, nd && nd.cons);
    if (token !== inspectToken) return;
    cv.width = hi.width;
    cv.height = hi.height;
    cv.getContext('2d').drawImage(hi, 0, 0);
  }
}

function placeholder(canvas, url) {
  const img = new Image();
  img.onload = () => {
    canvas.width = HI_W;
    canvas.height = Math.round(HI_W * TH / TW);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = url;
}

/**
 * Render a readable average of up to HI_N member pages (cached).
 *
 * Each page is first shifted onto the type's consensus (cons, a feature
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
  const inUse = (o) => state.types.some((t) => t.dest === o.id) || pagesFor(o.id).length;
  const rows = liveOutputs().filter(inUse).map((o) => {
    const n = state.sheets.filter((s) => destOf(s) === o.id).length;
    const colors = state.types.filter((t) => t.dest === o.id).map((t) => t.color);
    return `<div class="out-row" style="--c:${colors[0] ?? 'var(--line)'}">
      <span class="dot"></span>
      ${o.node === undefined
    ? `<input type="text" value="${esc(o.name)}" data-o="${o.id}" aria-label="output name">`
    : `<span class="out-name" title="rename on its page-type card">${esc(o.name)}.pdf</span>`}
      <span class="count">${n} sheet${n === 1 ? '' : 's'} · ${pagesFor(o.id).length} pages</span>
      <button class="btn" data-dl="${o.id}"${n ? '' : ' disabled'}>download .pdf</button>
    </div>`;
  }).join('');
  const nd = state.sheets.filter((s) => destOf(s) === DISCARD).length;
  $('#outputs').innerHTML = `${rows}
    <p class="hint">${nd} sheet${nd === 1 ? '' : 's'} discarded.</p>
    <div class="out-actions">
      <button class="btn" id="dl-all">download all</button>
      <label><input type="checkbox" id="omit-blank"${state.omitBlankBacks ? ' checked' : ''}>
        leave out blank backs (off keeps every sheet at 2 pages, as Gradescope expects)</label>
    </div>`;
  for (const inp of document.querySelectorAll('#outputs input[type=text]')) {
    inp.onchange = () => {
      state.outputs.find((o) => o.id === inp.dataset.o).name = inp.value.replace(/\.pdf$/i, '') || 'output';
      renderTypes();
      renderReview();
    };
  }
  for (const b of document.querySelectorAll('#outputs [data-dl]')) {
    b.onclick = () => exportOutput(b.dataset.dl, b);
  }
  $('#dl-all').onclick = async () => {
    for (const o of state.outputs) if (pagesFor(o.id).length) await exportOutput(o.id);
  };
  $('#omit-blank').onchange = (e) => { state.omitBlankBacks = e.target.checked; renderExport(); };
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
$('#reset-types').onclick = () => { autoCut(); renderTypesAndBelow(); };

const src = new URLSearchParams(location.search).get('src');
if (src) {
  (async () => {
    const items = await Promise.all(src.split(',').map(async (u) => ({
      name: decodeURIComponent(u.split('/').pop()),
      bytes: new Uint8Array(await (await fetch(u)).arrayBuffer()) })));
    await addFiles(items);
  })();
}
