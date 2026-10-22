'use strict';
/* Leitura (só leitura) de um calendário Google através do endereço secreto no formato iCal (.ics).
   Sem dependências: lê o ficheiro, expande eventos repetidos (RRULE) e devolve só os eventos
   que começam na janela pedida. O endereço nunca sai do servidor. */
const https = require('node:https'), crypto = require('node:crypto');

const unfold = t => t.replace(/\r?\n[ \t]/g, '');
const unesc = v => String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/* deslocamento (ms) de um fuso horário numa data UTC */
function tzOffset(tz, utcMs) {
  try {
    const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utcMs)).forEach(x => { p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
  } catch (e) { return 0; }
}
/* DTSTART/EXDATE → milissegundos UTC. params: texto depois de «;» (ex.: TZID=Europe/Lisbon) */
function parseDate(val, params, homeTz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(val).trim());
  if (!m) return null;
  const allDay = m[4] === undefined, p = [+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)];
  const asUtc = Date.UTC(p[0], p[1], p[2], p[3], p[4], p[5]);
  if (m[7]) return { t: asUtc, allDay: false, utc: true };
  const tz = (/TZID=([^;:]+)/i.exec(params || '') || [])[1] || homeTz || 'Europe/Lisbon';
  let t = asUtc - tzOffset(tz, asUtc);
  t = asUtc - tzOffset(tz, t);
  return { t, allDay };
}
function parseRule(s) { const r = {}; String(s || '').split(';').forEach(x => { const i = x.indexOf('='); if (i > 0) r[x.slice(0, i).toUpperCase()] = x.slice(i + 1); }); return r; }

function parseIcs(text, homeTz) {
  const lines = unfold(String(text || '')).split(/\r?\n/), evs = [];
  let cur = null;
  for (const ln of lines) {
    if (ln === 'BEGIN:VEVENT') { cur = { ex: [] }; continue; }
    if (ln === 'END:VEVENT') { if (cur && cur.uid && cur.start) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = ln.indexOf(':'); if (i < 1) continue;
    const head = ln.slice(0, i), val = ln.slice(i + 1), semi = head.indexOf(';');
    const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase(), params = semi < 0 ? '' : head.slice(semi + 1);
    if (name === 'UID') cur.uid = val.trim();
    else if (name === 'SUMMARY') cur.summary = unesc(val);
    else if (name === 'DESCRIPTION') cur.desc = unesc(val);
    else if (name === 'STATUS') cur.status = val.trim().toUpperCase();
    else if (name === 'DTSTART') { const d = parseDate(val, params, homeTz); if (d) { cur.start = d.t; cur.allDay = d.allDay; cur.utc = !!d.utc; } }
    else if (name === 'DTEND') { const d = parseDate(val, params, homeTz); if (d) cur.end = d.t; }
    else if (name === 'RRULE') cur.rule = parseRule(val);
    else if (name === 'EXDATE') val.split(',').forEach(v => { const d = parseDate(v, params, homeTz); if (d) cur.ex.push(d.t); });
    else if (name === 'RECURRENCE-ID') { const d = parseDate(val, params, homeTz); if (d) cur.recId = d.t; }
  }
  return evs;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
/* ocorrências de um evento com início entre a e b (ms). Suporta DAILY, WEEKLY (BYDAY), MONTHLY e YEARLY com INTERVAL, COUNT e UNTIL */
function occurrences(ev, a, b, tz0) {
  const tz = ev.utc ? 'UTC' : tz0;
  if (!ev.rule) return ev.start >= a && ev.start <= b ? [ev.start] : [];
  const r = ev.rule, freq = r.FREQ, step = Math.max(1, +r.INTERVAL || 1), until = r.UNTIL ? (parseDate(r.UNTIL, '', tz) || {}).t : Infinity;
  const count = r.COUNT ? +r.COUNT : Infinity, out = [], local = t => new Date(t + tzOffset(tz, t));
  const fromLocal = (y, mo, d, h, mi, s) => { const u = Date.UTC(y, mo, d, h, mi, s); let t = u - tzOffset(tz, u); t = u - tzOffset(tz, t); return t; };
  const s0 = local(ev.start), H = s0.getUTCHours(), Mi = s0.getUTCMinutes(), Se = s0.getUTCSeconds();
  const byday = r.BYDAY ? r.BYDAY.split(',').map(x => DAYS.indexOf(x.slice(-2))).filter(x => x >= 0) : [s0.getUTCDay()];
  let n = 0;
  const push = t => { if (t < ev.start || t > until || n >= count) return false; n++; if (t >= a && t <= b && ev.ex.indexOf(t) < 0) out.push(t); return t <= b; };
  const guard = 5000;
  if (freq === 'DAILY') {
    for (let i = 0, d = 0; i < guard; i++, d += step) { if (!push(fromLocal(s0.getUTCFullYear(), s0.getUTCMonth(), s0.getUTCDate() + d, H, Mi, Se))) break; }
  } else if (freq === 'WEEKLY') {
    const wk0 = s0.getUTCDate() - s0.getUTCDay();
    for (let w = 0, i = 0; i < guard; i++, w += step) {
      let go = true;
      for (const dow of byday.slice().sort((x, y) => x - y)) { if (!push(fromLocal(s0.getUTCFullYear(), s0.getUTCMonth(), wk0 + w * 7 + dow, H, Mi, Se))) { go = false; } }
      if (!go && fromLocal(s0.getUTCFullYear(), s0.getUTCMonth(), wk0 + w * 7, H, Mi, Se) > b) break;
    }
  } else if (freq === 'MONTHLY') {
    for (let i = 0, mo = 0; i < guard; i++, mo += step) { if (!push(fromLocal(s0.getUTCFullYear(), s0.getUTCMonth() + mo, s0.getUTCDate(), H, Mi, Se))) break; }
  } else if (freq === 'YEARLY') {
    for (let i = 0, y = 0; i < 200; i++, y += step) { if (!push(fromLocal(s0.getUTCFullYear() + y, s0.getUTCMonth(), s0.getUTCDate(), H, Mi, Se))) break; }
  } else if (ev.start >= a && ev.start <= b) out.push(ev.start);
  return out;
}

/* eventos que começam entre a e b, ordenados; id estável = uid + início */
function eventsBetween(text, a, b, tz) {
  const all = parseIcs(text, tz), over = new Set(all.filter(e => e.recId).map(e => e.uid + '|' + e.recId)), out = [];
  for (const ev of all) {
    if (ev.status === 'CANCELLED') continue;
    const times = ev.recId ? (ev.start >= a && ev.start <= b ? [ev.start] : []) : occurrences(ev, a, b, tz).filter(t => !over.has(ev.uid + '|' + t));
    for (const t of times) out.push({ id: crypto.createHash('sha256').update(ev.uid + '|' + t).digest('hex').slice(0, 16), title: ev.summary || '(sem título)', desc: ev.desc || '', at: t, allDay: !!ev.allDay });
  }
  return out.sort((x, y) => x.at - y.at);
}

/* vai buscar o ficheiro .ics (só https; máx. 4 MB; 15 s). As mensagens de erro nunca incluem o endereço. */
function fetchIcs(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(new Error('O endereço do calendário não é válido.')); }
    if (u.protocol !== 'https:' && !opts.allowHttp) return reject(new Error('O endereço do calendário tem de começar por https://.'));
    const lib = u.protocol === 'https:' ? https : require('node:http');
    const req = lib.get(u, { timeout: 15000, headers: { 'User-Agent': 'Enif-DOOH-calendario', Accept: 'text/calendar,*/*' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('O Google respondeu com o código ' + res.statusCode + '. Confirme o endereço secreto do calendário.')); }
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > 4e6) { req.destroy(); reject(new Error('O calendário é demasiado grande.')); } else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => reject(new Error('Falha a ler o calendário.')));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('O calendário demorou demasiado a responder.')); });
    req.on('error', () => reject(new Error('Não foi possível ligar ao calendário.')));
  });
}
module.exports = { parseIcs, eventsBetween, fetchIcs, parseDate };
