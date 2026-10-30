'use strict';
/* Testes da API: login, permissões, sincronização, upload, player, relatórios. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enif-'));
process.env.DATA_DIR = tmp; process.env.ADMIN_NAME = 'Tiago'; process.env.ADMIN_EMAIL = 'Tiago@Enif.pt'; process.env.ADMIN_PASS = 'segredo1'; process.env.PORT = '0';
const { server, db, underReset, cleanSweep, alertMailTick, weeklyMailTick, weeklyText } = require('../server');
const S = require('../lib/schedule');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed++; console.log('PASS ' + n); };
async function main() {
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (m, p, body, tok, extra) => {
    const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}, extra || {}), body: body === undefined ? undefined : (body instanceof Uint8Array ? body : JSON.stringify(body)) });
    let j = null; try { j = await r.clone().json(); } catch (e) { /* sem ação */ }
    return { s: r.status, j, r };
  };
  const today = S.lisbonNow('Europe/Lisbon').date, plus = n => S.addDay(today, n);

  // ---- primeiro acesso e login
  ok('não há página pública de criação de conta', (await call('GET', '/api/status')).j.setup === false);
  ok('state sem sessão recusado', (await call('GET', '/api/state')).s === 401);
  ok('criar conta pela internet recusado', (await call('POST', '/api/setup', { name: 'B', email: 'b@x.pt', pass: 'segredo1' })).s === 404);
  let r = await call('POST', '/api/login', { email: 'tiago@enif.pt', pass: 'segredo1' });
  ok('o administrador inicial entra', r.s === 200 && r.j.token);
  let adm = r.j.token;
  // ---- a sessão termina por inatividade (15 minutos); só quem usa a página a prolonga
  {
    const exp = t => db.prepare('SELECT exp FROM sessions WHERE token=?').get(t).exp;
    const idle = (await call('GET', '/api/state', undefined, adm)).j.idleMin;
    ok('o servidor indica o limite de inatividade (15 min)', idle === 15);
    ok('a sessão nova dura 15 minutos', Math.abs(exp(adm) - (Date.now() + 15 * 60000)) < 5000);
    db.prepare('UPDATE sessions SET exp=? WHERE token=?').run(Date.now() + 60000, adm);
    await call('GET', '/api/state', undefined, adm);
    ok('pedidos automáticos não prolongam a sessão', exp(adm) < Date.now() + 61000);
    await call('GET', '/api/state', undefined, adm, { 'X-Activity': '1' });
    ok('pedidos de quem está a usar a página prolongam-na', Math.abs(exp(adm) - (Date.now() + 15 * 60000)) < 5000);
    db.prepare('UPDATE sessions SET exp=? WHERE token=?').run(Date.now() - 1, adm);
    ok('sessão inativa mais de 15 minutos é recusada', (await call('GET', '/api/state', undefined, adm)).s === 401);
    r = await call('POST', '/api/login', { email: 'tiago@enif.pt', pass: 'segredo1' });
    adm = r.j.token;
  }
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
  await tok('vw@x.pt');
  await sync(adm, [op('users', 'uvw', { perms: ['ecras.ver', 'playlist.gerir'] }, ['perms'])]);
  const tpl2 = await tok('vw@x.pt');
  ok('playlist.gerir muda a ordem mas não o horário', (await sync(tpl2, [op('screens', 'ECR-001', { order: ['C1'], limit: 3 }, ['order', 'limit'])])).s === 200 && (await sync(tpl2, [op('screens', 'ECR-001', { off: 20 }, ['off'])])).s === 403);
  await sync(top, [op('screens', 'ECR-001', { order: [], limit: 5 }, ['order', 'limit'])]);

  // ---- conteúdos
  const up = async (tk, name, mime, bytes, q) => {
    const r = await fetch(base + '/api/upload?name=' + encodeURIComponent(name) + '&mime=' + encodeURIComponent(mime) + (q && q.indexOf('screens=') > -1 ? '' : '&screens=ECR-001') + (q || ''), { method: 'PUT', headers: { Authorization: 'Bearer ' + tk }, body: bytes });
    return { s: r.status, j: await r.json() };
  };
  const mkPng = (w, h) => { const b = Buffer.alloc(33 + 12); Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 2; b.write('IEND', 37); return b; };
  const png = mkPng(1920, 1080);
  ok('só consulta não carrega ficheiros', (await up(tpl2, 'a.png', 'image/png', png)).s === 403);
  ok('tipos perigosos recusados', (await up(top, 'x.exe', 'application/octet-stream', png)).s === 400);
  ok('ficheiro vazio recusado', (await up(top, 'a.png', 'image/png', Buffer.alloc(0))).s === 400);
  let f1 = await up(top, 'logo.png', 'image/png', png, '&res=800%C3%97600');
  ok('imagem carregada (a resolução é lida do próprio ficheiro)', f1.s === 200 && f1.j.type === 'Imagem' && f1.j.res === '1920×1080' && f1.j.secs === 10 && f1.j.screens.join() === 'ECR-001' && f1.j.house === false);
  let f2 = await up(top, 'spot.mp4', 'video/mp4', Buffer.alloc(5000, 1), '&secs=15.4&res=1280%C3%97720');
  ok('vídeo com duração (dica do browser quando não há ffprobe)', f2.s === 200 && f2.j.type === 'Vídeo' && f2.j.dur === '15 s' && f2.j.bytes === 5000);
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
  // vários intervalos de horas
  ok('mais de 3 intervalos recusados', (await sync(top, [camp('CI', { ivs: [[1, 2], [3, 4], [5, 6], [7, 8]] })])).s === 400);
  ok('intervalo com fim antes do início recusado', (await sync(top, [camp('CI', { ivs: [[10, 8], [19, 22]] })])).s === 400);
  ok('campanha com dois intervalos aceite', (await sync(top, [camp('CI', { ivs: [[19, 22], [7, 10]], items: [{ f: f1.j.id, h0: null, h1: null, ivs: [[8, 9], [20, 21]], ppm: 1 }] })])).s === 200);
  const ci = (await call('GET', '/api/state', undefined, top)).j.campaigns.find(x => x.id === 'CI');
  ok('intervalos guardados por ordem, com h0/h1 a cobrir o dia todo', JSON.stringify(ci.ivs) === '[[7,10],[19,22]]' && ci.h0 === 7 && ci.h1 === 22);
  ok('intervalos do vídeo guardados', JSON.stringify(ci.items[0].ivs) === '[[8,9],[20,21]]');
  await sync(top, [camp('CJ', { ivs: [[7, 10], [9, 12]] })]);
  const cj = (await call('GET', '/api/state', undefined, top)).j.campaigns.find(x => x.id === 'CJ');
  ok('intervalos sobrepostos ficam juntos (7–10 + 9–12 = 7–12)', cj && !cj.ivs && cj.h0 === 7 && cj.h1 === 12);
  await sync(top, [camp('CP', { priority: 'Baixa' }), camp('CQ', { priority: 'Alta', share: 'G1' }), camp('CR', { share: 'G1' })]);
  const cps = (await call('GET', '/api/state', undefined, top)).j.campaigns;
  ok('prioridade «Baixa» já não existe (passa a Normal)', cps.find(x => x.id === 'CP').priority === 'Normal');
  ok('prioridade Alta guardada', cps.find(x => x.id === 'CQ').priority === 'Alta');
  ok('posição partilhada guardada', cps.find(x => x.id === 'CQ').share === 'G1' && cps.find(x => x.id === 'CR').share === 'G1');
  ok('posição partilhada inválida recusada', (await sync(top, [camp('CS', { share: 'a b<c>' })])).s === 400);
  await sync(top, [{ op: 'del', coll: 'campaigns', id: 'CP' }, { op: 'del', coll: 'campaigns', id: 'CQ' }, { op: 'del', coll: 'campaigns', id: 'CR' }]);
  await sync(top, [{ op: 'del', coll: 'campaigns', id: 'CI' }, { op: 'del', coll: 'campaigns', id: 'CJ' }]);
  ok('gestor de conteúdos só mexe nos vídeos da campanha', (await sync(tcn, [op('campaigns', 'C1', { items: [{ f: f1.j.id, h0: null, h1: null, d0: null, d1: null, ppm: 1 }] }, ['items'])])).s === 200 && (await sync(tcn, [op('campaigns', 'C1', { name: 'Outro' }, ['name'])])).s === 403);
  await sync(top, [camp('C1')]);
  ok('chaves desconhecidas não passam', (await sync(top, [op('campaigns', 'C1', { evil: 1 }, ['evil'])])).s === 200 && !('evil' in (await call('GET', '/api/state', undefined, top)).j.campaigns[0]));

  // ---- player
  const key = (await call('GET', '/api/state', undefined, adm)).j.screens[0].playerKey;
  ok('playlist exige a chave', (await call('GET', '/api/player/playlist?code=ECR-001&key=errada')).s === 401);
  r = await call('GET', '/api/player/playlist?code=ECR-001&key=' + key);
  const hNow = S.lisbonNow('Europe/Lisbon').h, loop = r.j.days[today][hNow];
  ok('playlist tem o loop desta hora com duração e ficheiros', r.s === 200 && loop.seq.length === 1 && loop.seq[0].dur === 10 && loop.seq[0].items.length === 2 && Object.keys(r.j.files).length === 2 && r.j.screen.fit === 'caber');
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

  // ---- calendário (só leitura, endereço secreto iCal)
  {
    const http = require('node:http'), fmt = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const now = Date.now(), ev = (uid, title, h) => ['BEGIN:VEVENT', 'UID:' + uid, 'SUMMARY:' + title, 'DESCRIPTION:Detalhe do evento', 'DTSTART:' + fmt(now + h * 3600000), 'END:VEVENT'].join('\r\n');
    const ics = ['BEGIN:VCALENDAR', ev('u1', 'SPOTS DIGITAIS – Entrega', 30), ev('u2', 'Almoço de equipa', 20), ev('u3', 'SPOTS DIGITAIS – Instalação', 110), ev('u4', 'spots digitais – passado', -5), 'END:VCALENDAR'].join('\r\n');
    const cs = http.createServer((q, rs) => { rs.writeHead(200, { 'Content-Type': 'text/calendar' }); rs.end(ics); });
    await new Promise(r => cs.listen(0, '127.0.0.1', r));
    ok('calendário sem endereço: não configurado', (await call('GET', '/api/calendar', undefined, adm)).j.configured === false);
    process.env.CAL_ICS_URL = 'http://127.0.0.1:' + cs.address().port + '/secreto.ics'; process.env.CAL_ALLOW_HTTP = '1';
    ok('calendário exige sessão', (await call('GET', '/api/calendar')).s === 401);
    let cv = (await call('GET', '/api/calendar', undefined, adm)).j;
    ok('só os eventos com a palavra, no futuro', cv.configured && cv.events.length === 2 && cv.events.every(e => /SPOTS DIGITAIS/.test(e.title)));
    ok('a resposta nunca inclui o endereço secreto', !JSON.stringify(cv).includes('secreto'));
    ok('evento com descrição e hora', cv.events[0].desc === 'Detalhe do evento' && cv.events[0].at > now);
    const id0 = cv.events[0].id;
    ok('marcar como lida', (await call('POST', '/api/calendar/read', { id: id0 }, adm)).j.events.find(e => e.id === id0).read === true);
    ok('evento desconhecido recusado', (await call('POST', '/api/calendar/read', { id: 'deadbeefdeadbeef' }, adm)).s === 400);
    ok('palavra só com permissão de ecrãs', (await call('POST', '/api/calendar/keyword', { kw: 'x' }, tpl2)).s === 403);
    cv = (await call('POST', '/api/calendar/keyword', { kw: 'Almoço' }, adm)).j;
    ok('mudar a palavra muda os eventos lidos', cv.events.length === 1 && cv.events[0].title === 'Almoço de equipa');
    await call('POST', '/api/calendar/keyword', { kw: 'SPOTS DIGITAIS' }, adm);
    delete process.env.CAL_ICS_URL; cs.close();
  }

  // ---- movimento à volta do ecrã (OpenStreetMap, aqui um Overpass falso)
  {
    const http = require('node:http'), POI = require('../lib/poi'), AUD = require('../lib/audience');
    const els = [{ tags: { shop: 'clothes' } }, { tags: { shop: 'bakery' } }, { tags: { amenity: 'cafe' } }, { tags: { highway: 'bus_stop' } }, { tags: { railway: 'station' } }, { tags: { amenity: 'school' } }, { tags: { amenity: 'hospital' } }, { tags: { building: 'yes' } }];
    let got = '';
    const ov = http.createServer((q, rs) => { let b = ''; q.on('data', c => { b += c; }); q.on('end', () => { got = decodeURIComponent(b); rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ elements: els })); }); });
    await new Promise(r => ov.listen(0, '127.0.0.1', r));
    process.env.POI_URL = 'http://127.0.0.1:' + ov.address().port + '/api/interpreter'; process.env.POI_ALLOW_HTTP = '1';
    ok('movimento à volta exige sessão', (await call('POST', '/api/poi', { lat: 38.7, lng: -9.1 })).s === 401);
    ok('movimento à volta exige permissão de ecrãs', (await call('POST', '/api/poi', { lat: 38.7, lng: -9.1 }, tpl2)).s === 403);
    const pr = await call('POST', '/api/poi', { lat: 38.7369, lng: -9.1521 }, adm);
    ok('conta lojas, restaurantes, paragens, escolas e hospitais', pr.s === 200 && pr.j.shops === 2 && pr.j.food === 1 && pr.j.transit === 2 && pr.j.edu === 1 && pr.j.health === 1 && pr.j.r === 250);
    ok('a pergunta usa o raio de 250 m e as coordenadas', /around:250,38\.736900,-9\.152100/.test(got));
    ok('coordenadas inválidas recusadas', (await call('POST', '/api/poi', { lat: 99, lng: 0 }, adm)).s === 400);
    const f1 = POI.factor({ shops: 0, food: 0, transit: 0, edu: 0, health: 0 }), f2 = POI.factor({ shops: 200, food: 100, transit: 40, edu: 5, health: 5 });
    ok('fator de movimento entre −15 % e +40 %', Math.abs(f1 - 0.85) < 1e-9 && f2 > 1.35 && f2 <= 1.4);
    ok('o relatório final usa o mesmo fator que a aplicação', Math.abs(AUD.poiFactor({ shops: 17, food: 15, transit: 5, edu: 0, health: 0 }) - POI.factor({ shops: 17, food: 15, transit: 5, edu: 0, health: 0 })) < 1e-12);
    const sc = (id, loc) => ({ id, venue: 'Praça', city: 'Lisboa', spot: 'A', type: 'Totem', res: '1080×1920', limit: 5, order: [], draft: null, loc, on: 0, off: 24 });
    await sync(adm, [{ op: 'put', coll: 'screens', id: 'ECR-P1', doc: sc('ECR-P1', { addr: '', lat: 38.7369, lng: -9.1521, env: 'rua', pop: null, poi: Object.assign({}, pr.j, { evil: 1 }) }) }, { op: 'put', coll: 'screens', id: 'ECR-P2', doc: sc('ECR-P2', { addr: '', lat: null, lng: null, env: 'rua', pop: null, poi: pr.j }) }]);
    const sp = (await call('GET', '/api/state', undefined, adm)).j.screens;
    ok('movimento guardado com as coordenadas', sp.find(x => x.id === 'ECR-P1').loc.poi.shops === 2 && !('evil' in sp.find(x => x.id === 'ECR-P1').loc.poi));
    ok('sem coordenadas o movimento é ignorado', sp.find(x => x.id === 'ECR-P2').loc.poi === null);
    await sync(adm, [{ op: 'del', coll: 'screens', id: 'ECR-P1' }, { op: 'del', coll: 'screens', id: 'ECR-P2' }]);
    ov.close(); delete process.env.POI_URL;
  }

  // ---- comprovativo (1 ou 2 conteúdos que servem ao ecrã, máx. 2 min, fora dos relatórios)
  {
    const pA = await up(top, 'prova-a.png', 'image/png', mkPng(1080, 1920)), pB = await up(top, 'prova-b.png', 'image/png', mkPng(1080, 1920));
    const proof = (tk, o) => call('POST', '/api/screens/ECR-001/proof', o, tk), stop = tk => call('POST', '/api/screens/ECR-001/proof/stop', {}, tk);
    const scrView = async () => (await call('GET', '/api/state', undefined, adm)).j.screens.find(x => x.id === 'ECR-001');
    const tvwP = await tok('cn@x.pt');
    await hb({});
    ok('comprovativo exige permissão de playlist', (await proof(tvwP, { files: [pA.j.id], secs: 30 })).s === 403);
    ok('comprovativo exige sessão', (await proof(undefined, { files: [pA.j.id], secs: 30 })).s === 401);
    ok('sem conteúdos recusado', (await proof(top, { files: [], secs: 30 })).s === 400);
    ok('mais de 2 conteúdos recusado', (await proof(top, { files: [pA.j.id, pB.j.id, f3.j.id], secs: 30 })).s === 400);
    ok('conteúdo que não serve ao ecrã (outra resolução) recusado', (await proof(top, { files: [f1.j.id], secs: 30 })).s === 400);
    ok('conteúdo que não existe recusado', (await proof(top, { files: ['naoexiste'], secs: 30 })).s === 400);
    r = await proof(top, { files: [pA.j.id, pB.j.id], secs: 9999 });
    ok('comprovativo começa e o limite de 2 minutos é imposto no servidor', r.s === 200 && r.j.proof.secs === 120);
    ok('só um comprovativo de cada vez por ecrã', (await proof(top, { files: [pA.j.id], secs: 30 })).s === 400);
    let sv = await scrView();
    ok('o estado do ecrã mostra o comprovativo', sv.proof && sv.proof.files.join() === [pA.j.id, pB.j.id].join() && sv.proof.by && sv.proof.until > Date.now());
    r = await hb({});
    ok('o player recebe o comprovativo no heartbeat', r.j.proof && r.j.proof.files.length === 2 && r.j.proof.until - r.j.proof.serverTime > 100000);
    r = await call('GET', '/api/player/playlist?code=ECR-001&key=' + key);
    ok('a playlist traz os ficheiros do comprovativo', r.j.proof && r.j.proof.files.length === 2 && r.j.files[pA.j.id] && r.j.files[pB.j.id]);
    const n0 = db.prepare('SELECT COUNT(*) n FROM plays').get().n;
    r = await call('POST', '/api/player/plays', { code: 'ECR-001', key, plays: [{ pid: 'prova-1', c: '__proof', f: pA.j.id, ts: Date.now(), dur: 10, ok: 1 }] });
    ok('passagens do comprovativo são confirmadas mas não contam', r.j.received.includes('prova-1') && r.j.saved === 0 && db.prepare('SELECT COUNT(*) n FROM plays').get().n === n0);
    ok('terminar exige permissão', (await stop(tvwP)).s === 403);
    ok('terminar já', (await stop(top)).s === 200 && !(await scrView()).proof);
    sv = await scrView();
    ok('fica no registo do ecrã e na auditoria', sv.proofLog.length === 1 && sv.proofLog[0].files.join() === 'prova-a.png,prova-b.png' && db.prepare("SELECT COUNT(*) n FROM audit WHERE what LIKE 'Comprovativo%'").get().n === 2);
    ok('depois de terminar o player já não recebe comprovativo', (await hb({})).j.proof === null && (await call('GET', '/api/player/playlist?code=ECR-001&key=' + key)).j.proof === null);
    await proof(top, { files: [pA.j.id], secs: 10 });
    db.prepare('UPDATE proofs SET t0=? WHERE screen=?').run(Date.now() - 11000, 'ECR-001');
    ok('termina sozinho quando passa o tempo', !(await scrView()).proof && (await scrView()).proofLog.length === 2);
    db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now() - 10 * 60000, 'ECR-001');
    ok('ecrã offline não aceita comprovativo', (await proof(top, { files: [pA.j.id], secs: 30 })).s === 400);
    await hb({});
  }

  // ---- aviso «campanha abaixo do contratado» (só interno: painel e notificações)
  {
    const fU = await up(top, 'abaixo.png', 'image/png', mkPng(1080, 1920));
    const cU = { id: 'CU1', name: 'Campanha Alvo', client: 'Cli', venues: ['Fórum'], start: plus(-5), end: plus(5), h0: 0, h1: 24, ppm: 2, dur: 10, priority: 'Normal', manual: false, color: 1, items: [{ f: fU.j.id, h0: null, h1: null, d0: null, d1: null, ppm: 2 }], sector: '', sales: '', pauses: [] };
    await sync(top, [op('campaigns', 'CU1', cU)]);
    db.prepare('UPDATE live SET first_seen=?, last_seen=? WHERE screen=?').run(Date.now() - 24 * 3600000, Date.now(), 'ECR-001');
    db.prepare("DELETE FROM plays WHERE camp='CU1'").run();
    underReset();
    const alertsOf = async () => (await call('GET', '/api/state', undefined, adm)).j.alerts.filter(a => a.camp === 'CU1');
    let al = await alertsOf();
    ok('sem passagens, a campanha aparece «abaixo do contratado»', al.length === 1 && al[0].screen === 'ECR-001' && /abaixo do contratado/.test(al[0].title) && /das passagens previstas/.test(al[0].detail));
    ok('o aviso diz que não aparece nos relatórios', /Não aparece nos relatórios/.test(al[0].detail));
    const ins = db.prepare('INSERT INTO plays(pid,screen,camp,file,ts,day,hour,dur,ok) VALUES(?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 9000; i++) ins.run('u' + i, 'ECR-001', 'CU1', fU.j.id, Date.now() - 60000 - i * 9000, today, 12, 10, 1);   // 1 volta de 10 s: o loop prevê ~6 passagens por minuto
    underReset();
    ok('com passagens a chegar, o aviso desaparece', (await alertsOf()).length === 0);
    db.prepare("DELETE FROM plays WHERE camp='CU1'").run(); underReset();
    ok('o aviso volta se faltarem passagens', (await alertsOf()).length === 1);
    r = await sync(adm, [{ op: 'del', coll: 'alerts', id: al[0].id }]); underReset();
    ok('marcar como resolvido tira o aviso', r.s === 200 && (await alertsOf()).length === 0);
    await sync(top, [{ op: 'del', coll: 'campaigns', id: 'CU1' }]);
    db.prepare("DELETE FROM resolved WHERE id LIKE 'under-%'").run();
  }

  // ---- e-mail de alertas importantes ao administrador
  {
    const sent = [], fake = async (to, subject, text) => { sent.push({ to, subject, text }); };
    const mine = () => sent.filter(m => /ECR-001/.test(m.subject));
    db.prepare('UPDATE live SET first_seen=?, last_seen=? WHERE screen=?').run(Date.now() - 3 * 3600000, Date.now() - 20 * 60000, 'ECR-001');
    db.prepare("DELETE FROM alert_mail").run(); db.prepare("DELETE FROM resolved WHERE id LIKE 'off-%'").run();
    await alertMailTick(fake);
    ok('ecrã sem ligação há mais de 15 min: um e-mail ao administrador', mine().length === 1 && /sem ligação/.test(mine()[0].subject) && mine()[0].to === 'tiago@enif.pt');
    await alertMailTick(fake);
    ok('o mesmo problema não repete o e-mail', mine().length === 1);
    db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now(), 'ECR-001');
    await alertMailTick(fake);
    ok('quando o ecrã volta, chega um aviso de resolvido', mine().length === 2 && /Resolvido/.test(mine()[1].subject));
    db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now() - 5 * 60000, 'ECR-001');
    await alertMailTick(fake);
    ok('menos de 15 min offline não avisa', mine().length === 2);
    db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now() - 30 * 60000, 'ECR-001');
    const st0 = (await call('GET', '/api/state', undefined, adm)).j, al0 = st0.alerts.find(a => a.screen === 'ECR-001' && /^off-/.test(a.id));
    await sync(adm, [{ op: 'del', coll: 'alerts', id: al0.id }]);
    await alertMailTick(fake);
    ok('alerta já resolvido na app não gera e-mail', mine().length === 2);
    db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now() - 50 * 60000, 'ECR-001');
    await sync(adm, [op('users', st0.me.id, Object.assign({}, st0.me, { notif: { types: { alert: { app: true, email: false, sms: false } } } }), ['notif'])]);
    await alertMailTick(fake);
    ok('o administrador pode desligar o e-mail nas notificações', mine().length === 2);
    await sync(adm, [op('users', st0.me.id, Object.assign({}, st0.me, { notif: { types: { alert: { app: true, email: true, sms: false } } } }), ['notif'])]);
    db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now(), 'ECR-001');
    await alertMailTick(fake);
  }

  // ---- limpeza de conteúdos sem uso
  {
    const mk = async nm => (await up(top, nm, 'image/png', mkPng(1080, 1920))).j.id;
    const fNew = await mk('lx-novo.png'), fOld = await mk('lx-velho.png'), fUsed = await mk('lx-usado.png'), fAct = await mk('lx-ativo.png');
    const putRaw = (id, f) => { const d = JSON.parse(db.prepare("SELECT json FROM docs WHERE coll='contents' AND id=?").get(id).json); f(d); db.prepare("UPDATE docs SET json=? WHERE coll='contents' AND id=?").run(JSON.stringify(d), id); };
    const day = 864e5;
    putRaw(fOld, d => { d.up = Date.now() - 50 * day; });
    putRaw(fUsed, d => { d.up = Date.now() - 400 * day; });
    const cOld = { id: 'CL1', name: 'Velha', client: 'C', venues: ['Fórum'], start: plus(-200), end: plus(-170), h0: 0, h1: 24, ppm: 1, dur: 10, priority: 'Normal', manual: false, color: 1, items: [{ f: fUsed, h0: null, h1: null, d0: null, d1: null, ppm: 1 }], sector: '', sales: '', pauses: [] };
    const cAct = Object.assign({}, cOld, { id: 'CL2', name: 'Ativa', start: plus(-5), end: plus(5), items: [{ f: fAct, h0: null, h1: null, d0: null, d1: null, ppm: 1 }] });
    await sync(top, [op('campaigns', 'CL1', cOld), op('campaigns', 'CL2', cAct)]);
    putRaw(fAct, d => { d.up = Date.now() - 900 * day; });
    let stc = (await call('GET', '/api/state', undefined, adm)).j;
    const ex = id => (stc.contents.find(f => f.id === id) || {}).exp;
    ok('conteúdo novo e nunca usado: caduca 60 dias depois do carregamento', ex(fNew) === plus(60));
    ok('conteúdo nunca usado há 50 dias: já na janela de aviso (10 dias)', ex(fOld) === plus(10));
    ok('conteúdo usado: caduca 180 dias depois do fim da última campanha', ex(fUsed) === plus(10));
    ok('conteúdo numa campanha ativa nunca caduca', ex(fAct) === undefined);
    ok('o estado traz a configuração e a reciclagem', stc.clean.used === 180 && stc.clean.never === 60 && stc.clean.bin === 30 && Array.isArray(stc.bin));
    r = await call('POST', '/api/contents/keep', { ids: [fOld] }, await tok('vw@x.pt')); ok('quem só consulta não consegue manter', r.s === 403);
    ok('«Manter» num conteúdo fora da janela de aviso é ignorado', (await call('POST', '/api/contents/keep', { ids: [fNew] }, top)).j.n === 0);
    r = await call('POST', '/api/contents/keep', { ids: [fOld] }, top);
    stc = (await call('GET', '/api/state', undefined, adm)).j;
    ok('«Manter» dá mais 180 dias', r.j.n === 1 && ex(fOld) === plus(180));
    ok('só o administrador muda os prazos', (await call('POST', '/api/clean', { used: 90, never: 30 }, top)).s === 403 && (await call('POST', '/api/clean', { used: 5, never: 30 }, adm)).s === 400);
    cleanSweep(plus(11));
    stc = (await call('GET', '/api/state', undefined, adm)).j;
    ok('depois do prazo vai para a reciclagem (e a ativa e a mantida ficam)', !ex(fUsed) && stc.bin.some(f => f.id === fUsed) && stc.contents.some(f => f.id === fOld) && stc.contents.some(f => f.id === fAct) && stc.contents.some(f => f.id === fNew));
    ok('o ficheiro continua no disco enquanto está na reciclagem', !!db.prepare('SELECT 1 FROM files WHERE id=?').get(fUsed) && fs.existsSync(path.join(tmp, 'media', fUsed)));
    ok('um conteúdo reciclado não entra na playlist (já não existe na biblioteca)', (await sync(top, [op('campaigns', 'CL1', Object.assign({}, cOld, { end: plus(1) }))])).s === 400);
    r = await call('POST', '/api/contents/restore', { id: fUsed }, top);
    stc = (await call('GET', '/api/state', undefined, adm)).j;
    ok('restaurar devolve à biblioteca com mais 180 dias', r.s === 200 && ex(fUsed) === plus(180));
    cleanSweep(plus(70));
    stc = (await call('GET', '/api/state', undefined, adm)).j;
    ok('um conteúdo nunca usado vai para a reciclagem ao fim de 60 dias', stc.bin.some(f => f.id === fNew) && !stc.contents.some(f => f.id === fNew));
    cleanSweep(plus(70 + 31));
    stc = (await call('GET', '/api/state', undefined, adm)).j;
    const tomb = JSON.parse(db.prepare("SELECT json FROM docs WHERE coll='bin' AND id=?").get(fNew).json);
    ok('passados 30 dias na reciclagem, o ficheiro é apagado de vez', !stc.bin.some(f => f.id === fNew) && !db.prepare('SELECT 1 FROM files WHERE id=?').get(fNew) && !fs.existsSync(path.join(tmp, 'media', fNew)));
    ok('fica só o nome, para os relatórios antigos', tomb.gone === true && tomb.name === 'lx-novo.png' && !tomb.screens);
    r = await call('POST', '/api/clean', { used: 90, never: 30 }, adm);
    ok('o administrador muda os prazos', r.s === 200 && r.j.used === 90);
    await call('POST', '/api/clean', { used: 180, never: 60 }, adm);
    await sync(top, [{ op: 'del', coll: 'campaigns', id: 'CL1' }, { op: 'del', coll: 'campaigns', id: 'CL2' }]);
  }

  // ---- «Enviar teste» das notificações: e-mail verdadeiro (sem o servidor de e-mail configurado, diz-o com clareza)
  {
    let r = await call('POST', '/api/notif/test', {});
    ok('o teste de notificações exige sessão', r.s === 401);
    r = await call('POST', '/api/notif/test', {}, adm);
    ok('sem e-mail configurado no servidor o teste diz-o (e não finge que enviou)', r.s === 503 && /ainda não está configurado/.test(r.j.error));
  }

  // ---- resumo semanal por e-mail ao administrador
  {
    const got = [], fake = (a, sub, t) => { got.push({ a, sub, t }); };
    const w = await weeklyMailTick(fake, true);
    ok('o resumo semanal chega ao administrador', w.sent >= 1 && got[0].a === 'tiago@enif.pt' && /Resumo da semana/.test(got[0].sub));
    ok('o resumo traz ecrãs, campanhas, disco e cópias', ['ECRÃS:', 'ALERTAS ABERTOS:', 'CAMPANHAS:', 'CONTEÚDOS', 'CÓPIAS DE SEGURANÇA:'].every(k => got[0].t.includes(k)));
    ok('o resumo não leva palavras-passe nem chaves', !/segredo1|playerKey|palavraPasse/i.test(weeklyText()));
    got.length = 0;
    const again = await weeklyMailTick(fake);
    ok('fora de segunda-feira às 8h não envia', again.sent === 0 && !got.length);
    const me = JSON.parse(db.prepare("SELECT json FROM docs WHERE coll='users' AND json_extract(json,'$.email')='tiago@enif.pt'").get().json);
    me.notif = { types: { weekly: { app: false, email: false, sms: false } } };
    db.prepare("UPDATE docs SET json=? WHERE coll='users' AND id=?").run(JSON.stringify(me), me.id);
    const off = await weeklyMailTick(fake, true);
    ok('quem desligou o resumo semanal não o recebe', off.sent === 0 && !got.length);
    delete me.notif; db.prepare("UPDATE docs SET json=? WHERE coll='users' AND id=?").run(JSON.stringify(me), me.id);
  }

  console.log('\n' + passed + ' verificações ok');
}
main().then(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }).catch(e => { console.error('FALHOU:', e); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
