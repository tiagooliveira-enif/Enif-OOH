'use strict';
/* Leitura da resolução e da duração dos ficheiros carregados, no servidor (não se confia só no browser).
   Vídeos: ffprobe, se existir. Imagens: lê o cabeçalho do ficheiro (PNG, JPEG, GIF, WebP). */
const fs = require('node:fs'), { execFile } = require('node:child_process');

let hasProbe = null;
function run(cmd, args, timeout) {
  return new Promise(ok => execFile(cmd, args, { timeout: timeout || 20000, maxBuffer: 4e6 }, (e, out) => ok(e ? null : String(out))));
}
async function ffAvailable() {
  if (hasProbe === null) hasProbe = !!(await run('ffprobe', ['-version'], 5000));
  return hasProbe;
}
function imageSize(file) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch (e) { return null; }
  try {
    const b = Buffer.alloc(65536), n = fs.readSync(fd, b, 0, b.length, 0);
    if (n >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (n >= 10 && b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (n >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const t = b.toString('latin1', 12, 16);
      if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (t === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
      if (t === 'VP8X') return { w: (b.readUIntLE(24, 3)) + 1, h: (b.readUIntLE(27, 3)) + 1 };
    }
    if (n > 4 && b[0] === 0xff && b[1] === 0xd8) {                       // JPEG: procura o marcador SOF
      let i = 2;
      while (i + 9 < n) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch (e) { } finally { fs.closeSync(fd); }
  return null;
}
/* devolve { res: '1920×1080', secs: 12.4 } com o que conseguiu ler (campos em falta = não lidos) */
async function probe(file, type) {
  const out = {};
  if (type === 'Imagem') { const d = imageSize(file); if (d && d.w > 0 && d.h > 0) out.res = d.w + '×' + d.h; return out; }
  if (type !== 'Vídeo' || !(await ffAvailable())) return out;
  const j = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration:format=duration', '-of', 'json', file]);
  if (!j) return out;
  try {
    const o = JSON.parse(j), s = (o.streams || [])[0] || {};
    if (s.width > 0 && s.height > 0) out.res = s.width + '×' + s.height;
    const d = parseFloat(s.duration) || parseFloat((o.format || {}).duration);
    if (d > 0) out.secs = Math.round(d * 10) / 10;
  } catch (e) { }
  return out;
}
/* uma imagem do conteúdo (para o relatório final): imagem = a própria; vídeo = quadro ao segundo pedido (ffmpeg) */
async function still(file, type, mime, outFile, sec) {
  if (type === 'Imagem') { fs.copyFileSync(file, outFile); return /png/.test(mime) ? 'png' : 'jpg'; }
  if (type !== 'Vídeo' || !(await ffAvailable())) return null;
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(sec || 5), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', outFile], 30000);
  return r !== null && fs.existsSync(outFile) && fs.statSync(outFile).size > 0 ? 'jpg' : null;
}
module.exports = { probe, still, imageSize, ffAvailable };
