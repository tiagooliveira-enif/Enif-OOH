'use strict';
/* Testes de segurança e envios: dois passos, recuperação, e-mail de recuperação, cópias, avisos e relatório final por SMTP (servidor falso). */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enif-sec-'));
let passed = 0; const ok = (n, c) => { assert.ok(c, n); passed++; console.log('PASS ' + n); };

/* servidor SMTP falso: guarda as mensagens; recusa destinatários que começam por «recusa@» */
const inbox = [];
const smtp = net.createServer(sock => {
  let mode = 'cmd', data = '', from = '', to = '', buf = '';
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', d => {
    buf += d.toString('latin1');
    for (;;) {
      if (mode === 'data') {
        const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return;
        data = buf.slice(0, i); buf = buf.slice(i + 5); mode = 'cmd';
        inbox.push({ from, to, raw: data }); sock.write('250 2.0.0 Ok: queued as FAKE' + inbox.length + '\r\n'); continue;
      }
      const i = buf.indexOf('\r\n'); if (i < 0) return;
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
      else if (/^AUTH PLAIN/i.test(line)) sock.write(Buffer.from(line.slice(11), 'base64').toString().includes('segredo-smtp') ? '235 2.7.0 ok\r\n' : '535 5.7.8 credenciais erradas\r\n');
      else if (/^MAIL FROM/i.test(line)) { from = line; sock.write('250 ok\r\n'); }
      else if (/^RCPT TO/i.test(line)) { to = /<([^>]+)>/.exec(line)[1]; sock.write(/^recusa@/.test(to) ? '550 5.1.1 <' + to + '>: destinatário inexistente\r\n' : '250 ok\r\n'); }
      else if (/^DATA/i.test(line)) { mode = 'data'; sock.write('354 go\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('500 ?\r\n');
    }
  });
  sock.on('error', () => { });
});
const bodyOf = m => { const t = m.raw.split('\r\n\r\n'); return Buffer.from(t[1].replace(/\s+/g, ''), 'base64').toString('utf8'); };
const codeOf = m => /Código: (\d{6})/.exec(m.raw.includes('multipart') ? '' : bodyOf(m))[1];

async function main() {
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { DATA_DIR: tmp, ADMIN_NAME: 'Tiago', ADMIN_EMAIL: 'tiago@enif.pt', ADMIN_PASS: 'segredo-inicial', PORT: '0', CONFIG_FILE: path.join(tmp, 'sem.json'),
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_PLAIN: '1', SMTP_USER: 'utilizador', SMTP_PASS: 'segredo-smtp', SMTP_FROM: 'Enif DOOH <relatorios@enif.pt>' });
  fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify({ emailRecuperacao: 'recupera@enif.pt' }));
  const { server, db, tick, backupNow } = require('../server');
  const S = require('../lib/schedule');
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (m, p, body, tok) => {
    const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}), body: body === undefined ? undefined : (body instanceof Uint8Array ? body : JSON.stringify(body)) });
    let j = null; try { j = await r.clone().json(); } catch (e) { /* sem ação */ }
    return { s: r.status, j, r };
  };
  const today = S.lisbonNow('Europe/Lisbon').date, plus = n => S.addDay(today, n);
  const login = (pass) => call('POST', '/api/login', { email: 'tiago@enif.pt', pass: pass || 'segredo-inicial' });
  let r = await login(); const adm = r.j.token; ok('o administrador entra', !!adm);
  let st = (await call('GET', '/api/state', undefined, adm)).j;
  ok('o e-mail de recuperação vem do ficheiro de configuração', st.me.recovery === 'recupera@enif.pt' && st.smtpReady === true);
  ok('a palavra-passe do SMTP nunca vai para o estado', !JSON.stringify(st).includes('segredo-smtp'));

  // ---- dois passos
  ok('ligar dois passos', (await call('POST', '/api/me/twofa', { on: true }, adm)).s === 200);
  r = await login(); ok('com dois passos o login pede código e não dá sessão', r.s === 200 && r.j.step === 'code' && !r.j.token);
  let m = inbox[inbox.length - 1]; ok('o código vai para o e-mail de recuperação', m.to === 'recupera@enif.pt' && /^\d{6}$/.test(codeOf(m)));
  const ch = r.j.ch;
  const wrong = codeOf(m) === '000000' ? '111111' : '000000';
  ok('código errado recusado', (await call('POST', '/api/login/code', { ch, code: wrong })).s === 400);
  r = await call('POST', '/api/login/code', { ch, code: codeOf(m) }); ok('código certo dá sessão', r.s === 200 && !!r.j.token);
  ok('o código só serve uma vez', (await call('POST', '/api/login/code', { ch, code: codeOf(m) })).s === 400);
  r = await login(); const ch2 = r.j.ch; let last;
  for (let i = 0; i < 5; i++) last = await call('POST', '/api/login/code', { ch: ch2, code: '12345' + i });
  ok('5 códigos errados apagam o pedido', last.s === 400 && (await call('POST', '/api/login/code', { ch: ch2, code: codeOf(inbox[inbox.length - 1]) })).s === 400);
  ok('desligar dois passos', (await call('POST', '/api/me/twofa', { on: false }, adm)).s === 200 && (await login()).j.token);

  // ---- e-mail de recuperação com confirmação
  const n0 = inbox.length;
  r = await call('POST', '/api/me/recovery', { email: 'novo@enif.pt' }, adm); const rch = r.j.ch;
  ok('o código de confirmação vai para o NOVO e-mail', inbox.length === n0 + 1 && inbox[n0].to === 'novo@enif.pt');
  ok('até confirmar, o e-mail antigo mantém-se', (await call('GET', '/api/state', undefined, adm)).j.me.recovery === 'recupera@enif.pt');
  ok('confirmar com código errado falha', (await call('POST', '/api/me/recovery/confirm', { ch: rch, code: codeOf(inbox[n0]) === '000000' ? '111111' : '000000' }, adm)).s === 400);
  ok('confirmar com o código certo', (await call('POST', '/api/me/recovery/confirm', { ch: rch, code: codeOf(inbox[n0]) }, adm)).s === 200 && (await call('GET', '/api/state', undefined, adm)).j.me.recovery === 'novo@enif.pt');

  // ---- recuperar palavra-passe
  const n1 = inbox.length;
  ok('e-mail sem conta: resposta igual e nenhum e-mail', (await call('POST', '/api/forgot', { email: 'ninguem@x.pt' })).s === 200 && inbox.length === n1);
  r = await call('POST', '/api/forgot', { email: 'TIAGO@enif.pt' }); ok('administrador recebe o código no e-mail de recuperação', r.s === 200 && inbox.length === n1 + 1 && inbox[n1].to === 'novo@enif.pt');
  const fch = r.j.ch, fcode = codeOf(inbox[n1]);
  ok('palavra-passe curta recusada', (await call('POST', '/api/forgot/confirm', { ch: fch, code: fcode, pass: 'curta' })).s === 400);
  ok('recuperar com código certo', (await call('POST', '/api/forgot/confirm', { ch: fch, code: fcode, pass: 'nova-palavra-passe-1' })).s === 200);
  ok('a antiga já não entra e a nova entra', (await login()).s === 401 && (await login('nova-palavra-passe-1')).s === 200);
  ok('a sessão antiga terminou', (await call('GET', '/api/state', undefined, adm)).s === 401);
  const adm2 = (await login('nova-palavra-passe-1')).j.token;
  // utilizador não administrador não recupera por e-mail
  await call('POST', '/api/sync', { ops: [{ op: 'put', coll: 'users', id: 'uop', doc: { id: 'uop', name: 'Op', email: 'op@x.pt', admin: false, perms: ['ecras.ver'], active: true, pass: 'abcdef' } }] }, adm2);
  const n2 = inbox.length; await call('POST', '/api/forgot', { email: 'op@x.pt' }); ok('só o administrador recupera por e-mail', inbox.length === n2);
  const top = (await call('POST', '/api/login', { email: 'op@x.pt', pass: 'abcdef' })).j.token;
  ok('utilizador normal não mexe na segurança', (await call('POST', '/api/me/twofa', { on: true }, top)).s === 403 && (await call('POST', '/api/me/password', { old: 'abcdef', pass: 'outra-palavra-passe' }, top)).s === 403 && (await call('POST', '/api/backup-now', {}, top)).s === 403);
  // mudar a própria palavra-passe
  ok('palavra-passe atual errada recusada', (await call('POST', '/api/me/password', { old: 'x', pass: 'mais-uma-palavra-passe' }, adm2)).s === 400);
  r = await call('POST', '/api/me/password', { old: 'nova-palavra-passe-1', pass: 'terceira-palavra-passe' }, adm2);
  ok('mudar a própria palavra-passe mantém esta sessão e termina as outras', r.s === 200 && !!r.j.token && (await call('GET', '/api/state', undefined, adm2)).s === 401 && (await call('GET', '/api/state', undefined, r.j.token)).s === 200);
  const adm3 = r.j.token;

  // ---- cópias de segurança
  r = await call('POST', '/api/backup-now', {}, adm3); ok('cópia feita', r.s === 200 && fs.existsSync(path.join(tmp, 'backups', r.j.name)));
  ok('estado mostra a cópia', (await call('GET', '/api/state', undefined, adm3)).j.backups.length === 1);
  const { DatabaseSync } = require('node:sqlite'); const cp = new DatabaseSync(path.join(tmp, 'backups', r.j.name));
  ok('a cópia abre e tem os utilizadores', cp.prepare("SELECT COUNT(*) n FROM docs WHERE coll='users'").get().n === 2); cp.close();

  // ---- auditoria
  const au = (await call('GET', '/api/state', undefined, adm3)).j.auditLog;
  ok('a auditoria regista entradas, recuperação e cópia', ['Entrou', 'Recuperou a palavra-passe pelo e-mail', 'Fez uma cópia de segurança', 'Ligou a verificação em dois passos'].every(w => au.some(a => a.what.startsWith(w))));
  ok('a auditoria não guarda códigos nem palavras-passe', !JSON.stringify(au).match(/nova-palavra|terceira|\b\d{6}\b/));
  ok('a auditoria só se acrescenta', (() => { try { db.exec("DELETE FROM audit"); return false; } catch (e) { return true; } })());
  r = await fetch(base + '/api/audit.csv', { headers: { Authorization: 'Bearer ' + adm3 } }); const csv = await r.text();
  ok('CSV da auditoria só para o administrador', r.status === 200 && csv.includes('Quem') && (await fetch(base + '/api/audit.csv', { headers: { Authorization: 'Bearer ' + top } })).status === 403);

  // ---- avisos e relatório final
  const mkPng = (w, h) => { const b = Buffer.alloc(45); Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  const op = (coll, id, doc) => ({ op: 'put', coll, id, doc });
  await call('POST', '/api/sync', { ops: [op('screens', 'ECR-001', { id: 'ECR-001', venue: 'Fórum', city: 'Braga', spot: 'Átrio', type: 'Painel horizontal', res: '1920×1080', limit: 5, order: [], draft: null, loc: { addr: '', lat: null, lng: null, env: 'centro-comercial', pop: null }, on: 0, off: 24, onT: '00:00', offT: '23:59' })] }, adm3);
  const up = await fetch(base + '/api/upload?name=a.png&mime=image%2Fpng&screens=ECR-001', { method: 'PUT', headers: { Authorization: 'Bearer ' + adm3 }, body: mkPng(1920, 1080) });
  const f1 = await up.json(); ok('conteúdo carregado', up.status === 200);
  const camp = (id, o) => op('campaigns', id, Object.assign({ id, name: 'Camp ' + id, client: 'Cliente ' + id, venues: ['Fórum'], start: plus(-10), end: plus(5), h0: 0, h1: 24, ppm: 1, dur: 10, priority: 'Normal', manual: false, color: 1, sales: 'comercial@x.pt', items: [{ f: f1.id, h0: null, h1: null, d0: null, d1: null, ppm: 1 }] }, o || {}));
  await call('POST', '/api/sync', { ops: [camp('CA'), camp('CB', { start: plus(-20), end: plus(-1), sales: 'recusa@x.pt' }), camp('CC', { start: plus(-20), end: plus(-1), name: 'Passada «ação»' }), camp('CD', { sales: '', end: plus(2) })] }, adm3);
  for (const id of ['CB', 'CC']) for (let d = -15; d <= -1; d++) for (let h = 9; h < 20; h++) db.prepare('INSERT INTO plays(pid,screen,camp,file,ts,day,hour,dur,ok) VALUES(?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(), 'ECR-001', id, f1.id, Date.now(), plus(d), h, 10, 1);
  const nA = inbox.length;
  await tick(true);
  const sent = inbox.slice(nA), subj = m => /Subject: (.*)/.exec(m.raw)[1];
  ok('aviso de fim de campanha enviado uma semana antes (só com e-mail do comercial)', sent.some(x => x.to === 'comercial@x.pt' && /termina/.test(Buffer.from(/=\?UTF-8\?B\?([^?]+)\?=/.exec(subj(x))[1], 'base64').toString())) && !sent.some(x => x.to === ''));
  const finals = sent.filter(x => x.raw.includes('application/pdf'));
  ok('relatório final enviado a campanha terminada (e só a ela)', finals.length === 1 && finals[0].to === 'comercial@x.pt');
  const att = /filename="([^"]+)"\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/.exec(finals[0].raw), pdf = Buffer.from(att[2].replace(/\s+/g, ''), 'base64');
  ok('o anexo é um PDF', pdf.slice(0, 5).toString() === '%PDF-' && /^relatorio-final-passada-acao\.pdf$/.test(att[1]));
  let el = (await call('GET', '/api/state', undefined, adm3)).j.emailLog;
  const fin = el.find(e => e.kind === 'final' && e.camp === 'CC');
  ok('registo: SHA-256 do PDF coincide e há passos Agendado → Enviado', fin.sha === crypto.createHash('sha256').update(pdf).digest('hex') && fin.events.map(e => e.st).join() === 'Agendado,Enviado' && /FAKE/.test(fin.events[1].txt) && /^<.+@enif\.pt>$/.test(fin.msgId));
  ok('o Message-ID do registo é o da mensagem enviada', finals[0].raw.includes('Message-ID: ' + fin.msgId));
  const bad = el.find(e => e.camp === 'CB');
  ok('destinatário recusado fica «Falhou» com a resposta do servidor', bad && bad.events[bad.events.length - 1].st === 'Falhou' && /550/.test(bad.events[bad.events.length - 1].txt));
  const nB = inbox.length; await tick(true);
  ok('não repete avisos nem relatórios já enviados (e espera 1 h antes de repetir uma falha)', inbox.length === nB);
  r = await call('POST', '/api/emails/' + bad.id + '/retry', {}, adm3);
  ok('«Tentar de novo» cria novo registo', r.s === 200 && (await call('GET', '/api/state', undefined, adm3)).j.emailLog.length === el.length + 1);
  ok('o PDF enviado pode ser descarregado pelo administrador', (await fetch(base + '/api/emails/' + fin.id + '/file', { headers: { Authorization: 'Bearer ' + adm3 } })).status === 200 && (await fetch(base + '/api/emails/' + fin.id + '/file', { headers: { Authorization: 'Bearer ' + top } })).status === 403);
  ok('o registo de envios só se acrescenta', (() => { try { db.exec("UPDATE emails SET to_addr='x'"); return false; } catch (e) { return /só se acrescenta/.test(e.message); } })() && (() => { try { db.exec("DELETE FROM email_events"); return false; } catch (e) { return true; } })());
  const nC = inbox.length, ca = (await call('GET', '/api/state', undefined, adm3)).j.campaigns.find(c => c.id === 'CA');
  await call('POST', '/api/sync', { ops: [{ op: 'put', coll: 'campaigns', id: 'CA', doc: Object.assign({}, ca, { end: plus(4) }), keys: ['end'] }] }, adm3); await tick(true);
  ok('campanha prolongada leva novo aviso (nova data de fim)', inbox.length === nC + 1 && inbox[nC].to === 'comercial@x.pt');
  console.log(passed + ' verificações ok'); smtp.close(); server.close(); process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
