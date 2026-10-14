'use strict';
/* Enif OOH – servidor. Sem dependências: só Node 22.13+. */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const S = require('./lib/schedule');
const A = require('./lib/auth');

const PORT = +process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const TZ = process.env.TZ_NAME || 'Europe/Lisbon';
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 1024) * 1048576;
const ONLINE_MS = 150 * 1000;            // sem sinal de vida há mais de 2,5 min = offline
const SESSION_MS = 30 * 864e5;
const PLAYER_VERSION = '2';              // mudar para obrigar os players a recarregar
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'enif-data.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS docs(coll TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(coll,id));
CREATE TABLE IF NOT EXISTS secrets(coll TEXT NOT NULL, id TEXT NOT NULL, a TEXT, b TEXT, PRIMARY KEY(coll,id));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, mime TEXT, size INTEGER);
CREATE TABLE IF NOT EXISTS live(screen TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, now_c TEXT, now_f TEXT, ver TEXT, queue INTEGER DEFAULT 0, w INTEGER, h INTEGER, reload INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS beats(screen TEXT NOT NULL, minute INTEGER NOT NULL, PRIMARY KEY(screen,minute));
CREATE TABLE IF NOT EXISTS plays(pid TEXT PRIMARY KEY, screen TEXT, camp TEXT, file TEXT, ts INTEGER, day TEXT, hour INTEGER, dur REAL, ok INTEGER);
CREATE INDEX IF NOT EXISTS plays_day ON plays(day);
CREATE TABLE IF NOT EXISTS resolved(id TEXT PRIMARY KEY, ts INTEGER);
`);
const q = (sql, ...a) => db.prepare(sql).all(...a);
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');

/* ---------- documentos ---------- */
const nextSeq = () => q1('SELECT COALESCE(MAX(seq),0)+1 n FROM docs').n;
const docs = (coll, desc) => q(`SELECT json FROM docs WHERE coll=? ORDER BY seq ${desc ? 'DESC' : ''}`, coll).map(r => JSON.parse(r.json));
const getDoc = (coll, id) => { const r = q1('SELECT json FROM docs WHERE coll=? AND id=?', coll, String(id)); return r ? JSON.parse(r.json) : null; };
function putDoc(coll, id, obj) {
  const j = JSON.stringify(obj);
  if (q1('SELECT 1 x FROM docs WHERE coll=? AND id=?', coll, id)) run('UPDATE docs SET json=? WHERE coll=? AND id=?', j, coll, id);
  else run('INSERT INTO docs(coll,id,json,seq) VALUES(?,?,?,?)', coll, id, j, nextSeq());
}
const delDoc = (coll, id) => run('DELETE FROM docs WHERE coll=? AND id=?', coll, id);
const secret = (coll, id) => q1('SELECT a,b FROM secrets WHERE coll=? AND id=?', coll, id);
const setSecret = (coll, id, a, b) => run('INSERT INTO secrets(coll,id,a,b) VALUES(?,?,?,?) ON CONFLICT(coll,id) DO UPDATE SET a=excluded.a,b=excluded.b', coll, id, a, b || null);

/* ---------- http ---------- */
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg) => new HttpError(400, msg);
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }, extra));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
function readJson(req, limit = 3e6) {
  return new Promise((ok, ko) => {
    let n = 0; const b = [];
    req.on('data', c => { n += c.length; if (n > limit) { ko(new HttpError(413, 'Pedido demasiado grande')); req.destroy(); } else b.push(c); });
    req.on('end', () => { try { ok(b.length ? JSON.parse(Buffer.concat(b).toString('utf8')) : {}); } catch (e) { ko(bad('JSON inválido')); } });
    req.on('error', ko);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
function serveStatic(res, rel) {
  const root = path.join(__dirname, 'public');
  const f = path.normalize(path.join(root, rel));
  if (!f.startsWith(root + path.sep)) throw new HttpError(403, 'Proibido');
  let p = f; if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) throw new HttpError(404, 'Não encontrado');
  send(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || 'application/octet-stream');
}

/* ---------- autenticação ---------- */
const publicUser = u => u;                // o documento do utilizador nunca contém a palavra-passe
const todayStr = () => S.lisbonNow(TZ).date;
function accessError(u) {
  if (!u.active) return 'Esta conta está desativada. Fale com o administrador.';
  if (u.until && u.until < todayStr()) return 'O acesso desta conta terminou.';
  return null;
}
function authUser(req, u) {
  const h = String(req.headers.authorization || ''), tok = h.startsWith('Bearer ') ? h.slice(7) : (u && u.searchParams.get('t')) || '';
  if (!tok) return null;
  const s = q1('SELECT * FROM sessions WHERE token=?', tok);
  if (!s || s.exp < Date.now()) { if (s) run('DELETE FROM sessions WHERE token=?', tok); return null; }
  const user = getDoc('users', s.user);
  if (!user || accessError(user)) return null;
  return user;
}
function needUser(req, u) { const user = authUser(req, u); if (!user) throw new HttpError(401, 'Sessão expirada. Entre outra vez.'); return user; }
function need(user, perm) { if (!A.can(user, perm)) throw new HttpError(403, 'Não tem permissão para esta ação.'); }
const loginLimit = A.limiter(8, 10 * 60 * 1000);
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token,user,exp) VALUES(?,?,?)', token, userId, Date.now() + SESSION_MS);
  run('DELETE FROM sessions WHERE exp<?', Date.now());
  return token;
}
const userCount = () => q1("SELECT COUNT(*) n FROM docs WHERE coll='users'").n;
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/* ---------- validação dos documentos ---------- */
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const str = (v, max, what) => { if (typeof v !== 'string') throw bad(what + ' inválido.'); const t = v.trim(); if (t.length > max) throw bad(what + ' demasiado longo.'); return t; };
const optStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v, lo, hi, what) => { const n = +v; if (!(n >= lo && n <= hi)) throw bad(what + ' inválido.'); return n; };
const ids = (v, what) => { if (!Array.isArray(v) || v.length > 500) throw bad(what + ' inválido.'); return v.map(x => str(x, 120, what)); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function cleanScreen(o, id) {
  const loc = o.loc && typeof o.loc === 'object' ? o.loc : {};
  const out = {
    id, venue: str(o.venue, 120, 'Local'), city: optStr(o.city, 80), spot: str(o.spot, 120, 'Posição'), type: optStr(o.type, 60) || 'Outro',
    res: optStr(o.res, 20) || 'auto', limit: Math.round(num(o.limit, 1, 99, 'Limite')), order: ids(o.order || [], 'Ordem'),
    draft: null, loc: { addr: optStr(loc.addr, 200), lat: loc.lat == null ? null : num(loc.lat, -90, 90, 'Latitude'), lng: loc.lng == null ? null : num(loc.lng, -180, 180, 'Longitude'), env: optStr(loc.env, 40), pop: loc.pop == null ? null : Math.round(num(loc.pop, 0, 2e6, 'Pessoas por dia')) },
    on: num(o.on == null ? 0 : o.on, 0, 24, 'Hora de ligar'), off: num(o.off == null ? 24 : o.off, 0, 24, 'Hora de desligar'),
    onT: optStr(o.onT, 5) || '00:00', offT: optStr(o.offT, 5) || '23:59'
  };
  if (!out.venue || !out.spot) throw bad('Indique o local e a posição do ecrã.');
  if (o.draft) out.draft = { order: ids(o.draft.order || [], 'Rascunho'), limit: Math.round(num(o.draft.limit, 1, 99, 'Limite')) };
  return out;
}
function cleanCampaign(o, id) {
  const out = {
    id, name: str(o.name, 160, 'Nome'), client: optStr(o.client, 160) || 'Sem cliente', venues: ids(o.venues || [], 'Locais'),
    start: o.start, end: o.end, h0: num(o.h0, 0, 23, 'Hora de início'), h1: num(o.h1, 1, 24, 'Hora de fim'),
    ppm: num(o.ppm, 0.25, 12, 'Passagens por minuto'), dur: Math.round(num(o.dur == null ? 10 : o.dur, 3, 60, 'Duração')),
    priority: ['Alta', 'Normal', 'Baixa'].includes(o.priority) ? o.priority : 'Normal', manual: !!o.manual, color: Math.round(num(o.color == null ? 1 : o.color, 1, 6, 'Cor')), items: []
  };
  if (!out.name) throw bad('Dê um nome à campanha.');
  if (!isDate(out.start) || !isDate(out.end) || out.end < out.start) throw bad('Datas inválidas.');
  if (out.h1 <= out.h0) throw bad('A hora de fim tem de ser depois da hora de início.');
  if (!Array.isArray(o.items) || o.items.length > 200) throw bad('Conteúdos inválidos.');
  out.items = o.items.map(i => {
    const it = { f: str(i.f, 40, 'Conteúdo'), h0: i.h0 == null ? null : num(i.h0, 0, 24, 'Hora do vídeo'), h1: i.h1 == null ? null : num(i.h1, 0, 24, 'Hora do vídeo'), d0: i.d0 || null, d1: i.d1 || null, ppm: Math.round(num(i.ppm == null ? 1 : i.ppm, 1, 12, 'Vezes por minuto')) };
    if ((it.d0 && !isDate(it.d0)) || (it.d1 && !isDate(it.d1))) throw bad('Dias do vídeo inválidos.');
    if (!getDoc('contents', it.f)) throw bad('Conteúdo inexistente.');
    return it;
  });
  return out;
}
function cleanUserDoc(o, id, old) {
  const out = {
    id, name: str(o.name, 120, 'Nome'), email: str(o.email, 160, 'E-mail').toLowerCase(), admin: !!o.admin,
    perms: Array.isArray(o.perms) ? o.perms.filter(p => A.PERMS.indexOf(p) > -1) : [], until: o.until || null, active: o.active !== false
  };
  if (!out.name) throw bad('Indique o nome.');
  if (!validEmail(out.email)) throw bad('Indique um e-mail válido.');
  if (out.until && !isDate(out.until)) throw bad('Data de acesso inválida.');
  if (out.admin) out.perms = A.PERMS.slice();
  const photo = o.photo === undefined ? (old && old.photo) : o.photo;
  if (photo) { if (typeof photo !== 'string' || !photo.startsWith('data:image/') || photo.length > 250000) throw bad('Foto inválida.'); out.photo = photo; }
  const notif = o.notif === undefined ? (old && old.notif) : o.notif;
  if (notif) { if (typeof notif !== 'object' || JSON.stringify(notif).length > 200000) throw bad('Preferências inválidas.'); out.notif = notif; }
  const ui = o.ui === undefined ? (old && old.ui) : o.ui;
  if (ui) { if (typeof ui !== 'object' || JSON.stringify(ui).length > 50000) throw bad('Preferências inválidas.'); out.ui = ui; }
  return out;
}

/* ---------- sincronização (alterações vindas da interface) ---------- */
const PL_FIELDS = ['order', 'limit', 'draft'];
function applyOp(user, op) {
  if (!op || typeof op !== 'object') throw bad('Pedido inválido.');
  const { coll, id } = op;
  if (typeof id !== 'string' || !id || id.length > 80 || !/^[\w.\-]+$/.test(id)) throw bad('Identificador inválido.');
  if (op.op === 'del') {
    if (coll === 'alerts') { need(user, 'alertas.resolver'); run('INSERT OR IGNORE INTO resolved(id,ts) VALUES(?,?)', id, Date.now()); return; }
    if (coll === 'folders') { need(user, 'conteudos.gerir'); delDoc('folders', id); return; }
    if (coll === 'campaigns') { need(user, 'campanhas.gerir'); delDoc('campaigns', id); return; }
    if (coll === 'screens') { need(user, 'ecras.gerir'); delDoc('screens', id); run('DELETE FROM secrets WHERE coll=? AND id=?', 'screens', id); return; }
    throw new HttpError(403, 'Não é possível apagar isto.');
  }
  if (op.op !== 'put' || !op.doc || typeof op.doc !== 'object') throw bad('Pedido inválido.');
  const old = getDoc(coll, id);
  let d = op.doc;
  if (old && Array.isArray(op.keys)) {          // só os campos que a interface alterou
    d = Object.assign({}, old);
    op.keys.slice(0, 40).forEach(k => { if (typeof k === 'string' && k !== '__proto__') d[k] = op.doc[k]; });
  }
  if (coll === 'screens') {
    const n = cleanScreen(d, id);
    if (!old) { need(user, 'ecras.gerir'); putDoc('screens', id, n); setSecret('screens', id, uid(10)); return; }
    const ch = Object.keys(n).filter(k => !same(n[k], old[k]));
    ch.forEach(k => need(user, PL_FIELDS.indexOf(k) > -1 ? 'playlist.gerir' : 'ecras.gerir'));
    if (ch.length) putDoc('screens', id, n);
  } else if (coll === 'campaigns') {
    const n = cleanCampaign(d, id);
    if (!old) { need(user, 'campanhas.gerir'); putDoc('campaigns', id, n); return; }
    const ch = Object.keys(n).filter(k => !same(n[k], old[k]));
    if (ch.length && !(ch.length === 1 && ch[0] === 'items' && A.can(user, 'conteudos.gerir'))) need(user, 'campanhas.gerir');
    if (ch.length) putDoc('campaigns', id, n);
  } else if (coll === 'contents') {
    need(user, 'conteudos.gerir');
    if (!old) throw bad('Os conteúdos entram pelo carregamento de ficheiros.');
    const folder = d.folder || null;
    if (folder && !getDoc('folders', folder)) throw bad('Pasta inexistente.');
    if (folder !== (old.folder || null)) putDoc('contents', id, Object.assign({}, old, { folder }));
  } else if (coll === 'folders') {
    need(user, 'conteudos.gerir');
    const name = str(d.name, 80, 'Nome da pasta'); if (!name) throw bad('Dê um nome à pasta.');
    if (docs('folders').some(p => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw bad('Já existe uma pasta com esse nome.');
    putDoc('folders', id, { id, name });
  } else if (coll === 'users') {
    const self = user.id === id;
    if (!user.admin) {
      if (!self || !old) throw new HttpError(403, 'Só um administrador gere utilizadores.');
      const n = cleanUserDoc(Object.assign({}, old, { photo: d.photo, notif: d.notif, ui: d.ui }), id, old);
      putDoc('users', id, n); return;
    }
    const n = cleanUserDoc(d, id, old);
    if (self) { n.admin = old.admin; n.active = true; n.perms = old.perms; }
    if (docs('users').some(u => u.id !== id && u.email === n.email)) throw bad('Já existe um utilizador com esse e-mail.');
    const pass = typeof d.pass === 'string' ? d.pass : '';
    if (!old && pass.length < 6) throw bad('A palavra-passe precisa de pelo menos 6 caracteres.');
    if (pass && pass.length < 6) throw bad('A palavra-passe precisa de pelo menos 6 caracteres.');
    const others = docs('users').filter(u => u.id !== id && u.admin && u.active && !accessError(u)).length;
    if (!(n.admin && n.active) && others === 0) throw bad('Tem de existir pelo menos um administrador ativo.');
    putDoc('users', id, n);
    if (pass) { const h = A.hashPassword(pass); setSecret('users', id, h.salt, h.hash); }
    if (!self && (pass || !n.active || (old && !same(old.perms, n.perms)) || (old && old.admin !== n.admin))) run('DELETE FROM sessions WHERE user=?', id);
  } else throw bad('Coleção desconhecida.');
}
function sync(user, ops) {
  if (!Array.isArray(ops) || ops.length > 500) throw bad('Pedido inválido.');
  db.exec('BEGIN');
  try { ops.forEach(applyOp.bind(null, user)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------- estado de ecrãs, alertas ---------- */
const fmtHM = t => { const d = new Date(t), p = S.lisbonNow(TZ, d); return String(p.h).padStart(2, '0') + ':' + String(p.m).padStart(2, '0'); };
function expectedMinutes(scr, from, to) {
  let t = from, total = 0;
  while (t < to) {
    const next = Math.min(to, (Math.floor(t / 3600000) + 1) * 3600000);
    if (S.screenOn({ on_h: scr.on, off_h: scr.off }, S.lisbonNow(TZ, new Date(t)).h)) total += (next - t) / 60000;
    t = next;
  }
  return total;
}
function screenViews(withKeys) {
  const now = Date.now(), ln = S.lisbonNow(TZ), hourF = ln.h + ln.m / 60;
  const today = q('SELECT screen, SUM(ok) good, COUNT(*) total FROM plays WHERE day=? GROUP BY screen', ln.date);
  const tmap = {}; today.forEach(r => { tmap[r.screen] = r; });
  const resolved = new Set(q('SELECT id FROM resolved').map(r => r.id));
  const alerts = [];
  const list = docs('screens').map(s => {
    const lv = q1('SELECT * FROM live WHERE screen=?', s.id);
    const o = Object.assign({}, s);
    if (withKeys) { const sc = secret('screens', s.id); o.playerKey = sc ? sc.a : ''; }
    const inSched = hourF >= s.on && hourF < s.off;
    if (!lv || !lv.last_seen) { o.status = 'novo'; o.ping = ''; o.uptime = ''; return o; }
    const age = now - lv.last_seen, mins = Math.max(1, Math.round(age / 60000));
    o.lastSeen = lv.last_seen; o.ver = lv.ver; o.queue = lv.queue;
    o.nowCamp = age < ONLINE_MS ? lv.now_c : null; o.nowFile = age < ONLINE_MS ? lv.now_f : null;
    o.ping = age < 90000 ? 'há ' + Math.max(1, Math.round(age / 1000)) + ' s' : 'há ' + mins + ' min';
    const tt = tmap[s.id], total = tt ? tt.total : 0, failed = tt ? total - tt.good : 0;
    if (age > ONLINE_MS && inSched) {
      o.status = 'offline'; o.sinceMin = mins;
      const key = 'off-' + s.id + '-' + Math.floor(lv.last_seen / 60000);
      if (!resolved.has(key)) alerts.push({ id: key, sev: 'bad', screen: s.id, title: 'Ecrã sem ligação', detail: 'Sem resposta há ' + mins + ' min.', time: fmtHM(lv.last_seen + ONLINE_MS) });
    } else if (total >= 10 && failed / total >= 0.05) {
      const pct = Math.round(failed / total * 100);
      o.status = 'atencao'; o.issueLog = pct + ' % das reproduções de hoje falharam.';
      const key = 'fail-' + s.id + '-' + ln.date;
      if (!resolved.has(key)) alerts.push({ id: key, sev: 'warn', screen: s.id, title: 'Falhas de reprodução', detail: pct + ' % das reproduções de hoje falharam neste ecrã.', time: fmtHM(now) });
    } else o.status = 'online';
    // disponibilidade nos últimos 7 dias, só dentro do horário do ecrã
    const from = Math.max(lv.first_seen || lv.last_seen, now - 7 * 864e5), exp = expectedMinutes(s, from, now);
    if (exp >= 60) {
      const got = q1('SELECT COUNT(*) n FROM beats WHERE screen=? AND minute>=?', s.id, Math.floor(from / 60000)).n;
      o.uptime = (Math.min(1, got / exp) * 100).toFixed(1).replace('.', ',') + ' %';
    } else o.uptime = '';
    return o;
  });
  return { screens: list, alerts };
}
function buildState(user) {
  const sv = screenViews(A.can(user, 'ecras.gerir'));
  return {
    me: publicUser(user), now: S.lisbonNow(TZ), serverTime: Date.now(), tz: TZ,
    screens: sv.screens, alerts: sv.alerts, campaigns: docs('campaigns'), contents: docs('contents', true), folders: docs('folders'),
    users: user.admin ? docs('users') : [], playerVersion: PLAYER_VERSION
  };
}

/* ---------- playlist de um ecrã (player) ---------- */
function playlistFor(scr) {
  const camps = docs('campaigns');
  const sch = { venue: scr.venue, on_h: scr.on, off_h: scr.off, lim: scr.limit, ord: JSON.stringify(scr.order || []) };
  const now = S.lisbonNow(TZ), days = {}, used = {};
  [now.date, S.addDay(now.date, 1)].forEach(d => {
    days[d] = S.dayLoops(sch, camps, d);
    Object.values(days[d]).forEach(l => (l || []).forEach(e => e.items.forEach(f => { used[f] = 1; })));
  });
  const files = {};
  Object.keys(used).forEach(id => {
    const f = getDoc('contents', id), fl = q1('SELECT * FROM files WHERE id=?', id);
    if (f && fl) files[id] = { name: f.name, type: f.type, dur: f.secs || 10, size: fl.size, mime: fl.mime };
  });
  Object.values(days).forEach(day => Object.keys(day).forEach(h => {      // retira vídeos que já não existem
    if (day[h]) day[h] = day[h].map(e => Object.assign(e, { items: e.items.filter(f => files[f]) })).filter(e => e.items.length);
  }));
  const lv = q1('SELECT reload FROM live WHERE screen=?', scr.id);
  return { playerVersion: PLAYER_VERSION, tz: TZ, generated: Date.now(), reload: lv ? lv.reload : 0, screen: { code: scr.id, venue: scr.venue, spot: scr.spot }, days, files };
}
function screenAuth(code, key) {
  const s = getDoc('screens', String(code || '')); if (!s) return null;
  const sc = secret('screens', s.id), a = Buffer.from(String(key || '')), b = Buffer.from(sc ? sc.a : '');
  return sc && a.length === b.length && crypto.timingSafeEqual(a, b) ? s : null;
}
function playerApi(req, res, u, body) {
  const p = u.pathname;
  if (req.method === 'GET' && p === '/api/player/playlist') {
    const s = screenAuth(u.searchParams.get('code'), u.searchParams.get('key'));
    if (!s) throw new HttpError(401, 'Código ou chave inválidos');
    return send(res, 200, playlistFor(s));
  }
  if (req.method === 'POST' && p === '/api/player/heartbeat') {
    const s = screenAuth(body.code, body.key); if (!s) throw new HttpError(401, 'Código ou chave inválidos');
    const now = Date.now(), w = Math.round(+body.w) || null, h = Math.round(+body.h) || null;
    run(`INSERT INTO live(screen,first_seen,last_seen,now_c,now_f,ver,queue,w,h) VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(screen) DO UPDATE SET last_seen=excluded.last_seen, now_c=excluded.now_c, now_f=excluded.now_f, ver=excluded.ver, queue=excluded.queue, w=excluded.w, h=excluded.h`,
      s.id, now, now, body.c || null, body.f || null, String(body.ver || ''), +body.queue || 0, w, h);
    run('INSERT OR IGNORE INTO beats(screen,minute) VALUES(?,?)', s.id, Math.floor(now / 60000));
    if (s.res === 'auto' && w && h && w >= 240 && h >= 240) putDoc('screens', s.id, Object.assign({}, s, { res: w + '×' + h }));
    return send(res, 200, { ok: true, serverTime: now });
  }
  if (req.method === 'POST' && p === '/api/player/plays') {
    const s = screenAuth(body.code, body.key); if (!s) throw new HttpError(401, 'Código ou chave inválidos');
    const got = []; let saved = 0;
    db.exec('BEGIN');
    try {
      (Array.isArray(body.plays) ? body.plays : []).slice(0, 2000).forEach(x => {
        if (!x || !x.pid) return;
        const ts = Math.min(+x.ts || Date.now(), Date.now() + 60000), ln = S.lisbonNow(TZ, new Date(ts));
        const r = run('INSERT OR IGNORE INTO plays(pid,screen,camp,file,ts,day,hour,dur,ok) VALUES(?,?,?,?,?,?,?,?,?)', String(x.pid).slice(0, 80), s.id, String(x.c || '').slice(0, 80), String(x.f || '').slice(0, 80), ts, ln.date, ln.h, +x.dur || 0, x.ok ? 1 : 0);
        saved += Number(r.changes); got.push(x.pid);
      });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return send(res, 200, { ok: true, saved, received: got });
  }
  throw new HttpError(404, 'Não encontrado');
}

/* ---------- ficheiros ---------- */
function media(req, res, u, id) {
  const screen = screenAuth(u.searchParams.get('code'), u.searchParams.get('key'));
  if (!screen) needUser(req, u);
  const f = q1('SELECT * FROM files WHERE id=?', id), file = path.join(MEDIA, path.basename(id));
  if (!f || !fs.existsSync(file)) throw new HttpError(404, 'Ficheiro não existe');
  const size = fs.statSync(file).size, r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const h = { 'Content-Type': f.mime || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
  if (/html/.test(f.mime)) h['Content-Security-Policy'] = 'sandbox allow-scripts';
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
const sizeTxt = n => n > 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
async function upload(req, res, u) {
  const user = needUser(req, u); need(user, 'conteudos.gerir');
  const name = path.basename(String(u.searchParams.get('name') || 'ficheiro')).replace(/[\u0000-\u001f]/g, '').slice(0, 160) || 'ficheiro';
  let mime = String(u.searchParams.get('mime') || '').toLowerCase();
  const html = /\.html?$/i.test(name);
  const type = html ? 'HTML5' : /^video\//.test(mime) ? 'Vídeo' : /^image\//.test(mime) ? 'Imagem' : null;
  if (!type) throw bad('Tipo de ficheiro não suportado. Use imagens, vídeos ou HTML5.');
  if (html) mime = 'text/html; charset=utf-8';
  if (!/^[\w.+\-]+\/[\w.+\-]+(;.*)?$/.test(mime)) throw bad('Tipo de ficheiro inválido.');
  const declared = +req.headers['content-length'] || 0;
  if (declared > MAX_UPLOAD) throw new HttpError(413, 'O ficheiro é demasiado grande (máximo ' + Math.round(MAX_UPLOAD / 1048576) + ' MB).');
  const secs = Math.round((+u.searchParams.get('secs') || 0) * 10) / 10;
  const resTxt = html ? 'Responsivo' : (/^\d{2,5}×\d{2,5}$/.test(u.searchParams.get('res') || '') ? u.searchParams.get('res') : '—');
  const folder = u.searchParams.get('folder') || null;
  if (folder && !getDoc('folders', folder)) throw bad('Pasta inexistente.');
  const id = 'F' + uid(5), file = path.join(MEDIA, id);
  let n = 0;
  await new Promise((ok, ko) => {
    const w = fs.createWriteStream(file);
    req.on('data', c => { n += c.length; if (n > MAX_UPLOAD) { ko(new HttpError(413, 'O ficheiro é demasiado grande.')); req.destroy(); w.destroy(); } });
    req.pipe(w); w.on('finish', ok); w.on('error', ko); req.on('error', ko); req.on('aborted', () => ko(bad('Envio interrompido.')));
  }).catch(e => { try { fs.unlinkSync(file); } catch (x) { } throw e; });
  if (!n) { fs.unlinkSync(file); throw bad('Ficheiro vazio.'); }
  const dur = type === 'Imagem' ? 10 : (secs > 0 ? secs : 10);
  const doc = { id, name, type, res: resTxt, dur: type === 'Imagem' ? '' : Math.round(dur) + ' s', secs: dur, size: sizeTxt(n), folder, ready: true };
  db.exec('BEGIN');
  try { run('INSERT INTO files(id,mime,size) VALUES(?,?,?)', id, mime, n); putDoc('contents', id, doc); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  send(res, 200, doc);
}

/* ---------- relatórios ---------- */
function playsApi(res, u, user) {
  need(user, 'relatorios.ver');
  const from = u.searchParams.get('from'), to = u.searchParams.get('to');
  if (!isDate(from) || !isDate(to) || to < from) throw bad('Período inválido.');
  const args = [from, to]; let where = 'day>=? AND day<=?';
  const camp = u.searchParams.get('camp'); if (camp) { where += ' AND camp=?'; args.push(camp); }
  const scr = (u.searchParams.get('screens') || '').split(',').filter(Boolean).slice(0, 500);
  if (scr.length) { where += ` AND screen IN (${scr.map(() => '?').join(',')})`; args.push(...scr); }
  const rows = q(`SELECT screen s, camp c, file f, day d, hour h, SUM(ok) n, COUNT(*)-SUM(ok) bad, ROUND(SUM(CASE WHEN ok=1 THEN dur ELSE 0 END)) sec FROM plays WHERE ${where} GROUP BY screen,camp,file,day,hour`, ...args);
  send(res, 200, { rows, now: S.lisbonNow(TZ) });
}

/* ---------- rotas ---------- */
const router = async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method;
  if (p === '/health') return send(res, 200, { ok: true });
  if (p === '/') { res.writeHead(302, { Location: '/app/' }); return res.end(); }
  if (p === '/api/status') return send(res, 200, { setup: userCount() === 0 });
  if (p === '/api/setup' && m === 'POST') {
    if (userCount() > 0) throw new HttpError(403, 'A plataforma já foi configurada.');
    const b = await readJson(req), name = str(b.name || '', 120, 'Nome'), email = str(b.email || '', 160, 'E-mail').toLowerCase(), pass = String(b.pass || '');
    if (!name) throw bad('Indique o nome.');
    if (!validEmail(email)) throw bad('Indique um e-mail válido.');
    if (pass.length < 6) throw bad('A palavra-passe precisa de pelo menos 6 caracteres.');
    const id = 'u' + uid(4), h = A.hashPassword(pass);
    db.exec('BEGIN');
    try { putDoc('users', id, { id, name, email, admin: true, perms: A.PERMS.slice(), until: null, active: true }); setSecret('users', id, h.salt, h.hash); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    return send(res, 200, { token: newSession(id) });
  }
  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req), email = String(b.email || '').trim().toLowerCase();
    if (loginLimit.blocked(email)) throw new HttpError(429, 'Demasiadas tentativas. Tente daqui a alguns minutos.');
    const user = docs('users').find(x => x.email === email), sc = user && secret('users', user.id);
    if (!user || !A.checkPassword(String(b.pass || ''), sc && sc.a, sc && sc.b)) { loginLimit.fail(email); throw new HttpError(401, 'E-mail ou palavra-passe incorretos.'); }
    const err = accessError(user); if (err) throw new HttpError(403, err);
    loginLimit.ok(email);
    return send(res, 200, { token: newSession(user.id) });
  }
  if (p === '/api/logout' && m === 'POST') {
    const h = String(req.headers.authorization || ''); if (h.startsWith('Bearer ')) run('DELETE FROM sessions WHERE token=?', h.slice(7));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/state' && m === 'GET') return send(res, 200, buildState(needUser(req, u)));
  if (p === '/api/sync' && m === 'POST') { const user = needUser(req, u), b = await readJson(req); sync(user, b.ops); return send(res, 200, { ok: true }); }
  if (p === '/api/upload' && m === 'PUT') return upload(req, res, u);
  if (p === '/api/plays' && m === 'GET') return playsApi(res, u, needUser(req, u));
  let r;
  if ((r = /^\/api\/screens\/([\w.\-]+)\/restart$/.exec(p)) && m === 'POST') {
    const user = needUser(req, u); need(user, 'ecras.gerir');
    if (!getDoc('screens', r[1])) throw new HttpError(404, 'Ecrã não existe');
    run('INSERT INTO live(screen,reload) VALUES(?,1) ON CONFLICT(screen) DO UPDATE SET reload=reload+1', r[1]);
    return send(res, 200, { ok: true });
  }
  if (p.startsWith('/api/player/')) return playerApi(req, res, u, m === 'POST' ? await readJson(req, 5e6) : {});
  if (m === 'GET' && (r = /^\/media\/(\w+)$/.exec(p))) return media(req, res, u, r[1]);
  if (m === 'GET' && (p.startsWith('/player') || p.startsWith('/app'))) return serveStatic(res, p.replace(/^\//, ''));
  throw new HttpError(404, 'Não encontrado');
};
const server = http.createServer((req, res) => {
  Promise.resolve().then(() => router(req, res)).catch(e => {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e instanceof HttpError ? e.code : 500, { error: e instanceof HttpError ? e.message : 'Erro no servidor' });
    else res.end();
  });
});
if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Enif OOH a correr em http://localhost:' + PORT + '/');
    if (userCount() === 0) console.log('Primeiro acesso: abra o endereço acima para criar o administrador.');
  });
}
module.exports = { server, db, playlistFor, buildState };
