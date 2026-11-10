// Pure export + geometry logic. No DOM except what the caller passes in (doc for canvasTextToPng).
// Annotation geometry lives in unrotated PDF user space (y-up points).
// Framed annots (text, image): (x,y) = visual top-left corner, w/h in points, rot = total page rotation
// at creation (degrees CCW, as pdf-lib's rotate). u = along-text direction, d = "down" direction.

export const LINE_H = 1.2;
export const HL_OPACITY = 0.5;
// base = first-line baseline offset in em from the top of a LINE_H line box, for the metric-compatible
// browser fonts (Arial/Liberation Sans, Times New Roman/Liberation Serif, Courier New/Liberation Mono).
export const FONTS = {
  Helvetica: { std: 'Helvetica', base: 0.9465, css: 'Helvetica, Arial, "Liberation Sans", sans-serif' },
  Times: { std: 'TimesRoman', base: 0.9375, css: '"Times New Roman", Times, "Liberation Serif", serif' },
  Courier: { std: 'Courier', base: 0.8665, css: '"Courier New", Courier, "Liberation Mono", monospace' },
};

export const norm = (a) => ((a % 360) + 360) % 360;
const rnd = (v) => Math.round(v * 1e9) / 1e9;

export function frameVecs(rot) {
  const r = (rot * Math.PI) / 180;
  return { u: [rnd(Math.cos(r)), rnd(Math.sin(r))], d: [rnd(Math.sin(r)), rnd(-Math.cos(r))] };
}

export function hexToRgb(PDFLib, hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '') || [0, '000000'];
  const n = parseInt(m[1], 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export const textLines = (t) => String(t).replace(/\r/g, '').replace(/\t/g, '    ').split('\n');

// PDF-space line segments [x1,y1,x2,y2] for line / arrow / pen.
export function segments(a) {
  if (a.type === 'pen') {
    const p = a.pts;
    if (p.length === 1) return [[p[0][0], p[0][1], p[0][0], p[0][1]]];
    return p.slice(1).map((q, i) => [p[i][0], p[i][1], q[0], q[1]]);
  }
  const [x1, y1] = a.p1, [x2, y2] = a.p2;
  const out = [[x1, y1, x2, y2]];
  if (a.type === 'arrow') {
    const ang = Math.atan2(y2 - y1, x2 - x1), hl = Math.max(8, a.width * 4);
    for (const s of [1, -1]) {
      const t = ang + Math.PI - s * 0.45;
      out.push([x2, y2, x2 + hl * Math.cos(t), y2 + hl * Math.sin(t)]);
    }
  }
  return out;
}

// Render lines to a transparent PNG with the browser's own text shaping (used for non-WinAnsi text).
export function canvasTextToPng(doc, { lines, fontCss, size, color, w, h, pad, scale, base }) {
  const c = doc.createElement('canvas');
  c.width = Math.ceil((w + 2 * pad) * scale);
  c.height = Math.ceil((h + 2 * pad) * scale);
  const g = c.getContext('2d');
  g.scale(scale, scale);
  g.font = `${size}px ${fontCss}`;
  g.fillStyle = color;
  g.textBaseline = 'alphabetic';
  lines.forEach((l, i) => g.fillText(l, pad, pad + (base * size) + i * LINE_H * size));
  return new Promise((res, rej) => c.toBlob(async (b) => {
    if (!b) return rej(new Error('canvas toBlob failed'));
    res(new Uint8Array(await b.arrayBuffer()));
  }, 'image/png'));
}

/**
 * pages: [{origIndex, delta, annots} | {blank:true, width, height, delta, annots}], images: Map id -> {bytes, mime}.
 * opts: {textToPng(spec) -> Promise<Uint8Array>, onWarn(msg)}. Returns Uint8Array.
 * Works on the loaded original document (no copyPages) so outlines, links and forms survive.
 */
export async function exportPdf(PDFLib, bytes, pages, images, opts = {}) {
  const { PDFDocument, StandardFonts, degrees, BlendMode, LineCapStyle, rgb } = PDFLib;
  const warn = opts.onWarn || (() => {});
  const doc = await PDFDocument.load(bytes, { updateMetadata: false }); // never ignoreEncryption
  const orig = doc.getPages();
  // removePage/insertPage re-parent leaves: copy attributes inherited from intermediate /Pages nodes onto each page first
  for (const pg of orig) for (const k of ['MediaBox', 'CropBox', 'Rotate', 'Resources']) {
    const n = PDFLib.PDFName.of(k), v = pg.node.getInheritableAttribute(n);
    if (v && !pg.node.has(n)) pg.node.set(n, v);
  }
  const fonts = new Map(), embedded = new Map();
  const getFont = async (n) => { if (!fonts.has(n)) fonts.set(n, await doc.embedFont(StandardFonts[n])); return fonts.get(n); };
  const getImage = async (id) => {
    if (!embedded.has(id)) {
      const im = images.get(id);
      embedded.set(id, im.mime === 'image/jpeg' ? await doc.embedJpg(im.bytes) : await doc.embedPng(im.bytes));
    }
    return embedded.get(id);
  };

  async function drawFrameImage(page, img, a, w, h, pad = 0) {
    const { u, d } = frameVecs(a.rot);
    const x = a.x - u[0] * pad - d[0] * pad + d[0] * (h + 2 * pad);
    const y = a.y - u[1] * pad - d[1] * pad + d[1] * (h + 2 * pad); // bottom-left of the box
    page.drawImage(img, { x, y, width: w + 2 * pad, height: h + 2 * pad, rotate: degrees(a.rot) });
  }

  async function drawText(page, a) {
    const f = FONTS[a.font] || FONTS.Helvetica;
    const font = await getFont(f.std);
    const lines = textLines(a.text);
    const color = hexToRgb(PDFLib, a.color);
    let ok = true;
    for (const l of lines) { try { font.encodeText(l); } catch { ok = false; break; } }
    if (ok) {
      const { d } = frameVecs(a.rot);
      lines.forEach((l, i) => {
        if (!l) return;
        const off = f.base * a.size + i * LINE_H * a.size;
        page.drawText(l, { x: a.x + d[0] * off, y: a.y + d[1] * off, size: a.size, font, color, rotate: degrees(a.rot) });
      });
      return;
    }
    // shortcut: non-WinAnsi text is exported as an image, not selectable; embed fonts via fontkit if selectable text is needed
    try {
      if (!opts.textToPng) throw new Error('no textToPng');
      const pad = a.size * 0.3, S = 4;
      const png = await opts.textToPng({ lines, fontCss: f.css, size: a.size, color: a.color, w: a.w, h: a.h, pad, scale: S, base: f.base });
      await drawFrameImage(page, await doc.embedPng(png), a, a.w, a.h, pad);
    } catch (e) {
      warn('Text exported with "?" for unsupported characters: ' + e.message);
      const { d } = frameVecs(a.rot);
      lines.forEach((l, i) => {
        const safe = Array.from(l).map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
        const off = f.base * a.size + i * LINE_H * a.size;
        page.drawText(safe, { x: a.x + d[0] * off, y: a.y + d[1] * off, size: a.size, font, color, rotate: degrees(a.rot) });
      });
    }
  }

  async function drawAnnot(page, a) {
    const color = hexToRgb(PDFLib, a.color);
    switch (a.type) {
      case 'text': return drawText(page, a);
      case 'image': return drawFrameImage(page, await getImage(a.imageId), a, a.w, a.h);
      case 'highlight':
        return page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color, opacity: HL_OPACITY, borderWidth: 0, blendMode: BlendMode.Multiply });
      case 'whiteout':
        return page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: rgb(1, 1, 1), borderWidth: 0 });
      case 'rect':
        return page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, borderColor: color, borderWidth: a.width });
      case 'ellipse':
        return page.drawEllipse({ x: a.x + a.w / 2, y: a.y + a.h / 2, xScale: a.w / 2, yScale: a.h / 2, borderColor: color, borderWidth: a.width });
      default:
        for (const [x1, y1, x2, y2] of segments(a)) {
          page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: a.width, color, lineCap: LineCapStyle.Round });
        }
    }
  }

  // 1. resolve every entry to a PDFPage object (blanks are appended), draw + rotate
  const all = [...orig];
  const resolved = pages.map((p) => {
    if (!p.blank) return orig[p.origIndex];
    const pg = doc.addPage([p.width, p.height]);
    all.push(pg);
    return pg;
  });
  for (const [n, p] of pages.entries()) {
    const page = resolved[n];
    for (const a of p.annots) {
      try { await drawAnnot(page, a); } catch (e) { warn(`Could not export a ${a.type}: ${e.message}`); }
    }
    page.setRotation(degrees(norm(page.getRotation().angle + p.delta)));
  }
  // 2. remove then reorder, by object reference (indices shift on every mutation)
  const keep = new Set(resolved);
  for (let i = all.length - 1; i >= 0; i--) if (!keep.has(all[i])) { doc.removePage(i); all.splice(i, 1); }
  resolved.forEach((target, i) => {
    const cur = all.indexOf(target);
    if (cur === i) return;
    doc.removePage(cur); doc.insertPage(i, target);
    all.splice(cur, 1); all.splice(i, 0, target);
  });
  return doc.save();
}
