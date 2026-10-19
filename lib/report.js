'use strict';
/* Relatório final de uma campanha, em PDF (gerado no servidor, sem dependências). */
const { Pdf, widthOf } = require('./pdf');
const AUD = require('./audience');

const BLUE = '#1D5FE5', INK = '#1a1f36', MUTED = '#6b7390', LINE = '#e3e7f2', SOFT = '#f4f6fb';
const nf = new Intl.NumberFormat('pt-PT');
const dShort = d => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
const lisbonStamp = t => new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', dateStyle: 'short', timeStyle: 'short' }).format(new Date(t));

/* c: campanha; rows: linhas de passagens de TODAS as campanhas nos ecrãs e dias da campanha ({s,c,f,d,h,n,bad,sec});
   screens: documentos dos ecrãs; files: { id: { name, type, jpg:Buffer|null } }; now: instante da geração */
function buildReport(c, rows, screens, files, now) {
  const w = AUD.weighRows(rows, screens), mine = w.filter(x => x.r.c === c.id);
  const scr = {}; screens.forEach(s => { scr[s.id] = s; });
  const sum = (arr, k) => arr.reduce((a, x) => a + k(x), 0);
  const plays = sum(mine, x => x.r.n), views = Math.round(sum(mine, x => x.impr)), secs = sum(mine, x => x.r.sec || 0);
  const byScr = {}, byDay = {}, byFile = {};
  mine.forEach(x => {
    const s = byScr[x.r.s] = byScr[x.r.s] || { n: 0, v: 0 }; s.n += x.r.n; s.v += x.impr;
    const d = byDay[x.r.d] = byDay[x.r.d] || { n: 0, v: 0 }; d.n += x.r.n; d.v += x.impr;
    const f = byFile[x.r.f] = byFile[x.r.f] || { n: 0, v: 0 }; f.n += x.r.n; f.v += x.impr;
  });
  const doc = new Pdf({
    title: 'Relatório final · ' + c.name,
    footer: (d, n, t) => {
      d.line(40, 800, 555, 800, LINE, 0.5);
      d.text(40, 816, 'Enif DOOH · Visibilidade com Inteligência', { size: 8, color: MUTED });
      d.text(555, 816, 'Página ' + n + ' de ' + t, { size: 8, color: MUTED, align: 'r' });
    }
  });
  const M = 40, W = 515;
  let y = 0;
  const need = h => { if (y + h > 780) { doc.addPage(); y = 50; } };
  // cabeçalho
  doc.rect(0, 0, doc.W, 86, BLUE);
  doc.text(M, 40, 'Enif DOOH', { size: 22, bold: true, color: '#ffffff' });
  doc.text(M, 62, 'Relatório final da campanha', { size: 12, color: '#dbe6ff' });
  doc.text(555, 62, 'Gerado a ' + lisbonStamp(now), { size: 9, color: '#dbe6ff', align: 'r' });
  y = 120;
  doc.text(M, y, c.name, { size: 20, bold: true, color: INK }); y += 22;
  doc.text(M, y, (c.client ? c.client + ' · ' : '') + dShort(c.start) + ' a ' + dShort(c.end) + ' (' + (daysBetween(c.start, c.end) + 1) + ' dias)', { size: 11, color: MUTED }); y += 30;
  // números principais
  const kp = [['Passagens', nf.format(plays)], ['Visualizações estimadas', nf.format(views)], ['Ecrãs', String(Object.keys(byScr).length)], ['Tempo no ar', nf.format(Math.round(secs / 3600 * 10) / 10).replace(/,0$/, '') + ' h']];
  const kw = (W - 3 * 10) / 4;
  kp.forEach((k, i) => {
    const x = M + i * (kw + 10);
    doc.rect(x, y, kw, 62, SOFT, LINE);
    doc.text(x + 10, y + 20, k[0], { size: 8.5, color: MUTED });
    doc.text(x + 10, y + 46, k[1], { size: k[1].length > 9 ? 15 : 19, bold: true, color: INK });
  });
  y += 84;
  const table = (title, heads, aligns, widths, data) => {
    need(60); doc.text(M, y, title, { size: 13, bold: true }); y += 14;
    const head = () => {
      doc.rect(M, y, W, 20, SOFT);
      let x = M;
      heads.forEach((h, i) => { doc.text(aligns[i] === 'r' ? x + widths[i] - 8 : x + 8, y + 13.5, h, { size: 8.5, bold: true, color: MUTED, align: aligns[i] === 'r' ? 'r' : 'l' }); x += widths[i]; });
      y += 20;
    };
    head();
    if (!data.length) { doc.text(M + 8, y + 15, 'Sem passagens registadas.', { size: 9.5, color: MUTED }); y += 26; }
    data.forEach(r => {
      if (y + 20 > 780) { doc.addPage(); y = 50; head(); }
      let x = M;
      r.forEach((v, i) => {
        let s = String(v); while (s.length > 3 && widthOf(s, 9.5, false) > widths[i] - 14) s = s.slice(0, -2) + '…';
        doc.text(aligns[i] === 'r' ? x + widths[i] - 8 : x + 8, y + 14, s, { size: 9.5, align: aligns[i] === 'r' ? 'r' : 'l' }); x += widths[i];
      });
      doc.line(M, y + 20, M + W, y + 20, LINE, 0.4); y += 20;
    });
    y += 22;
  };
  const sRows = Object.keys(byScr).sort((a, b) => byScr[b].v - byScr[a].v).map(id => [(scr[id] ? scr[id].venue + ' · ' + (scr[id].spot || '') : id) + ' (' + id + ')', nf.format(byScr[id].n), nf.format(Math.round(byScr[id].v))]);
  table('Por ecrã', ['Local', 'Passagens', 'Visualizações'], ['l', 'r', 'r'], [335, 85, 95], sRows);
  const dRows = Object.keys(byDay).sort().map(d => [dShort(d), nf.format(byDay[d].n), nf.format(Math.round(byDay[d].v))]);
  table('Por dia', ['Dia', 'Passagens', 'Visualizações'], ['l', 'r', 'r'], [335, 85, 95], dRows);
  // conteúdos (imagem de cada um)
  const ids = Object.keys(byFile).sort((a, b) => byFile[b].n - byFile[a].n);
  if (ids.length) {
    need(60); doc.text(M, y, 'Conteúdos exibidos', { size: 13, bold: true }); y += 16;
    const cw = 245, ch = 138;
    for (let i = 0; i < ids.length; i += 2) {
      need(ch + 52);
      [ids[i], ids[i + 1]].forEach((id, k) => {
        if (!id) return; const x = M + k * (cw + 25), f = files[id] || {}, st = byFile[id];
        doc.rect(x, y, cw, ch, '#0b1020');
        if (f.jpg) { const d = doc.dims(f.jpg); if (d) { const r = Math.min(cw / d.w, ch / d.h), iw = d.w * r, ih = d.h * r; doc.image(f.jpg, x + (cw - iw) / 2, y + (ch - ih) / 2, iw, ih); } }
        else doc.text(x + cw / 2, y + ch / 2, 'Imagem não disponível', { size: 9, color: '#8f9bbd', align: 'c' });
        let nm = f.name || id; while (nm.length > 3 && widthOf(nm, 9.5, true) > cw) nm = nm.slice(0, -2) + '…';
        doc.text(x, y + ch + 15, nm, { size: 9.5, bold: true });
        doc.text(x, y + ch + 28, nf.format(st.n) + ' passagens · ' + nf.format(Math.round(st.v)) + ' visualizações estimadas', { size: 8.5, color: MUTED });
      });
      y += ch + 44;
    }
  }
  need(70);
  doc.rect(M, y, W, 1, LINE); y += 14;
  y += doc.para(M, y + 8, 'Passagens: número de vezes que o conteúdo foi exibido, registado pelo próprio ecrã (só conta o que realmente passou). Visualizações estimadas: calculadas a partir da audiência esperada de cada local e hora, repartida pelo tempo que cada conteúdo esteve no ar; é uma estimativa, não uma contagem de pessoas.', W, { size: 8.5, color: MUTED });
  return doc.build();
}
module.exports = { buildReport };
