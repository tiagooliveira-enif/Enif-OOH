'use strict';
/* Gerador de PDF mínimo, sem dependências: A4, texto (Helvetica, com acentos), retângulos, linhas, imagens JPEG. */
const zlib = require('node:zlib');

const WR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const WB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const CP = { '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '€': 0x80, '…': 0x85 };
/* texto → bytes WinAnsi */
function enc(s) {
  const out = [];
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (CP[ch]) out.push(CP[ch]); else if (c >= 32 && c < 127) out.push(c); else if (c >= 160 && c < 256) out.push(c); else if (ch === ' ') out.push(32); else out.push(63);
  }
  return Buffer.from(out);
}
function cw(ch, bold) {
  const c = ch.codePointAt(0), t = bold ? WB : WR;
  if (c >= 32 && c <= 126) return t[c - 32];
  const base = ch.normalize('NFD')[0], b = base.codePointAt(0);
  if (b >= 32 && b <= 126 && base !== ch) return t[b - 32];
  return 556;
}
const widthOf = (s, size, bold) => { let w = 0; for (const ch of String(s)) w += cw(ch, bold); return w * size / 1000; };
const hex2 = h => { const n = parseInt(String(h).replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
const f2 = n => (Math.round(n * 100) / 100).toString();
const esc = b => Buffer.from(b.toString('latin1').replace(/([\\()])/g, '\\$1'), 'latin1');

function jpegInfo(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), comps: b[i + 9] };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

class Pdf {
  constructor(opts) {
    this.W = 595.28; this.H = 841.89; this.pages = []; this.imgs = []; this.title = (opts && opts.title) || 'Documento';
    this.footer = opts && opts.footer; this.addPage();
  }
  addPage() { this.cur = { ops: [], imgs: [] }; this.pages.push(this.cur); return this.cur; }
  _y(y) { return this.H - y; }
  _push(s) { this.cur.ops.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1')); }
  rect(x, y, w, h, fill, stroke) {
    const parts = [];
    if (fill) parts.push(hex2(fill).map(f2).join(' ') + ' rg');
    if (stroke) parts.push(hex2(stroke).map(f2).join(' ') + ' RG 0.5 w');
    parts.push(f2(x) + ' ' + f2(this._y(y + h)) + ' ' + f2(w) + ' ' + f2(h) + ' re ' + (fill && stroke ? 'B' : fill ? 'f' : 'S'));
    this._push(parts.join('\n') + '\n');
  }
  line(x1, y1, x2, y2, color, w) { this._push(hex2(color || '#cccccc').map(f2).join(' ') + ' RG ' + f2(w || 0.5) + ' w ' + f2(x1) + ' ' + f2(this._y(y1)) + ' m ' + f2(x2) + ' ' + f2(this._y(y2)) + ' l S\n'); }
  /* (x, y) = linha de base do texto; align: 'l' | 'r' | 'c' relativo a x */
  text(x, y, s, o) {
    o = o || {}; const size = o.size || 10, bold = !!o.bold; s = String(s);
    const w = widthOf(s, size, bold); if (o.align === 'r') x -= w; else if (o.align === 'c') x -= w / 2;
    this._push(hex2(o.color || '#1a1f36').map(f2).join(' ') + ' rg BT /' + (bold ? 'F2' : 'F1') + ' ' + f2(size) + ' Tf ' + f2(x) + ' ' + f2(this._y(y)) + ' Td (');
    this._push(esc(enc(s))); this._push(') Tj ET\n');
    return w;
  }
  wrap(s, maxW, size, bold) {
    const out = []; String(s).split('\n').forEach(par => {
      let line = '';
      par.split(/\s+/).forEach(w => {
        if (!w) return;
        const t = line ? line + ' ' + w : w;
        if (widthOf(t, size, bold) <= maxW || !line) line = t; else { out.push(line); line = w; }
      });
      out.push(line);
    });
    return out;
  }
  para(x, y, s, maxW, o) {
    o = o || {}; const size = o.size || 10, lh = o.lh || size * 1.35, ls = this.wrap(s, maxW, size, o.bold);
    ls.forEach((l, i) => this.text(x, y + i * lh, l, o)); return ls.length * lh;
  }
  image(jpg, x, y, w, h) {
    const info = jpegInfo(jpg); if (!info) return false;
    let id = this.imgs.findIndex(i => i.buf === jpg);
    if (id < 0) { this.imgs.push({ buf: jpg, info }); id = this.imgs.length - 1; }
    if (this.cur.imgs.indexOf(id) < 0) this.cur.imgs.push(id);
    this._push('q ' + f2(w) + ' 0 0 ' + f2(h) + ' ' + f2(x) + ' ' + f2(this._y(y + h)) + ' cm /Im' + id + ' Do Q\n');
    return true;
  }
  dims(jpg) { return jpegInfo(jpg); }
  build() {
    const objs = []; const add = b => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1')); return objs.length; };
    add('');                                                         // 1: catálogo (preenchido no fim)
    add('');                                                         // 2: páginas
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2o = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const imgIds = this.imgs.map(im => add(Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width ' + im.info.w + ' /Height ' + im.info.h + ' /ColorSpace /' + (im.info.comps === 1 ? 'DeviceGray' : im.info.comps === 4 ? 'DeviceCMYK' : 'DeviceRGB') + ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.buf.length + ' >>\nstream\n', 'latin1'), im.buf, Buffer.from('\nendstream', 'latin1')])));
    const total = this.pages.length, pageIds = [];
    this.pages.forEach((pg, n) => {
      if (this.footer) { this.cur = pg; this.footer(this, n + 1, total); }
      const content = zlib.deflateSync(Buffer.concat(pg.ops));
      const cid = add(Buffer.concat([Buffer.from('<< /Filter /FlateDecode /Length ' + content.length + ' >>\nstream\n', 'latin1'), content, Buffer.from('\nendstream', 'latin1')]));
      const xo = pg.imgs.map(i => '/Im' + i + ' ' + imgIds[i] + ' 0 R').join(' ');
      pageIds.push(add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + f2(this.W) + ' ' + f2(this.H) + '] /Resources << /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2o + ' 0 R >> /XObject << ' + xo + ' >> >> /Contents ' + cid + ' 0 R >>'));
    });
    const info = add('<< /Title (' + esc(enc(this.title)).toString('latin1') + ') /Producer (Enif DOOH) /CreationDate (D:' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z) >>');
    objs[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1');
    objs[1] = Buffer.from('<< /Type /Pages /Kids [' + pageIds.map(i => i + ' 0 R').join(' ') + '] /Count ' + pageIds.length + ' >>', 'latin1');
    const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offs = []; let pos = parts[0].length;
    objs.forEach((o, i) => { offs.push(pos); const b = Buffer.concat([Buffer.from((i + 1) + ' 0 obj\n', 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]); parts.push(b); pos += b.length; });
    let x = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n'; offs.forEach(o => { x += String(o).padStart(10, '0') + ' 00000 n \n'; });
    x += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R /Info ' + info + ' 0 R >>\nstartxref\n' + pos + '\n%%EOF\n';
    parts.push(Buffer.from(x, 'latin1')); return Buffer.concat(parts);
  }
}
module.exports = { Pdf, widthOf, jpegInfo };
