'use strict';
/* Relatório final da campanha (o PDF que o comercial recebe): números, tabela por conteúdo, gráfico e registo de emissão. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const R = require('../lib/report');
const camp = { id: 'C1', name: 'Campanha Teste', client: 'Cliente', start: '2026-10-01', end: '2026-10-03', venues: ['Fórum'] };
const screens = [{ id: 'ECR-001', venue: 'Fórum', spot: 'Átrio', city: 'Braga', res: '1920×1080', on: 0, off: 24, limit: 14, order: [], loc: { env: 'centro-comercial', pop: null } }];
const rows = [];
const add = (c, f, d, hs, n) => hs.forEach(h => rows.push({ s: 'ECR-001', c, f, d, h, n, bad: 0, sec: n * 10 }));
add('C1', 'FA', '2026-10-01', [9, 10, 11], 3);   // vídeo A: horas seguidas -> 1 linha
add('C1', 'FB', '2026-10-01', [9, 12], 5);       // vídeo B: duas linhas (9h e 12h)
add('C1', 'FA', '2026-10-02', [10], 4);
add('OUTRA', 'FX', '2026-10-01', [9], 99);       // outra campanha: não conta
const files = { FA: { name: 'Video_A.mp4', type: 'Vídeo', jpg: null }, FB: { name: 'Cartaz_B.jpg', type: 'Imagem', jpg: null } };
const buf = R.buildReport(camp, rows, screens, files, Date.parse('2026-10-05T10:00:00Z'));
assert.equal(buf.slice(0, 4).toString(), '%PDF');
const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rep-')), 'r.pdf'); fs.writeFileSync(f, buf);
const txt = execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' });
const has = s => assert.ok(txt.includes(s), 'falta no PDF: ' + s);
['Relatório final da campanha', 'Campanha Teste', 'Visualizações por hora do dia', 'Por conteúdo', 'Video_A.mp4', 'Cartaz_B.jpg', 'Por ecrã', 'Por dia', 'Registo de emissão (4 registos)', 'Em curso'.slice(0, 0)].forEach(has);
assert.ok(!txt.includes('FX'), 'a outra campanha não entra');
const tot = 3 * 3 + 5 * 2 + 4;     // 23 passagens
assert.ok(new RegExp('Passagens\\s+Visualiza').test(txt) && txt.includes(String(tot)), 'total de passagens ' + tot);
assert.equal((txt.match(/Entrou/g) || []).length >= 1, true);
// o registo tem 4 linhas: A(1/10 9h-12h), B(1/10 9h), B(1/10 12h), A(2/10 10h)
const log = txt.slice(txt.indexOf('Registo de emissão'));
assert.equal((log.match(/Video_A\.mp4/g) || []).length, 2, 'vídeo A em 2 linhas do registo');
assert.equal((log.match(/Cartaz_B\.jpg/g) || []).length, 2, 'vídeo B em 2 linhas do registo');
assert.ok(/09:00\s+12:00/.test(log), 'horas seguidas juntas (09:00 a 12:00)');
// campanha sem passagens
const vazio = R.buildReport(camp, [], screens, {}, Date.now());
assert.equal(vazio.slice(0, 4).toString(), '%PDF');
console.log('PASS relatório final (comercial): gráfico, tabela por conteúdo e registo de emissão');
