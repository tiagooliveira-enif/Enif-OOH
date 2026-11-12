'use strict';
const assert = require('node:assert/strict');
const S = require('../lib/schedule');
const mk = (id, o) => Object.assign({ id, name: id, venues: ['V'], start: '2026-10-01', end: '2026-10-31', h0: 0, h1: 24, ppm: 1, priority: 'Normal', manual: 0, items: [], pauses: [], sector: '' }, o);
const scr = { id: 'S1', venue: 'V', on: 0, off: 24, limit: 14, order: [], res: '1920×1080' };
const D = '2026-10-14';
const file = (id, o) => Object.assign({ id, res: '1920×1080', type: 'Vídeo', dur: '10 s', ready: true, screens: ['S1'] }, o);
const ctx = { contents: ['a1', 'a2', 'a3', 'b1', 'b2', 'c1', 'e1', 'e2', 'f1', 'x'].map(i => file(i)) };
const loop = (cs, d, h, sc, cx) => S.hourLoop(sc || scr, S.playlistOf(sc || scr, cs, cx || ctx, d), d, h, cx || ctx);

// campanha 2x/min aparece duas vezes na volta; vídeos alternam
const A = mk('A', { ppm: 2, items: [{ f: 'a1' }, { f: 'a2' }, { f: 'a3' }] });
const B = mk('B', { items: [{ f: 'b1' }, { f: 'b2' }] });
const C = mk('C', { items: [{ f: 'c1' }] });
let l = loop([A, B, C], D, 10);
assert.equal(l.seq.filter(e => e.c === 'A').length, 2, 'A passa 2x por volta');
assert.equal(l.seq.filter(e => e.c === 'B').length, 1);
assert.equal(l.seq.length, 4);
const names = l.seq.map(e => e.c).join('');
assert.ok(!/AA/.test(names + names[0]), 'passagens de A separadas: ' + names);
// fora de horas / datas / ecrã desligado
assert.equal(loop([mk('X', { h0: 9, h1: 12, items: [{ f: 'x' }] })], D, 13).seq.length, 0);
assert.equal(loop([mk('X', { start: '2026-11-01', end: '2026-11-05', items: [{ f: 'x' }] })], D, 10).seq.length, 0);
assert.equal(loop([A], D, 22, { id: 'S1', venue: 'V', on: 8, off: 20 }), null);
// vídeo com dias próprios entra e sai
const E = mk('E', { items: [{ f: 'e1', d1: '2026-10-14' }, { f: 'e2', d0: '2026-10-15' }] });
assert.deepEqual(loop([E], '2026-10-14', 10).seq[0].items, ['e1']);
assert.deepEqual(loop([E], '2026-10-15', 10).seq[0].items, ['e2']);
// vezes por minuto no vídeo
assert.equal(loop([mk('F', { items: [{ f: 'f1', ppm: 3 }] })], D, 10).seq.length, 3);
// campanha sem vídeos não passa
assert.equal(loop([mk('G')], D, 10).seq.length, 0);
// pausa
assert.equal(S.statusOf(mk('P', { pauses: [{ from: D }] }), D), 'Pausada');
assert.equal(loop([mk('P', { pauses: [{ from: D }], items: [{ f: 'x' }] })], D, 10).seq.length, 0);
// conteúdo não associado ao ecrã não passa
assert.equal(loop([mk('N', { items: [{ f: 'x' }] })], D, 10, scr, { contents: [file('x', { screens: ['OUTRO'] })] }).seq.length, 0);
// proporção incompatível não passa; ajuste ≤10px passa
assert.equal(S.fitOf({ res: '1080×1920' }, scr).ok, false);
assert.equal(S.fitOf({ res: '1920×1075' }, scr).k, 'ajuste');
// spot: ecrã com folga leva o spot no fim da volta; ecrã cheio leva spot5
const hs = { contents: ctx.contents.concat([file('sp', { house: true })]) };
l = loop([B], D, 10, scr, hs);
assert.equal(l.seq[l.seq.length - 1].spot, true); assert.equal(l.spot5, null);
l = loop([B, C], D, 10, Object.assign({}, scr, { limit: 2 }), hs);
assert.equal(l.seq.some(e => e.spot), false); assert.ok(l.spot5 && l.spot5.files[0] === 'sp');
// tipo de negócio: campanhas do mesmo tipo não ficam seguidas
const cs = ['A', 'B', 'C', 'D'].map((n, i) => mk(n, { sector: i < 2 ? 'Cafés' : 'Banca', items: [{ f: 'x' }] }));
l = loop(cs, D, 10);
const ids = l.seq.map(e => e.c);
for (let i = 0; i < 4; i++) assert.notEqual(cs.find(c => c.id === ids[i]).sector, cs.find(c => c.id === ids[(i + 1) % 4]).sector);
// vários intervalos de horas no mesmo dia (campanha e vídeo)
const M = mk('M', { h0: 7, h1: 22, ivs: [[7, 10], [19, 22]], items: [{ f: 'a1' }, { f: 'a2', h0: 8, h1: 21, ivs: [[8, 10], [20, 21]] }, { f: 'a3', h0: 19, h1: 21 }] });
const seqAt = h => { const r = loop([M], D, h); return r ? r.seq.map(e => e.items.join('+')).join(',') : ''; };
assert.equal(seqAt(6), '', 'antes do 1.º intervalo');
assert.equal(seqAt(7), 'a1', 'só a1 às 7h');
assert.equal(seqAt(8), 'a1+a2', 'a1 e a2 às 8h');
assert.equal(seqAt(12), '', 'fora dos dois intervalos');
assert.equal(seqAt(19), 'a1+a3', 'a1 e a3 às 19h');
assert.equal(seqAt(20), 'a1+a2+a3', 'os três às 20h');
assert.equal(seqAt(21), 'a1', 'às 21h só a1: a2 e a3 já saíram');
assert.equal(seqAt(22), '', 'depois do 2.º intervalo');
assert.deepEqual(S.civs(M), [[7, 10], [19, 22]]);
assert.deepEqual(S.civs(mk('S', { h0: 9, h1: 12 })), [[9, 12]], 'campanha de um só intervalo continua igual');
assert.equal(S.onAt(M, D, 12, scr, ctx), false);
assert.equal(S.onAt(M, D, 20, scr, ctx), true);
console.log('schedule: ok');

/* ---------- prioridade Alta e posição partilhada ---------- */
{
  const S2 = require('../lib/schedule'), assert2 = require('node:assert');
  const spot = { id: 'S', name: 'Spot', type: 'Vídeo', res: '1920×1080', dur: '20 s', house: true, screens: ['E1'], ready: true };
  const mkF = (id) => ({ id, name: id, type: 'Vídeo', res: '1920×1080', dur: '10 s', house: false, screens: ['E1'], ready: true });
  const ctx = { contents: [spot, mkF('f1'), mkF('f2'), mkF('f3'), mkF('f4'), mkF('f5')] };
  const sc = { id: 'E1', venue: 'V', res: '1920×1080', limit: 14, order: [], on: 0, off: 24, fit: null };
  const mk = (id, ppm, pri, share) => ({ id, name: id, client: 'c', sector: '', venues: ['V'], start: '2026-10-01', end: '2026-10-31', h0: 0, h1: 24, ppm, dur: 10, priority: pri, share: share || undefined, manual: false, pauses: [], items: [{ f: 'f' + id.slice(1), h0: null, h1: null, d0: null, d1: null, ppm: 1 }] });
  // 5 campanhas Normal: o loop dura 50 s + spot; a campanha 1 pede 2×/min
  const camps = [mk('c1', 2, 'Normal'), mk('c2', 0.2, 'Normal'), mk('c3', 0.2, 'Normal'), mk('c4', 0.2, 'Normal'), mk('c5', 0.2, 'Normal')];
  const rate = (list) => { const L = S2.loopFrom(list, 14, '2026-10-20', 12, sc, ctx); return { L, r: S2.rateOf(list[0], L) }; };
  const normal = rate(camps);
  assert2.ok(normal.r < 2 - 1e-9, 'Normal sem garantia fica abaixo do pedido');
  const altaList = camps.map((c, i) => i === 0 ? Object.assign({}, c, { priority: 'Alta' }) : c);
  const alta = rate(altaList);
  assert2.ok(alta.r >= 2 - 1e-9, 'Alta cumpre as passagens por minuto pedidas (' + alta.r + ')');
  assert2.ok(alta.L.cycle > normal.L.cycle, 'o loop cresce para a Alta repetir');
  // posição partilhada: duas campanhas à vez, uma por volta, ocupam um só lugar
  const sh = [mk('c1', 1, 'Normal', 'G1'), mk('c2', 1, 'Normal', 'G1'), mk('c3', 1, 'Normal')];
  const L2 = S2.loopFrom(sh, 2, '2026-10-20', 12, sc, ctx);
  assert2.strictEqual(L2.loop.length, 3, 'as três entram: o grupo conta como um lugar');
  assert2.strictEqual(L2.per, 2, 'duas voltas por ronda');
  assert2.deepStrictEqual(L2.seq.filter(c => !c.house).map(c => c.id), ['c1', 'c3', 'c2', 'c3']);
  console.log('prioridade Alta e posição partilhada: ok');
}

{
  const sc = { on: 7.5, off: 23.5 };
  assert.equal(S.onOverlap(sc, 9, 10), 1, 'hora inteira dentro do horário');
  assert.equal(S.onOverlap(sc, 7, 8), 0.5, 'liga às 07:30');
  assert.equal(S.onOverlap(sc, 23, 24), 0.5, 'desliga às 23:30');
  assert.equal(S.onOverlap(sc, 23.5, 24), 0, 'depois de desligar: nada');
  assert.equal(S.onOverlap({ on: 0, off: 24 }, 3, 3.25), 0.25, 'ecrã sempre ligado');
  console.log('horário de ligar/desligar ao minuto: ok');
}

{
  // vídeo com «Vezes/min» maior: repete-se na ronda, espaçado por igual (A, B, C, A, D, E, F)
  const sc = { id: 'E1', venue: 'V', res: '1920×1080', limit: 14, order: [], on: 0, off: 24, fit: null };
  const mkC = w => ({ id: 'C', name: 'C', client: 'c', venues: ['V'], start: '2020-01-01', end: '2099-01-01', h0: 0, h1: 24, ppm: 1, dur: 10, items: ['A', 'B', 'C', 'D', 'E', 'F'].map((f, i) => ({ f, ppm: i === 0 ? w : 1 })), pauses: [] });
  const ctx = { contents: [] }, ids = c => S.itemList(c, 10, '2026-11-04', sc, ctx).map(i => i.f).join('');
  assert.equal(ids(mkC(1)), 'ABCDEF', 'sem pesos: ordem normal, tudo igual a antes');
  assert.equal(ids(mkC(2)), 'ABCADEF', 'A 2×: A, B, C, A, D, E, F');
  assert.equal(ids(mkC(3)), 'ABACDAEF', 'A 3×: repetições espaçadas por igual');
  assert.equal(S.copiesOf(mkC(2), '2026-11-04', 10, sc, ctx), 7, 'a campanha entra 7 vezes por volta para a ronda caber numa volta');
  assert.equal(S.copiesOf(mkC(1), '2026-11-04', 10, sc, ctx), 1, 'sem pesos entra 1 vez');
  const e = S.hourLoop(sc, [mkC(2)], '2026-11-04', 10, ctx).seq.filter(x => !x.spot)[0];
  assert.equal(e.items.join(''), 'ABCADEF', 'o player recebe a ronda com A repetido');
  console.log('vídeo com mais passagens por minuto: ok');
}

// mínimo do grupo: a posição partilhada passa pelo menos N vezes por minuto, à vez, e só conta as campanhas ativas
{
  const sc = { id: 'S1', venue: 'V', on: 0, off: 24, limit: 14, order: [], res: '1920×1080' };
  const cx = { contents: ['a', 'b', 'c', 'd', 'o'].map(i => file(i)) };
  const outras = Array.from({ length: 8 }, (_, i) => mk('X' + i, { items: [{ f: 'o' }] }));
  const grupo = (gmin, extra) => ['a', 'b', 'c', 'd'].map((i, k) => mk(i.toUpperCase(), Object.assign({ share: 'G', gmin: gmin || undefined, items: [{ f: i }] }, extra && extra(k))));
  const L = (cs) => S.loopFrom(S.playlistOf(sc, cs, cx, D), 14, D, 10, sc, cx);
  const sem = L(grupo(0).concat(outras)), com = L(grupo(2).concat(outras));
  assert.ok(S.gRateOf({ m: grupo(0) }, sem) < 1, 'sem mínimo o grupo passa menos de 1 vez por minuto');
  assert.ok(com.gm.length === 1 && Math.abs(S.gRateOf(com.gm[0], com) - 2) < 1e-6, 'com mínimo 2 o grupo passa 2 vezes por minuto');
  const so = L(grupo(1, k => k ? { start: '2026-11-20' } : {}).concat(outras));
  assert.ok(S.gRateOf(so.gm[0], so) >= 1 - 1e-9 && so.loop.filter(c => c.share).length === 1, 'só a campanha ativa conta e cumpre o mínimo');
  const alta = L(grupo(2, k => k === 0 ? { priority: 'Alta' } : {}).concat(outras));
  assert.equal(alta.gm.length, 0, 'com uma campanha Alta no grupo o mínimo do grupo não se aplica');
  // as passagens do grupo alternam sempre entre as campanhas (A, B, C, D, A, B…), mesmo quando o grupo repete na volta
  const gr = L(grupo(2).concat(outras)), memb = gr.seq.filter(c => c.share).map(c => c.id).join('');
  assert.ok(/^(ABCD)+$/.test(memb), 'o grupo alterna pela ordem: ' + memb);
  const dois = L(grupo(1, k => k > 1 ? { start: '2026-11-20' } : {}).concat(outras)), m2 = dois.seq.filter(c => c.share).map(c => c.id).join('');
  assert.ok(m2.length >= 4 && /^(AB)+$/.test(m2), 'com duas ativas alternam A, B, A, B: ' + m2);
  // as passagens do grupo ficam espalhadas por igual pela volta (diferença de distância até 1 entrada)
  [5, 7, 8, 12].forEach(n => [1, 2].forEach(gm => {
    const x = Array.from({ length: n }, (_, i) => mk('X' + i, { items: [{ f: 'o' }] }));
    const q = L(grupo(gm, k => k > 1 ? { start: '2026-11-20' } : {}).concat(x)).seq, at = q.map((c, i) => c.share ? i : -1).filter(i => i >= 0);
    if (at.length < 2) return;
    const gaps = at.map((v, i) => ((at[(i + 1) % at.length] - v + q.length) % q.length) || q.length);
    assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, 'grupo espalhado por igual (' + n + ' campanhas, mínimo ' + gm + '): ' + gaps);
  }));
  console.log('mínimo do grupo: ok');
}

/* margem oculta: a resolução útil (ecrã menos margem) é a que conta para a compatibilidade */
{
  const sc = { id: 'E', res: '763×492', crop: { t: 30, b: 0, l: 0, r: 0 } };
  assert.deepStrictEqual(S.usefulDims(sc), { w: 763, h: 462 });
  assert.strictEqual(S.fitOf({ type: 'Vídeo', res: '1526×984' }, sc).ok, true, 'a margem não conta: o conteúdo com a proporção do ecrã serve');
  assert.strictEqual(S.fitOf({ type: 'Vídeo', res: '763×492' }, sc).k, 'igual', 'conteúdo do tamanho do painel continua a servir');
  assert.strictEqual(S.fitOf({ type: 'Vídeo', res: '763×492' }, { id: 'E', res: '763×492' }).k, 'igual', 'sem margem tudo como antes');
  console.log('margem oculta: ok');
}
