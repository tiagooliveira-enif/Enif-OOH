'use strict';
const assert = require('node:assert/strict');
const S = require('../lib/schedule');
const mk = (id, o) => Object.assign({ id, name: id, venues: ['V'], start: '2026-10-01', end: '2026-10-31', h0: 0, h1: 24, ppm: 1, priority: 'Normal', manual: 0, items: [] }, o);
const scr = { venue: 'V', on_h: 0, off_h: 24, lim: 14, ord: '[]' };
const D = '2026-10-14';
// dois vídeos alternam por passagem; campanha 2x/min aparece duas vezes na volta
const A = mk('A', { ppm: 2, items: [{ f: 'a1' }, { f: 'a2' }, { f: 'a3' }] });
const B = mk('B', { items: [{ f: 'b1' }, { f: 'b2' }] });
const C = mk('C', { items: [{ f: 'c1' }] });
let l = S.loopAt(scr, S.orderFor(scr, [A, B, C]), D, 10);
assert.equal(l.filter(e => e.c === 'A').length, 2, 'A passa 2x por volta');
assert.equal(l.filter(e => e.c === 'B').length, 1);
assert.equal(l.length, 4);
// os 2 A não ficam seguidos quando há outras campanhas entre eles
const names = l.map(e => e.c).join('');
assert.ok(!/AA/.test(names + names[0]), 'passagens de A separadas: ' + names);
// fora de horas / datas / ecrã desligado
assert.deepEqual(S.loopAt(scr, [mk('X', { h0: 9, h1: 12, items: [{ f: 'x' }] })], D, 13), []);
assert.deepEqual(S.loopAt(scr, [mk('X', { start: '2026-11-01', end: '2026-11-05', items: [{ f: 'x' }] })], D, 10), []);
assert.equal(S.loopAt({ venue: 'V', on_h: 8, off_h: 20 }, [A], D, 22), null);
// vídeo com dias próprios entra e sai
const E = mk('E', { items: [{ f: 'e1', d1: '2026-10-14' }, { f: 'e2', d0: '2026-10-15' }] });
assert.deepEqual(S.loopAt(scr, [E], '2026-10-14', 10)[0].items, ['e1']);
assert.deepEqual(S.loopAt(scr, [E], '2026-10-15', 10)[0].items, ['e2']);
// vezes por minuto no vídeo (exclusivo)
const F = mk('F', { items: [{ f: 'f1', ppm: 3 }] });
assert.equal(S.loopAt(scr, [F], D, 10).length, 3);
// campanha sem vídeos não passa
assert.deepEqual(S.loopAt(scr, [mk('G')], D, 10), []);
// limite do ecrã
assert.equal(S.loopAt({ venue: 'V', lim: 1 }, S.orderFor(scr, [B, C]), D, 10).length, 1);
// prioridade
assert.equal(S.orderFor(scr, [mk('P', { priority: 'Baixa' }), mk('Q', { priority: 'Alta' })])[0].id, 'Q');
assert.equal(S.addDay('2026-10-31', 1), '2026-11-01');
console.log('schedule: ok');
