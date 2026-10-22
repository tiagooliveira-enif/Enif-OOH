'use strict';
const isNil = v => v === null || v === undefined;
/* Lógica do loop. É a MESMA do protótipo (funções loopFrom, spreadSeq, sectorFix, fitOf, spotOf…),
   com datas em texto 'AAAA-MM-DD' (comparam-se como texto) e horas numéricas.
   Os conteúdos entram por um «contexto» { contents: [documentos de conteúdos] }. */
const PRI = { Alta: 2, Normal: 1 };   // só duas prioridades: a Alta garante as passagens por minuto
const FIT_PX = 10;          // margem de proporção: acima disto o conteúdo não serve ao ecrã
const HOUSE_MAX = 2;        // no máximo 2 spots da Enif por ecrã
const SPOT_GAP = 300;       // ecrã cheio: o spot da Enif passa 1 vez a cada 5 minutos

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ---------- compatibilidade conteúdo-ecrã ---------- */
const dimsOf = res => { const m = /(\d+)\s*[×x]\s*(\d+)/.exec(res || ''); return m && +m[1] > 0 && +m[2] > 0 ? { w: +m[1], h: +m[2] } : null; };
function fitOf(f, s) {
  const a = f && f.type !== 'HTML5' ? dimsOf(f.res) : null, b = dimsOf(s.res);
  if (!a || !b) return { k: 'livre', ok: true };
  const de = a.w + '×' + a.h, para = b.w + '×' + b.h;
  if (a.w === b.w && a.h === b.h) return { k: 'igual', ok: true, de, para };
  const d = Math.min(Math.abs(a.h * b.w / a.w - b.h), Math.abs(a.w * b.h / a.h - b.w)), r = Math.round(d);
  if (d < 0.5) return { k: 'escala', ok: true, de, para };
  if (r <= FIT_PX) return { k: 'ajuste', ok: true, px: Math.max(1, r), de, para };
  return { k: 'incomp', ok: false, px: r, de, para };
}
/* o conteúdo passa neste ecrã: foi associado a ele e a proporção serve */
const okFor = (f, s) => !f || !s || ((!f.screens || f.screens.indexOf(s.id) > -1) && fitOf(f, s).ok);

const fileOf = (ctx, id) => (ctx.contents || []).find(f => f.id === id);
const houseFor = (s, ctx) => (ctx.contents || []).filter(f => f.house && f.ready !== false && okFor(f, s));
const houseCnt = (s, ctx, skip) => (ctx.contents || []).filter(f => f.house && f.id !== skip && f.ready !== false && okFor(f, s)).length;
const durOf = f => { const m = /(\d+)/.exec(f.dur || ''); return m ? +m[1] : 10; };
/* o spot da Enif de um ecrã: entra 1 vez em cada volta (com 2 spots compatíveis, alternam volta a volta) */
function spotOf(sc, ctx) {
  const hs = sc ? houseFor(sc, ctx) : [];
  if (!hs.length) return null;
  const dur = Math.max.apply(null, hs.map(durOf));
  return { id: '__spot', house: true, name: 'Spot da Enif', dur, ppm: 1, sector: '', files: hs.map(f => f.id) };
}

/* ---------- campanhas ---------- */
const pausedOn = (c, d) => (c.pauses || []).some(p => p.from <= d && (!p.to || p.to >= d));
const statusOf = (c, today) => c.end < today ? 'Terminada' : (pausedOn(c, today) ? 'Pausada' : (c.start > today ? 'Agendada' : 'Ativa'));
/* intervalos de horas da campanha: um só (h0–h1) ou até 3 (ivs); h0/h1 guardam sempre o início do primeiro e o fim do último */
const civs = c => (c.ivs && c.ivs.length) ? c.ivs : [[c.h0, c.h1]];
const inIvs = (v, h) => v.some(x => h >= x[0] && h < x[1]);
/* intervalos efetivos de um vídeo: os dele (ou o seu h0–h1) cortados pelos da campanha */
function itemIvs(c, i) {
  const own = (i.ivs && i.ivs.length) ? i.ivs : [[isNil(i.h0) ? 0 : i.h0, isNil(i.h1) ? 24 : i.h1]], out = [];
  civs(c).forEach(cv => { own.forEach(o => { const a = Math.max(cv[0], o[0]), b = Math.min(cv[1], o[1]); if (b > a) out.push([a, b]); }); });
  return out.sort((x, y) => x[0] - y[0]);
}
/* janela de um vídeo (do primeiro início ao último fim); serve para ordenar */
const itemWin = (c, i) => { const v = itemIvs(c, i); return v.length ? [v[0][0], v[v.length - 1][1]] : [c.h0, c.h0]; };
const itemDays = (c, i) => [(i.d0 && i.d0 > c.start) ? i.d0 : c.start, (i.d1 && i.d1 < c.end) ? i.d1 : c.end];
/* vídeos ativos numa hora e dia, por ordem de entrada (dia, hora) e depois pela ordem da lista */
function itemsOn(c, h, d, sc, ctx) {
  return c.items.map((i, k) => ({ i, k, v: itemIvs(c, i), w: itemWin(c, i), y: itemDays(c, i) }))
    .filter(x => inIvs(x.v, h) && (!d || (d >= x.y[0] && d <= x.y[1])) && (!sc || okFor(fileOf(ctx, x.i.f), sc)))
    .sort((p, q) => c.manual ? (p.k - q.k) : (cmp(p.y[0], q.y[0]) || (p.w[0] - q.w[0]) || (p.k - q.k)))
    .map(x => x.i);
}
const onAt = (c, d, h, sc, ctx) => c.start <= d && c.end >= d && !pausedOn(c, d) && inIvs(civs(c), h) && (!c.items.length || itemsOn(c, h, d, sc, ctx).length > 0);

/* vezes que a campanha entra numa volta: o maior «passagens por minuto» entre campanha e vídeos ativos */
function copiesOf(c, d, h, sc, ctx) {
  let k = Math.max(1, Math.ceil(c.ppm - 1e-9));
  if (c.items.length) itemsOn(c, h, d, sc, ctx).forEach(i => { if ((i.ppm || 1) > k) k = i.ppm; });
  return Math.min(12, k);
}
/* repete cada campanha as vezes pedidas, distribuídas por igual ao longo da volta, pela ordem da playlist */
function spreadSeq(loop, cp) {
  const m = loop.length, ev = [];
  loop.forEach((c, i) => { const k = cp[c.id] || 1; for (let j = 0; j < k; j++) ev.push({ c, pos: (i + j * m / k) % m, i, j }); });
  ev.sort((a, b) => (a.pos - b.pos) || (a.i - b.i) || (a.j - b.j));
  return ev.map(e => e.c);
}

/* ---------- tipo de negócio: campanhas do mesmo tipo não passam seguidas ---------- */
const secKey = c => String(c.sector || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const secBad = (x, y) => x !== y && secKey(x) !== '' && secKey(x) === secKey(y);
function secCost(a) {
  const n = a.length; let k = 0;
  for (let i = 0; i < n; i++) { const x = a[i], y = a[(i + 1) % n]; if (secBad(x, y)) k += 100; else if (x === y && n > 1) k += 1; }
  return k;
}
function sectorFix(seq) {
  const n = seq.length;
  if (n < 3 || !seq.some(c => secKey(c))) return seq;
  const a = seq.slice(); let cost = secCost(a);
  if (cost < 100) return a;
  for (let pass = 0; pass < n * 2 && cost >= 100; pass++) {
    let moved = false;
    for (let i = 0; i < n && cost >= 100; i++) {
      const j0 = (i + 1) % n;
      if (!secBad(a[i], a[j0])) continue;
      let done = false;
      for (let d = 1; d < n && !done; d++) {
        for (const j of [(j0 + d) % n, (j0 - d + n) % n]) {
          if (j === j0 || j === i) continue;
          const t = a[j0]; a[j0] = a[j]; a[j] = t;
          const c2 = secCost(a);
          if (c2 < cost) { cost = c2; moved = done = true; break; }
          a[j] = a[j0]; a[j0] = t;
        }
      }
    }
    if (!moved) break;
  }
  return a;
}

/* ---------- ecrã ---------- */
const sOn = s => isNil(s.on) ? 0 : s.on, sOff = s => isNil(s.off) ? 24 : s.off;
const screenOn = (s, h) => h + 1 > sOn(s) && h < sOff(s);

/* ordem das campanhas num ecrã: a ordem guardada primeiro, as restantes por prioridade e data de início */
function playlistOf(s, camps, ctx, today) {
  const valid = camps.filter(c => statusOf(c, today) !== 'Terminada' && c.venues.indexOf(s.venue) > -1 && (!c.items.length || c.items.some(i => okFor(fileOf(ctx, i.f), s))));
  const ids = valid.map(c => c.id), ord = (s.order || []).filter(id => ids.indexOf(id) > -1);
  valid.slice().sort((a, b) => ((PRI[b.priority] || 1) - (PRI[a.priority] || 1)) || cmp(a.start, b.start))
    .forEach(c => { if (ord.indexOf(c.id) < 0) ord.push(c.id); });
  return ord.map(id => valid.find(c => c.id === id));
}

/* posições do loop: cada campanha ocupa uma; as que partilham a posição (c.share) ocupam uma só, à vez, uma por volta */
function slotsOf(all, limit) {
  const loop = [], out = [], slots = [], gs = {}; let demand = 0;
  all.forEach(c => {
    const g = c.share || null;
    if (g && gs[g]) { gs[g].push(c); loop.push(c); return; }
    demand++;
    if (slots.length < limit) { const sl = [c]; slots.push(sl); if (g) gs[g] = sl; loop.push(c); }
    else { out.push(c); if (g) gs[g] = []; }
  });
  return { loop, out, slots, demand };
}
const gcd = (a, b) => b ? gcd(b, a % b) : a;
const SPOT_CUT = L => L.spot5 ? SPOT_GAP / (SPOT_GAP + L.spot5.dur) : 1;
const rateOf = (c, L) => L.cycle ? ((L.occ[c.id] || 1) * 60 / L.cycle) * SPOT_CUT(L) : 0;
const needOf = (c, L) => Math.max(c.ppm, L.copies[c.id] > Math.ceil(c.ppm - 1e-9) ? L.copies[c.id] : 0);

/* o loop de uma hora: campanhas em horário, pela ordem da playlist, até ao limite do ecrã.
   Uma «ronda» tem as voltas precisas para as campanhas de cada posição partilhada passarem à vez.
   Prioridade Alta: cumpre as passagens por minuto pedidas, repetindo a campanha na volta o que for preciso (máx. 12). */
function loopFrom(list, limit, d, h, sc, ctx) {
  const all = list.filter(c => onAt(c, d, h, sc, ctx)), S = slotsOf(all, limit), loop = S.loop, out = S.out, slots = S.slots;
  const cp0 = {}; loop.forEach(c => { cp0[c.id] = copiesOf(c, d, h, sc, ctx); });
  const per = Math.min(60, slots.reduce((a, sl) => a / gcd(a, sl.length) * sl.length, 1)), cheio = slots.length >= limit;
  const build = cp => {
    let seq = [], sp = null, sp5 = null; const occ = {};
    for (let v = 0; v < per; v++) {
      const reps = slots.map(sl => sl[v % sl.length]), sq = sectorFix(spreadSeq(reps, cp)), sp0 = sq.length ? spotOf(sc, ctx) : null;
      if (sp0 && !cheio) sp = sp0;
      if (sp0 && cheio) sp5 = sp0;
      seq = seq.concat(sp0 && !cheio ? sq.concat([sp0]) : sq);
    }
    seq.forEach(c => { if (!c.house) occ[c.id] = (occ[c.id] || 0) + 1; });
    return { seq, spot: sp, spot5: sp5, occ, cycle: seq.reduce((a, c) => a + (c.dur || 10), 0) };
  };
  const cp = Object.assign({}, cp0), alta = loop.filter(c => c.priority === 'Alta');
  let R = build(cp);
  for (let n = 0; alta.length && n < 12 * alta.length; n++) {
    let worst = null, wr = 1;
    alta.forEach(c => { const r = rateOf(c, R) / needOf(c, { copies: cp0 }); if (r < 1 - 1e-9 && r < wr && cp[c.id] < 12) { wr = r; worst = c; } });
    if (!worst) break;
    cp[worst.id]++; R = build(cp);
  }
  return { all, loop, out, seq: R.seq, spot: R.spot, spot5: R.spot5, copies: cp0, occ: R.occ, per, demand: S.demand, cycle: R.cycle };
}
const secPairs = L => {
  const q = L.seq, n = q.length, out = [];
  if (n < 2) return out;
  for (let i = 0; i < n; i++) { const x = q[i], y = q[(i + 1) % n]; if (secBad(x, y) && !out.some(p => (p[0] === x && p[1] === y) || (p[0] === y && p[1] === x))) out.push([x, y]); }
  return out;
};

/* O que o player toca numa hora: sequência exata da volta.
   Cada entrada: { c, n, dur, items:[ids de ficheiro, por ordem de alternância] }; o spot tem spot:true e files.
   spot5 = spot que interrompe o loop a cada SPOT_GAP segundos (ecrã cheio). null = ecrã desligado nessa hora. */
function hourLoop(s, list, d, h, ctx) {
  if (!screenOn(s, h)) return null;
  const L = loopFrom(list, s.limit || 14, d, h, s, ctx);
  const ent = c => c.house
    ? { c: '__spot', n: c.name, dur: c.dur, spot: true, files: c.files }
    : { c: c.id, n: c.name, dur: c.dur || 10, items: itemsOn(c, h, d, s, ctx).map(i => i.f) };
  const seq = L.seq.map(ent).filter(e => e.spot || e.items.length);
  return { seq, spot5: L.spot5 ? ent(L.spot5) : null };
}
function dayLoops(s, camps, d, ctx, today) {
  const list = playlistOf(s, camps, ctx, today || d), out = {};
  for (let h = 0; h < 24; h++) out[h] = hourLoop(s, list, d, h, ctx);
  return out;
}

const addDay = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
function lisbonNow(tz, at) {
  const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/Lisbon', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(at || new Date()).forEach(x => { p[x.type] = x.value; });
  return { date: p.year + '-' + p.month + '-' + p.day, h: +p.hour, m: +p.minute };
}
module.exports = { PRI, FIT_PX, HOUSE_MAX, SPOT_GAP, dimsOf, fitOf, okFor, fileOf, houseFor, houseCnt, spotOf, pausedOn, statusOf, civs, itemIvs, itemWin, itemDays, itemsOn, onAt, copiesOf, spreadSeq, secKey, sectorFix, secPairs, screenOn, playlistOf, slotsOf, rateOf, needOf, loopFrom, hourLoop, dayLoops, addDay, lisbonNow };
