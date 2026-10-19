'use strict';
/* Enif OOH – servidor. Sem dependências: só Node 22.13+. */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const S = require('./lib/schedule');
const MAIL = require('./lib/mail'), REPORT = require('./lib/report');
const A = require('./lib/auth');
const M = require('./lib/media');

const PORT = +process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const TZ = process.env.TZ_NAME || 'Europe/Lisbon';
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 1024) * 1048576;
const ONLINE_MS = 150 * 1000;            // sem sinal de vida há mais de 2,5 min = offline
const SESSION_MS = 30 * 864e5;
const PLAYER_VERSION = '4';              // mudar para obrigar os players a recarregar
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
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, who TEXT, ip TEXT, what TEXT NOT NULL, detail TEXT);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'O registo de auditoria só se acrescenta'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'O registo de auditoria só se acrescenta'); END;
CREATE TABLE IF NOT EXISTS cmds(id INTEGER PRIMARY KEY AUTOINCREMENT, screen TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL);
`);
for (const col of ['disk_free INTEGER', 'disk_total INTEGER', 'bri INTEGER']) { try { db.exec('ALTER TABLE live ADD COLUMN ' + col); } catch (e) { /* já existe */ } }
const q = (sql, ...a) => db.prepare(sql).all(...a);
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
/* registo de auditoria: só se acrescenta (a base de dados recusa alterar ou apagar) */
function audit(who, what, detail, ip) {
  run('INSERT INTO audit(ts,who,ip,what,detail) VALUES(?,?,?,?,?)', Date.now(), who ? (typeof who === 'string' ? who : who.name) : '—', ip || '', String(what).slice(0, 200), String(detail || '').slice(0, 500));
}

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
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' }, extra));
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

const FITS = ['caber', 'preencher', 'esticar'];
function cleanBri(b, old) {
  if (b === undefined) return old || null;
  if (b === null) return null;
  if (typeof b !== 'object') throw bad('Brilho inválido.');
  const pc = (v, what) => { const n = Math.round(+v); if (!(n >= 10 && n <= 100)) throw bad(what + ' inválido (10 a 100 %).'); return n; };
  const hr = (v, what) => { const n = Math.round(+v); if (!(n >= 0 && n <= 23)) throw bad(what + ' inválida.'); return n; };
  const out = { mode: b.mode === 'manual' ? 'manual' : 'auto', day: pc(b.day == null ? 100 : b.day, 'Brilho de dia'), night: pc(b.night == null ? 40 : b.night, 'Brilho de noite'), from: hr(b.from == null ? 8 : b.from, 'Hora'), to: hr(b.to == null ? 20 : b.to, 'Hora'), manual: pc(b.manual == null ? 80 : b.manual, 'Brilho manual') };
  if (out.mode === 'auto' && out.from === out.to) throw bad('O início e o fim do dia não podem ser à mesma hora.');
  return out;
}
function cleanScreen(o, id, old) {
  const loc = o.loc && typeof o.loc === 'object' ? o.loc : {};
  const out = {
    id, venue: str(o.venue, 120, 'Local'), city: optStr(o.city, 80), spot: str(o.spot, 120, 'Posição'), type: optStr(o.type, 60) || 'Outro',
    res: optStr(o.res, 20) || 'auto', limit: Math.round(num(o.limit, 1, 99, 'Limite')), order: ids(o.order || [], 'Ordem'),
    draft: null, loc: { addr: optStr(loc.addr, 200), lat: loc.lat == null ? null : num(loc.lat, -90, 90, 'Latitude'), lng: loc.lng == null ? null : num(loc.lng, -180, 180, 'Longitude'), env: optStr(loc.env, 40), pop: loc.pop == null ? null : Math.round(num(loc.pop, 0, 2e6, 'Pessoas por dia')) },
    on: num(o.on == null ? 0 : o.on, 0, 24, 'Hora de ligar'), off: num(o.off == null ? 24 : o.off, 0, 24, 'Hora de desligar'),
    onT: optStr(o.onT, 5) || '00:00', offT: optStr(o.offT, 5) || '23:59',
    fit: FITS.indexOf(o.fit) > -1 ? o.fit : ((old && old.fit) || 'caber'),
    bri: cleanBri(o.bri, old && old.bri)
  };
  if (!out.venue || !out.spot) throw bad('Indique o local e a posição do ecrã.');
  if (o.draft) out.draft = { order: ids(o.draft.order || [], 'Rascunho'), limit: Math.round(num(o.draft.limit, 1, 99, 'Limite')) };
  return out;
}
function cleanCampaign(o, id, old) {
  const out = {
    id, name: str(o.name, 160, 'Nome'), client: optStr(o.client, 160) || 'Sem cliente', venues: ids(o.venues || [], 'Locais'),
    sector: optStr(o.sector, 40), sales: optStr(o.sales, 160).toLowerCase(),
    start: o.start, end: o.end, h0: num(o.h0, 0, 23, 'Hora de início'), h1: num(o.h1, 1, 24, 'Hora de fim'),
    ppm: num(o.ppm, 0.2, 12, 'Passagens por minuto'), dur: Math.round(num(o.dur == null ? 10 : o.dur, 3, 60, 'Duração')),
    priority: ['Alta', 'Normal', 'Baixa'].includes(o.priority) ? o.priority : 'Normal', manual: !!o.manual, color: Math.round(num(o.color == null ? 1 : o.color, 1, 6, 'Cor')), items: [],
    pauses: []
  };
  if (!out.name) throw bad('Dê um nome à campanha.');
  if (out.sales && !validEmail(out.sales)) throw bad('O e-mail do comercial não parece válido.');
  if (!isDate(out.start) || !isDate(out.end) || out.end < out.start) throw bad('Datas inválidas.');
  if (out.h1 <= out.h0) throw bad('A hora de fim tem de ser depois da hora de início.');
  if (o.pauses != null) {
    if (!Array.isArray(o.pauses) || o.pauses.length > 200) throw bad('Pausas inválidas.');
    out.pauses = o.pauses.map(x => {
      if (!x || !isDate(x.from) || (x.to != null && !isDate(x.to)) || (x.to != null && x.to < x.from)) throw bad('Pausas inválidas.');
      return { from: x.from, to: x.to == null ? null : x.to };
    });
  }
  if (!Array.isArray(o.items) || o.items.length > 200) throw bad('Conteúdos inválidos.');
  out.items = o.items.map(i => {
    const it = { f: str(i.f, 40, 'Conteúdo'), h0: i.h0 == null ? null : num(i.h0, 0, 24, 'Hora do vídeo'), h1: i.h1 == null ? null : num(i.h1, 0, 24, 'Hora do vídeo'), d0: i.d0 || null, d1: i.d1 || null, ppm: Math.round(num(i.ppm == null ? 1 : i.ppm, 1, 12, 'Vezes por minuto')) };
    if ((it.d0 && !isDate(it.d0)) || (it.d1 && !isDate(it.d1))) throw bad('Dias do vídeo inválidos.');
    if (!getDoc('contents', it.f)) throw bad('Conteúdo inexistente.');
    return it;
  });
  // campos que só o servidor escreve (avisos e relatório final já enviados ao comercial)
  ['warnFor', 'salesSentAt', 'salesSentFor', 'salesTries', 'salesTryAt', 'salesTryFor'].forEach(k => { if (old && old[k] != null) out[k] = old[k]; });
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
  // dados de segurança: só o servidor os escreve
  ['recovery', 'twoFA'].forEach(k => { if (old && old[k] != null) out[k] = old[k]; });
  return out;
}

/* ---------- conteúdos: ecrãs permitidos e spot da Enif ---------- */
const sharedCtx = () => ({ contents: docs('contents') });
/* valida os ecrãs de um conteúdo (e o limite de spots por ecrã). Devolve a lista limpa. */
function checkContentScreens(cand, screenIds) {
  if (!Array.isArray(screenIds) || !screenIds.length) throw bad('Escolha pelo menos um ecrã.');
  const all = docs('screens'), list = ids(screenIds, 'Ecrãs');
  list.forEach(id => {
    const sc = all.find(x => x.id === id);
    if (!sc) throw bad('O ecrã ' + id + ' não existe.');
    if (!S.fitOf(cand, sc).ok) throw bad('O ecrã ' + id + ' (' + sc.venue + ') não serve a este conteúdo: a proporção difere mais de ' + S.FIT_PX + ' px.');
  });
  if (cand.house) {
    const others = docs('contents').filter(f => f.id !== cand.id), c2 = Object.assign({}, cand, { screens: list });
    all.forEach(sc => {
      if (!S.okFor(c2, sc)) return;
      if (S.houseCnt(sc, { contents: others }, cand.id) >= S.HOUSE_MAX) throw bad('O ecrã ' + sc.id + ' (' + sc.venue + ') já tem ' + S.HOUSE_MAX + ' spots da Enif. Tire este ecrã ou deixe de usar outro spot.');
    });
  }
  return list;
}

/* ---------- sincronização (alterações vindas da interface) ---------- */
const PL_FIELDS = ['order', 'limit', 'draft'];
const diffKeys = (n, old, skip) => Object.keys(n).filter(k => (skip || []).indexOf(k) < 0 && !same(n[k], old[k]));
function applyOp(user, op) {
  if (!op || typeof op !== 'object') throw bad('Pedido inválido.');
  const { coll, id } = op;
  if (typeof id !== 'string' || !id || id.length > 80 || !/^[\w.\-]+$/.test(id)) throw bad('Identificador inválido.');
  if (op.op === 'del') {
    if (coll === 'alerts') { need(user, 'alertas.resolver'); run('INSERT OR IGNORE INTO resolved(id,ts) VALUES(?,?)', id, Date.now()); return; }
    if (coll === 'folders') { need(user, 'conteudos.gerir'); const f = getDoc('folders', id); delDoc('folders', id); if (f) audit(user, 'Eliminou a pasta', f.name); return; }
    if (coll === 'campaigns') { need(user, 'campanhas.gerir'); const c = getDoc('campaigns', id); delDoc('campaigns', id); if (c) audit(user, 'Eliminou a campanha', c.name); return; }
    if (coll === 'screens') {
      need(user, 'ecras.gerir'); const sc = getDoc('screens', id);
      delDoc('screens', id); run('DELETE FROM secrets WHERE coll=? AND id=?', 'screens', id);
      docs('contents').forEach(f => { if (Array.isArray(f.screens) && f.screens.indexOf(id) > -1) putDoc('contents', f.id, Object.assign({}, f, { screens: f.screens.filter(x => x !== id) })); });
      if (sc) audit(user, 'Eliminou o ecrã', id + ' · ' + sc.venue);
      return;
    }
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
    const n = cleanScreen(d, id, old);
    if (!old) { need(user, 'ecras.gerir'); putDoc('screens', id, n); setSecret('screens', id, uid(10)); audit(user, 'Criou o ecrã', id + ' · ' + n.venue); return; }
    const ch = diffKeys(n, old);
    ch.forEach(k => need(user, PL_FIELDS.indexOf(k) > -1 ? 'playlist.gerir' : 'ecras.gerir'));
    if (ch.length) {
      putDoc('screens', id, n);
      const plOnly = ch.every(k => PL_FIELDS.indexOf(k) > -1);
      audit(user, plOnly ? 'Alterou a playlist do ecrã' : 'Alterou o ecrã', id + ' · ' + ch.join(', '));
    }
  } else if (coll === 'campaigns') {
    const n = cleanCampaign(d, id, old);
    if (!old) { need(user, 'campanhas.gerir'); putDoc('campaigns', id, n); audit(user, 'Criou a campanha', n.name); return; }
    const ch = diffKeys(n, old);
    if (ch.length && !(ch.length === 1 && ch[0] === 'items' && A.can(user, 'conteudos.gerir'))) need(user, 'campanhas.gerir');
    if (ch.length) {
      // se a data de fim mudou, o aviso de fim volta a poder sair para a nova data
      if (ch.indexOf('end') > -1) delete n.warnFor;
      putDoc('campaigns', id, n);
      const op0 = (old.pauses || []).filter(p => !p.to).length, op1 = n.pauses.filter(p => !p.to).length;
      if (ch.indexOf('pauses') > -1 && op1 > op0) audit(user, 'Pausou a campanha', n.name);
      else if (ch.indexOf('pauses') > -1 && op1 < op0) audit(user, 'Retomou a campanha', n.name);
      else audit(user, 'Atualizou a campanha', n.name);
    }
  } else if (coll === 'contents') {
    need(user, 'conteudos.gerir');
    if (!old) throw bad('Os conteúdos entram pelo carregamento de ficheiros.');
    const folder = d.folder === undefined ? (old.folder || null) : (d.folder || null);
    if (folder && !getDoc('folders', folder)) throw bad('Pasta inexistente.');
    const n = Object.assign({}, old, { folder });
    const wantHouse = d.house === undefined ? !!old.house : !!d.house;
    if (wantHouse !== !!old.house) {
      if (!user.admin) throw new HttpError(403, 'Só o administrador pode fazer isto.');
      n.house = wantHouse;
    }
    const scr = d.screens === undefined ? null : d.screens;
    const changedScreens = scr !== null && !same(scr, old.screens || null);
    if (changedScreens && (old.house || n.house) && !user.admin) throw new HttpError(403, 'Só o administrador pode alterar este conteúdo.');
    if (changedScreens || (n.house && !old.house)) n.screens = checkContentScreens(n, changedScreens ? scr : (old.screens || docs('screens').map(x => x.id)));
    putDoc('contents', id, n);
    if (folder !== (old.folder || null)) audit(user, 'Moveu um conteúdo de pasta', old.name);
    if (n.house !== !!old.house) audit(user, n.house ? 'Marcou como spot da Enif' : 'Deixou de ser spot da Enif', old.name);
    if (changedScreens) audit(user, 'Alterou os ecrãs de um conteúdo', old.name + ' → ' + n.screens.join(', '));
  } else if (coll === 'folders') {
    need(user, 'conteudos.gerir');
    const name = str(d.name, 80, 'Nome da pasta'); if (!name) throw bad('Dê um nome à pasta.');
    if (docs('folders').some(p => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw bad('Já existe uma pasta com esse nome.');
    putDoc('folders', id, { id, name });
    audit(user, old ? 'Renomeou a pasta' : 'Criou a pasta', name);
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
    if (!old) audit(user, 'Criou o utilizador', n.name);
    else if (!self || pass) audit(user, 'Atualizou o utilizador', n.name + (pass ? ' (palavra-passe redefinida pelo administrador)' : ''));
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
    if (lv.disk_total > 0) {
      o.disk = { free: lv.disk_free, total: lv.disk_total };
      if (lv.disk_free / lv.disk_total < 0.1) { const dk = 'disk-' + s.id + '-' + ln.date; if (!resolved.has(dk)) alerts.push({ id: dk, sev: 'warn', screen: s.id, title: 'Disco quase cheio', detail: 'Só restam ' + lv.disk_free + ' GB livres no PC deste ecrã (de ' + lv.disk_total + ' GB). Liberte espaço ou use um disco maior.', time: fmtHM(now) }); }
    }
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
  const st = {
    me: publicUser(user), now: S.lisbonNow(TZ), serverTime: Date.now(), tz: TZ,
    screens: sv.screens, alerts: sv.alerts, campaigns: docs('campaigns'), contents: docs('contents', true), folders: docs('folders'),
    users: user.admin ? docs('users') : [], playerVersion: PLAYER_VERSION, smtpReady: smtpReady()
  };
  if (user.admin) {
    st.auditLog = q('SELECT ts,who,ip,what,detail FROM audit ORDER BY id DESC LIMIT 300').map(a => ({ t: a.ts, who: a.who, what: a.what, detail: a.detail }));
    st.backups = backupList(10); st.emailLog = emailList();
  }
  try { const d = fs.statfsSync(DATA); st.serverDisk = { free: Number(d.bavail) * Number(d.bsize), total: Number(d.blocks) * Number(d.bsize) }; } catch (e) { /* sem informação */ }
  return st;
}

/* ---------- playlist de um ecrã (player) ---------- */
/* Para cada hora de hoje e de amanhã: { seq:[entradas da volta, por ordem], spot5 } ou null (ecrã desligado).
   Entrada de campanha: { c, n, dur, items:[ficheiros, por ordem de alternância] }.
   Entrada de spot da Enif: { c:'__spot', spot:true, dur, files:[…] } (com 2 spots, alternam volta a volta).
   spot5: o spot que interrompe o loop a cada SPOT_GAP segundos quando o ecrã está cheio. */
function playlistFor(scr) {
  const camps = docs('campaigns'), ctx = sharedCtx();
  const now = S.lisbonNow(TZ), days = {}, used = {};
  [now.date, S.addDay(now.date, 1)].forEach(d => {
    days[d] = S.dayLoops(scr, camps, d, ctx, now.date);
    Object.values(days[d]).forEach(l => { if (l) l.seq.concat(l.spot5 ? [l.spot5] : []).forEach(e => (e.spot ? e.files : e.items).forEach(f => { used[f] = 1; })); });
  });
  const files = {};
  Object.keys(used).forEach(id => {
    const f = getDoc('contents', id), fl = q1('SELECT * FROM files WHERE id=?', id);
    if (f && fl) files[id] = { name: f.name, type: f.type, dur: f.secs || 10, size: fl.size, mime: fl.mime, res: f.res, spot: !!f.house };
  });
  const keep = e => { if (e.spot) e.files = e.files.filter(f => files[f]); else e.items = e.items.filter(f => files[f]); return e.spot ? e.files.length > 0 : e.items.length > 0; };
  Object.values(days).forEach(day => Object.keys(day).forEach(h => {      // retira ficheiros que já não existem
    const l = day[h]; if (!l) return;
    l.seq = l.seq.filter(keep);
    if (l.spot5 && !keep(l.spot5)) l.spot5 = null;
    if (!l.seq.length) l.spot5 = null;
  }));
  const lv = q1('SELECT reload FROM live WHERE screen=?', scr.id);
  return { playerVersion: PLAYER_VERSION, tz: TZ, generated: Date.now(), reload: lv ? lv.reload : 0, spotGap: S.SPOT_GAP,
    screen: { code: scr.id, venue: scr.venue, spot: scr.spot, res: scr.res, fit: scr.fit || 'caber', bri: scr.bri || null }, days, files };
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
    const dk = body.disk && +body.disk.total > 0 ? { f: Math.round(+body.disk.free) || 0, t: Math.round(+body.disk.total) } : null;
    run(`INSERT INTO live(screen,first_seen,last_seen,now_c,now_f,ver,queue,w,h,disk_free,disk_total) VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(screen) DO UPDATE SET last_seen=excluded.last_seen, now_c=excluded.now_c, now_f=excluded.now_f, ver=excluded.ver, queue=excluded.queue, w=excluded.w, h=excluded.h,
         disk_free=COALESCE(excluded.disk_free,disk_free), disk_total=COALESCE(excluded.disk_total,disk_total)`,
      s.id, now, now, body.c || null, body.f || null, String(body.ver || ''), +body.queue || 0, w, h, dk ? dk.f : null, dk ? dk.t : null);
    if (+body.ack > 0) run('DELETE FROM cmds WHERE screen=? AND id<=?', s.id, +body.ack);
    run('INSERT OR IGNORE INTO beats(screen,minute) VALUES(?,?)', s.id, Math.floor(now / 60000));
    if (s.res === 'auto' && w && h && w >= 240 && h >= 240) putDoc('screens', s.id, Object.assign({}, s, { res: w + '×' + h }));
    const lv2 = q1('SELECT reload FROM live WHERE screen=?', s.id);
    return send(res, 200, { ok: true, serverTime: now, reload: lv2 ? lv2.reload : 0, cmds: q('SELECT id,kind FROM cmds WHERE screen=? ORDER BY id', s.id) });
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
  const wantHouse = u.searchParams.get('house') === '1';
  if (wantHouse && !user.admin) throw new HttpError(403, 'Só o administrador pode fazer isto.');
  const screenIds = String(u.searchParams.get('screens') || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!screenIds.length) throw bad('Escolha pelo menos um ecrã.');
  const declared = +req.headers['content-length'] || 0;
  if (declared > MAX_UPLOAD) throw new HttpError(413, 'O ficheiro é demasiado grande (máximo ' + Math.round(MAX_UPLOAD / 1048576) + ' MB).');
  const folder = u.searchParams.get('folder') || null;
  if (folder && !getDoc('folders', folder)) throw bad('Pasta inexistente.');
  const id = 'F' + uid(5), file = path.join(MEDIA, id);
  let n = 0;
  await new Promise((ok, ko) => {
    const w = fs.createWriteStream(file);
    req.on('data', c => { n += c.length; if (n > MAX_UPLOAD) { ko(new HttpError(413, 'O ficheiro é demasiado grande.')); req.destroy(); w.destroy(); } });
    req.pipe(w); w.on('finish', ok); w.on('error', ko); req.on('error', ko); req.on('aborted', () => ko(bad('Envio interrompido.')));
  }).catch(e => { try { fs.unlinkSync(file); } catch (x) { } throw e; });
  const drop = () => { try { fs.unlinkSync(file); } catch (x) { } };
  if (!n) { drop(); throw bad('Ficheiro vazio.'); }
  // o servidor lê a resolução e a duração do próprio ficheiro; só se não conseguir usa o que o browser disse
  const got = await M.probe(file, type);
  const hint = /^\d{2,5}×\d{2,5}$/.test(u.searchParams.get('res') || '') ? u.searchParams.get('res') : '';
  const resTxt = html ? 'Responsivo' : (got.res || hint || 'Por detetar');
  const secs0 = got.secs || Math.round((+u.searchParams.get('secs') || 0) * 10) / 10;
  const dur = type === 'Imagem' ? 10 : (secs0 > 0 ? secs0 : 10);
  const doc = { id, name, type, res: resTxt, dur: type === 'Imagem' ? '' : Math.round(dur) + ' s', secs: dur, size: sizeTxt(n), bytes: n, folder, ready: true, house: wantHouse };
  try { doc.screens = checkContentScreens(doc, screenIds); } catch (e) { drop(); throw e; }
  db.exec('BEGIN');
  try { run('INSERT INTO files(id,mime,size) VALUES(?,?,?)', id, mime, n); putDoc('contents', id, doc); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); drop(); throw e; }
  audit(user, 'Carregou conteúdos', name + (wantHouse ? ' (spot da Enif)' : ''));
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


/* ---------- administrador inicial (vem de ficheiro ou variáveis; nunca da internet) ---------- */
function adminFromConfig() {
  let c = {};
  const file = process.env.CONFIG_FILE || path.join(__dirname, 'enif-config.json');
  try { if (fs.existsSync(file)) c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('Não consegui ler ' + file + ': ' + e.message); }
  const name = String(process.env.ADMIN_NAME || c.nome || '').trim(), email = String(process.env.ADMIN_EMAIL || c.email || '').trim().toLowerCase(), pass = String(process.env.ADMIN_PASS || c.palavraPasse || '');
  return name && validEmail(email) && pass.length >= 6 ? { name, email, pass, file } : null;
}
function seedAdmin(reset) {
  const a = adminFromConfig();
  if (userCount() > 0 && !reset) return 'existe';
  if (!a) return userCount() > 0 ? 'sem-config' : 'falta';
  const old = docs('users').find(u => u.email === a.email), id = old ? old.id : 'u' + uid(4), h = A.hashPassword(a.pass);
  db.exec('BEGIN');
  try {
    putDoc('users', id, Object.assign({}, old || {}, { id, name: old ? old.name : a.name, email: a.email, admin: true, perms: A.PERMS.slice(), until: null, active: true }, reset ? { twoFA: false } : {}));
    setSecret('users', id, h.salt, h.hash); run('DELETE FROM sessions WHERE user=?', id); db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return old ? 'reposto' : 'criado';
}
const SEED = seedAdmin(process.argv.includes('--reset-admin'));
/* e-mail de recuperação do administrador: vem do ficheiro de configuração, se ainda não houver um guardado */
(function () {
  const rec = String(readConfig().emailRecuperacao || '').trim().toLowerCase(); if (!validEmail(rec)) return;
  docs('users').filter(x => x.admin && !x.recovery).forEach(x => putDoc('users', x.id, Object.assign({}, x, { recovery: rec })));
})();

/* ---------- tabelas de segurança e de envios ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS chal(id TEXT PRIMARY KEY, kind TEXT NOT NULL, user TEXT, salt TEXT, hash TEXT, exp INTEGER NOT NULL, tries INTEGER DEFAULT 0, data TEXT);
CREATE TABLE IF NOT EXISTS emails(id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, camp TEXT, camp_name TEXT, to_addr TEXT NOT NULL, subject TEXT NOT NULL, msg_id TEXT, file TEXT, bytes INTEGER, sha TEXT);
CREATE TRIGGER IF NOT EXISTS emails_no_update BEFORE UPDATE ON emails BEGIN SELECT RAISE(ABORT, 'O registo de envios só se acrescenta'); END;
CREATE TRIGGER IF NOT EXISTS emails_no_delete BEFORE DELETE ON emails BEGIN SELECT RAISE(ABORT, 'O registo de envios só se acrescenta'); END;
CREATE TABLE IF NOT EXISTS email_events(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, ts INTEGER NOT NULL, st TEXT NOT NULL, txt TEXT);
CREATE TRIGGER IF NOT EXISTS email_events_no_update BEFORE UPDATE ON email_events BEGIN SELECT RAISE(ABORT, 'O registo de envios só se acrescenta'); END;
CREATE TRIGGER IF NOT EXISTS email_events_no_delete BEFORE DELETE ON email_events BEGIN SELECT RAISE(ABORT, 'O registo de envios só se acrescenta'); END;
`);
const BACKUPS = path.join(DATA, 'backups'), REPORTS = path.join(DATA, 'reports');
fs.mkdirSync(BACKUPS, { recursive: true }); fs.mkdirSync(REPORTS, { recursive: true });
const END_WARN = 7;                      // dias antes do fim em que se avisa o comercial

/* ---------- configuração do e-mail (ficheiro enif-config.json ou variáveis; nunca vai para o GitHub) ---------- */
function readConfig() {
  const file = process.env.CONFIG_FILE || path.join(__dirname, 'enif-config.json');
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* já avisado no arranque */ }
  return {};
}
function smtpCfg() {
  const c = readConfig().smtp || {}, e = process.env;
  const host = String(e.SMTP_HOST || c.servidor || '').trim(); if (!host) return null;
  const port = +(e.SMTP_PORT || c.porta) || 587, secure = e.SMTP_SECURE != null ? e.SMTP_SECURE === '1' : (c.seguro != null ? !!c.seguro : port === 465);
  const user = String(e.SMTP_USER || c.utilizador || ''), pass = String(e.SMTP_PASS || c.palavraPasse || ''), from = String(e.SMTP_FROM || c.de || user || '').trim();
  if (!from || !/@/.test(from)) return null;
  return { host, port, secure, user, pass, from, allowPlain: e.SMTP_PLAIN === '1' || c.semCifra === true, rejectUnauthorized: e.SMTP_INSECURE !== '1' };
}
const smtpReady = () => !!smtpCfg();

/* ---------- desafios (códigos de 6 dígitos): entrada em dois passos, recuperação, mudança do e-mail de recuperação ---------- */
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function newChallenge(kind, userId, ttlMs, data) {
  const id = uid(16), code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'), salt = uid(8);
  run('DELETE FROM chal WHERE exp<?', Date.now());
  if (userId) run('DELETE FROM chal WHERE user=? AND kind=?', userId, kind);
  run('INSERT INTO chal(id,kind,user,salt,hash,exp,tries,data) VALUES(?,?,?,?,?,?,0,?)', id, kind, userId || null, salt, sha(salt + code), Date.now() + ttlMs, data ? JSON.stringify(data) : null);
  return { id, code };
}
/* confere o código; 5 erros ou expirado = desafio apagado. Não apaga quando certo (quem chama apaga depois de agir). */
function checkChallenge(id, kind, code) {
  const c = q1('SELECT * FROM chal WHERE id=? AND kind=?', String(id || ''), kind);
  if (!c) throw new HttpError(400, 'Código incorreto ou expirado. Peça um novo.');
  if (c.exp < Date.now()) { run('DELETE FROM chal WHERE id=?', c.id); throw new HttpError(400, 'O código expirou. Peça um novo.'); }
  const a = Buffer.from(sha(c.salt + String(code || '').trim())), b = Buffer.from(c.hash);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
    run('UPDATE chal SET tries=tries+1 WHERE id=?', c.id);
    if (c.tries + 1 >= 5) { run('DELETE FROM chal WHERE id=?', c.id); audit(null, 'Código falhado 5 vezes', kind + ' · ' + (c.user || '')); throw new HttpError(400, 'Demasiadas tentativas. Peça um novo código.'); }
    throw new HttpError(400, 'Código incorreto.');
  }
  return Object.assign({}, c, { data: c.data ? JSON.parse(c.data) : null });
}
async function mailCode(to, subject, text) {
  const cfg = smtpCfg(); if (!cfg) throw new HttpError(503, 'O envio de e-mail ainda não está configurado no servidor.');
  try { await MAIL.send(cfg, { to, subject, text }); } catch (e) { console.error('E-mail de código falhou:', e.message); throw new HttpError(503, 'Não foi possível enviar o e-mail com o código. Tente de novo daqui a pouco.'); }
}
const codeText = (code, why, min) => 'Olá,\n\n' + why + '\n\nCódigo: ' + code + '\n\nÉ válido durante ' + min + ' minutos. Se não foi você, ignore esta mensagem e não partilhe o código com ninguém.\n\nEnif DOOH';
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const minPass = p => { if (String(p || '').length < 10) throw bad('A palavra-passe precisa de pelo menos 10 caracteres.'); return String(p); };
function setPassword(userId, pass) {
  const h = A.hashPassword(pass); setSecret('users', userId, h.salt, h.hash); run('DELETE FROM sessions WHERE user=?', userId);
}

/* ---------- registo de envios ao comercial (imutável; só se acrescentam passos) ---------- */
function emailEvent(id, st, txt) { run('INSERT INTO email_events(email,ts,st,txt) VALUES(?,?,?,?)', id, Date.now(), st, String(txt || '').slice(0, 500)); }
function emailList() {
  const evs = q('SELECT email,ts,st,txt FROM email_events ORDER BY id'), by = {};
  evs.forEach(e => { (by[e.email] = by[e.email] || []).push({ st: e.st, t: e.ts, txt: e.txt }); });
  return q('SELECT * FROM emails ORDER BY ts DESC LIMIT 500').map(e => ({ id: e.id, kind: e.kind, camp: e.camp, campName: e.camp_name, to: e.to_addr, subject: e.subject, msgId: e.msg_id, file: e.file || '', kb: e.bytes ? Math.max(1, Math.round(e.bytes / 1024)) : 0, sha: e.sha || '', events: by[e.id] || [] }));
}
const slug = n => String(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const dPt = d => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
const dayDiff = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 864e5);

async function finalReportPdf(c) {
  const scrs = docs('screens').filter(s => c.venues.indexOf(s.venue) > -1);
  const rows = scrs.length ? q(`SELECT screen s, camp c, file f, day d, hour h, SUM(ok) n, COUNT(*)-SUM(ok) bad, ROUND(SUM(CASE WHEN ok=1 THEN dur ELSE 0 END)) sec FROM plays WHERE day>=? AND day<=? AND screen IN (${scrs.map(() => '?').join(',')}) GROUP BY screen,camp,file,day,hour`, c.start, c.end, ...scrs.map(s => s.id)) : [];
  const files = {}, tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'enif-pdf-'));
  try {
    const ids = [...new Set(rows.filter(r => r.c === c.id).map(r => r.f))];
    for (const id of ids) {
      const f = getDoc('contents', id); if (!f) continue;
      const out = path.join(tmp, id + '.jpg'); let jpg = null;
      try { if (await M.jpegStill(path.join(MEDIA, path.basename(id)), f.type, out, 2)) jpg = fs.readFileSync(out); } catch (e) { }
      files[id] = { name: f.name, jpg };
    }
    return REPORT.buildReport(c, rows, scrs, files, Date.now());
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
/* envia (ou tenta) uma mensagem ao comercial e regista cada passo. Devolve o id do registo. */
async function sendToSales(c, kind, to) {
  const cfg = smtpCfg(); if (!cfg) return null;
  const av = kind === 'aviso', n = dayDiff(c.end, todayStr());
  const subject = av ? 'A campanha «' + c.name + '» termina ' + (n <= 0 ? 'hoje' : n === 1 ? 'amanhã' : 'a ' + dPt(c.end)) : 'Relatório final da campanha «' + c.name + '»';
  const text = av
    ? 'Olá,\n\nA campanha «' + c.name + '» (' + c.client + ') termina ' + (n <= 0 ? 'hoje' : 'a ' + dPt(c.end)) + '. Se o cliente quiser renovar ou continuar, esta é a altura de falar com ele.\n\nO relatório final com as imagens da campanha segue na manhã a seguir ao fim.\n\nEnif DOOH - Visibilidade com Inteligência'
    : 'Olá,\n\nSegue em anexo o relatório final da campanha «' + c.name + '» (' + c.client + '), de ' + dPt(c.start) + ' a ' + dPt(c.end) + ', com as passagens, as visualizações estimadas e as imagens dos conteúdos.\n\nEnif DOOH - Visibilidade com Inteligência';
  let att = null, file = '', digest = '';
  const id = 'E' + Date.now().toString(36) + uid(3), msgId = '<' + uid(16) + '@' + (cfg.from.split('@')[1] || 'enif.pt').replace(/[>\s]/g, '') + '>';
  if (!av) {
    try { att = await finalReportPdf(c); } catch (e) { console.error('PDF falhou:', e); }
    if (!att) { run('INSERT INTO emails(id,ts,kind,camp,camp_name,to_addr,subject,msg_id,file,bytes,sha) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, Date.now(), kind, c.id, c.name, to, subject, msgId, '', 0, ''); emailEvent(id, 'Falhou', 'Não foi possível gerar o PDF do relatório.'); return id; }
    file = 'relatorio-final-' + slug(c.name) + '.pdf'; digest = sha(att);
    fs.writeFileSync(path.join(REPORTS, id + '.pdf'), att);
  }
  run('INSERT INTO emails(id,ts,kind,camp,camp_name,to_addr,subject,msg_id,file,bytes,sha) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, Date.now(), kind, c.id, c.name, to, subject, msgId, file, att ? att.length : 0, digest);
  emailEvent(id, 'Agendado', av ? 'Aviso enviado automaticamente a ' + Math.max(0, n) + (n === 1 ? ' dia' : ' dias') + ' do fim da campanha' : 'Envio iniciado automaticamente no fim da campanha');
  try {
    const r = await MAIL.send(cfg, { to, subject, text, messageId: msgId, attachments: att ? [{ name: file, type: 'application/pdf', data: att }] : [] });
    emailEvent(id, 'Enviado', 'Aceite pelo servidor de e-mail: ' + r.response);
    audit('sistema', av ? 'Aviso de fim de campanha enviado ao comercial' : 'Relatório final enviado ao comercial', c.name + ' → ' + to);
  } catch (e) {
    emailEvent(id, 'Falhou', (e.smtp || e.message || 'Erro').toString().split('\n').pop());
    audit('sistema', av ? 'Aviso de fim de campanha falhou' : 'Relatório final falhou', c.name + ' → ' + to + ' · ' + e.message);
  }
  return id;
}

/* ---------- cópias de segurança (base de dados + ficheiros) ---------- */
const stampOf = d => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
function backupList(limit) {
  return fs.readdirSync(BACKUPS).filter(n => /^enif-\d{8}-\d{6}-(auto|manual)\.db$/.test(n)).map(n => { const st = fs.statSync(path.join(BACKUPS, n)); return { name: n, t: st.mtimeMs, mb: Math.max(0.1, Math.round(st.size / 104857.6) / 10), auto: /-auto\.db$/.test(n), ok: true }; })
    .sort((a, b) => b.t - a.t).slice(0, limit || 10);
}
function backupNow(auto) {
  const name = 'enif-' + stampOf(new Date()) + (auto ? '-auto' : '-manual') + '.db', file = path.join(BACKUPS, name);
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  db.prepare('VACUUM INTO ?').run(file);
  const md = path.join(BACKUPS, 'media'); fs.mkdirSync(md, { recursive: true });
  let copied = 0; fs.readdirSync(MEDIA).forEach(f => { const to = path.join(md, f); if (!fs.existsSync(to)) { fs.copyFileSync(path.join(MEDIA, f), to + '.part'); fs.renameSync(to + '.part', to); copied++; } });
  const old = Date.now() - 30 * 864e5;                                                    // mantém 30 dias
  fs.readdirSync(BACKUPS).forEach(n => { if (/^enif-.*\.db$/.test(n) && fs.statSync(path.join(BACKUPS, n)).mtimeMs < old) fs.unlinkSync(path.join(BACKUPS, n)); });
  fs.readdirSync(REPORTS).forEach(() => { });                                              // os PDF enviados ficam sempre (são comprovativo)
  return { name, mb: Math.max(0.1, Math.round(fs.statSync(file).size / 104857.6) / 10), files: copied };
}

/* ---------- tarefas agendadas: cópia à noite, avisos e relatórios finais ---------- */
let ticking = false;
async function tick(force) {
  if (ticking) return; ticking = true;
  try {
    const ln = S.lisbonNow(TZ), today = ln.date;
    if ((ln.h > 3 || (ln.h === 3 && ln.m >= 30)) && !backupList(100).some(b => b.auto && S.lisbonNow(TZ, new Date(b.t)).date === today)) {
      try { const b = backupNow(true); audit('sistema', 'Cópia de segurança automática', b.mb + ' MB'); } catch (e) { console.error('Cópia de segurança falhou:', e.message); audit('sistema', 'Cópia de segurança automática falhou', e.message); }
    }
    if (!smtpReady()) return;
    for (const c0 of docs('campaigns')) {
      if (!c0.sales) continue;
      const upd = patch => { const cur = getDoc('campaigns', c0.id); if (cur) { Object.assign(cur, patch); putDoc('campaigns', c0.id, cur); } };
      const n = dayDiff(c0.end, today);
      if (c0.start <= today && n >= 0 && n <= END_WARN && c0.warnFor !== c0.end) { upd({ warnFor: c0.end }); await sendToSales(c0, 'aviso', c0.sales); continue; }
      if (c0.end < today && c0.salesSentFor !== c0.end && dayDiff(today, c0.end) <= 30 && (ln.h >= 8 || force)) {
        const tries = c0.salesTryFor === c0.end ? (c0.salesTries || 0) : 0;
        if (tries >= 3 || Date.now() - (c0.salesTryAt || 0) < 3600e3) continue;
        upd({ salesTryFor: c0.end, salesTries: tries + 1, salesTryAt: Date.now() });
        const id = await sendToSales(c0, 'final', c0.sales);
        const last = id && q1('SELECT st FROM email_events WHERE email=? ORDER BY id DESC LIMIT 1', id);
        if (last && last.st === 'Enviado') upd({ salesSentFor: c0.end, salesSentAt: Date.now() });
      }
    }
  } catch (e) { console.error('Tarefas agendadas:', e); } finally { ticking = false; }
}

/* ---------- rotas ---------- */
const router = async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method; let r;
  if (p === '/health') return send(res, 200, { ok: true });
  if (p === '/') { res.writeHead(302, { Location: '/app/' }); return res.end(); }
  if (p === '/api/status') return send(res, 200, { setup: false });
  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req), email = String(b.email || '').trim().toLowerCase(), ip = ipOf(req);
    if (loginLimit.blocked(email)) throw new HttpError(429, 'Demasiadas tentativas. Tente daqui a alguns minutos.');
    const user = docs('users').find(x => x.email === email), sc = user && secret('users', user.id);
    if (!user || !A.checkPassword(String(b.pass || ''), sc && sc.a, sc && sc.b)) { loginLimit.fail(email); audit('—', 'Tentativa de entrada falhada', email || '(sem e-mail)', ip); throw new HttpError(401, 'E-mail ou palavra-passe incorretos.'); }
    const err = accessError(user); if (err) throw new HttpError(403, err);
    if (user.twoFA) {                                                            // segundo passo: código enviado por e-mail
      const ch = newChallenge('login', user.id, 10 * 60 * 1000);
      await mailCode(user.recovery || user.email, 'O seu código de entrada no Enif DOOH', codeText(ch.code, 'Pediram para entrar na sua conta do Enif DOOH.', 10));
      return send(res, 200, { step: 'code', ch: ch.id });
    }
    loginLimit.ok(email); audit(user, 'Entrou', '', ip);
    return send(res, 200, { token: newSession(user.id) });
  }
  if (p === '/api/login/code' && m === 'POST') {
    const b = await readJson(req), c = checkChallenge(b.ch, 'login', b.code), user = getDoc('users', c.user);
    if (!user || accessError(user)) throw new HttpError(403, 'Esta conta não pode entrar.');
    run('DELETE FROM chal WHERE id=?', c.id); loginLimit.ok(user.email); audit(user, 'Entrou (com código por e-mail)', '', ipOf(req));
    return send(res, 200, { token: newSession(user.id) });
  }
  if (p === '/api/forgot' && m === 'POST') {                                      // a resposta é igual para qualquer e-mail
    const b = await readJson(req), email = String(b.email || '').trim().toLowerCase(), ip = ipOf(req);
    if (loginLimit.blocked('f:' + email) || loginLimit.blocked('f:ip:' + ip)) throw new HttpError(429, 'Demasiados pedidos. Tente daqui a alguns minutos.');
    loginLimit.fail('f:' + email); loginLimit.fail('f:ip:' + ip);
    const user = docs('users').find(x => x.admin && x.active && x.email === email);
    if (user) {
      const ch = newChallenge('forgot', user.id, 15 * 60 * 1000);
      audit(user, 'Pediu recuperação da palavra-passe', '', ip);
      try { await mailCode(user.recovery || user.email, 'Recuperar a palavra-passe do Enif DOOH', codeText(ch.code, 'Pediram para recuperar a palavra-passe da sua conta do Enif DOOH.', 15)); } catch (e) { audit('sistema', 'Falhou o envio do código de recuperação', e.message); }
      return send(res, 200, { ch: ch.id });
    }
    audit('—', 'Pedido de recuperação para e-mail sem conta de administrador', email || '(sem e-mail)', ip);
    return send(res, 200, { ch: uid(16) });
  }
  if (p === '/api/forgot/confirm' && m === 'POST') {
    const b = await readJson(req), c = checkChallenge(b.ch, 'forgot', b.code), pass = minPass(b.pass), user = getDoc('users', c.user);
    if (!user || !user.admin) throw new HttpError(400, 'Código incorreto ou expirado. Peça um novo.');
    setPassword(user.id, pass); run('DELETE FROM chal WHERE id=?', c.id); loginLimit.ok(user.email);
    audit(user, 'Recuperou a palavra-passe pelo e-mail', '', ipOf(req));
    return send(res, 200, { ok: true });
  }
  if (p.startsWith('/api/me/') && m === 'POST') {
    const user = needUser(req, u), b = await readJson(req); if (!user.admin) throw new HttpError(403, 'Só o administrador pode fazer isto.');
    const save = patch => putDoc('users', user.id, Object.assign({}, getDoc('users', user.id), patch));
    if (p === '/api/me/password') {
      const sc = secret('users', user.id);
      if (!A.checkPassword(String(b.old || ''), sc && sc.a, sc && sc.b)) throw bad('A palavra-passe atual não está certa.');
      const pass = minPass(b.pass); if (pass === String(b.old)) throw bad('A nova palavra-passe tem de ser diferente da atual.');
      setPassword(user.id, pass); audit(user, 'Mudou a própria palavra-passe', '', ipOf(req));
      return send(res, 200, { token: newSession(user.id) });                       // as outras sessões terminam; esta continua
    }
    if (p === '/api/me/twofa') {
      const on = !!b.on;
      if (on && !smtpReady()) throw new HttpError(503, 'O envio de e-mail ainda não está configurado no servidor. Sem isso não é possível ligar a verificação em dois passos.');
      save({ twoFA: on }); audit(user, on ? 'Ligou a verificação em dois passos' : 'Desligou a verificação em dois passos', '', ipOf(req));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/me/recovery') {                                                // o novo e-mail só vale depois de confirmado com um código lá enviado
      const to = String(b.email || '').trim().toLowerCase(); if (!validEmail(to)) throw bad('Indique um e-mail válido.');
      const ch = newChallenge('recovery', user.id, 15 * 60 * 1000, { to });
      await mailCode(to, 'Confirmar o e-mail de recuperação do Enif DOOH', codeText(ch.code, 'Pediram para usar este e-mail como e-mail de recuperação da conta de administrador do Enif DOOH.', 15));
      audit(user, 'Pediu para mudar o e-mail de recuperação', to, ipOf(req));
      return send(res, 200, { ch: ch.id });
    }
    if (p === '/api/me/recovery/confirm') {
      const c = checkChallenge(b.ch, 'recovery', b.code); if (c.user !== user.id) throw new HttpError(400, 'Código incorreto ou expirado.');
      save({ recovery: c.data.to }); run('DELETE FROM chal WHERE id=?', c.id); audit(user, 'Mudou o e-mail de recuperação', c.data.to, ipOf(req));
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Não encontrado');
  }
  if (p === '/api/backup-now' && m === 'POST') {
    const user = needUser(req, u); if (!user.admin) throw new HttpError(403, 'Só o administrador pode fazer isto.');
    const b = backupNow(false); audit(user, 'Fez uma cópia de segurança', b.mb + ' MB', ipOf(req)); return send(res, 200, b);
  }
  if (p === '/api/audit.csv' && m === 'GET') {
    const user = needUser(req, u); if (!user.admin) throw new HttpError(403, 'Só o administrador pode fazer isto.');
    const qq = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"', fmtL = t => new Intl.DateTimeFormat('pt-PT', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(t));
    const rows = [['Data e hora (Lisboa)', 'Data e hora (UTC)', 'Quem', 'O quê', 'Detalhe', 'IP']].concat(q('SELECT * FROM audit ORDER BY id DESC').map(a => [fmtL(a.ts), new Date(a.ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC', a.who, a.what, a.detail, a.ip]));
    return send(res, 200, '﻿' + rows.map(x => x.map(qq).join(';')).join('\r\n'), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="registo-de-auditoria-' + todayStr() + '.csv"' });
  }
  if ((r = /^\/api\/emails\/(\w+)\/(file|retry)$/.exec(p))) {
    const user = needUser(req, u); if (!user.admin) throw new HttpError(403, 'Só o administrador pode fazer isto.');
    const e = q1('SELECT * FROM emails WHERE id=?', r[1]); if (!e) throw new HttpError(404, 'Envio não existe');
    if (r[2] === 'file' && m === 'GET') {
      const f = path.join(REPORTS, path.basename(e.id) + '.pdf'); if (!e.file || !fs.existsSync(f)) throw new HttpError(404, 'Sem ficheiro');
      return send(res, 200, fs.readFileSync(f), 'application/pdf', { 'Content-Disposition': 'attachment; filename="' + e.file + '"' });
    }
    if (r[2] === 'retry' && m === 'POST') {
      const c = getDoc('campaigns', e.camp); if (!c) throw new HttpError(404, 'A campanha já não existe.');
      if (!smtpReady()) throw new HttpError(503, 'O envio de e-mail ainda não está configurado no servidor.');
      const id = await sendToSales(c, e.kind, e.to_addr), last = id && q1('SELECT st FROM email_events WHERE email=? ORDER BY id DESC LIMIT 1', id);
      if (e.kind === 'final' && last && last.st === 'Enviado') { const cur = getDoc('campaigns', c.id); putDoc('campaigns', c.id, Object.assign(cur, { salesSentFor: c.end, salesSentAt: Date.now() })); }
      audit(user, 'Repetiu um envio ao comercial', c.name + ' → ' + e.to_addr, ipOf(req));
      return send(res, 200, { ok: true, id });
    }
  }
  if (p === '/api/logout' && m === 'POST') {
    const h = String(req.headers.authorization || ''); if (h.startsWith('Bearer ')) run('DELETE FROM sessions WHERE token=?', h.slice(7));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/state' && m === 'GET') return send(res, 200, buildState(needUser(req, u)));
  if (p === '/api/sync' && m === 'POST') { const user = needUser(req, u), b = await readJson(req); sync(user, b.ops); return send(res, 200, { ok: true }); }
  if (p === '/api/upload' && m === 'PUT') return upload(req, res, u);
  if (p === '/api/plays' && m === 'GET') return playsApi(res, u, needUser(req, u));
  if ((r = /^\/api\/screens\/([\w.\-]+)\/restart$/.exec(p)) && m === 'POST') {
    const user = needUser(req, u); need(user, 'ecras.gerir');
    if (!getDoc('screens', r[1])) throw new HttpError(404, 'Ecrã não existe');
    run('INSERT INTO live(screen,reload) VALUES(?,1) ON CONFLICT(screen) DO UPDATE SET reload=reload+1', r[1]);
    audit(user, 'Reiniciou o player', r[1]);
    return send(res, 200, { ok: true });
  }
  if ((r = /^\/api\/screens\/([\w.\-]+)\/(sync-now|test)$/.exec(p)) && m === 'POST') {
    const user = needUser(req, u);
    if (r[2] === 'test') need(user, 'ecras.gerir'); else if (!A.can(user, 'ecras.gerir') && !A.can(user, 'playlist.gerir')) throw new HttpError(403, 'Não tem permissão para esta ação.');
    const sc = getDoc('screens', r[1]); if (!sc) throw new HttpError(404, 'Ecrã não existe');
    run('DELETE FROM cmds WHERE screen=? AND kind=?', sc.id, r[2]);
    run('INSERT INTO cmds(screen,kind,ts) VALUES(?,?,?)', sc.id, r[2], Date.now());
    audit(user, r[2] === 'test' ? 'Teste no ecrã' : 'Atualizar agora no ecrã', sc.id + ' · ' + sc.venue);
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
  if (SEED === 'falta') {
    console.error('\nFalta a conta de administrador. Crie o ficheiro enif-config.json ao lado do server.js com:\n\n  { "nome": "O seu nome", "email": "o.seu@email.pt", "palavraPasse": "uma palavra-passe forte" }\n\ne volte a arrancar. (Este ficheiro nunca vai para o GitHub.)\n');
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log('Enif DOOH a correr em http://localhost:' + PORT + '/');
    setTimeout(tick, 5000); setInterval(tick, 60000);
    if (SEED === 'criado') console.log('Conta de administrador criada. Pode apagar a palavra-passe do enif-config.json.');
    if (SEED === 'reposto') console.log('Palavra-passe do administrador reposta. Pode apagá-la do enif-config.json.');
  });
}
module.exports = { server, db, playlistFor, buildState, tick, backupNow, sendToSales, finalReportPdf };
