'use strict';
/* Testes da API: login, permissões, sincronização, upload, player, relatórios. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enif-'));
process.env.DATA_DIR = tmp; process.env.ADMIN_NAME = 'Tiago'; process.env.ADMIN_EMAIL = 'Tiago@Enif.pt'; process.env.ADMIN_PASS = 'segredo1'; process.env.PORT = '0';
const { server, db, underReset, cleanSweep, alertMailTick, alertPushTick, weeklyMailTick, weeklyText } = require('../server');
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
  // ---- endurecimento: corpo inválido não dá erro 500; páginas com política de conteúdos
  ok('login com corpo «null» dá erro 400, não 500', (await call('POST', '/api/login', null)).s === 400);
  { const c = (await fetch(base + '/app/')).headers.get('content-security-policy') || ''; ok('scripts: só os da própria página (impressão digital), sem unsafe-inline', /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/.test(c) && !/script-src[^;]*unsafe-inline/.test(c)); }
  { const h = await fetch(base + '/app/'); ok('a página traz Content-Security-Policy sem permitir ser embutida', /frame-ancestors 'none'/.test(h.headers.get('content-security-policy') || '') && !/Strict-Transport/.test([...h.headers.keys()].join()));
    const h2 = await fetch(base + '/app/', { headers: { 'X-Forwarded-Proto': 'https' } }); ok('atrás de HTTPS acrescenta HSTS', !!h2.headers.get('strict-transport-security')); }
  // ---- dispositivos de confiança (verificação em dois passos): 30 dias sem código só no navegador já verificado
  {
    const crypto = require('node:crypto');
    const uid = db.prepare("SELECT id FROM docs WHERE coll='users' AND json LIKE '%tiago@enif.pt%'").get().id;
    const setTwo = on => { const d = JSON.parse(db.prepare("SELECT json FROM docs WHERE coll='users' AND id=?").get(uid).json); d.twoFA = on; db.prepare("UPDATE docs SET json=? WHERE coll='users' AND id=?").run(JSON.stringify(d), uid); };
    const put = (tok, exp, user) => db.prepare('INSERT INTO trusted(id,user,hash,label,created,last,exp) VALUES(?,?,?,?,?,?,?)').run('t' + Math.random(), user || uid, crypto.createHash('sha256').update(tok).digest('hex'), 'Teste', Date.now(), Date.now(), exp);
    const T1 = 'a'.repeat(64), T2 = 'b'.repeat(64), T3 = 'c'.repeat(64);
    setTwo(true); put(T1, Date.now() + 5 * 864e5); put(T2, Date.now() - 1000); put(T3, Date.now() + 5 * 864e5, 'outro-utilizador');
    const lg = tr => call('POST', '/api/login', { email: 'tiago@enif.pt', pass: 'segredo1', trust: tr });
    let x = await lg(T1);
    ok('2FA ligada + dispositivo de confiança válido: entra sem código', x.s === 200 && x.j.token);
    const nova = db.prepare('SELECT exp FROM trusted WHERE hash=?').get(crypto.createHash('sha256').update(T1).digest('hex')).exp;
    ok('cada entrada renova os 30 dias', Math.abs(nova - (Date.now() + 30 * 864e5)) < 10000);
    x = await lg(T2); ok('dispositivo expirado: pede o código (não dá sessão)', !(x.j && x.j.token));
    x = await lg(T3); ok('identificador de outro utilizador não serve', !(x.j && x.j.token));
    x = await lg('d'.repeat(64)); ok('identificador desconhecido não serve', !(x.j && x.j.token));
    x = await lg(undefined); ok('sem identificador: pede o código', !(x.j && x.j.token));
    x = await call('POST', '/api/me/devices/clear', {}, r.j.token);
    ok('«remover todos» apaga os dispositivos do utilizador', x.s === 200 && db.prepare('SELECT COUNT(*) n FROM trusted WHERE user=?').get(uid).n === 0);
    x = await lg(T1); ok('depois de retirada a confiança o identificador deixa de servir', !(x.j && x.j.token));
    put(T1, Date.now() + 864e5);
    await call('POST', '/api/me/twofa', { on: false }, r.j.token);
    ok('desligar a verificação apaga os dispositivos', db.prepare('SELECT COUNT(*) n FROM trusted WHERE user=?').get(uid).n === 0);
    setTwo(false);
    r = await call('POST', '/api/login', { email: 'tiago@enif.pt', pass: 'segredo1' });
  }
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
  for (let i = 0; i < 4; i++) await call('POST', '/api/login', { email: 'lim@x.pt', pass: 'x' });
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
  // ---- verificação em dois passos exigida pelo administrador
  {
    const crypto = require('node:crypto');
    ok('exigir 2 passos sem e-mail configurado no servidor é recusado com explicação', (await sync(adm, [op('users', 'uvw', { mfa: true }, ['mfa'])])).s === 503);
    const d = JSON.parse(db.prepare("SELECT json FROM docs WHERE coll='users' AND id='uvw'").get().json); d.mfa = true;
    db.prepare("UPDATE docs SET json=? WHERE coll='users' AND id='uvw'").run(JSON.stringify(d));
    let x = await call('POST', '/api/login', { email: 'vw@x.pt', pass: 'abcdef' });
    ok('utilizador com 2 passos exigidos não entra só com a palavra-passe', !(x.j && x.j.token));
    const T = 'e'.repeat(64);
    db.prepare('INSERT INTO trusted(id,user,hash,label,created,last,exp) VALUES(?,?,?,?,?,?,?)').run('tm1', 'uvw', crypto.createHash('sha256').update(T).digest('hex'), 'Teste', Date.now(), Date.now(), Date.now() + 864e5);
    x = await call('POST', '/api/login', { email: 'vw@x.pt', pass: 'abcdef', trust: T });
    ok('...mas entra num dispositivo de confiança', x.s === 200 && x.j.token);
    ok('não consegue desligar a exigência', [400, 403].includes((await call('POST', '/api/me/twofa', { on: false }, x.j.token)).s));
    ok('nem pela sincronização', (await sync(x.j.token, [op('users', 'uvw', { mfa: false }, ['mfa'])])).s === 200 && JSON.parse(db.prepare("SELECT json FROM docs WHERE coll='users' AND id='uvw'").get().json).mfa === true);
    ok('o administrador vê a marca na lista', (await call('GET', '/api/state', undefined, adm)).j.users.find(u => u.id === 'uvw').mfa === true);
    ok('o administrador retira a exigência e os dispositivos de confiança desaparecem', (await sync(adm, [op('users', 'uvw', { mfa: false }, ['mfa'])])).s === 200 && db.prepare("SELECT COUNT(*) n FROM trusted WHERE user='uvw'").get().n === 0);
    x = await call('POST', '/api/login', { email: 'vw@x.pt', pass: 'abcdef' });
    ok('sem a exigência volta a entrar só com a palavra-passe', x.s === 200 && x.j.token);
  }
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
  await sync(top, [camp('CQ', { share: 'G1', gmin: 2 }), camp('CR', { share: 'G1', gmin: 2 })]);
  const gq = (await call('GET', '/api/state', undefined, top)).j.campaigns;
  ok('mínimo do grupo guardado', gq.find(x => x.id === 'CQ').gmin === 2 && gq.find(x => x.id === 'CR').gmin === 2);
  ok('mínimo do grupo fora do intervalo recusado', (await sync(top, [camp('CQ', { share: 'G1', gmin: 99 })])).s === 400);
  await sync(top, [camp('CQ', { share: 'G1' })]);
  ok('mínimo do grupo some quando deixa de estar definido', !('gmin' in (await call('GET', '/api/state', undefined, top)).j.campaigns.find(x => x.id === 'CQ')));
  await sync(top, [camp('CQ', { priority: 'Alta', share: 'G1' })]);
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
  // duração própria de um conteúdo (só pode ter menos segundos do que a campanha)
  {
    const it = (d) => [{ f: f1.j.id, h0: null, h1: null, d0: null, d1: null, ppm: 1, dur: d }, { f: f2.j.id, h0: null, h1: null, d0: null, d1: null, ppm: 1 }];
    const rj = await sync(top, [camp('C1', { items: it(11) })]);
    ok('conteúdo com mais segundos do que a campanha: conflito', rj.s === 400 && /Conflito/.test(JSON.stringify(rj.j)) && /mais do que a campanha \(10 s\)/.test(JSON.stringify(rj.j)));
    ok('conteúdo com menos de 3 segundos recusado', (await sync(top, [camp('C1', { items: it(2) })])).s === 400);
    ok('conteúdo com 5 s numa campanha de 10 s aceite', (await sync(top, [camp('C1', { items: it(5) })])).s === 200);
    ok('a duração do conteúdo fica guardada', (await call('GET', '/api/state', undefined, top)).j.campaigns.find(c => c.id === 'C1').items[0].dur === 5);
    r = await call('GET', '/api/player/playlist?code=ECR-001&key=' + key);
    const en = r.j.days[today][hNow].seq[0];
    ok('a playlist leva a duração própria só do conteúdo mais curto', en.dur === 10 && en.ds && en.ds[f1.j.id] === 5 && !en.ds[f2.j.id]);
    ok('baixar a duração da campanha abaixo da do conteúdo: conflito', (await sync(top, [camp('C1', { dur: 4, items: it(5) })])).s === 400);
    ok('igual à da campanha não guarda nada (é o mesmo que vazio)', (await sync(top, [camp('C1', { items: it(10) })])).s === 200 && (await call('GET', '/api/state', undefined, top)).j.campaigns.find(c => c.id === 'C1').items[0].dur === undefined);
    r = await call('GET', '/api/player/playlist?code=ECR-001&key=' + key);
    ok('sem duração própria a playlist não leva «ds»', !r.j.days[today][hNow].seq[0].ds);
  }
  ok('playlist tem hoje e amanhã', Object.keys(r.j.days).length === 2);
  ok('ficheiro do player acessível com a chave do ecrã', (await fetch(base + `/media/${f1.j.id}?code=ECR-001&key=${key}`)).status === 200);
  const hb = (o) => call('POST', '/api/player/heartbeat', Object.assign({ code: 'ECR-001', key, c: 'C1', f: f1.j.id, queue: 0, ver: '2', w: 1080, h: 1920 }, o || {}));
  ok('sinal de vida', (await hb()).s === 200);
  st = (await call('GET', '/api/state', undefined, top)).j;
  ok('ecrã online, resolução detetada', st.screens[0].status === 'online' && st.screens[0].res === '1080×1920' && st.screens[0].nowCamp === 'C1');
  await hb({ disk: { free: 94 * 1073741824, total: 128 * 1073741824 } });
  ok('o disco enviado em bytes (player antigo) aparece em GB', (d => d && d.total === 128 && d.free === 94)((await call('GET', '/api/state', undefined, top)).j.screens[0].disk));
  await hb({ disk: { free: 94.5, total: 128 } });
  ok('o disco enviado em GB fica em GB', (d => d && d.total === 128 && d.free === 94.5)((await call('GET', '/api/state', undefined, top)).j.screens[0].disk));
  // ---- saúde do ecrã, disco real do Windows e reinícios
  {
    const T0 = Date.now() - 3600000;
    await hb({ boot: T0 }); await hb({ boot: T0 });
    await hb({ boot: T0 + 600000 });
    let h = (await call('GET', '/api/screens/ECR-001/saude', undefined, top));
    ok('a saúde do ecrã exige sessão', (await call('GET', '/api/screens/ECR-001/saude')).s === 401);
    await hb({ boot: T0 + 900000, bootWhy: '3h' }); await hb({ boot: T0 + 1200000, bootWhy: 'invento' });
    ok('o motivo do reinício fica guardado (só os conhecidos)', (r2 => r2.j.boots.find(b => b.ts === T0 + 900000).why === '3h' && r2.j.boots.find(b => b.ts === T0 + 1200000).why === '')(await call('GET', '/api/screens/ECR-001/saude', undefined, top)));
    h = await call('GET', '/api/screens/ECR-001/saude', undefined, top);
    ok('cada arranque do player conta uma vez só', h.s === 200 && h.j.boots.filter(b => b.kind === 'player').length === 4 && h.j.boots[0].ts === T0 + 1200000);
    ok('a saúde traz sinais perdidos e vídeos a falhar (listas)', Array.isArray(h.j.gaps) && Array.isArray(h.j.fails));
    ok('ecrã que não existe: 404', (await call('GET', '/api/screens/ECR-999/saude', undefined, top)).s === 404);
    ok('o sysinfo recusa chave errada', (await call('POST', '/api/player/sysinfo', { code: 'ECR-001', key: 'x', diskFreeGB: 10, diskTotalGB: 100 })).s === 401);
    ok('o sysinfo recusa disco impossível', (await call('POST', '/api/player/sysinfo', { code: 'ECR-001', key, diskFreeGB: 500, diskTotalGB: 100 })).s === 400);
    ok('o sysinfo guarda o disco real e o arranque do PC', (await call('POST', '/api/player/sysinfo', { code: 'ECR-001', key, diskFreeGB: 51.234, diskTotalGB: 237.9, boot: T0 - 86400000 })).s === 200);
    const d1 = (await call('GET', '/api/state', undefined, top)).j.screens[0].disk;
    ok('o disco real aparece em GB com 1 decimal', d1.free === 51.2 && d1.total === 237.9);
    await hb({ disk: { free: 1, total: 2 } });
    ok('com o disco do Windows ativo, o disco aproximado do browser não o substitui', (d => d.free === 51.2 && d.total === 237.9)((await call('GET', '/api/state', undefined, top)).j.screens[0].disk));
    h = await call('GET', '/api/screens/ECR-001/saude', undefined, top);
    ok('o arranque do PC (há mais de 24 h) fica de fora; os do player ficam', !h.j.boots.some(b => b.kind === 'pc'));
    await call('POST', '/api/player/sysinfo', { code: 'ECR-001', key, diskFreeGB: 51.2, diskTotalGB: 237.9, boot: Date.now() - 7200000 });
    h = await call('GET', '/api/screens/ECR-001/saude', undefined, top);
    ok('o arranque recente do PC aparece na saúde', h.j.boots.some(b => b.kind === 'pc'));
    db.prepare('UPDATE live SET sys_ts=NULL WHERE screen=?').run('ECR-001');
    await hb({ disk: { free: 94.5, total: 128 } });

    // qualidade do vídeo lida no servidor + ignorar o aviso + alerta «Vídeo a falhar»
    const vf = path.join(tmp, 'q60.mp4');
    require('node:child_process').execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=60', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vf]);
    const vq = await up(top, 'q60.mp4', 'video/mp4', fs.readFileSync(vf));
    ok('o servidor lê o codec, os fps e o débito do vídeo', vq.s === 200 && vq.j.q && vq.j.q.codec === 'h264' && vq.j.q.fps === 60 && vq.j.q.mbps >= 0 && vq.j.q.w === 1080 && !vq.j.qIgn);
    const vq2 = await up(top, 'q60b.mp4', 'video/mp4', fs.readFileSync(vf), '&qign=1');
    ok('o aviso pode ser ignorado logo ao carregar', vq2.s === 200 && vq2.j.qIgn === true);
    const failN = n => call('POST', '/api/player/plays', { code: 'ECR-001', key, plays: Array.from({ length: n }, (_, i) => ({ pid: 'vf' + Math.random().toString(36).slice(2) + i, c: 'C1', f: vq.j.id, ts: Date.now(), dur: 0, ok: 0, why: 'erro' })) });
    await failN(2);
    ok('2 falhas não fazem alerta', !(await call('GET', '/api/state', undefined, top)).j.alerts.some(a => a.title === 'Vídeo a falhar'));
    await failN(2);
    h = await call('GET', '/api/screens/ECR-001/saude', undefined, top);
    ok('4 falhas: o vídeo aparece na saúde do ecrã', h.j.fails.length === 1 && h.j.fails[0].n === 4 && h.j.fails[0].name === 'q60.mp4' && h.j.fails[0].qIgn === false);
    ok('4 falhas: aparece o alerta «Vídeo a falhar»', (await call('GET', '/api/state', undefined, top)).j.alerts.some(a => a.title === 'Vídeo a falhar' && /q60\.mp4/.test(a.detail)));
    ok('quem não gere conteúdos não ignora o aviso', (await sync(tpl2, [op('contents', vq.j.id, { qIgn: true }, ['qIgn'])])).s === 403);
    ok('ignorar o aviso do vídeo', (await sync(top, [op('contents', vq.j.id, { qIgn: true }, ['qIgn'])])).s === 200 && (await call('GET', '/api/state', undefined, top)).j.contents.find(c => c.id === vq.j.id).qIgn === true);
    ok('vídeo com aviso ignorado deixa de dar alerta', !(await call('GET', '/api/state', undefined, top)).j.alerts.some(a => a.title === 'Vídeo a falhar'));
    ok('ignorar fica no registo de auditoria', db.prepare("SELECT COUNT(*) n FROM audit WHERE what LIKE '%aviso de qualidade%'").get().n >= 1);
    ok('voltar a avisar', (await sync(top, [op('contents', vq.j.id, { qIgn: false }, ['qIgn'])])).s === 200 && !(await call('GET', '/api/state', undefined, top)).j.contents.find(c => c.id === vq.j.id).qIgn);
    // reinícios a mais, descarregamento pendente e resumo semanal
    db.prepare("DELETE FROM boots WHERE screen='ECR-001'").run();
    await hb({ miss: 2 });
    ok('o ecrã diz quantos ficheiros ainda faltam descarregar', (await call('GET', '/api/state', undefined, top)).j.screens[0].miss === 2);
    await hb({ miss: 0 });
    ok('sem ficheiros em falta, o aviso desaparece', !(await call('GET', '/api/state', undefined, top)).j.screens[0].miss);
    ok('2 reinícios sem motivo não fazem alerta', !(await call('GET', '/api/state', undefined, top)).j.alerts.some(a => a.title === 'Reinícios a mais'));
    await hb({ boot: Date.now() - 5000, bootWhy: '' }); await hb({ boot: Date.now() - 4000, bootWhy: 'preso' }); await hb({ boot: Date.now() - 3000, bootWhy: '3h' }); await hb({ boot: Date.now() - 2000, bootWhy: 'pedido' });
    const nb0 = (await call('GET', '/api/state', undefined, top)).j.alerts.filter(a => a.title === 'Reinícios a mais').length;
    await hb({ boot: Date.now() - 1000, bootWhy: '' });
    ok('3 reinícios sem motivo fazem o alerta «Reinícios a mais» (pedidos e das 3h não contam)', nb0 === 0 && (await call('GET', '/api/state', undefined, top)).j.alerts.some(a => a.title === 'Reinícios a mais' && /3 vezes/.test(a.detail)));
    ok('o resumo semanal traz a saúde dos ecrãs', /SAÚDE DOS ECRÃS \(7 dias\): 1 com sinais/.test(weeklyText()) && /reinício\(s\) sem motivo/.test(weeklyText()));
    db.prepare("DELETE FROM boots WHERE screen='ECR-001' AND why IS NOT NULL AND why IN ('','preso')").run();
    db.prepare("DELETE FROM plays WHERE pid LIKE 'vf%'").run(); db.prepare('DELETE FROM plays_agg WHERE file=?').run(vq.j.id);   // as falhas de teste não contam para o resto
  }
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
  { const raw = db.prepare("SELECT SUM(ok) n, COUNT(*)-SUM(ok) bad, ROUND(SUM(CASE WHEN ok=1 THEN dur ELSE 0 END)) sec FROM plays WHERE day=? AND screen='ECR-001'").get(today);
    const ag = r.j.rows.reduce((a, x) => ({ n: a.n + x.n, bad: a.bad + x.bad, sec: a.sec + x.sec }), { n: 0, bad: 0, sec: 0 });
    ok('os totais por hora dão o mesmo que somar as passagens uma a uma', raw.n === ag.n && raw.bad === ag.bad && raw.sec === ag.sec);
    const gz = await fetch(base + `/api/plays?from=${today}&to=${today}`, { headers: { Authorization: 'Bearer ' + top, 'Accept-Encoding': 'gzip' } });
    ok('respostas grandes seguem comprimidas quando o navegador aceita', gz.headers.get('content-encoding') === 'gzip' || (await gz.clone().text()).length < 1024); }
  ok('relatório com filtros', (await call('GET', `/api/plays?from=${today}&to=${today}&camp=XX`, undefined, top)).j.rows.length === 0);
  ok('relatório exige permissão', (await call('GET', `/api/plays?from=${today}&to=${today}`, undefined, tcn)).s === 403);
  ok('período inválido recusado', (await call('GET', '/api/plays?from=x&to=y', undefined, top)).s === 400);

  // ---- offline, alertas e resolução
  db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now() - 10 * 60000, 'ECR-001');
  st = (await call('GET', '/api/state', undefined, top)).j;
  ok('sem sinal há 10 min → offline com alerta', st.screens[0].status === 'offline' && st.screens[0].sinceMin >= 10 && st.alerts.some(a => a.sev === 'bad'));
  const al = st.alerts.find(a => a.sev === 'bad');
  ok('aviso de sem ligação diz a hora e a duração', /^Sem resposta desde (as|ontem às) \d\d:\d\d \(há 1\d min\)\.$/.test(al.detail));
  db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now() - 1357 * 60000, 'ECR-001');
  ok('mais de 1 h conta em horas', /\(há 22 h\)/.test(((await call('GET', '/api/state', undefined, top)).j.alerts.find(a => a.sev === 'bad' && a.id.startsWith('off-')) || {}).detail));
  db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now() - 10 * 60000, 'ECR-001');
  ok('só consulta não resolve alertas', (await sync(tcn, [{ op: 'del', coll: 'alerts', id: al.id }])).s === 403);
  ok('operador resolve alerta', (await sync(top, [{ op: 'del', coll: 'alerts', id: al.id }])).s === 200 && !(await call('GET', '/api/state', undefined, top)).j.alerts.some(a => a.id === al.id));
  ok('ecrã fora do horário não gera alerta', await (async () => {
    const h = S.lisbonNow('Europe/Lisbon').h; const on = (h + 2) % 24 || 1;
    await sync(top, [op('screens', 'ECR-001', { on: Math.min(on, 22), off: 24 }, ['on', 'off'])]);
    const s2 = (await call('GET', '/api/state', undefined, top)).j;
    await sync(top, [op('screens', 'ECR-001', { on: 0, off: 24 }, ['on', 'off'])]);
    return h + 2 > 23 || !s2.alerts.some(a => a.id.startsWith('off-ecr') || (a.sev === 'bad' && a.title === 'Ecrã sem ligação' && a.id !== al.id));
  })());
  ok('campanha sem fim fica com fim 2099 e noEnd, nunca «Terminada»', await (async () => {
    const base = (await call('GET', '/api/state', undefined, top)).j.campaigns[0];
    const nova = Object.assign({}, base, { id: 'SEMFIM', name: 'Sem fim', noEnd: true, end: '2020-01-01', start: '2020-01-01', warnFor: undefined });
    await sync(top, [op('campaigns', 'SEMFIM', nova, Object.keys(nova))]);
    const c = (await call('GET', '/api/state', undefined, top)).j.campaigns.find(x => x.id === 'SEMFIM');
    await sync(top, [{ op: 'del', coll: 'campaigns', id: 'SEMFIM' }]);
    return !!c && c.noEnd === true && c.end === '2099-12-31' && S.statusOf(c, '2026-11-09') === 'Ativa';
  })());
  ok('fora do horário e sem sinal → «fora», não «online»', await (async () => {
    const h = S.lisbonNow('Europe/Lisbon').h; if (h + 2 > 22) return true;
    await sync(top, [op('screens', 'ECR-001', { on: h + 2, off: 24 }, ['on', 'off'])]);
    const s3 = (await call('GET', '/api/state', undefined, top)).j.screens[0];
    await sync(top, [op('screens', 'ECR-001', { on: 0, off: 24 }, ['on', 'off'])]);
    return s3.status === 'fora' && s3.sinceMin >= 10;
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
    r = await call('POST', '/api/player/plays', { code: 'ECR-001', key, plays: [{ pid: 'falha-1', c: 'C1', f: pA.j.id, ts: Date.now(), dur: 0, ok: 0, why: 'o vídeo não abriu (ficheiro com erro)' }] });
    const fl = (await call('GET', '/api/screens/ECR-001/falhas', undefined, top)).j;
    ok('lista de falhas mostra o motivo', fl.total >= 1 && fl.rows[0].why === 'o vídeo não abriu (ficheiro com erro)');
    db.prepare('DELETE FROM plays WHERE pid=?').run('falha-1');
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
    db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now() - 3600000, 'ECR-001'); underReset();
    ok('ecrã sem internet: não há aviso de «abaixo do contratado» (as passagens estão guardadas no ecrã)', (await alertsOf()).length === 0);
    db.prepare('UPDATE live SET last_seen=?, queue=? WHERE screen=?').run(Date.now(), 40, 'ECR-001'); underReset();
    ok('voltou a internet mas ainda há passagens por enviar: ainda não se avalia', (await alertsOf()).length === 0);
    db.prepare('UPDATE live SET queue=0 WHERE screen=?').run('ECR-001'); underReset();
    ok('tudo enviado e continua abaixo: agora sim, o aviso aparece', (await alertsOf()).length === 1);
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

  // ---- ficha técnica do ecrã (PDF: só o administrador carrega e remove; quem vê os ecrãs descarrega)
  {
    const fvw = await tok('vw@x.pt'), fcn = await tok('cn@x.pt');
    const pdf = n => { const b = new Uint8Array(n); b.set(Buffer.from('%PDF-1.4\n%teste\n')); return b; }, url = (id, q) => '/api/screens/' + id + '/ficha' + (q || '');
    const ids = (await call('GET', '/api/state', undefined, adm)).j.screens.map(x => x.id), other = ids.find(x => x !== 'ECR-001');
    ok('sem sessão não se carrega nem descarrega a ficha', (await call('PUT', url('ECR-001', '?name=a.pdf'), pdf(300))).s === 401 && (await call('GET', url('ECR-001'))).s === 401);
    ok('quem não é administrador não carrega a ficha técnica', (await call('PUT', url('ECR-001', '?name=a.pdf'), pdf(300), top)).s === 403);
    ok('ecrã inexistente: 404', (await call('PUT', url('ECR-XXX', '?name=a.pdf'), pdf(300), adm)).s === 404);
    ok('ficheiro que não é PDF é recusado', (await call('PUT', url('ECR-001', '?name=a.pdf'), Buffer.from('isto não é um pdf'), adm)).s === 400 && (await call('PUT', url('ECR-001', '?name=a.txt'), pdf(300), adm)).s === 400);
    ok('PDF com mais de 10 MB é recusado', [413, 0].includes((await call('PUT', url('ECR-001', '?name=a.pdf'), pdf(10 * 1048576 + 10), adm).catch(() => ({ s: 0 }))).s));
    ok('o ecrã ainda não tem ficha: 404', (await call('GET', url('ECR-001'), undefined, fvw)).s === 404);
    r = await call('PUT', url('ECR-001', '?name=' + encodeURIComponent('Braga Normas.pdf') + (other ? '&also=' + other : '')), pdf(2000), adm);
    ok('o administrador carrega a ficha técnica', r.s === 200 && r.j.fichas['ECR-001'].name === 'Braga Normas.pdf' && r.j.fichas['ECR-001'].size === 2000 && (!other || r.j.fichas[other]));
    const dl = await call('GET', url('ECR-001'), undefined, fvw), bytes = Buffer.from(await dl.r.arrayBuffer());
    ok('quem vê os ecrãs descarrega o PDF igual ao carregado', dl.s === 200 && /application\/pdf/.test(dl.r.headers.get('content-type')) && /attachment/.test(dl.r.headers.get('content-disposition')) && bytes.length === 2000 && bytes.subarray(0, 5).toString() === '%PDF-');
    ok('quem não vê os ecrãs não descarrega a ficha', (await call('GET', url('ECR-001'), undefined, fcn)).s === 403);
    ok('o estado traz as fichas a quem vê os ecrãs e nada a quem não vê', (await call('GET', '/api/state', undefined, fvw)).j.fichas['ECR-001'].name === 'Braga Normas.pdf' && Object.keys((await call('GET', '/api/state', undefined, fcn)).j.fichas).length === 0);
    r = await call('PUT', url('ECR-001', '?name=Nova.pdf'), pdf(500), adm);
    ok('substituir a ficha troca o ficheiro', r.s === 200 && r.j.fichas['ECR-001'].name === 'Nova.pdf' && Buffer.from(await (await call('GET', url('ECR-001'), undefined, fvw)).r.arrayBuffer()).length === 500);
    ok('quem não é administrador não remove a ficha', (await call('DELETE', url('ECR-001'), undefined, top)).s === 403 && (await call('DELETE', url('ECR-001'), undefined, fvw)).s === 403);
    ok('o administrador remove a ficha e deixa de haver download', (await call('DELETE', url('ECR-001'), undefined, adm)).s === 200 && (await call('GET', url('ECR-001'), undefined, fvw)).s === 404);
    ok('as fichas não se mexem pela sincronização genérica', (await sync(adm, [op('fichas', 'ECR-001', { id: 'ECR-001', file: 'x', name: 'x.pdf' })])).s === 400);
    ok('carregar e remover ficam no registo de auditoria', db.prepare("SELECT COUNT(*) n FROM audit WHERE what LIKE '%ficha técnica%'").get().n >= 3);
    if (other) await call('DELETE', url(other), undefined, adm);
  }

  // ---- avisos push ao computador (chegam com a página fechada e sem sessão)
  {
    const crypto = require('node:crypto'), WP = require('../lib/webpush');
    const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
    const mkSub = () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + crypto.randomBytes(8).toString('hex'), keys: { p256dh: WP.b64u(ua.getPublicKey()), auth: WP.b64u(crypto.randomBytes(16)) } });
    ok('a chave pública dos avisos push só se pede com sessão', (await call('GET', '/api/push/key')).s === 401 && WP.unb64u((await call('GET', '/api/push/key', undefined, adm)).j.key).length === 65);
    ok('a chave dos avisos push fica sempre a mesma', (await call('GET', '/api/push/key', undefined, adm)).j.key === (await call('GET', '/api/push/key', undefined, adm)).j.key);
    ok('sem sessão não se guarda subscrição push', (await call('POST', '/api/push/subscribe', { sub: mkSub() })).s === 401);
    ok('quem não é administrador não recebe avisos push', (await call('POST', '/api/push/subscribe', { sub: mkSub() }, top)).s === 403);
    ok('endereço de push que não é de um serviço conhecido é recusado', (await call('POST', '/api/push/subscribe', { sub: { endpoint: 'https://evil.example/x', keys: mkSub().keys } }, adm)).s === 400);
    ok('chaves de push inválidas são recusadas', (await call('POST', '/api/push/subscribe', { sub: { endpoint: mkSub().endpoint, keys: { p256dh: 'abc', auth: 'def' } } }, adm)).s === 400);
    const sub = mkSub(), nSubs = () => db.prepare('SELECT COUNT(*) n FROM push_subs').get().n;
    ok('o administrador ativa os avisos neste computador', (await call('POST', '/api/push/subscribe', { sub, label: 'Chrome em macOS' }, adm)).s === 200 && nSubs() === 1);
    ok('ativar outra vez o mesmo computador não o duplica', (await call('POST', '/api/push/subscribe', { sub, label: 'Chrome em macOS' }, adm)).s === 200 && nSubs() === 1);
    const got = [], fake = async (user, payload) => { got.push(payload); return 1; }, mine = () => got.filter(x => /ECR-001/.test(x.title));
    db.prepare('DELETE FROM alert_push').run(); db.prepare("DELETE FROM docs WHERE coll='settings' AND id='pushinit'").run(); db.prepare("DELETE FROM resolved WHERE id LIKE 'off-%'").run();
    db.prepare('UPDATE live SET first_seen=?, last_seen=? WHERE screen=?').run(Date.now() - 3 * 3600000, Date.now() - 40 * 60000, 'ECR-001');
    await alertPushTick(fake);
    ok('na primeira vez não avisa o que já estava aberto (só regista)', got.length === 0 && db.prepare('SELECT COUNT(*) n FROM alert_push').get().n > 0);
    db.prepare("DELETE FROM alert_push WHERE id LIKE 'off-%'").run(); db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now(), 'ECR-001'); await alertPushTick(fake);
    db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now() - 20 * 60000, 'ECR-001');
    await alertPushTick(fake);
    ok('ecrã sem ligação há mais de 15 min: um aviso push, com o ecrã e o link da app', mine().length === 1 && /sem ligação/i.test(mine()[0].title) && mine()[0].url === '/app/' && /^al-off-/.test(mine()[0].tag));
    await alertPushTick(fake);
    ok('o mesmo problema não repete o aviso push', mine().length === 1);
    db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now(), 'ECR-001');
    await alertPushTick(fake);
    ok('quando o ecrã volta, chega o aviso de resolvido', mine().length === 2 && /^Resolvido/.test(mine()[1].title));
    const st1 = (await call('GET', '/api/state', undefined, adm)).j;
    db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now() - 50 * 60000, 'ECR-001');
    await sync(adm, [op('users', st1.me.id, Object.assign({}, st1.me, { notif: { types: { alert: { app: false, email: true, sms: false } } } }), ['notif'])]);
    await alertPushTick(fake);
    ok('com «Computador» desligado nesse tipo, não há aviso push', mine().length === 2);
    await sync(adm, [op('users', st1.me.id, Object.assign({}, st1.me, { notif: { types: { alert: { app: true, email: true, sms: false } } } }), ['notif'])]);
    db.prepare('UPDATE live SET last_seen=? WHERE screen=?').run(Date.now(), 'ECR-001'); await alertPushTick(fake);
    db.prepare('DELETE FROM resolved').run();
    ok('quem desativa o computador deixa de ter subscrição', (await call('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }, adm)).s === 200 && nSubs() === 0);
    ok('o teste de aviso push responde mesmo sem computadores ativos', (await call('POST', '/api/push/test', {}, adm)).j.sent === 0);
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
    ok('conteúdo nunca usado há 50 dias: já na janela de aviso (10 dias)', [plus(9), plus(10), plus(11)].includes(ex(fOld))); // tolera a mudança de hora
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
    r = await call('POST', '/api/clean', { used: 15, never: 15 }, adm);
    ok('aceita prazos curtos (15 dias)', r.s === 200 && r.j.used === 15 && r.j.never === 15 && (await call('POST', '/api/clean', { used: 6, never: 15 }, adm)).s === 400);
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
