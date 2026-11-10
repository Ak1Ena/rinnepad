import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import { FONTS, LINE_H, HL_OPACITY, norm, frameVecs, segments, textLines, exportPdf, canvasTextToPng } from './pdf-export.js';

const CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
pdfjsLib.GlobalWorkerOptions.workerSrc = CDN + 'build/pdf.worker.min.mjs';
const PDFLib = window.PDFLib;
const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

// ---------- state ----------
let bytes = null;            // pristine bytes for pdf-lib
let pdfDoc = null;           // pdf.js document
let pdfPages = [];           // pdf.js pages by origIndex
let fileName = 'document.pdf';
let pages = [];              // [{origIndex, delta, annots}]
const images = new Map();    // id -> {bytes, mime, url}
let undoStack = [], redoStack = [];
let version = 0, exportedVersion = 0;
let scale = 1, fitMode = true;
let tool = 'select';
let sel = null;              // {i, id}
let editing = null;          // {i, id|null, ta, base:{...}}
let drag = null;
let slots = [], thumbs = [];
let observer = null, thumbObserver = null;
let current = 0;
const toolColors = { text: '#000000', highlight: '#facc15', rect: '#dc2626', ellipse: '#dc2626', line: '#dc2626', arrow: '#dc2626', pen: '#dc2626', whiteout: '#ffffff' };
let uidN = 0;
const uid = () => 'a' + Date.now().toString(36) + (uidN++);

// ---------- ui helpers ----------
const setStatus = (m) => { $('status-msg').textContent = m; };
function showError(m) {
  $('error-text').textContent = m;
  $('error-banner').classList.remove('hidden');
  setStatus('Error');
}
const clearError = () => $('error-banner').classList.add('hidden');
$('error-close').onclick = clearError;
const dirty = () => version !== exportedVersion;
const snap = () => structuredClone(pages);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function updateButtons() {
  const has = !!pdfDoc;
  $('btn-download').disabled = !has;
  for (const el of document.querySelectorAll('.tb')) if (el.id !== 'btn-sidebar') el.disabled = !has;
  $('btn-undo').disabled = !has || !undoStack.length;
  $('btn-redo').disabled = !has || !redoStack.length;
  for (const b of document.querySelectorAll('.tb:disabled')) b.classList.add('opacity-40');
  for (const b of document.querySelectorAll('.tb:not(:disabled)')) b.classList.remove('opacity-40');
  for (const b of document.querySelectorAll('.tool')) {
    b.classList.toggle('bg-indigo-600', b.dataset.tool === tool);
  }
  $('zoom-label').textContent = Math.round(scale * 100) + '%';
}

// ---------- geometry ----------
function baseVp(p, sc = scale) {
  // blank pages have no pdf.js page: reuse the PageViewport class (not exported) with origin 0,0
  if (p.blank) return new (pdfPages[0].getViewport({ scale: 1 }).constructor)({ viewBox: [0, 0, p.width, p.height], userUnit: 1, scale: sc, rotation: p.delta, offsetX: 0, offsetY: 0, dontFlip: false });
  const pg = pdfPages[p.origIndex];
  return pg.getViewport({ scale: sc, rotation: norm(pg.rotate + p.delta) });
}
const toScr = (s, x, y) => s.vp.convertToViewportPoint(x, y);
const toPdf = (s, x, y) => s.vp.convertToPdfPoint(x, y);

function bboxOf(a) { // PDF-space bbox for non-framed shapes
  if (a.type === 'line' || a.type === 'arrow') return { x0: Math.min(a.p1[0], a.p2[0]), y0: Math.min(a.p1[1], a.p2[1]), x1: Math.max(a.p1[0], a.p2[0]), y1: Math.max(a.p1[1], a.p2[1]) };
  if (a.type === 'pen') {
    const xs = a.pts.map((p) => p[0]), ys = a.pts.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }
  return { x0: a.x, y0: a.y, x1: a.x + a.w, y1: a.y + a.h };
}
const isFramed = (a) => a.type === 'text' || a.type === 'image';

function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function hit(a, P, tol) {
  if (isFramed(a)) {
    const { u, d } = frameVecs(a.rot), rx = P[0] - a.x, ry = P[1] - a.y;
    const lx = rx * u[0] + ry * u[1], ly = rx * d[0] + ry * d[1];
    return lx >= -tol && lx <= a.w + tol && ly >= -tol && ly <= a.h + tol;
  }
  const b = bboxOf(a);
  if (a.type === 'highlight' || a.type === 'whiteout') return P[0] >= b.x0 && P[0] <= b.x1 && P[1] >= b.y0 && P[1] <= b.y1;
  if (a.type === 'rect') {
    const t = tol + a.width / 2;
    const inOut = P[0] >= b.x0 - t && P[0] <= b.x1 + t && P[1] >= b.y0 - t && P[1] <= b.y1 + t;
    const inIn = P[0] > b.x0 + t && P[0] < b.x1 - t && P[1] > b.y0 + t && P[1] < b.y1 - t;
    return inOut && !inIn;
  }
  if (a.type === 'ellipse') {
    const rx = (b.x1 - b.x0) / 2 || 1e-6, ry = (b.y1 - b.y0) / 2 || 1e-6;
    const r = Math.hypot((P[0] - (b.x0 + rx)) / rx, (P[1] - (b.y0 + ry)) / ry);
    return Math.abs(r - 1) * Math.min(rx, ry) <= tol + a.width / 2;
  }
  return segments(a).some((s) => distSeg(P[0], P[1], ...s) <= tol + a.width / 2);
}
function hitTest(i, P) {
  const tol = 6 / scale;
  const list = pages[i].annots;
  for (let k = list.length - 1; k >= 0; k--) if (hit(list[k], P, tol)) return list[k];
  return null;
}

const mctx = document.createElement('canvas').getContext('2d');
function measure(text, font, size) {
  mctx.font = `${size * 10}px ${(FONTS[font] || FONTS.Helvetica).css}`;
  const lines = textLines(text);
  return { w: Math.max(...lines.map((l) => mctx.measureText(l).width)) / 10, h: lines.length * LINE_H * size };
}

// ---------- open ----------
async function openFile(file) {
  if (!file) return;
  if (pdfDoc && dirty() && !confirm('Discard unexported edits and open another file?')) return;
  clearError();
  setStatus('Opening ' + file.name + '...');
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return showError(`"${file.name}" is not a PDF file.`);
  let data;
  try { data = new Uint8Array(await file.arrayBuffer()); } catch { return showError('Could not read the file.'); }
  const head = new TextDecoder('latin1').decode(data.subarray(0, 1024));
  if (!head.includes('%PDF-')) return showError(`"${file.name}" is not a valid PDF (missing PDF header).`);
  try {
    await PDFLib.PDFDocument.load(data, { updateMetadata: false });
  } catch (e) {
    if (e instanceof PDFLib.EncryptedPDFError || /encrypted/i.test(e?.message)) return showError('Password-protected PDFs are not supported.');
    return showError('This PDF is corrupt or unreadable: ' + e.message);
  }
  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data: data.slice(), isEvalSupported: false,
      cMapUrl: CDN + 'cmaps/', cMapPacked: true, standardFontDataUrl: CDN + 'standard_fonts/',
    }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') return showError('Password-protected PDFs are not supported.');
    return showError('This PDF is corrupt or unreadable: ' + (e?.message || e));
  }
  try {
    const list = [];
    for (let n = 1; n <= doc.numPages; n++) list.push(await doc.getPage(n));
    if (pdfDoc) pdfDoc.destroy();
    for (const im of images.values()) URL.revokeObjectURL(im.url);
    images.clear();
    pdfDoc = doc; pdfPages = list; bytes = data;
  } catch (e) {
    return showError('This PDF is corrupt or unreadable: ' + (e?.message || e));
  }
  fileName = file.name;
  $('file-name').textContent = file.name;
  pages = pdfPages.map((_, i) => ({ origIndex: i, delta: 0, annots: [] }));
  undoStack = []; redoStack = []; version = exportedVersion = 0; sel = null; editing = null; current = 0;
  $('empty').classList.add('hidden');
  fitMode = true;
  scale = clamp(fitScale(), 0.25, 1.5);
  rebuild(0);
  setTool('select');
  setStatus(`Opened ${file.name} (${pages.length} page${pages.length > 1 ? 's' : ''})`);
}

for (const id of ['file-input', 'file-input-empty']) {
  $(id).addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
}
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('drop-overlay').classList.replace('hidden', 'flex'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').classList.replace('flex', 'hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop-overlay').classList.replace('flex', 'hidden');
  openFile(e.dataTransfer.files[0]);
});
window.addEventListener('beforeunload', (e) => { if (pdfDoc && dirty()) { e.preventDefault(); e.returnValue = ''; } });

// ---------- render queue (one canvas, one render at a time) ----------
function queue(s, fn) {
  const gen = ++s.gen, prev = s.chain;
  s.chain = (async () => {
    if (s.task) s.task.cancel();
    try { await prev; } catch { /* cancelled */ }
    if (gen !== s.gen) return;
    await fn();
  })();
}
function paint(s, vp) {
  if (!s.page) return; // blank: the white slot background is the page
  queue(s, async () => {
    let dpr = window.devicePixelRatio || 1;
    while (vp.width * vp.height * dpr * dpr > 30e6 && dpr > 0.3) dpr *= 0.8;
    const c = s.canvas;
    c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
    c.style.width = vp.width + 'px'; c.style.height = vp.height + 'px';
    const task = s.page.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    s.task = task;
    try { await task.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') console.error(e); }
    finally { if (s.task === task) s.task = null; }
  });
}
const release = (s) => queue(s, async () => { s.canvas.width = s.canvas.height = 0; });

// ---------- pages view ----------
function rebuild(goto) {
  if (observer) observer.disconnect();
  if (thumbObserver) thumbObserver.disconnect();
  for (const s of [...slots, ...thumbs]) { s.gen++; s.task?.cancel(); }
  $('pages').replaceChildren(); $('thumbs').replaceChildren();
  slots = []; thumbs = [];
  observer = new IntersectionObserver((es) => {
    for (const en of es) {
      const s = slots[+en.target.dataset.i];
      if (!s) continue;
      s.visible = en.isIntersecting;
      if (s.visible) { paint(s, s.vp); renderOverlay(+en.target.dataset.i); } else release(s);
    }
  }, { root: $('viewer'), rootMargin: '800px 0px' });
  thumbObserver = new IntersectionObserver((es) => {
    for (const en of es) {
      const t = thumbs[+en.target.dataset.i];
      if (t && en.isIntersecting) paintThumb(t);
    }
  }, { root: $('sidebar'), rootMargin: '300px 0px' });

  pages.forEach((p, i) => {
    const vp = baseVp(p);
    const el = document.createElement('div');
    el.className = 'relative bg-white shadow-lg shrink-0';
    el.dataset.i = i;
    el.style.width = vp.width + 'px'; el.style.height = vp.height + 'px';
    const canvas = document.createElement('canvas');
    canvas.className = 'block';
    const overlay = document.createElement('div');
    overlay.className = 'absolute inset-0 overflow-hidden select-none';
    const layer = document.createElement('div');
    layer.className = 'absolute inset-0';
    overlay.appendChild(layer);
    el.append(canvas, overlay);
    const s = { el, canvas, overlay, layer, page: p.blank ? null : pdfPages[p.origIndex], vp, gen: 0, chain: null, task: null, visible: false };
    overlay.addEventListener('pointerdown', (e) => onDown(e, i));
    overlay.addEventListener('mousedown', (e) => { if (e.target !== editing?.ta) e.preventDefault(); });
    overlay.addEventListener('dblclick', (e) => onDbl(e, i));
    $('pages').appendChild(el);
    slots.push(s);
    observer.observe(el);

    // thumbnail
    const tw = 110, pg = p.blank ? null : pdfPages[p.origIndex];
    const tvp = baseVp(p, 1), tvp2 = baseVp(p, tw / tvp.width);
    const box = document.createElement('div');
    box.className = 'group';
    box.dataset.i = i;
    const cv = document.createElement('canvas');
    cv.className = 'block mx-auto bg-white cursor-pointer border-2 border-transparent';
    cv.style.width = tvp2.width + 'px'; cv.style.height = tvp2.height + 'px';
    cv.title = 'Page ' + (i + 1);
    cv.onclick = () => { goTo(i); if (window.innerWidth < 768) $('sidebar').classList.add('hidden'); };
    const bar = document.createElement('div');
    bar.className = 'flex items-center justify-center gap-1 mt-1 text-xs text-slate-300';
    const num = document.createElement('span'); num.textContent = i + 1; num.className = 'w-5 text-center';
    bar.append(num,
      tbtn('fa-arrow-up', 'Move up', i === 0, () => movePage(i, -1)),
      tbtn('fa-arrow-down', 'Move down', i === pages.length - 1, () => movePage(i, 1)),
      tbtn('fa-rotate-right', 'Rotate 90', false, () => rotatePage(i)),
      tbtn('fa-file-circle-plus', 'Add blank page after', false, () => addBlank(i)),
      tbtn('fa-trash', 'Delete page', false, () => deletePage(i)));
    box.append(cv, bar);
    $('thumbs').appendChild(box);
    const t = { el: box, canvas: cv, page: pg, vp: tvp2, gen: 0, chain: null, task: null };
    thumbs.push(t);
    thumbObserver.observe(box);
  });
  $('page-count').textContent = pages.length;
  $('page-input').max = pages.length;
  updateButtons();
  if (goto != null) goTo(clamp(goto, 0, pages.length - 1), true);
  updateCurrent();
}
function tbtn(icon, title, disabled, fn) {
  const b = document.createElement('button');
  b.title = title; b.disabled = disabled;
  b.className = 'px-1 py-0.5 rounded hover:bg-slate-600 disabled:opacity-30';
  const ic = document.createElement('i'); ic.className = 'fa-solid ' + icon;
  b.appendChild(ic); b.onclick = fn;
  return b;
}
function paintThumb(t) {
  if (t.done || !t.page) return;
  t.done = true;
  queue(t, async () => {
    const dpr = window.devicePixelRatio || 1;
    t.canvas.width = Math.floor(t.vp.width * dpr); t.canvas.height = Math.floor(t.vp.height * dpr);
    const task = t.page.render({ canvasContext: t.canvas.getContext('2d'), viewport: t.vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    t.task = task;
    try { await task.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') console.error(e); }
    finally { if (t.task === task) t.task = null; }
  });
}

function relayout() { // after zoom
  commitEdit();
  const v = $('viewer'), ratio = v.scrollHeight ? v.scrollTop / v.scrollHeight : 0;
  slots.forEach((s, i) => {
    s.vp = baseVp(pages[i]);
    s.el.style.width = s.vp.width + 'px'; s.el.style.height = s.vp.height + 'px';
    if (s.visible) { paint(s, s.vp); renderOverlay(i); }
  });
  v.scrollTop = ratio * v.scrollHeight;
  updateButtons();
}
function fitScale() {
  const w = Math.max(...pages.map((p) => baseVp(p, 1).width));
  return ($('viewer').clientWidth - 40) / w;
}
function setScale(s, fit = false) {
  scale = clamp(s, 0.25, 4); fitMode = fit;
  relayout();
}
$('btn-zoom-in').onclick = () => setScale(scale * 1.2);
$('btn-zoom-out').onclick = () => setScale(scale / 1.2);
$('btn-fit').onclick = () => setScale(fitScale(), true);
window.addEventListener('resize', () => { if (pdfDoc && fitMode) setScale(fitScale(), true); });

function goTo(i, instant) {
  const s = slots[i]; if (!s) return;
  $('viewer').scrollTo({ top: s.el.offsetTop - 12, behavior: instant ? 'instant' : 'smooth' });
}
function updateCurrent() {
  const v = $('viewer'), y = v.scrollTop + 40;
  let c = slots.findIndex((s) => s.el.offsetTop + s.el.offsetHeight > y);
  if (c < 0) c = slots.length - 1;
  current = Math.max(0, c);
  if (document.activeElement !== $('page-input')) $('page-input').value = current + 1;
  thumbs.forEach((t, i) => {
    t.canvas.classList.toggle('border-indigo-400', i === current);
    t.canvas.classList.toggle('border-transparent', i !== current);
  });
}
let scrollRaf = 0;
$('viewer').addEventListener('scroll', () => { cancelAnimationFrame(scrollRaf); scrollRaf = requestAnimationFrame(updateCurrent); });
$('page-input').addEventListener('change', (e) => { if (pdfDoc) goTo(clamp((+e.target.value || 1) - 1, 0, pages.length - 1)); });
$('btn-sidebar').onclick = () => $('sidebar').classList.toggle('hidden');

// ---------- mutations / undo ----------
function mutate(fn, structure, goto) {
  commitEdit();
  const before = snap();
  fn();
  undoStack.push(before); if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  version++;
  afterChange(structure, goto);
}
function afterChange(structure, goto) {
  if (structure) rebuild(goto);
  else renderAllOverlays();
  updateButtons();
}
function restore(from, to) {
  commitEdit();
  if (!from.length) return;
  to.push(snap());
  const sig = (ps) => ps.map((p) => (p.blank ? 'b' + p.width + 'x' + p.height : p.origIndex) + ':' + p.delta).join();
  const same = sig(pages) === sig(from[from.length - 1]);
  pages = from.pop();
  version++;
  if (sel && !pages[sel.i]?.annots.some((a) => a.id === sel.id)) sel = null;
  if (same) renderAllOverlays(); else rebuild(current);
  updateButtons();
}
const undo = () => restore(undoStack, redoStack);
const redo = () => restore(redoStack, undoStack);
$('btn-undo').onclick = undo;
$('btn-redo').onclick = redo;

function rotatePage(i) { mutate(() => { pages[i].delta = (pages[i].delta + 90) % 360; }, true, i); }
function addBlank(i) { // same displayed size as the page it follows
  const vp = baseVp(pages[i], 1);
  mutate(() => { pages.splice(i + 1, 0, { blank: true, width: vp.width, height: vp.height, delta: 0, annots: [] }); }, true, i + 1);
}
$('btn-add-page').onclick = () => { if (pdfDoc) addBlank(current); };
function deletePage(i) {
  if (pages.length <= 1) return showError('Cannot delete the last remaining page.');
  mutate(() => { pages.splice(i, 1); }, true, Math.min(i, pages.length - 1));
}
function movePage(i, dir) {
  const j = i + dir; if (j < 0 || j >= pages.length) return;
  mutate(() => { [pages[i], pages[j]] = [pages[j], pages[i]]; }, true, j);
}

// ---------- overlay rendering ----------
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
function renderAllOverlays() { slots.forEach((s, i) => { if (s.visible) renderOverlay(i); }); }

function annotEl(a, s) {
  const k = s.vp.scale, T = s.vp.rotation;
  if (isFramed(a)) {
    const [sx, sy] = toScr(s, a.x, a.y);
    const el = document.createElement(a.type === 'image' ? 'img' : 'div');
    Object.assign(el.style, { position: 'absolute', left: sx + 'px', top: sy + 'px', transformOrigin: '0 0', transform: `rotate(${T - a.rot}deg)`, pointerEvents: 'none', margin: '0', padding: '0' });
    if (a.type === 'image') {
      el.src = images.get(a.imageId)?.url || '';
      el.draggable = false;
      el.style.width = a.w * k + 'px'; el.style.height = a.h * k + 'px';
    } else {
      el.textContent = a.text;
      Object.assign(el.style, { whiteSpace: 'pre', fontFamily: (FONTS[a.font] || FONTS.Helvetica).css, fontSize: a.size * k + 'px', lineHeight: LINE_H * a.size * k + 'px', color: a.color });
    }
    return el;
  }
  const b = bboxOf(a);
  const [ax, ay] = toScr(s, b.x0, b.y0), [bx, by] = toScr(s, b.x1, b.y1);
  const l = Math.min(ax, bx), t = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
  if (a.type === 'highlight' || a.type === 'whiteout') {
    const el = document.createElement('div');
    Object.assign(el.style, { position: 'absolute', left: l + 'px', top: t + 'px', width: w + 'px', height: h + 'px', pointerEvents: 'none' });
    el.style.background = a.type === 'whiteout' ? '#fff' : a.color;
    if (a.type === 'highlight') { el.style.opacity = HL_OPACITY; el.style.mixBlendMode = 'multiply'; }
    return el;
  }
  const svg = svgEl('svg', { width: s.vp.width, height: s.vp.height });
  Object.assign(svg.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', overflow: 'visible' });
  const common = { stroke: a.color, 'stroke-width': a.width * k, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (a.type === 'rect') svg.appendChild(svgEl('rect', { x: l, y: t, width: w, height: h, ...common }));
  else if (a.type === 'ellipse') svg.appendChild(svgEl('ellipse', { cx: l + w / 2, cy: t + h / 2, rx: w / 2, ry: h / 2, ...common }));
  else {
    const d = segments(a).map(([x1, y1, x2, y2]) => { const p = toScr(s, x1, y1), q = toScr(s, x2, y2); return `M${p[0]} ${p[1]}L${q[0]} ${q[1]}`; }).join('');
    svg.appendChild(svgEl('path', { d, ...common }));
  }
  return svg;
}

function handle(parent, name, x, y, cursor) {
  const h = document.createElement('div');
  h.dataset.h = name;
  Object.assign(h.style, { position: 'absolute', left: x - 5 + 'px', top: y - 5 + 'px', width: '10px', height: '10px', background: '#6366f1', border: '1px solid #fff', borderRadius: '2px', cursor });
  parent.appendChild(h);
}
function drawSelection(i, layer) {
  const s = slots[i], a = pages[i].annots.find((x) => x.id === sel.id);
  if (!a) return;
  const k = s.vp.scale, T = s.vp.rotation;
  if (isFramed(a)) {
    const [sx, sy] = toScr(s, a.x, a.y);
    const box = document.createElement('div');
    Object.assign(box.style, { position: 'absolute', left: sx + 'px', top: sy + 'px', width: a.w * k + 'px', height: a.h * k + 'px', transformOrigin: '0 0', transform: `rotate(${T - a.rot}deg)`, outline: '1px dashed #6366f1' });
    handle(box, 'br', a.w * k, a.h * k, 'nwse-resize');
    layer.appendChild(box);
    return;
  }
  if (a.type === 'line' || a.type === 'arrow') {
    const box = document.createElement('div'); box.style.position = 'absolute'; layer.appendChild(box);
    for (const n of ['p1', 'p2']) { const p = toScr(s, ...a[n]); handle(layer, n, p[0], p[1], 'move'); }
    return;
  }
  const b = bboxOf(a), A = toScr(s, b.x0, b.y0), B = toScr(s, b.x1, b.y1);
  const l = Math.min(A[0], B[0]), t = Math.min(A[1], B[1]), r = Math.max(A[0], B[0]), bt = Math.max(A[1], B[1]);
  const box = document.createElement('div');
  Object.assign(box.style, { position: 'absolute', left: l + 'px', top: t + 'px', width: r - l + 'px', height: bt - t + 'px', outline: '1px dashed #6366f1' });
  layer.appendChild(box);
  handle(layer, 'nw', l, t, 'nwse-resize'); handle(layer, 'ne', r, t, 'nesw-resize');
  handle(layer, 'sw', l, bt, 'nesw-resize'); handle(layer, 'se', r, bt, 'nwse-resize');
}
function renderOverlay(i) {
  const s = slots[i]; if (!s) return;
  s.layer.replaceChildren();
  for (const a of pages[i].annots) {
    if (editing && editing.id === a.id) continue;
    s.layer.appendChild(annotEl(a, s));
  }
  if (sel && sel.i === i) drawSelection(i, s.layer);
}

// ---------- tools ----------
function setTool(t) {
  commitEdit();
  tool = t;
  if (t !== 'select') selectAnnot(null);
  $('pages').style.cursor = t === 'select' ? 'default' : t === 'text' ? 'text' : 'crosshair';
  for (const s of slots) s.overlay.style.touchAction = t === 'select' ? 'pan-x pan-y' : 'none';
  if (toolColors[t]) $('in-color').value = toolColors[t];
  updateButtons();
}
for (const b of document.querySelectorAll('.tool')) b.onclick = () => setTool(b.dataset.tool);

function selectAnnot(n) {
  const prev = sel;
  sel = n;
  if (prev && prev.i !== n?.i) renderOverlay(prev.i);
  if (n) renderOverlay(n.i); else if (prev) renderOverlay(prev.i);
  const a = n && pages[n.i].annots.find((x) => x.id === n.id);
  if (a) {
    if (a.color) $('in-color').value = a.color;
    if (a.type === 'text') { $('in-font').value = a.font; $('in-size').value = a.size; }
    if (a.width) $('in-width').value = a.width;
  }
}
const getSel = () => sel && pages[sel.i]?.annots.find((a) => a.id === sel.id);

function applyToSel(fn) {
  const a = getSel();
  if (!a) return false;
  mutate(() => fn(pages[sel.i].annots.find((x) => x.id === sel.id)));
  return true;
}
$('in-color').addEventListener('change', (e) => {
  if (!applyToSel((a) => { if (a.type !== 'whiteout') a.color = e.target.value; })) toolColors[tool] = e.target.value;
  else if (getSel()) toolColors[getSel().type] = e.target.value;
});
$('in-width').addEventListener('change', (e) => { const v = clamp(+e.target.value || 2, 0.5, 40); applyToSel((a) => { if (a.width) a.width = v; }); });
function textProps(e) {
  const font = $('in-font').value, size = clamp(+$('in-size').value || 14, 4, 200);
  applyToSel((a) => { if (a.type === 'text') { a.font = font; a.size = size; Object.assign(a, measure(a.text, font, size)); } });
}
$('in-font').addEventListener('change', textProps);
$('in-size').addEventListener('change', textProps);

// ---------- pointer handling ----------
const local = (e, s) => { const r = s.overlay.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

function onDown(e, i) {
  if (e.button !== 0 || e.target === editing?.ta) return;
  e.preventDefault();
  commitEdit();
  const s = slots[i], pt = local(e, s), P = toPdf(s, ...pt);
  const h = e.target.dataset?.h;
  if (h && sel && sel.i === i) return startResize(i, h, P, pt);
  if (tool === 'select') {
    const a = hitTest(i, P);
    selectAnnot(a ? { i, id: a.id } : null);
    if (a) startMove(i, a, P);
  } else if (tool === 'text') {
    selectAnnot(null);
    drag = { kind: 'textclick', i, P, a: hitTest(i, P) };
    window.addEventListener('pointerup', onUp);
  } else startDraw(i, P, pt);
}
function onDbl(e, i) {
  if (tool !== 'select') return;
  const s = slots[i], a = hitTest(i, toPdf(s, ...local(e, s)));
  if (a?.type === 'text') startEdit(i, a);
}
function track() {
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
function startMove(i, a, P) {
  drag = { kind: 'move', i, id: a.id, before: snap(), orig: structuredClone(a), P0: P, moved: false };
  track();
}
function startResize(i, h, P, pt) {
  const a = getSel();
  const d = { kind: 'resize', i, id: a.id, h, before: snap(), orig: structuredClone(a), P0: P, moved: false };
  if (!isFramed(a) && a.type !== 'line' && a.type !== 'arrow') {
    const s = slots[i], b = bboxOf(a), A = toScr(s, b.x0, b.y0), B = toScr(s, b.x1, b.y1);
    const L = Math.min(A[0], B[0]), R = Math.max(A[0], B[0]), Tp = Math.min(A[1], B[1]), Bt = Math.max(A[1], B[1]);
    d.opp = [h.includes('w') ? R : L, h.includes('n') ? Bt : Tp];
    d.ob = b;
  }
  drag = d;
  track();
}
function startDraw(i, P, pt) {
  const type = tool;
  const a = { id: uid(), type, color: toolColors[type] || $('in-color').value, width: clamp(+$('in-width').value || 2, 0.5, 40) };
  if (type === 'line' || type === 'arrow') Object.assign(a, { p1: P, p2: P });
  else if (type === 'pen') a.pts = [P];
  else Object.assign(a, { x: P[0], y: P[1], w: 0, h: 0 });
  drag = { kind: 'draw', i, id: a.id, before: snap(), P0: P, pt0: pt, last: pt, moved: false };
  pages[i].annots.push(a);
  track();
}

function onMove(e) {
  if (!drag) return;
  const s = slots[drag.i], pt = local(e, s), P = toPdf(s, ...pt);
  const a = pages[drag.i].annots.find((x) => x.id === drag.id);
  if (!a) return;
  const dx = P[0] - drag.P0[0], dy = P[1] - drag.P0[1], o = drag.orig;
  if (drag.kind === 'move') {
    if (Math.hypot(...pt.map((v, n) => v - toScr(s, ...drag.P0)[n])) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (o.pts) a.pts = o.pts.map((p) => [p[0] + dx, p[1] + dy]);
    else if (o.p1) { a.p1 = [o.p1[0] + dx, o.p1[1] + dy]; a.p2 = [o.p2[0] + dx, o.p2[1] + dy]; }
    else { a.x = o.x + dx; a.y = o.y + dy; }
  } else if (drag.kind === 'resize') {
    drag.moved = true;
    if (isFramed(a)) {
      const { u, d } = frameVecs(a.rot), rx = P[0] - a.x, ry = P[1] - a.y;
      const lx = rx * u[0] + ry * u[1], ly = rx * d[0] + ry * d[1];
      if (a.type === 'image') { a.w = Math.max(8, lx); a.h = Math.max(8, ly); }
      else { const f = clamp(lx / o.w, 0.2, 10); a.size = Math.round(o.size * f * 10) / 10; a.w = o.w * f; a.h = o.h * f; $('in-size').value = a.size; }
    } else if (drag.h === 'p1' || drag.h === 'p2') a[drag.h] = P;
    else {
      const po = toPdf(s, ...drag.opp);
      const nb = { x0: Math.min(po[0], P[0]), y0: Math.min(po[1], P[1]), x1: Math.max(po[0], P[0]), y1: Math.max(po[1], P[1]) };
      if (a.pts) {
        const ob = drag.ob, ow = ob.x1 - ob.x0 || 1, oh = ob.y1 - ob.y0 || 1;
        a.pts = o.pts.map((p) => [nb.x0 + ((p[0] - ob.x0) / ow) * (nb.x1 - nb.x0), nb.y0 + ((p[1] - ob.y0) / oh) * (nb.y1 - nb.y0)]);
      } else Object.assign(a, { x: nb.x0, y: nb.y0, w: nb.x1 - nb.x0, h: nb.y1 - nb.y0 });
    }
  } else if (drag.kind === 'draw') {
    drag.moved = true;
    if (a.pts) { if (Math.hypot(pt[0] - drag.last[0], pt[1] - drag.last[1]) >= 2) { a.pts.push(P); drag.last = pt; } }
    else if (a.p1) a.p2 = P;
    else {
      Object.assign(a, { x: Math.min(drag.P0[0], P[0]), y: Math.min(drag.P0[1], P[1]), w: Math.abs(P[0] - drag.P0[0]), h: Math.abs(P[1] - drag.P0[1]) });
    }
  }
  renderOverlay(drag.i);
}
function onUp(e) {
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  const d = drag; drag = null;
  if (!d) return;
  if (d.kind === 'textclick') {
    const s = slots[d.i], pt = local(e, s);
    return d.a?.type === 'text' ? startEdit(d.i, d.a) : startEdit(d.i, null, toPdf(s, ...pt));
  }
  const list = pages[d.i].annots, a = list.find((x) => x.id === d.id);
  if (d.kind === 'draw') {
    const s = slots[d.i], pt = local(e, s);
    const tiny = Math.hypot(pt[0] - d.pt0[0], pt[1] - d.pt0[1]) < 4;
    if (!a || tiny || (a.pts && a.pts.length < 2)) {
      if (a) list.splice(list.indexOf(a), 1);
      return renderOverlay(d.i);
    }
    commitDrag(d, true);
    selectAnnot({ i: d.i, id: d.id });
    return;
  }
  if (d.moved) commitDrag(d, false);
  renderOverlay(d.i);
}
function commitDrag(d) {
  undoStack.push(d.before); if (undoStack.length > 100) undoStack.shift();
  redoStack = []; version++;
  renderOverlay(d.i);
  updateButtons();
}
function cancelDrag() {
  if (!drag) return false;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  if (drag.before) { pages = drag.before; renderAllOverlays(); }
  drag = null;
  return true;
}

// ---------- text editing ----------
function startEdit(i, a, P) {
  commitEdit();
  const s = slots[i], k = s.vp.scale, T = s.vp.rotation;
  const base = a ? { x: a.x, y: a.y, rot: a.rot, font: a.font, size: a.size, color: a.color } : {
    x: P[0], y: P[1], rot: T, font: $('in-font').value, size: clamp(+$('in-size').value || 14, 4, 200), color: toolColors.text,
  };
  const ta = document.createElement('textarea');
  ta.value = a ? a.text : '';
  ta.wrap = 'off'; ta.spellcheck = false;
  const [sx, sy] = toScr(s, base.x, base.y);
  Object.assign(ta.style, {
    position: 'absolute', left: sx + 'px', top: sy + 'px', transformOrigin: '0 0', transform: `rotate(${T - base.rot}deg)`,
    margin: '0', padding: '0', border: '1px dashed #6366f1', outline: 'none', background: 'rgba(255,255,255,0.6)', resize: 'none', overflow: 'hidden',
    whiteSpace: 'pre', fontFamily: FONTS[base.font].css, fontSize: base.size * k + 'px', lineHeight: LINE_H * base.size * k + 'px', color: base.color, boxSizing: 'content-box',
  });
  const fit = () => {
    const m = measure(ta.value || ' ', base.font, base.size);
    ta.style.width = (m.w + base.size) * k + 'px';
    ta.style.height = Math.max(m.h, LINE_H * base.size) * k + 'px';
  };
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commitEdit(); }
  });
  ta.addEventListener('blur', () => commitEdit());
  s.overlay.appendChild(ta);
  editing = { i, id: a ? a.id : null, ta, base };
  if (a) renderOverlay(i);
  fit(); ta.focus();
}
function commitEdit() {
  const e = editing; if (!e) return;
  editing = null;
  const text = e.ta.value.replace(/\r/g, '').replace(/\t/g, '    ');
  e.ta.remove();
  const list = pages[e.i].annots;
  const old = e.id && list.find((x) => x.id === e.id);
  if (!text.trim()) {
    if (old) mutate(() => { list.splice(list.indexOf(old), 1); }); else renderOverlay(e.i);
    if (old && sel?.id === old.id) sel = null;
    return;
  }
  if (old && old.text === text) return renderOverlay(e.i);
  mutate(() => {
    const m = measure(text, e.base.font, e.base.size);
    if (old) Object.assign(old, { text }, m);
    else {
      const a = { id: uid(), type: 'text', text, ...e.base, ...m };
      list.push(a);
      sel = { i: e.i, id: a.id };
    }
  });
}

// ---------- images ----------
$('btn-image').onclick = () => $('image-input').click();
$('image-input').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) try { await insertImage(f); } catch (err) { showError('Could not insert image: ' + (err?.message || err)); }
});
async function insertImage(file) {
  let blob = file;
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') { // convert other types to PNG via canvas
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url; await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || 300; c.height = img.naturalHeight || 150;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw new Error('conversion failed');
    } finally { URL.revokeObjectURL(url); }
  }
  const bm = await createImageBitmap(blob);
  const nw = bm.width, nh = bm.height; bm.close();
  const id = uid(), mime = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  images.set(id, { bytes: new Uint8Array(await blob.arrayBuffer()), mime, url: URL.createObjectURL(blob) });
  const i = current, s = slots[i], k = s.vp.scale;
  const w = Math.min(200, s.vp.width / k / 2), h = w * nh / nw;
  const v = $('viewer'), cy = clamp(v.scrollTop + v.clientHeight / 2 - s.el.offsetTop, h * k / 2, Math.max(h * k / 2, s.vp.height - h * k / 2));
  const P = toPdf(s, s.vp.width / 2 - (w * k) / 2, cy - (h * k) / 2);
  mutate(() => {
    const a = { id: uid(), type: 'image', imageId: id, x: P[0], y: P[1], w, h, rot: s.vp.rotation };
    pages[i].annots.push(a);
    sel = { i, id: a.id };
  });
  setStatus('Image inserted. Drag to move, use the corner handle to resize.');
}

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (!pdfDoc) return;
  const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    if (cancelDrag()) return;
    if (editing) return commitEdit();
    selectAnnot(null); setTool('select');
  } else if (typing) return;
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
    e.preventDefault();
    const { i, id } = sel;
    mutate(() => { const l = pages[i].annots; l.splice(l.findIndex((a) => a.id === id), 1); sel = null; });
  }
});

// ---------- export ----------
$('btn-download').onclick = async () => {
  if (!pdfDoc) return;
  commitEdit();
  const btn = $('btn-download'), warns = [];
  btn.disabled = true; setStatus('Exporting...'); clearError();
  try {
    const out = await exportPdf(PDFLib, bytes, pages, images, {
      textToPng: (spec) => canvasTextToPng(document, spec),
      onWarn: (m) => warns.push(m),
    });
    const url = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url; a.download = fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    exportedVersion = version;
    setStatus(warns.length ? 'Exported with warnings: ' + warns.join('; ') : 'Exported ' + a.download);
  } catch (e) {
    showError('Export failed (your edits are kept): ' + (e?.message || e));
  } finally { btn.disabled = false; }
};

updateButtons();
setTool('select');
