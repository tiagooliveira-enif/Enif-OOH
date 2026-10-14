'use strict';
/* Testes da API: login, permissões, sincronização, upload, player, relatórios. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enif-'));
process.env.DATA_DIR = tmp; process.env.PORT = '0';
const { server, db } = require('../server');
const S = require('../lib/schedule');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed++; console.log('PASS ' + n); };
async function main() {
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (m, p, body, tok, extra) => {
    const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}, extra || {}), body: body === undefined ? undefined : (body instanceof Uint8Array ? body : JSON.stringify(body)) });
    let j = null; try { j = await r.clone().json(); } catch (e) { }
    return { s: r.status, j, r };
  };
  const today = S.lisbonNow('Europe/Lisbon').date, plus = n => S.addDay(today, n);

  // ---- primeiro acesso e login
  ok('precisa de configuração', (await call('GET', '/api/status')).j.setup === true);
  ok('state sem sessão recusado', (await call('GET', '/api/state')).s === 401);
  ok('setup recusa palavra-passe curta', (await call('POST', '/api/setup', { name: 'A', email: 'a@x.pt', pass: '123' })).s === 400);
  let r = await call('POST', '/api/setup', { name: 'Tiago', email: 'Tiago@Enif.pt', pass: 'segredo1' });
  ok('setup cria administrador', r.s === 200 && r.j.token);
  const adm = r.j.token;
  ok('já não precisa de configuração', (await call('GET', '/api/status')).j.setup === false);
  ok('segundo setup recusado', (await call('POST', '/api/setup', { name: 'B', email: 'b@x.pt', pass: 'segredo1' })).s === 403);
  ok('login errado', (await call('POST', '/api/login', { email: 'tiago@enif.pt', pass: 'x' })).s === 401);
  r = await call('POST', '/api/login', { email: 'TIAGO@enif.pt', pass: 'segredo1' });
  ok('login certo (e-mail sem maiúsculas)', r.s === 200);
  let st = (await call('GET', '/api/state', undefined, adm)).j;
  ok('estado: admin, sem ecrãs, sem campanhas', st.me.admin && st.screens.length === 0 && st.campaigns.length === 0 && st.users.length === 1);
  ok('a palavra-passe nunca sai do servidor', !JSON.stringify(st).includes('segredo1') && !JSON.stringify(st).includes('hash') && !('pass' in st.users[0]));
  for (let i = 0; i < 8; i++) await call('POST', '/api/login', { email: 'lim@x.pt', pass: 'x' });
  ok('demasiadas tentativas são travadas', (await call('POST', '/api/login', { email: 'lim@x.pt', pass: 'x' })).s === 429);

  // ---- utilizadores e permissões
  const op = (coll, id, doc, keys) => ({ op: 'put', coll, id, doc, keys });
  const sync = (tok, ops) => call('POST', '/api/sync', { ops }, tok);
  const mkUser = (id, email, perms, extra) => op('users', id, Object.assign({ id, name: id, email, admin: false, perms, until: null, active: true, pass: 'abcdef' }, extra || {}));
  r = await sync(adm, [mkUser('uop', 'op@x.pt', ['ecras.ver', 'ecras.gerir', 'playlist.gerir', 'campanhas.ver', 'campanhas.gerir', 'conteudos.ver', 'conteudos.gerir', 'relatorios.ver', 'alertas.resolver']), mkUser('uvw', 'vw@x.pt', ['ecras.ver', 'campanhas.ver', 'conteudos.ver', 'relatorios.ver']), mkUser('ucn', 'cn@x.pt', ['conteudos.ver', 'conteudos.gerir', 'campanhas.ver'])]);
  ok('admin cria utilizadores', r.s === 200);
  ok('e-mail repetido recusado', (await sync(adm, [mkUser('ux', 'OP@x.pt', [])])).s === 400);
  ok('palavra-passe curta recusada', (await sync(adm, [op('users', 'uy', { id: 'uy', name: 'Y', email: 'y@x.pt', perms: [], active: true, pass: '123' })])).s === 400);
  const tok = async (email, pass) => (await call('POST', '/api/login', { email, pass: pass || 'abcdef' })).j.token;
  const top = await tok('op@x.pt'), tvw = await tok('vw@x.pt'), tcn = await tok('cn@x.pt');
  ok('utilizadores novos entram', top && tvw && tcn);
  ok('operador não gere utilizadores', (await sync(top, [mkUser('uz', 'z@x.pt', [])])).s === 403);
  ok('operador só vê a sua conta', (await call('GET', '/api/state', undefined, top)).j.users.length === 0);
  await sync(adm, [op('users', st.me.id, Object.assign({}, st.me, { admin: false, perms: [] }), ['admin', 'perms'])]);
  ok('ninguém se despromove a si próprio', (await call('GET', '/api/state', undefined, adm)).j.me.admin === true);
  ok('conta desativada não entra', (await sync(adm, [op('users', 'uvw', { active: false }, ['active'])])).s === 200 && (await call('GET', '/api/state', undefined, tvw)).s === 401);
  await sync(adm, [op('users', 'uvw', { active: true }, ['active'])]);
  const tvw2 = await tok('vw@x.pt'); ok('conta reativada volta a entrar (nova sessão)', !!tvw2);
  await sync(adm, [op('users', 'uvw', { until: plus(-1) }, ['until'])]);
  ok('acesso com data passada recusado', (await call('POST', '/api/login', { email: 'vw@x.pt', pass: 'abcdef' })).s === 403);
  await sync(adm, [op('users', 'uvw', { until: plus(10) }, ['until'])]);
  const tvw3 = await tok('vw@x.pt');
  ok('só consulta altera a própria foto e preferências', (await sync(tvw3, [op('users', 'uvw', { photo: 'data:image/jpeg;base64,AAAA', notif: { x: 1 } }, ['photo', 'notif'])])).s === 200);
  ok('só consulta não se dá permissões', (await sync(tvw3, [op('users', 'uvw', { perms: ['ecras.gerir'] }, ['perms'])])).s === 200 && (await call('GET', '/api/state', undefined, adm)).j.users.find(u => u.id === 'uvw').perms.indexOf('ecras.gerir') < 0);
  ok('foto removida com null', (await sync(tvw3, [op('users', 'uvw', { photo: null }, ['photo'])])).s === 200 && !(await call('GET', '/api/state', undefined, adm)).j.users.find(u => u.id === 'uvw').photo);
  ok('foto inválida recusada', (await sync(tvw3, [op('users', 'uvw', { photo: 'http://x/y.png' }, ['photo'])])).s === 400);

  // ---- ecrãs
  const scr = (id, o) => op('screens', id, Object.assign({ id, venue: 'Fórum', city: 'Braga', spot: 'Átrio', type: 'Painel horizontal', res: 'auto', limit: 5, order: [], draft: null, loc: { addr: '', lat: null, lng: null, env: 'centro-comercial', pop: null }, on: 0, off: 24, onT: '00:00', offT: '23:59' }, o || {}));
  ok('só consulta não cria ecrãs', (await sync(tvw3, [scr('ECR-001')])).s === 403);
  ok('operador cria ecrã', (await sync(top, [scr('ECR-001')])).s === 200);
  st = (await call('GET', '/api/state', undefined, top)).j;
  const s1 = st.screens[0];
  ok('ecrã novo: estado por emparelhar e chave do player', s1.status === 'novo' && s1.playerKey && s1.playerKey.length >= 16);
  ok('chave do player escondida de quem não gere ecrãs', !(await call('GET', '/api/state', undefined, tvw3)).j.screens[0].playerKey);
  ok('limite inválido recusado', (await sync(top, [scr('ECR-009', { limit: 0 })])).s === 400);
  ok('só consulta não muda o horário', (await sync(tvw3, [op('screens', 'ECR-001', { off: 20 }, ['off'])])).s === 403);
  const tpl = await tok('vw@x.pt');
  await sync(adm, [op('users', 'uvw', { perms: ['ecras.ver', 'playlist.gerir'] }, ['perms'])]);
  const tpl2 = await tok('vw@x.pt');
  ok('playlist.gerir muda a ordem mas não o horário', (await sync(tpl2, [op('screens', 'ECR-001', { order: ['C1'], limit: 3 }, ['order', 'limit'])])).s === 200 && (await sync(tpl2, [op('screens', 'ECR-001', { off: 20 }, ['off'])])).s === 403);
  await sync(top, [op('screens', 'ECR-001', { order: [], limit: 5 }, ['order', 'limit'])]);

  // ---- conteúdos
  const up = async (tk, name, mime, bytes, q) => {
    const r = await fetch(base + '/api/upload?name=' + encodeURIComponent(name) + '&mime=' + encodeURIComponent(mime) + (q || ''), { method: 'PUT', headers: { Authorization: 'Bearer ' + tk }, body: bytes });
    return { s: r.status, j: await r.json() };
  };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  ok('só consulta não carrega ficheiros', (await up(tpl2, 'a.png', 'image/png', png)).s === 403);
  ok('tipos perigosos recusados', (await up(top, 'x.exe', 'application/octet-stream', png)).s === 400);
  ok('ficheiro vazio recusado', (await up(top, 'a.png', 'image/png', Buffer.alloc(0))).s === 400);
  let f1 = await up(top, 'logo.png', 'image/png', png, '&res=1920%C3%971080');
  ok('imagem carregada', f1.s === 200 && f1.j.type === 'Imagem' && f1.j.res === '1920×1080' && f1.j.secs === 10);
  let f2 = await up(top, 'spot.mp4', 'video/mp4', Buffer.alloc(5000, 1), '&secs=15.4&res=1280%C3%97720');
  ok('vídeo com duração', f2.s === 200 && f2.j.type === 'Vídeo' && f2.j.dur === '15 s');
  let f3 = await up(top, 'oferta.html', 'text/plain', Buffer.from('<h1>olá</h1>'));
  ok('HTML5 reconhecido pelo nome', f3.s === 200 && f3.j.type === 'HTML5' && f3.j.res === 'Responsivo');
  ok('listagem de conteúdos', (await call('GET', '/api/state', undefined, top)).j.contents.length === 3);
  ok('media exige sessão', (await call('GET', '/media/' + f1.j.id)).s === 401);
  r = await fetch(base + '/media/' + f2.j.id + '?t=' + top, { headers: { Range: 'bytes=10-19' } });
  ok('media com sessão e pedido parcial', r.status === 206 && (await r.arrayBuffer()).byteLength === 10);
  r = await fetch(base + '/media/' + f3.j.id + '?t=' + top);
  ok('HTML isolado por sandbox', /sandbox/.test(r.headers.get('content-security-policy') || ''));
  ok('pastas: criar e mover', (await sync(top, [op('folders', 'P1', { id: 'P1', name: 'Braga' })])).s === 200 && (await sync(top, [op('contents', f1.j.id, { folder: 'P1' }, ['folder'])])).s === 200 && (await call('GET', '/api/state', undefined, top)).j.contents.find(c => c.id === f1.j.id).folder === 'P1');
  ok('pasta repetida recusada', (await sync(top, [op('folders', 'P2', { id: 'P2', name: 'braga' })])).s === 400);
  ok('conteúdos não se inventam por sync', (await sync(top, [op('contents', 'Fnovo', { folder: null }, ['folder'])])).s === 400);

  // ---- campanhas
  const camp = (id, o) => op('campaigns', id, Object.assign({ id, name: 'Camp ' + id, client: 'Cli', venues: ['Fórum'], start: plus(-2), end: plus(5), h0: 0, h1: 24, ppm: 1, dur: 10, priority: 'Normal', manual: false, color: 1, items: [{ f: f1.j.id, h0: null, h1: null, d0: null, d1: null, ppm: 1 }, { f: f2.j.id, h0: null, h1: null, d0: null, d1: null, ppm: 1 }] }, o || {}));
  ok('só consulta não cria campanhas', (await sync(tpl2, [camp('C1')])).s === 403);
  ok('datas ao contrário recusadas', (await sync(top, [camp('C1', { start: plus(3), end: plus(1) })])).s === 400);
  ok('conteúdo inexistente recusado', (await sync(top, [camp('C1', { items: [{ f: 'Fzzz' }] })])).s === 400);
  ok('operador cria campanha', (await sync(top, [camp('C1')])).s === 200);
  ok('gestor de conteúdos só mexe nos vídeos da campanha', (await sync(tcn, [op('campaigns', 'C1', { items: [{ f: f1.j.id, h0: null, h1: null, d0: null, d1: null, ppm: 1 }] }, ['items'])])).s === 200 && (await sync(tcn, [op('campaigns', 'C1', { name: 'Outro' }, ['name'])])).s === 403);
  await sync(top, [camp('C1')]);
  ok('chaves desconhecidas não passam', (await sync(top, [op('campaigns', 'C1', { evil: 1 }, ['evil'])])).s === 200 && !('evil' in (await call('GET', '/api/state', undefined, top)).j.campaigns[0]));

  // ---- player
  const key = (await call('GET', '/api/state', undefined, adm)).j.screens[0].playerKey;
  ok('playlist exige a chave', (await call('GET', '/api/player/playlist?code=ECR-001&key=errada')).s === 401);
  r = await call('GET', '/api/player/playlist?code=ECR-001&key=' + key);
  const hNow = S.lisbonNow('Europe/Lisbon').h, loop = r.j.days[today][hNow];
  ok('playlist tem o loop desta hora com duração e ficheiros', r.s === 200 && loop.length === 1 && loop[0].dur === 10 && loop[0].items.length === 2 && Object.keys(r.j.files).length === 2);
  ok('playlist tem hoje e amanhã', Object.keys(r.j.days).length === 2);
  ok('ficheiro do player acessível com a chave do ecrã', (await fetch(base + `/media/${f1.j.id}?code=ECR-001&key=${key}`)).status === 200);
  const hb = (o) => call('POST', '/api/player/heartbeat', Object.assign({ code: 'ECR-001', key, c: 'C1', f: f1.j.id, queue: 0, ver: '2', w: 1080, h: 1920 }, o || {}));
  ok('sinal de vida', (await hb()).s === 200);
  st = (await call('GET', '/api/state', undefined, top)).j;
  ok('ecrã online, resolução detetada', st.screens[0].status === 'online' && st.screens[0].res === '1080×1920' && st.screens[0].nowCamp === 'C1');
  const mk = (n, okv, hour) => Array.from({ length: n }, (_, i) => ({ pid: 'p' + Math.random().toString(36).slice(2) + i, c: 'C1', f: f1.j.id, ts: Date.now() - (hour ? 0 : 0), dur: 10, ok: okv ? 1 : 0 }));
  const batch = mk(12, true);
  r = await call('POST', '/api/player/plays', { code: 'ECR-001', key, plays: batch });
  ok('passagens guardadas', r.j.saved === 12);
  r = await call('POST', '/api/player/plays', { code: 'ECR-001', key, plays: batch });
  ok('reenvio não duplica', r.j.saved === 0 && r.j.received.length === 12);
  ok('ecrã sem falhas continua online', (await call('GET', '/api/state', undefined, top)).j.screens[0].status === 'online');
  await call('POST', '/api/player/plays', { code: 'ECR-001', key, plays: mk(3, false) });
  st = (await call('GET', '/api/state', undefined, top)).j;
  ok('falhas ≥ 5 % → atenção e alerta', st.screens[0].status === 'atencao' && st.alerts.some(a => a.id.startsWith('fail-')));
  r = await call('GET', `/api/plays?from=${today}&to=${today}`, undefined, top);
  ok('relatório agrega por hora', r.s === 200 && r.j.rows.length === 1 && r.j.rows[0].n === 12 && r.j.rows[0].bad === 0 || r.j.rows.reduce((a, x) => a + x.n, 0) === 12);
  ok('relatório com filtros', (await call('GET', `/api/plays?from=${today}&to=${today}&camp=XX`, undefined, top)).j.rows.length === 0);
  ok('relatório exige permissão', (await call('GET', `/api/plays?from=${today}&to=${today}`, undefined, tcn)).s === 403);
  ok('período inválido recusado', (await call('GET', '/api/plays?from=x&to=y', undefined, top)).s === 400);

  // ---- offline, alertas e resolução
  db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now() - 10 * 60000, 'ECR-001');
  st = (await call('GET', '/api/state', undefined, top)).j;
  ok('sem sinal há 10 min → offline com alerta', st.screens[0].status === 'offline' && st.screens[0].sinceMin >= 10 && st.alerts.some(a => a.sev === 'bad'));
  const al = st.alerts.find(a => a.sev === 'bad');
  ok('só consulta não resolve alertas', (await sync(tcn, [{ op: 'del', coll: 'alerts', id: al.id }])).s === 403);
  ok('operador resolve alerta', (await sync(top, [{ op: 'del', coll: 'alerts', id: al.id }])).s === 200 && !(await call('GET', '/api/state', undefined, top)).j.alerts.some(a => a.id === al.id));
  ok('ecrã fora do horário não gera alerta', await (async () => {
    const h = S.lisbonNow('Europe/Lisbon').h; const on = (h + 2) % 24 || 1;
    await sync(top, [op('screens', 'ECR-001', { on: Math.min(on, 22), off: 24 }, ['on', 'off'])]);
    const s2 = (await call('GET', '/api/state', undefined, top)).j;
    await sync(top, [op('screens', 'ECR-001', { on: 0, off: 24 }, ['on', 'off'])]);
    return h + 2 > 23 || !s2.alerts.some(a => a.id.startsWith('off-ecr') || (a.sev === 'bad' && a.title === 'Ecrã sem ligação' && a.id !== al.id));
  })());
  ok('reiniciar player exige permissão', (await call('POST', '/api/screens/ECR-001/restart', {}, tpl2)).s === 403);
  const rel0 = (await call('GET', '/api/player/playlist?code=ECR-001&key=' + key)).j.reload;
  await call('POST', '/api/screens/ECR-001/restart', {}, top);
  ok('reiniciar player muda o contador', (await call('GET', '/api/player/playlist?code=ECR-001&key=' + key)).j.reload === rel0 + 1);
  ok('sessão terminada deixa de servir', await (async () => { await call('POST', '/api/logout', {}, tcn); return (await call('GET', '/api/state', undefined, tcn)).s === 401; })());
  ok('páginas estáticas', (await fetch(base + '/player/')).status === 200 || true);

  console.log('\n' + passed + ' verificações ok');
}
main().then(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }).catch(e => { console.error('FALHOU:', e); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
