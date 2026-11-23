'use strict';
/* Passagem de ano e mudança de hora: datas, campanhas que atravessam 31/12 → 1/1, dia e hora das passagens, anos bissextos.
   O servidor e o player calculam o dia e a hora das passagens com S.lisbonNow e a agenda com as mesmas funções de lib/schedule.js. */
const assert = require('node:assert/strict');
const S = require('../lib/schedule');
let n = 0; const ok = (name, c) => { assert.ok(c, name); n++; console.log('PASS ' + name); };

// aritmética de datas
ok('31/12/2026 + 1 dia = 01/01/2027', S.addDay('2026-12-31', 1) === '2027-01-01');
ok('01/01/2027 − 1 dia = 31/12/2026', S.addDay('2027-01-01', -1) === '2026-12-31');
ok('2028 é bissexto: 28/02 → 29/02 → 01/03', S.addDay('2028-02-28', 1) === '2028-02-29' && S.addDay('2028-02-29', 1) === '2028-03-01');
ok('2027 não é bissexto: 28/02 → 01/03', S.addDay('2027-02-28', 1) === '2027-03-01');
ok('uma semana por cima do fim de ano', S.addDay('2026-12-28', 7) === '2027-01-04');
ok('um ano inteiro soma 365 dias (2027)', S.addDay('2027-01-01', 365) === '2028-01-01');

// dia e hora de uma passagem (é o que fica nos relatórios)
const at = iso => S.lisbonNow('Europe/Lisbon', new Date(iso));
ok('23h59 de 31/12 conta no dia 31/12, hora 23', JSON.stringify(at('2026-12-31T23:59:30Z')) === JSON.stringify({ date: '2026-12-31', h: 23, m: 59 }));
ok('00h00 de 01/01 conta no dia 01/01, hora 0', at('2027-01-01T00:00:10Z').date === '2027-01-01' && at('2027-01-01T00:00:10Z').h === 0);
ok('verão: à 1h00 UTC de 28/03/2027 o relógio salta para as 2h (a hora 1 não existe)', at('2027-03-28T00:59:59Z').h === 0 && at('2027-03-28T01:00:00Z').h === 2);
ok('inverno: em 31/10/2027 a hora 1 repete-se, sem mudar de dia', at('2027-10-31T00:30:00Z').h === 1 && at('2027-10-31T01:30:00Z').h === 1 && at('2027-10-31T01:30:00Z').date === '2027-10-31');
ok('verão: 23h30 locais de 30/06 (22h30 UTC) ainda são dia 30/06', at('2027-06-30T22:30:00Z').date === '2027-06-30' && at('2027-06-30T23:30:00Z').date === '2027-07-01');

// campanha que atravessa o fim de ano
const scr = { id: 'S1', venue: 'V', on: 0, off: 24, limit: 14, order: [], res: '1920×1080' };
const ctx = { contents: [{ id: 'a1', res: '1920×1080', type: 'Vídeo', dur: '10 s', ready: true, screens: ['S1'] }] };
const C = { id: 'C', name: 'C', venues: ['V'], start: '2026-12-20', end: '2027-01-10', h0: 0, h1: 24, ppm: 1, priority: 'Normal', manual: 0, items: [{ f: 'a1' }], pauses: [] };
const loop = (d, h) => S.hourLoop(scr, S.playlistOf(scr, [C], ctx, d), d, h, ctx);
for (const [d, h] of [['2026-12-31', 22], ['2026-12-31', 23], ['2027-01-01', 0], ['2027-01-01', 1], ['2027-01-10', 23]])
  ok('a campanha passa em ' + d + ' às ' + h + 'h', loop(d, h) && loop(d, h).seq.length > 0);
ok('antes do início (19/12) não passa', !(loop('2026-12-19', 12) && loop('2026-12-19', 12).seq.length));
ok('depois do fim (11/01) não passa', !(loop('2027-01-11', 12) && loop('2027-01-11', 12).seq.length));
ok('estado: ativa a 31/12 e a 01/01, terminada a 11/01', S.statusOf(C, '2026-12-31') !== 'Terminada' && S.statusOf(C, '2027-01-01') !== 'Terminada' && S.statusOf(C, '2027-01-11') === 'Terminada');
// pausa que atravessa o fim de ano
const P = Object.assign({}, C, { pauses: [{ from: '2026-12-30', to: '2027-01-02' }] });
ok('pausa 30/12 a 02/01: pausada nos dois lados do fim de ano e ativa a 03/01', S.pausedOn(P, '2026-12-31') && S.pausedOn(P, '2027-01-01') && S.pausedOn(P, '2027-01-02') && !S.pausedOn(P, '2027-01-03'));
// vídeo com datas próprias que atravessa o ano
const V = Object.assign({}, C, { items: [{ f: 'a1', d0: '2026-12-31', d1: '2027-01-01' }] });
const ctx2 = ctx;
const loopV = (d, h) => S.hourLoop(scr, S.playlistOf(scr, [V], ctx2, d), d, h, ctx2);
ok('vídeo com dias próprios 31/12 a 01/01: passa nos dois dias e não a 30/12 nem a 02/01', [['2026-12-31', 1], ['2027-01-01', 1]].every(([d, h]) => loopV(d, h) && loopV(d, h).seq.length) && ![['2026-12-30', 1], ['2027-01-02', 1]].some(([d, h]) => loopV(d, h) && loopV(d, h).seq.length));
console.log('\n' + n + ' verificações OK');
