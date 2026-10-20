'use strict';
/* Envio de e-mail por SMTP, sem dependências. Suporta ligação segura direta (porta 465) e STARTTLS (587/25),
   autenticação PLAIN/LOGIN, texto e anexos. Devolve a resposta do servidor (prova de que o servidor aceitou a mensagem). */
const net = require('node:net'), tls = require('node:tls'), crypto = require('node:crypto');

const b64 = s => Buffer.from(s).toString('base64');
const wrap = s => s.replace(/(.{76})/g, '$1\r\n');
const hdr = s => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=';
const addr = s => { const m = /<([^>]+)>/.exec(s); return (m ? m[1] : s).trim(); };

function build(cfg, m, msgId, date) {
  const bd = 'enif-' + crypto.randomBytes(12).toString('hex');
  const H = ['From: ' + cfg.from, 'To: ' + m.to, 'Subject: ' + hdr(m.subject), 'Date: ' + date.toUTCString().replace('GMT', '+0000'), 'Message-ID: ' + msgId, 'MIME-Version: 1.0', 'Auto-Submitted: auto-generated'];
  const text = m.text.replace(/\r?\n/g, '\r\n');
  let body;
  if (m.attachments && m.attachments.length) {
    H.push('Content-Type: multipart/mixed; boundary="' + bd + '"');
    body = '--' + bd + '\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + wrap(b64(text)) + '\r\n';
    m.attachments.forEach(a => {
      body += '--' + bd + '\r\nContent-Type: ' + (a.type || 'application/octet-stream') + '; name="' + a.name + '"\r\nContent-Disposition: attachment; filename="' + a.name + '"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + wrap(a.data.toString('base64')) + '\r\n';
    });
    body += '--' + bd + '--\r\n';
  } else {
    H.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    body = wrap(b64(text)) + '\r\n';
  }
  return H.join('\r\n') + '\r\n\r\n' + body;
}

/* cfg: { host, port, secure, user, pass, from, rejectUnauthorized }; m: { to, subject, text, attachments:[{name,type,data:Buffer}] }
   devolve { ok, messageId, response, accepted } ou lança Error com .smtp (resposta do servidor) */
function send(cfg, m, opts) {
  const msgId = m.messageId || ('<' + crypto.randomBytes(16).toString('hex') + '@' + (String(cfg.from).split('@')[1] || 'enif.pt').replace(/[>\s]/g, '') + '>');
  const raw = build(cfg, m, msgId, new Date());
  const timeout = (opts && opts.timeout) || 30000;
  return new Promise((resolve, reject) => {
    let sock, buf = '', waiting = null, done = false;
    const fail = (e, smtp) => { if (done) return; done = true; try { sock && sock.destroy(); } catch (x) { /* sem ação */ } const er = e instanceof Error ? e : new Error(String(e)); er.smtp = smtp || er.smtp || ''; reject(er); };
    const timer = setTimeout(() => fail(new Error('Tempo esgotado a falar com o servidor de e-mail')), timeout);
    const onData = d => {
      buf += d.toString('utf8');
      for (;;) {                                               // resposta completa = linhas até uma sem «-» a seguir ao código
        const lines = buf.split('\r\n'); if (lines.length < 2) return;
        let end = -1; for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) { end = i; break; }
        if (end < 0) return;
        const text = lines.slice(0, end + 1).join('\n'); buf = lines.slice(end + 1).join('\r\n');
        const w = waiting; waiting = null; if (w) w({ code: +text.slice(0, 3), text });
      }
    };
    const reply = () => new Promise(r => { waiting = r; });
    const cmd = async (line, ok) => { sock.write(line + '\r\n'); const r = await reply(); if (ok.indexOf(Math.floor(r.code / 100)) < 0 && ok.indexOf(r.code) < 0) throw Object.assign(new Error('O servidor de e-mail respondeu: ' + r.text.split('\n').pop()), { smtp: r.text }); return r; };
    const attach = s => { sock = s; s.setTimeout(timeout, () => fail(new Error('Tempo esgotado a falar com o servidor de e-mail'))); s.on('data', onData); s.on('error', e => fail(e)); };
    const connect = () => new Promise((res, rej) => {
      const o = { host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false };
      const s = cfg.secure ? tls.connect(o, () => res(s)) : net.connect({ host: cfg.host, port: cfg.port }, () => res(s));
      s.once('error', rej);
    });
    (async () => {
      const s = await connect(); s.removeAllListeners('error'); attach(s);
      let r = await reply(); if (r.code !== 220) throw Object.assign(new Error('O servidor de e-mail recusou a ligação'), { smtp: r.text });
      const name = 'enif.local';
      r = await cmd('EHLO ' + name, [2]);
      if (!cfg.secure && /STARTTLS/i.test(r.text)) {
        await cmd('STARTTLS', [2]);
        sock.removeAllListeners('data'); sock.removeAllListeners('error');
        const t = await new Promise((res, rej) => { const x = tls.connect({ socket: sock, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false }, () => res(x)); x.once('error', rej); });
        buf = ''; attach(t);
        r = await cmd('EHLO ' + name, [2]);
      } else if (!cfg.secure && cfg.requireTls !== false && cfg.user && !cfg.allowPlain) throw new Error('O servidor não oferece ligação cifrada (STARTTLS); não envio a palavra-passe sem cifra.');
      if (cfg.user) {
        if (/AUTH[^\n]*PLAIN/i.test(r.text)) await cmd('AUTH PLAIN ' + b64('\0' + cfg.user + '\0' + cfg.pass), [2]);
        else { await cmd('AUTH LOGIN', [3]); await cmd(b64(cfg.user), [3]); await cmd(b64(cfg.pass), [2]); }
      }
      await cmd('MAIL FROM:<' + addr(cfg.from) + '>', [2]);
      await cmd('RCPT TO:<' + addr(m.to) + '>', [2]);
      await cmd('DATA', [3]);
      sock.write(raw.replace(/^\./gm, '..') + '.\r\n'); r = await reply();
      if (r.code < 200 || r.code >= 300) throw Object.assign(new Error('O servidor de e-mail não aceitou a mensagem: ' + r.text.split('\n').pop()), { smtp: r.text });
      const final = r.text.split('\n').pop();
      try { sock.write('QUIT\r\n'); } catch (e) { /* sem ação */ }
      clearTimeout(timer); done = true; try { sock.end(); } catch (e) { /* sem ação */ }
      resolve({ ok: true, messageId: msgId, response: final, accepted: addr(m.to), bytes: raw.length });
    })().catch(e => { clearTimeout(timer); fail(e); });
  });
}
module.exports = { send, build };
