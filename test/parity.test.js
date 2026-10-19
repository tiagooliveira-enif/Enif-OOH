'use strict';
/* Teste de paridade: o loop do servidor (lib/schedule.js) tem de dar EXATAMENTE a mesma sequência que o protótipo.
   test/fixtures/proto-loops.json é gerado a partir do protótipo (dados + sequências por ecrã, dia e hora). */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert');
const S = require('../lib/schedule');
const file = path.join(__dirname, 'fixtures', 'proto-loops.json');
if (!fs.existsSync(file)) { console.log('parity: sem ficheiro de referência, ignorado'); process.exit(0); }
const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
let n = 0, bad = 0;
for (const sc of fx.scenarios || [fx]) {
  const ctx = { contents: sc.data.contents };
  const lists = {};
  sc.data.screens.forEach(s => { lists[s.id] = S.playlistOf(s, sc.data.campaigns, ctx, sc.today); });
  for (const key of Object.keys(sc.loops)) {
    const [id, d, h] = key.split('|'), s = sc.data.screens.find(x => x.id === id), want = sc.loops[key];
    const got = S.screenOn(s, +h) ? S.loopFrom(lists[id], s.limit, d, +h, s, ctx) : { seq: [], spot: null, spot5: null, cycle: 0, all: [] };
    const g = { seq: got.seq.map(c => c.id), spot: got.spot ? 1 : 0, spot5: got.spot5 ? 1 : 0, cycle: got.cycle, all: got.all.length };
    const w = S.screenOn(s, +h) ? want : { seq: [], spot: 0, spot5: 0, cycle: 0, all: 0 };
    n++;
    try { assert.deepStrictEqual(g, w); } catch (e) { bad++; if (bad <= 5) console.log('DIFERENTE', key, 'servidor', JSON.stringify(g), 'protótipo', JSON.stringify(w)); }
  }
}
console.log('parity: ' + n + ' verificações, ' + bad + ' diferenças');
if (bad) process.exit(1);
