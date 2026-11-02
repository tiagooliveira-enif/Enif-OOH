'use strict';
/* Relatório final de uma campanha, em PDF (gerado no servidor, sem dependências), com o mesmo desenho do PDF que se exporta na plataforma: horizontal, amarelo, logótipo, resumo, gráfico, tabelas, imagens e registo de emissão. */
const { Pdf, widthOf } = require('./pdf');
const AUD = require('./audience');

const INK = '#151a22', MUTED = '#5c6675', ACC = '#ffe651', PEAK = '#f4b800', BAR = '#ece2ac', ALT = '#fffbe8', LINE = '#d2d6dd';
const LOGO = (() => { try { return require('node:fs').readFileSync(require('node:path').join(__dirname, 'logo.jpg')); } catch (e) { return null; } })();
const fmtPpm = x => String(Math.round(x * 100) / 100).replace('.', ',');
const modTxt = x => (x >= 1 ? fmtPpm(x) + '×/min' : '1× a cada ' + fmtPpm(Math.round(60 / x / 60 * 10) / 10) + ' min');
const nf = new Intl.NumberFormat('pt-PT', { useGrouping: 'always' });
const dShort = d => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
const pad2 = n => String(n).padStart(2, '0');
const lisbonDayHour = t => {
  const o = {}; new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).forEach(p => { o[p.type] = p.value; });
  return { d: o.year + '-' + o.month + '-' + o.day, h: +o.hour };
};
const LOG_MAX = 3000;
const lisbonStamp = t => new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', dateStyle: 'short', timeStyle: 'short' }).format(new Date(t));

/* c: campanha; rows: linhas de passagens de TODAS as campanhas nos ecrãs e dias da campanha ({s,c,f,d,h,n,bad,sec});
   screens: documentos dos ecrãs; files: { id: { name, type, jpg:Buffer|null } }; now: instante da geração */
function buildReport(c, rows, screens, files, now) {
  const w = AUD.weighRows(rows, screens), mine = w.filter(x => x.r.c === c.id);
  const scr = {}; screens.forEach(s => { scr[s.id] = s; });
  const sum = (arr, k) => arr.reduce((a, x) => a + k(x), 0);
  const plays = sum(mine, x => x.r.n), views = Math.round(sum(mine, x => x.impr));
  const byScr = {}, byFile = {};
  mine.forEach(x => {
    const s = byScr[x.r.s] = byScr[x.r.s] || { n: 0, v: 0 }; s.n += x.r.n; s.v += x.impr;
    const f = byFile[x.r.f] = byFile[x.r.f] || { n: 0, v: 0 }; f.n += x.r.n; f.v += x.impr;
  });
  const nScr = Object.keys(byScr).length;
  const M = 40;
  const doc = new Pdf({
    title: 'Relatório final · ' + c.name, landscape: true,
    footer: (d, n, t) => {
      d.rect(M, d.H - 32, d.W - 2 * M, 2, ACC);
      d.text(M, d.H - 18, 'Enif DOOH', { size: 8, color: MUTED });
      d.text(d.W - M, d.H - 18, 'Página ' + n + ' de ' + t, { size: 8, color: MUTED, align: 'r' });
    }
  });
  const PW = doc.W, PH = doc.H, W = PW - 2 * M, BOT = PH - 34;
  const venue = id => (scr[id] ? scr[id].venue + ' · ' + (scr[id].spot || '') : id);
  let y = 0;
  const title = t => {
    if (y > PH - 110) { doc.addPage(); y = M; }
    doc.rect(M, y - 10, 4, 14, PEAK);
    doc.text(M + 12, y, t, { size: 12, bold: true, color: INK }); y += 8;
  };
  // tabela: cabeçalho amarelo, linhas alternadas, cabeçalho repetido em cada página
  const table = (heads, aligns, widths, data, o) => {
    o = o || {}; const size = o.size || 9, pad = o.pad || 5, rh = size + 2 * pad + 1;
    const cell = (x, yy, v, i, bold, color) => {
      let t = String(v); while (t.length > 3 && widthOf(t, size, bold) > widths[i] - 2 * pad) t = t.slice(0, -2) + '…';
      doc.text(aligns[i] === 'r' ? x + widths[i] - pad : x + pad, yy + pad + size * 0.85, t, { size, bold, color: color || INK, align: aligns[i] === 'r' ? 'r' : 'l' });
    };
    const head = () => {
      doc.rect(M, y, W, rh, ACC);
      let x = M; heads.forEach((h, i) => { cell(x, y, h, i, true); x += widths[i]; });
      y += rh;
    };
    if (y + 2 * rh > BOT) { doc.addPage(); y = M; }
    head();
    data.forEach((r, k) => {
      if (y + rh > BOT) { doc.addPage(); y = M; head(); }
      if (k % 2) doc.rect(M, y, W, rh, ALT);
      let x = M; r.forEach((v, i) => { cell(x, y, v, i, false); x += widths[i]; });
      y += rh;
    });
    y += 22;
  };
  // cabeçalho: logótipo à esquerda, título à direita
  const LH = 92;
  if (LOGO) doc.image(LOGO, M, M, LH, LH);
  doc.text(PW - M, M + 40, 'Relatório de Insights', { size: 22, bold: true, color: INK, align: 'r' });
  doc.text(PW - M, M + 62, 'Enif DOOH - Visibilidade com Inteligência', { size: 11, color: INK, align: 'r' });
  y = M + LH + 28;
  const infos = ['Campanha: ' + c.name + (c.client ? ' (' + c.client + ')' : ''),
    'Ecrãs: ' + (nScr === 1 ? venue(Object.keys(byScr)[0]) : nScr + ' de ' + screens.length + ' ecrãs'),
    'Período: ' + dShort(c.start) + ' a ' + dShort(c.end),
    'Gerado em ' + lisbonStamp(now)];
  infos.forEach(l => { doc.text(M, y, l, { size: 10, color: MUTED }); y += 13; });
  y += 8;
  if (!mine.length) doc.text(M, y + 10, 'Sem reproduções neste período para a seleção.', { size: 10, color: INK });
  // resumo
  if (mine.length) {
    const cw4 = W / 4, hd = ['Visualizações estimadas', 'Passagens', 'Ecrãs com reprodução', 'Média por ecrã'];
    const vals = [nf.format(views), nf.format(plays), nScr + ' de ' + screens.length, nf.format(Math.round(views / nScr))];
    doc.rect(M, y, W, 27, ACC);
    hd.forEach((h, i) => doc.text(M + i * cw4 + cw4 / 2, y + 17, h, { size: 11, bold: true, color: INK, align: 'c' }));
    y += 27; doc.rect(M, y, W, 39, '#ffffff', LINE);
    vals.forEach((v, i) => doc.text(M + i * cw4 + cw4 / 2, y + 27, v, { size: 20, color: INK, align: 'c' }));
    y += 39 + 22;
  }
  // gráfico: média diária de visualizações por hora do dia
  if (mine.length) {
    const nd = Math.max(1, new Set(mine.map(x => x.r.d)).size), hv = new Array(24).fill(0);
    mine.forEach(x => { hv[x.r.h] += x.impr / nd; });
    const mx = Math.max(...hv), peaks = hv.map((v, h) => [v, h]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(p => p[1]);
    if (y > PH - 190) { doc.addPage(); y = M; }
    title('Visualizações por hora do dia (média diária)'); y += 10;
    const x0 = M + 34, cw = W - 34, ch = 100, bw = cw / 24, yb = y + ch;
    doc.text(x0 - 6, y + 6, nf.format(Math.round(mx)), { size: 7, color: MUTED, align: 'r' });
    doc.text(x0 - 6, yb, '0', { size: 7, color: MUTED, align: 'r' });
    doc.line(x0, yb, x0 + cw, yb, LINE, 0.5);
    hv.forEach((v, h) => {
      const bh = mx > 0 ? v / mx * ch : 0;
      if (bh > 0.2) doc.rect(x0 + h * bw + 2, yb - bh, bw - 4, bh, peaks.indexOf(h) > -1 ? PEAK : BAR);
      if (h % 3 === 0) doc.text(x0 + h * bw + bw / 2, yb + 11, pad2(h) + 'h', { size: 7, color: MUTED, align: 'c' });
    });
    y = yb + 30;
  }
  // bloco da campanha
  const fIds = Object.keys(byFile).sort((a, b) => byFile[b].v - byFile[a].v);
  if (mine.length) {
    if (y > PH - 170) { doc.addPage(); y = M; }
    title('Campanha: ' + c.name); y += 6;
    const mt = c.ppm > 0 ? modTxt(c.ppm) + ' · ' : '';
    doc.text(M, y, (c.client ? c.client + ' · ' : '') + mt + nScr + (nScr === 1 ? ' ecrã' : ' ecrãs') + ' · ' + nf.format(plays) + ' passagens · ' + nf.format(views) + ' visualizações estimadas', { size: 10, color: MUTED });
    y += 18;
    table(['Conteúdo', 'Tipo', 'Passagens', 'Visualizações'], ['l', 'l', 'r', 'r'], [W - 360, 100, 130, 130],
      fIds.map(id => [(files[id] && files[id].name) || 'Sem conteúdo associado', (files[id] && files[id].type) || '—', nf.format(byFile[id].n), nf.format(Math.round(byFile[id].v))]));
    const sIds = Object.keys(byScr).sort((a, b) => byScr[b].v - byScr[a].v);
    table(['Ecrã', 'Local', 'Cidade', 'Passagens', 'Visualizações'], ['l', 'l', 'l', 'r', 'r'], [W - 520, 160, 130, 100, 130],
      sIds.map(id => [id + (scr[id] && scr[id].spot ? ' · ' + scr[id].spot : ''), (scr[id] && scr[id].venue) || '—', (scr[id] && scr[id].city) || '—', nf.format(byScr[id].n), nf.format(Math.round(byScr[id].v))]));
    // imagem de cada conteúdo (o exemplo mais visto primeiro)
    const shots = fIds.filter(id => files[id] && files[id].jpg && doc.dims(files[id].jpg)).slice(0, 12);
    if (shots.length) {
      if (y > PH - 150) { doc.addPage(); y = M; }
      title(shots.length > 1 ? 'Imagens dos conteúdos' : 'Imagem do conteúdo'); y += 6;
      shots.forEach(id => {
        const f = files[id], d = doc.dims(f.jpg), iw = d.w >= d.h ? 230 : 100, ih = iw * d.h / d.w;
        if (y > PH - 110 - ih + 40) { doc.addPage(); y = M; }
        doc.image(f.jpg, M, y, iw, ih); doc.rect(M, y, iw, ih, null, LINE);
        const tx = M + iw + 20; let ty = y + 14;
        doc.para(tx, ty, f.name || id, PW - M - tx, { size: 12, bold: true, color: INK, lh: 16 }); ty += 16 * doc.wrap(f.name || id, PW - M - tx, 12, true).length;
        [f.type + (f.type === 'Vídeo' ? ' · imagem ao segundo 2' : ''), 'Campanha: ' + c.name, 'Emitido em: ' + (nScr === 1 ? venue(Object.keys(byScr)[0]) : nScr + ' ecrãs'),
          nf.format(byFile[id].n) + ' passagens · ' + nf.format(Math.round(byFile[id].v)) + ' visualizações estimadas'].forEach(t => { doc.text(tx, ty, t, { size: 10, color: MUTED }); ty += 14; });
        y += ih + 24;
      });
    }
  }
  // registo de emissão: uma linha por conteúdo, ecrã e dia (horas seguidas somadas)
  if (mine.length) {
    const grp = {};
    rows.filter(r => r.c === c.id && r.n > 0).forEach(r => { const k = r.s + '|' + r.f + '|' + r.d; (grp[k] = grp[k] || []).push(r); });
    const log = [], nowD = lisbonDayHour(now);
    Object.keys(grp).forEach(k => {
      const l = grp[k].sort((a, b) => a.h - b.h); let cur = null;
      l.forEach(r => {
        if (cur && r.h === cur.b) { cur.b = r.h + 1; cur.n += r.n; }
        else { cur = { s: r.s, f: r.f, d: r.d, a: r.h, b: r.h + 1, n: r.n }; log.push(cur); }
      });
    });
    log.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0) || venue(a.s).localeCompare(venue(b.s), 'pt') || a.a - b.a);
    const shown = log.slice(0, LOG_MAX);
    if (y > PH - 140) { doc.addPage(); y = M; }
    title('Registo de emissão (' + nf.format(log.length) + ' registos' + (log.length > shown.length ? ', mostrados os ' + nf.format(shown.length) + ' mais recentes' : '') + ')'); y += 6;
    table(['Data', 'Local', 'Ecrã', 'Campanha', 'Vídeo', 'Entrou', 'Saiu', 'Passagens'], ['l', 'l', 'l', 'l', 'l', 'r', 'r', 'r'], [62, 118, 118, 140, W - 62 - 118 - 118 - 140 - 52 - 66 - 60, 52, 66, 60],
      shown.map(e => [dShort(e.d), (scr[e.s] && scr[e.s].venue) || e.s, (scr[e.s] && scr[e.s].spot ? scr[e.s].spot + ' (' + e.s + ')' : e.s), c.name, (files[e.f] && files[e.f].name) || e.f || '—', pad2(e.a) + ':00',
        e.d === nowD.d && nowD.h >= e.a && nowD.h < e.b ? 'Em curso' : pad2(e.b) + ':00', nf.format(e.n)]), { size: 8, pad: 4 });
  }
  return doc.build();
}
module.exports = { buildReport };
