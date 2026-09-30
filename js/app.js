/**
 * scan_split UI: load scanned PDFs, match pages, route sheets, export.
 *
 * Flow: render every page small (pdf.js) -> features and page types
 * (pipeline.js) -> the user routes page types, and single sheets, to named
 * outputs or discard -> export copies the original pages (pdf-lib), so
 * scan quality is untouched.
 *
 * A sheet is {front, back} page indices; back is null in a simplex stack.
 * Loading ?src=a.pdf,b.pdf fetches those URLs instead of waiting for a drop.
 */
import * as pdfjsLib from '../vendor/pdf.min.mjs';
import * as P from './pipeline.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../vendor/pdf.worker.min.mjs', import.meta.url).href;

// feature render size: 4x the pipeline's feature grid
const TW = P.GRID_W * 4;
const TH = P.GRID_H * 4;
const COLORS = ['#3b73d9', '#e0762b', '#3f9d58', '#d64550', '#8a5cc7',
  '#1f9e9e', '#c49a1a', '#d45fa6', '#7a6a58', '#5d7a8c'];
const BLANK = -1;
const DISCARD = 'discard';
const LOW_MARGIN = 0.1;

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
  // {id, label, color, dest, n, img}
  types: [],
  // {id, name}
  outputs: [],
  S: null,
  lag: null,
  typ: null,
  duplexAuto: false,
  duplexMode: 'auto',
  splitNcc: 0.7,
  period: null,
  selected: new Set(),
  anchor: null,
  filter: 'all',
  omitBlankBacks: false,
  pdfLib: new Map(),
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
  const f = document.createElement('canvas');
  f.width = TW;
  f.height = TH;
  const fctx = f.getContext('2d', { willReadFrequently: true });
  fctx.drawImage(c, 0, 0, TW, TH);
  const rgba = fctx.getImageData(0, 0, TW, TH).data;
  const ink = new Uint8Array(TW * TH);
  for (let i = 0; i < ink.length; i++) {
    ink[i] = 255 - Math.round(0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] +
      0.114 * rgba[4 * i + 2]);
  }
  const { v, energy } = P.featurize(P.downsample(ink, TW, TH, 4));
  return { file, idx, thumb: URL.createObjectURL(blob), v, energy, ink };
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

/** Assign page types to sheet fronts and reset routing to the defaults. */
function cluster() {
  buildSheets();
  const pages = state.pages;
  const F = pages.map((p) => p.v);
  const live = state.sheets.filter((s) => !pages[s.front].blank);
  const idx = live.map((s) => s.front);
  const { labels, cons } = P.pageTypes(F, idx, state.S, pages.length, state.splitNcc);
  live.forEach((s, a) => {
    s.type = labels[a];
    const sims = cons.map((c) => P.dot(F[s.front], c)).sort((x, y) => y - x);
    s.margin = sims.length > 1 ? sims[0] - sims[1] : sims[0];
  });
  state.outputs = cons.map((_, k) => ({ id: `o${k}`, name: `type_${letter(k)}` }));
  state.types = cons.map((_, k) => ({
    id: k, label: letter(k), color: COLORS[k % COLORS.length], dest: `o${k}`,
  }));
  if (state.sheets.some((s) => s.type === BLANK)) {
    state.types.push({ id: BLANK, label: 'Blank', color: '#9a9aa2', dest: DISCARD });
  }
  for (const t of state.types) {
    const mem = state.sheets.filter((s) => s.type === t.id);
    t.n = mem.length;
    t.img = consensusImage(mem.map((s) => pages[s.front]));
  }
  state.period = P.period(state.sheets.map((s) => s.type));
  state.selected.clear();
  state.filter = 'all';
}

const letter = (k) => (k < 26 ? String.fromCharCode(65 + k) : `T${k}`);

/** Average member pages into a picture of the printed template. */
function consensusImage(pages) {
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(TW, TH);
  const acc = new Float32Array(TW * TH);
  // cap the members averaged; the template is stable well before this
  const use = pages.slice(0, 80);
  for (const p of use) for (let i = 0; i < acc.length; i++) acc[i] += p.ink[i];
  for (let i = 0; i < acc.length; i++) {
    const g = 255 - (use.length ? acc[i] / use.length : 0);
    img.data.set([g, g, g, 255], 4 * i);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/* ---------- routing helpers ---------- */

const typeOf = (s) => state.types.find((t) => t.id === s.type);
const destOf = (s) => s.dest ?? typeOf(s).dest;
const outputName = (d) => (d === DISCARD ? 'discard'
  : state.outputs.find((o) => o.id === d)?.name ?? '?');
const flagged = (s) => s.flipped || (s.type !== BLANK && s.margin < LOW_MARGIN);
const workOnBack = (s) => s.back !== null && !state.pages[s.back].blank;

function destOptions(selected, { includeDefault = false } = {}) {
  let h = includeDefault ? '<option value="">(page type default)</option>' : '';
  for (const o of state.outputs) {
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
  renderTypes();
  renderReview();
  renderExport();
}

function renderFiles() {
  $('#files').innerHTML = state.files.map((f) =>
    `<li>${esc(f.name)} · ${f.nPages} p</li>`).join('');
}

function renderSummary() {
  const sh = state.sheets;
  const nTypes = state.types.filter((t) => t.id !== BLANK).length;
  const per = state.period;
  let exam = '—';
  if (nTypes > 1 && per.p > 1 && per.agree > 0.5) {
    exam = per.window.map((k) => letter(k)).join(' → ');
  } else if (nTypes > 1) {
    exam = 'not collated';
  } else if (nTypes === 1) {
    exam = 'one type';
  }
  const stat = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  $('#summary').innerHTML = `
    <dl class="stats">
      ${stat('pages', state.pages.length)}
      ${stat('sheets', sh.length)}
      ${stat('scan', isDuplex() ? 'duplex' : 'simplex')}
      ${stat('blank pages', state.pages.filter((p) => p.blank).length)}
      ${stat('page types', nTypes)}
      ${stat('one exam', exam)}
      ${stat('flagged', sh.filter(flagged).length)}
    </dl>
    <div class="settings">
      <label>Pairing
        <select id="duplex-mode">
          <option value="auto">auto (${state.duplexAuto ? 'duplex' : 'simplex'} detected)</option>
          <option value="duplex">duplex: front + back per sheet</option>
          <option value="simplex">simplex: every page alone</option>
        </select></label>
      <label title="Lower merges look-alike pages into one type; higher splits them">
        Type split
        <input type="range" id="split" min="0.3" max="0.95" step="0.05" value="${state.splitNcc}">
        <span id="split-val">${state.splitNcc.toFixed(2)}</span></label>
      <span class="hint">Changing these re-sorts and resets routing.</span>
    </div>`;
  $('#duplex-mode').value = state.duplexMode;
  $('#duplex-mode').onchange = (e) => {
    state.duplexMode = e.target.value;
    cluster();
    renderAll();
  };
  $('#split').oninput = (e) => { $('#split-val').textContent = (+e.target.value).toFixed(2); };
  $('#split').onchange = (e) => {
    state.splitNcc = +e.target.value;
    cluster();
    renderAll();
  };
}

function renderTypes() {
  $('#type-cards').innerHTML = state.types.map((t) => `
    <div class="type-card" style="--c:${t.color}">
      <img src="${t.img}" alt="average of type ${esc(t.label)}">
      <div class="row"><b><span class="tag">${esc(t.label)}</span></b>
        <span class="hint">${t.n} sheet${t.n === 1 ? '' : 's'}</span></div>
      <select data-type="${t.id}">${destOptions(t.dest)}</select>
    </div>`).join('');
  for (const sel of document.querySelectorAll('#type-cards select')) {
    sel.onchange = () => {
      const t = state.types.find((x) => x.id === +sel.dataset.type);
      const d = resolveDest(sel.value);
      if (d) t.dest = d;
      renderTypes();
      renderReview();
      renderExport();
    };
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

function renderReview() {
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

  const pages = state.pages;
  $('#grid').innerHTML = visibleSheets().map(([s, i]) => {
    const t = typeOf(s);
    const d = destOf(s);
    const badges = [];
    if (s.flipped) badges.push('<span class="badge warn" title="scanned back-first; front detected">flipped</span>');
    if (s.type !== BLANK && s.margin < LOW_MARGIN) badges.push('<span class="badge warn" title="close to another type">unsure</span>');
    if (s.dest !== null) badges.push(`<span class="badge">&rarr; ${esc(outputName(d))}</span>`);
    const back = workOnBack(s) ? `<img class="back" src="${pages[s.back].thumb}" alt="" title="back has writing">` : '';
    return `<div class="tile${state.selected.has(i) ? ' sel' : ''}${d === DISCARD ? ' discard' : ''}"
        data-i="${i}" style="--c:${t.color}" tabindex="0">
      <img class="front" src="${pages[s.front].thumb}" alt="" loading="lazy">${back}
      <button class="zoom" title="inspect">&#10530;</button>
      <div class="meta"><span class="tag">${esc(t.label)}</span>#${i + 1} ${badges.join(' ')}</div>
    </div>`;
  }).join('') || '<p class="hint">No sheets match this filter.</p>';

  for (const el of document.querySelectorAll('#grid .tile')) {
    const i = +el.dataset.i;
    el.onclick = (e) => {
      if (e.target.closest('.zoom')) { openPreview(i); return; }
      select(i, e.shiftKey);
    };
    el.ondblclick = () => openPreview(i);
    el.onkeydown = (e) => { if (e.key === 'Enter') openPreview(i); if (e.key === ' ') { e.preventDefault(); select(i, e.shiftKey); } };
  }
  renderBulk();
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
      ${destOptions(null, { includeDefault: true }).replace(' selected', '')}</select></label>
    <button class="btn ghost" id="bulk-swap">swap front / back</button>
    <button class="btn ghost" id="bulk-all">select all shown</button>
    <button class="btn ghost" id="bulk-clear">clear selection</button>`;
  $('#bulk-dest').onchange = (e) => {
    const v = e.target.value;
    const d = v === '' ? null : resolveDest(v);
    if (v !== '' && !d) return;
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

/* ---------- preview ---------- */

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
  const rows = state.outputs.map((o) => {
    const n = state.sheets.filter((s) => destOf(s) === o.id).length;
    const colors = state.types.filter((t) => t.dest === o.id).map((t) => t.color);
    return `<div class="out-row" style="--c:${colors[0] ?? 'var(--line)'}">
      <span class="dot"></span>
      <input type="text" value="${esc(o.name)}" data-o="${o.id}" aria-label="output name">
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

const src = new URLSearchParams(location.search).get('src');
if (src) {
  (async () => {
    const items = await Promise.all(src.split(',').map(async (u) => ({
      name: decodeURIComponent(u.split('/').pop()),
      bytes: new Uint8Array(await (await fetch(u)).arrayBuffer()) })));
    await addFiles(items);
  })();
}
