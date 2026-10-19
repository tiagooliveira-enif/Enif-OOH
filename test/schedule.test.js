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
console.log('schedule: ok');
