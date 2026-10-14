'use strict';
/* Enif OOH – servidor. Sem dependências: só Node 22.13+. */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const S = require('./lib/schedule');

const PORT = +process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN = process.env.ADMIN_TOKEN || 'admin';
const TZ = process.env.TZ_NAME || 'Europe/Lisbon';
const ONLINE_MS = 150 * 1000;          // sem sinal de vida há mais de 2,5 min = offline
const PLAYER_VERSION = '1';            // mudar para obrigar os players a recarregar
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'enif.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS screens(id TEXT PRIMARY KEY, code TEXT UNIQUE, key TEXT, venue TEXT, spot TEXT, on_h REAL, off_h REAL, lim INTEGER DEFAULT 14, ord TEXT DEFAULT '[]', last_seen INTEGER, now_c TEXT, now_f TEXT, ver TEXT, queue INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, name TEXT, type TEXT, mime TEXT, dur REAL, size INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY, name TEXT, client TEXT, venues TEXT, start TEXT, end TEXT, h0 REAL, h1 REAL, ppm REAL, priority TEXT, manual INTEGER DEFAULT 0, items TEXT DEFAULT '[]', created INTEGER);
CREATE TABLE IF NOT EXISTS plays(pid TEXT PRIMARY KEY, screen TEXT, camp TEXT, file TEXT, ts INTEGER, dur REAL, ok INTEGER);
CREATE INDEX IF NOT EXISTS plays_ts ON plays(ts);
`);
const q = (sql, ...a) => db.prepare(sql).all(...a);
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
const campOut = r => Object.assign({}, r, { venues: JSON.parse(r.venues), items: JSON.parse(r.items) });

/* ---------- utilitários http ---------- */
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const fail = (res, code, msg) => send(res, code, { error: msg });
function readJson(req, limit = 1e6) {
  return new Promise((ok, ko) => {
    let n = 0; const b = [];
    req.on('data', c => { n += c.length; if (n > limit) { ko(new Error('Pedido demasiado grande')); req.destroy(); } else b.push(c); });
    req.on('end', () => { try { ok(b.length ? JSON.parse(Buffer.concat(b).toString('utf8')) : {}); } catch (e) { ko(new Error('JSON inválido')); } });
    req.on('error', ko);
  });
}
const isAdmin = req => {
  const t = String(req.headers['x-admin-token'] || '');
  const a = Buffer.from(t), b = Buffer.from(ADMIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
function screenAuth(code, key) {
  const s = q1('SELECT * FROM screens WHERE code=?', String(code || ''));
  if (!s) return null;
  const a = Buffer.from(String(key || '')), b = Buffer.from(s.key);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? s : null;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
function serveStatic(res, rel) {
  const root = path.join(__dirname, 'public');
  const f = path.normalize(path.join(root, rel));
  if (!f.startsWith(root + path.sep)) return fail(res, 403, 'Proibido');
  let p = f; if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) return fail(res, 404, 'Não encontrado');
  send(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || 'application/octet-stream');
}

/* ---------- playlist de um ecrã ---------- */
function playlistFor(scr) {
  const camps = q('SELECT * FROM campaigns').map(campOut);
  const now = S.lisbonNow(TZ), days = {}, used = {};
  [now.date, S.addDay(now.date, 1)].forEach(d => {
    days[d] = S.dayLoops(scr, camps, d);
    Object.values(days[d]).forEach(l => (l || []).forEach(e => e.items.forEach(f => { used[f] = 1; })));
  });
  const files = {};
  Object.keys(used).forEach(id => {
    const f = q1('SELECT * FROM files WHERE id=?', id);
    if (f) files[id] = { name: f.name, type: f.type, dur: f.dur, size: f.size, mime: f.mime };
  });
  Object.values(days).forEach(day => Object.keys(day).forEach(h => {   // retira vídeos que já não existem
    if (day[h]) day[h] = day[h].map(e => Object.assign(e, { items: e.items.filter(f => files[f]) })).filter(e => e.items.length);
  }));
  return { playerVersion: PLAYER_VERSION, tz: TZ, generated: Date.now(), screen: { code: scr.code, venue: scr.venue, spot: scr.spot }, days, files };
}

/* ---------- API do player ---------- */
async function playerApi(req, res, u) {
  const p = u.pathname;
  if (req.method === 'GET' && p === '/api/player/playlist') {
    const s = screenAuth(u.searchParams.get('code'), u.searchParams.get('key'));
    if (!s) return fail(res, 401, 'Código ou chave inválidos');
    return send(res, 200, playlistFor(s));
  }
  if (req.method === 'POST' && p === '/api/player/heartbeat') {
    const b = await readJson(req);
    const s = screenAuth(b.code, b.key); if (!s) return fail(res, 401, 'Código ou chave inválidos');
    run('UPDATE screens SET last_seen=?, now_c=?, now_f=?, ver=?, queue=? WHERE id=?', Date.now(), b.c || null, b.f || null, String(b.ver || ''), +b.queue || 0, s.id);
    return send(res, 200, { ok: true, serverTime: Date.now() });
  }
  if (req.method === 'POST' && p === '/api/player/plays') {
    const b = await readJson(req, 5e6);
    const s = screenAuth(b.code, b.key); if (!s) return fail(res, 401, 'Código ou chave inválidos');
    let n = 0; const ids = [];
    db.exec('BEGIN');
    try {
      (Array.isArray(b.plays) ? b.plays : []).slice(0, 2000).forEach(x => {
        if (!x || !x.pid) return;
        const r = run('INSERT OR IGNORE INTO plays(pid,screen,camp,file,ts,dur,ok) VALUES(?,?,?,?,?,?,?)', String(x.pid), s.id, String(x.c || ''), String(x.f || ''), +x.ts || Date.now(), +x.dur || 0, x.ok ? 1 : 0);
        n += Number(r.changes); ids.push(x.pid);
      });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    run('UPDATE screens SET last_seen=? WHERE id=?', Date.now(), s.id);
    return send(res, 200, { ok: true, saved: n, received: ids });
  }
  fail(res, 404, 'Não encontrado');
}
function media(req, res, u, id) {
  const s = screenAuth(u.searchParams.get('code'), u.searchParams.get('key'));
  if (!s && !(isAdmin(req) || u.searchParams.get('admin') === ADMIN)) return fail(res, 401, 'Sem acesso');
  const f = q1('SELECT * FROM files WHERE id=?', id), file = path.join(MEDIA, path.basename(id));
  if (!f || !fs.existsSync(file)) return fail(res, 404, 'Ficheiro não existe');
  const size = fs.statSync(file).size, r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const h = { 'Content-Type': f.mime || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
  if (r && (r[1] || r[2])) {
    let a = r[1] ? +r[1] : size - +r[2], b = r[1] && r[2] ? +r[2] : size - 1;
    if (a > b || a >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
    b = Math.min(b, size - 1);
    res.writeHead(206, Object.assign(h, { 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 }));
    return fs.createReadStream(file, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, Object.assign(h, { 'Content-Length': size }));
  fs.createReadStream(file).pipe(res);
}

/* ---------- API de administração ---------- */
const todayStart = () => { const n = S.lisbonNow(TZ), d = new Date(); return d.getTime() - ((n.h * 60 + n.m) * 60 + d.getSeconds()) * 1000 - d.getMilliseconds(); };
function overview() {
  const now = Date.now(), t0 = todayStart();
  const screens = q('SELECT * FROM screens ORDER BY code').map(s => {
    const online = !!s.last_seen && now - s.last_seen < ONLINE_MS;
    const pl = q1('SELECT COUNT(*) n FROM plays WHERE screen=? AND ts>=? AND ok=1', s.id, t0).n;
    return { id: s.id, code: s.code, key: s.key, venue: s.venue, spot: s.spot, on: s.on_h, off: s.off_h, limit: s.lim, online, lastSeen: s.last_seen, nowCamp: online ? s.now_c : null, nowFile: online ? s.now_f : null, queue: s.queue, ver: s.ver, playsToday: pl };
  });
  const files = q('SELECT * FROM files ORDER BY created DESC');
  const campaigns = q('SELECT * FROM campaigns ORDER BY created DESC').map(campOut);
  const alerts = screens.filter(s => !s.online).map(s => ({ screen: s.code, title: s.lastSeen ? 'Ecrã sem ligação' : 'Ecrã ainda nunca ligou', detail: s.lastSeen ? 'Último sinal há ' + Math.round((now - s.lastSeen) / 60000) + ' min.' : 'Instale o player e abra o endereço do ecrã.' }));
  return { screens, files, campaigns, alerts, now: S.lisbonNow(TZ) };
}
const num = (v, d) => (v === '' || v == null || isNaN(+v)) ? d : +v;
const dateOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
function campaignFrom(b, id) {
  const c = { id: id || 'C' + uid(4), name: String(b.name || '').trim(), client: String(b.client || '').trim(), venues: Array.isArray(b.venues) ? b.venues.map(String) : [], start: b.start, end: b.end, h0: num(b.h0, 0), h1: num(b.h1, 24), ppm: num(b.ppm, 1), priority: ['Alta', 'Normal', 'Baixa'].includes(b.priority) ? b.priority : 'Normal', manual: b.manual ? 1 : 0, items: Array.isArray(b.items) ? b.items : [] };
  if (!c.name) throw new Error('Indique o nome da campanha.');
  if (!dateOk(c.start) || !dateOk(c.end) || c.end < c.start) throw new Error('Datas inválidas.');
  if (!(c.h0 >= 0 && c.h1 <= 24 && c.h1 > c.h0)) throw new Error('Horas inválidas.');
  if (!(c.ppm > 0 && c.ppm <= 12)) throw new Error('Passagens por minuto entre 0 e 12.');
  c.items = c.items.map(i => ({ f: String(i.f), h0: i.h0 == null || i.h0 === '' ? null : +i.h0, h1: i.h1 == null || i.h1 === '' ? null : +i.h1, d0: i.d0 || null, d1: i.d1 || null, ppm: num(i.ppm, 1) }));
  c.items.forEach(i => { if (!q1('SELECT id FROM files WHERE id=?', i.f)) throw new Error('Conteúdo inexistente: ' + i.f); });
  return c;
}
async function adminApi(req, res, u) {
  if (!isAdmin(req)) return fail(res, 401, 'Chave de administração inválida');
  const p = u.pathname, m = req.method;
  if (m === 'GET' && p === '/api/admin/overview') return send(res, 200, overview());
  if (m === 'POST' && p === '/api/admin/screens') {
    const b = await readJson(req);
    const n = q('SELECT code FROM screens').map(x => +String(x.code).replace(/\D/g, '')).reduce((a, c) => Math.max(a, c), 0) + 1;
    const s = { id: 'S' + uid(4), code: 'ECR-' + String(n).padStart(3, '0'), key: uid(10) };
    const venue = String(b.venue || '').trim(); if (!venue) return fail(res, 400, 'Indique o local.');
    run('INSERT INTO screens(id,code,key,venue,spot,on_h,off_h,lim,created) VALUES(?,?,?,?,?,?,?,?,?)', s.id, s.code, s.key, venue, String(b.spot || '').trim(), num(b.on, 0), num(b.off, 24), Math.max(1, Math.min(99, Math.round(num(b.limit, 14)))), Date.now());
    return send(res, 200, s);
  }
  let r;
  if (m === 'DELETE' && (r = /^\/api\/admin\/screens\/([\w-]+)$/.exec(p))) { run('DELETE FROM screens WHERE id=?', r[1]); return send(res, 200, { ok: true }); }
  if (m === 'PUT' && p === '/api/admin/files') {          // corpo = bytes do ficheiro
    const name = u.searchParams.get('name') || 'ficheiro', mime = u.searchParams.get('mime') || 'application/octet-stream';
    const type = /^video/.test(mime) ? 'Vídeo' : (/^image/.test(mime) ? 'Imagem' : 'HTML');
    const dur = num(u.searchParams.get('dur'), type === 'Vídeo' ? 10 : 10);
    const id = 'F' + uid(5), file = path.join(MEDIA, id);
    await new Promise((ok, ko) => { const w = fs.createWriteStream(file); req.pipe(w); w.on('finish', ok); w.on('error', ko); req.on('error', ko); });
    const size = fs.statSync(file).size;
    if (!size) { fs.unlinkSync(file); return fail(res, 400, 'Ficheiro vazio.'); }
    run('INSERT INTO files(id,name,type,mime,dur,size,created) VALUES(?,?,?,?,?,?,?)', id, name, type, mime, dur, size, Date.now());
    return send(res, 200, { id, name, type, dur, size });
  }
  if (m === 'DELETE' && (r = /^\/api\/admin\/files\/(\w+)$/.exec(p))) {
    if (q('SELECT items FROM campaigns').some(c => JSON.parse(c.items).some(i => i.f === r[1]))) return fail(res, 409, 'Este conteúdo está numa campanha.');
    run('DELETE FROM files WHERE id=?', r[1]); try { fs.unlinkSync(path.join(MEDIA, r[1])); } catch (e) { }
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/admin/campaigns') {
    try { const c = campaignFrom(await readJson(req)); run('INSERT INTO campaigns(id,name,client,venues,start,end,h0,h1,ppm,priority,manual,items,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', c.id, c.name, c.client, JSON.stringify(c.venues), c.start, c.end, c.h0, c.h1, c.ppm, c.priority, c.manual, JSON.stringify(c.items), Date.now()); return send(res, 200, c); }
    catch (e) { return fail(res, 400, e.message); }
  }
  if (m === 'PUT' && (r = /^\/api\/admin\/campaigns\/(\w+)$/.exec(p))) {
    try { const c = campaignFrom(await readJson(req), r[1]); run('UPDATE campaigns SET name=?,client=?,venues=?,start=?,end=?,h0=?,h1=?,ppm=?,priority=?,manual=?,items=? WHERE id=?', c.name, c.client, JSON.stringify(c.venues), c.start, c.end, c.h0, c.h1, c.ppm, c.priority, c.manual, JSON.stringify(c.items), c.id); return send(res, 200, c); }
    catch (e) { return fail(res, 400, e.message); }
  }
  if (m === 'DELETE' && (r = /^\/api\/admin\/campaigns\/(\w+)$/.exec(p))) { run('DELETE FROM campaigns WHERE id=?', r[1]); return send(res, 200, { ok: true }); }
  if (m === 'GET' && p === '/api/admin/report') {
    const from = num(u.searchParams.get('from'), 0), to = num(u.searchParams.get('to'), Date.now() + 1), camp = u.searchParams.get('campaign');
    const where = 'ts>=? AND ts<? AND ok=1' + (camp ? ' AND camp=?' : ''), args = camp ? [from, to, camp] : [from, to];
    return send(res, 200, {
      byCampaign: q(`SELECT camp, COUNT(*) plays FROM plays WHERE ${where} GROUP BY camp`, ...args),
      byFile: q(`SELECT camp, file, COUNT(*) plays FROM plays WHERE ${where} GROUP BY camp,file`, ...args),
      byScreen: q(`SELECT screen, COUNT(*) plays FROM plays WHERE ${where} GROUP BY screen`, ...args),
      failures: q1('SELECT COUNT(*) n FROM plays WHERE ts>=? AND ts<? AND ok=0', from, to).n
    });
  }
  fail(res, 404, 'Não encontrado');
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (p === '/health') return send(res, 200, { ok: true });
    if (p === '/') { res.writeHead(302, { Location: '/admin/' }); return res.end(); }
    if (p.startsWith('/api/player/')) return await playerApi(req, res, u);
    if (p.startsWith('/api/admin/')) return await adminApi(req, res, u);
    let r; if (req.method === 'GET' && (r = /^\/media\/(\w+)$/.exec(p))) return media(req, res, u, r[1]);
    if (req.method === 'GET' && (p.startsWith('/player') || p.startsWith('/admin'))) return serveStatic(res, p.replace(/^\//, ''));
    fail(res, 404, 'Não encontrado');
  } catch (e) { console.error(e); if (!res.headersSent) fail(res, 500, e.message || 'Erro'); else res.end(); }
});
if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Enif OOH a correr em http://localhost:' + PORT + '  (administração: /admin/)');
    if (ADMIN === 'admin') console.log('AVISO: a chave de administração é a de teste. Defina ADMIN_TOKEN antes de pôr isto na internet.');
  });
}
module.exports = { server, db, playlistFor };
