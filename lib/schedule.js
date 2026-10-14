'use strict';
/* Lógica de loop, portada do protótipo. Datas 'AAAA-MM-DD' (comparam-se como texto), horas numéricas. */
const PRI = { Alta: 3, Normal: 2, Baixa: 1 };

const itemWin = (c, i) => [Math.max(c.h0, i.h0 == null ? c.h0 : i.h0), Math.min(c.h1, i.h1 == null ? c.h1 : i.h1)];
const itemDays = (c, i) => [(i.d0 && i.d0 > c.start) ? i.d0 : c.start, (i.d1 && i.d1 < c.end) ? i.d1 : c.end];

/* vídeos ativos numa hora e dia: por ordem de entrada (dia, hora) e depois pela ordem da lista; manual = só a lista */
function itemsOn(c, h, d) {
  return c.items.map((i, k) => ({ i, k, w: itemWin(c, i), y: itemDays(c, i) }))
    .filter(x => h >= x.w[0] && h < x.w[1] && d >= x.y[0] && d <= x.y[1])
    .sort((p, q) => c.manual ? (p.k - q.k)
      : ((p.y[0] < q.y[0] ? -1 : p.y[0] > q.y[0] ? 1 : 0) || (p.w[0] - q.w[0]) || (p.k - q.k)))
    .map(x => x.i);
}
/* uma campanha só passa se estiver em datas e horas e tiver pelo menos um vídeo ativo */
const onAt = (c, d, h) => c.start <= d && c.end >= d && h >= c.h0 && h < c.h1 && itemsOn(c, h, d).length > 0;

/* vezes que a campanha entra numa volta: o maior «passagens por minuto» entre campanha e vídeos ativos */
function copiesOf(c, d, h) {
  let k = Math.max(1, Math.ceil(c.ppm - 1e-9));
  itemsOn(c, h, d).forEach(i => { if ((i.ppm || 1) > k) k = i.ppm; });
  return Math.min(12, k);
}
/* repete cada campanha as vezes pedidas, distribuídas por igual ao longo da volta */
function spreadSeq(loop, cp) {
  const m = loop.length, ev = [];
  loop.forEach((c, i) => { const k = cp[c.id] || 1; for (let j = 0; j < k; j++) ev.push({ c, pos: (i + j * m / k) % m, i, j }); });
  ev.sort((a, b) => (a.pos - b.pos) || (a.i - b.i) || (a.j - b.j));
  return ev.map(e => e.c);
}
/* ordem das campanhas num ecrã: a ordem guardada primeiro, as restantes por prioridade e data de início */
function orderFor(screen, camps) {
  const valid = camps.filter(c => c.venues.indexOf(screen.venue) > -1);
  const ids = valid.map(c => c.id);
  let saved = [];
  try { saved = JSON.parse(screen.ord || '[]'); } catch (e) { }
  const ord = saved.filter(id => ids.indexOf(id) > -1);
  valid.slice().sort((a, b) => (PRI[b.priority] - PRI[a.priority]) || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
    .forEach(c => { if (ord.indexOf(c.id) < 0) ord.push(c.id); });
  return ord.map(id => valid.find(c => c.id === id));
}
const screenOn = (s, h) => h + 1 > (s.on_h == null ? 0 : s.on_h) && h < (s.off_h == null ? 24 : s.off_h);

/* o loop de uma hora: [{c, n, items:[idFicheiro…]}…] ; null = ecrã desligado nessa hora */
function loopAt(screen, list, d, h) {
  if (!screenOn(screen, h)) return null;
  const all = list.filter(c => onAt(c, d, h)), loop = all.slice(0, screen.lim || 14);
  const cp = {}; loop.forEach(c => { cp[c.id] = copiesOf(c, d, h); });
  return spreadSeq(loop, cp).map(c => ({ c: c.id, n: c.name, dur: c.dur || 10, items: itemsOn(c, h, d).map(i => i.f) }));
}
function dayLoops(screen, camps, d) {
  const list = orderFor(screen, camps), out = {};
  for (let h = 0; h < 24; h++) out[h] = loopAt(screen, list, d, h);
  return out;
}
const addDay = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
function lisbonNow(tz, at) {
  const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/Lisbon', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(at || new Date()).forEach(x => { p[x.type] = x.value; });
  return { date: p.year + '-' + p.month + '-' + p.day, h: +p.hour, m: +p.minute };
}
module.exports = { PRI, itemWin, itemDays, itemsOn, onAt, copiesOf, spreadSeq, orderFor, screenOn, loopAt, dayLoops, addDay, lisbonNow };
