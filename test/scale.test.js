'use strict';
/* Teste de escala: 30 ecrãs a funcionar ao mesmo tempo e (opcional) envio de um vídeo de 5 GB.
   Correr: node test/scale.test.js            (30 ecrãs)
           SCALE_BIG=1 node test/scale.test.js (acrescenta o envio de 5 GB; precisa de ~12 GB livres) */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enif-scale-'));
process.env.DATA_DIR = tmp; process.env.ADMIN_NAME = 'Tiago'; process.env.ADMIN_EMAIL = 'tiago@enif.pt'; process.env.ADMIN_PASS = 'segredo1'; process.env.PORT = '0';
const { server } = require('../server');
const S = require('../lib/schedule');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed++; console.log('PASS ' + n); };
const N = 30;
async function main() {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port, base = 'http://127.0.0.1:' + port;
  const call = async (m, p, body, tok) => {
    const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.clone().json(); } catch (e) { }
    return { s: r.status, j };
  };
  const today = S.lisbonNow('Europe/Lisbon').date, plus = n => S.addDay(today, n);
  const adm = (await call('POST', '/api/login', { email: 'tiago@enif.pt', pass: 'segredo1' })).j.token;
  const op = (coll, id, doc) => ({ op: 'put', coll, id, doc });
  const cities = ['Lisboa', 'Porto', 'Braga', 'Faro', 'Coimbra', 'Aveiro'];
  const ids = Array.from({ length: N }, (_, i) => 'ECR-' + String(i + 1).padStart(3, '0'));
  const scr = (id, i) => op('screens', id, { id, venue: 'Local ' + (i + 1), city: cities[i % cities.length], spot: 'Átrio', type: 'Painel horizontal', res: 'auto', limit: 8, order: [], draft: null, loc: { addr: '', lat: null, lng: null, env: 'centro-comercial', pop: null }, on: 0, off: 24, onT: '00:00', offT: '23:59' });
  let t0 = Date.now();
  let r = await call('POST', '/api/sync', { ops: ids.map(scr) }, adm);
  ok(N + ' ecrãs criados de uma vez (' + (Date.now() - t0) + ' ms)', r.s === 200);
  let st = (await call('GET', '/api/state', undefined, adm)).j;
  ok(N + ' ecrãs no estado, cada um com chave própria', st.screens.length === N && new Set(st.screens.map(s => s.playerKey)).size === N);

  const up = async (name, mime, bytes, screens) => {
    const rr = await fetch(base + '/api/upload?name=' + encodeURIComponent(name) + '&mime=' + encodeURIComponent(mime) + '&screens=' + screens.join(',') + '&secs=12&res=1920%C3%971080', { method: 'PUT', headers: { Authorization: 'Bearer ' + adm }, body: bytes });
    return { s: rr.status, j: await rr.json() };
  };
  const files = [];
  for (let i = 0; i < 6; i++) { const f = await up('video' + i + '.mp4', 'video/mp4', Buffer.alloc(20000, i + 1), ids); files.push(f); }
  ok('6 vídeos carregados para os ' + N + ' ecrãs', files.every(f => f.s === 200 && f.j.screens.length === N));

  const camp = (id, i) => op('campaigns', id, { id, name: 'Campanha ' + id, client: 'Cli ' + i, venues: [], start: plus(-2), end: plus(20), h0: 0, h1: 24, ppm: 1, dur: 10, priority: 'Normal', manual: false, color: (i % 6) + 1, items: [{ f: files[i % 6].j.id, h0: null, h1: null, d0: null, d1: null, ppm: 1 }] });
  const cids = Array.from({ length: 20 }, (_, i) => 'C' + (i + 1));
  r = await call('POST', '/api/sync', { ops: cids.map(camp) }, adm);
  if (r.s !== 200) console.log('RECUSA:', r.s, JSON.stringify(r.j));
  ok('20 campanhas criadas', r.s === 200);
  // as campanhas passam a incluir todos os ecrãs; pode haver recusas legítimas de regras — o importante é não rebentar
  st = (await call('GET', '/api/state', undefined, adm)).j;
  ok('estado com ' + N + ' ecrãs e 20 campanhas (tamanho ' + Math.round(JSON.stringify(st).length / 1024) + ' KB)', st.screens.length === N && st.campaigns.length === 20);

  // ---- 30 players ao mesmo tempo: playlist + sinal de vida + passagens
  const keyOf = Object.fromEntries(st.screens.map(s => [s.id, s.playerKey]));
  t0 = Date.now();
  const res = await Promise.all(ids.map(async id => {
    const pl = await call('GET', '/api/player/playlist?code=' + id + '&key=' + keyOf[id]);
    const hb = await call('POST', '/api/player/heartbeat', { code: id, key: keyOf[id], c: 'C1', f: files[0].j.id, queue: 0, ver: '4', w: 1920, h: 1080 });
    const plays = Array.from({ length: 400 }, (_, i) => ({ pid: id + '-' + i + '-' + Math.random().toString(36).slice(2), c: cids[i % 20], f: files[i % 6].j.id, ts: Date.now() - (i % 20) * 1000, dur: 10, ok: 1 }));
    const pr = await call('POST', '/api/player/plays', { code: id, key: keyOf[id], plays });
    return { pl, hb, pr };
  }));
  const dt = Date.now() - t0;
  ok(N + ' players ao mesmo tempo, sem erros (' + dt + ' ms)', res.every(x => x.pl.s === 200 && x.hb.s === 200 && x.pr.s === 200 && x.pr.j.saved === 400));
  ok('playlist de cada ecrã tem dias e horas', res.every(x => x.pl.j && x.pl.j.days && Object.keys(x.pl.j.days).length > 0));
  st = (await call('GET', '/api/state', undefined, adm)).j;
  ok('todos os ' + N + ' ecrãs aparecem online', st.screens.filter(s => s.status === 'online').length === N);

  // ---- relatórios com 12 000 passagens e 30 ecrãs
  t0 = Date.now();
  const pr = await call('GET', '/api/plays?from=' + plus(-3) + '&to=' + plus(0), undefined, adm);
  ok('relatório de todos os ecrãs (' + (Date.now() - t0) + ' ms)', pr.s === 200 && pr.j.rows.length > 0 && new Set(pr.j.rows.map(x => x.s)).size === N);
  const total = pr.j.rows.reduce((a, x) => a + x.n, 0);
  ok('total de passagens certo (12 000)', total === N * 400);

  // ---- cópia de segurança com tudo isto
  t0 = Date.now();
  const bk = await call('POST', '/api/backup-now', {}, adm);
  ok('cópia de segurança (' + (Date.now() - t0) + ' ms)', bk.s === 200);

  // ---- envio grande (opcional): 5 GB, sem passar pela memória
  if (process.env.SCALE_BIG) {
    const SIZE = 5 * 1024 ** 3, chunk = Buffer.alloc(8 * 1024 * 1024, 7);
    const put = (size, declared) => new Promise((ok2, ko) => {
      const q = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/upload?name=grande.mp4&mime=video%2Fmp4&screens=ECR-001&secs=30&res=1920%C3%971080', headers: { Authorization: 'Bearer ' + adm, 'Content-Length': declared } }, rs => { let b = ''; rs.on('data', c => b += c); rs.on('end', () => ok2({ s: rs.statusCode, b })); });
      q.on('error', e => ok2({ s: 0, b: String(e.code || e) }));
      let sent = 0;
      (function w() { while (sent < size) { const n = Math.min(chunk.length, size - sent); sent += n; if (!q.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return q.once('drain', w); } q.end(); })();
    });
    t0 = Date.now();
    const big = await put(SIZE, SIZE);
    const bj = JSON.parse(big.b || '{}');
    ok('vídeo de 5 GB aceite (' + Math.round((Date.now() - t0) / 1000) + ' s)', big.s === 200 && bj.bytes === SIZE && bj.size);
    const rr = await fetch(base + '/media/' + bj.id + '?t=' + adm, { headers: { Range: 'bytes=' + (SIZE - 10) + '-' + (SIZE - 1) } });
    ok('pedido parcial no fim do ficheiro de 5 GB', rr.status === 206 && (await rr.arrayBuffer()).byteLength === 10);
    const tooBig = await new Promise(ok2 => { const q = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/upload?name=x.mp4&mime=video%2Fmp4&screens=ECR-001', headers: { Authorization: 'Bearer ' + adm, 'Content-Length': 7 * 1024 ** 3 } }, rs => { rs.resume(); ok2(rs.statusCode); }); q.on('error', () => ok2(0)); q.end(); });
    ok('ficheiro de 7 GB recusado antes de ser enviado', tooBig === 413 || tooBig === 0);
  }
  console.log('\n' + passed + ' verificações OK');
  server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  process.exit(0);
}
main().catch(e => { console.error('FALHOU:', e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { } process.exit(1); });
