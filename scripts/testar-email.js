#!/usr/bin/env node
/* Envia um e-mail de teste com as definições do enif-config.json e mostra o erro exato, se houver.
   Uso (no servidor):  CONFIG_FILE=/etc/enif/enif-config.json node scripts/testar-email.js o.seu@email.pt */
const fs = require('fs'), path = require('path');
const MAIL = require('../lib/mail');
const file = process.env.CONFIG_FILE || path.join(__dirname, '..', 'enif-config.json');
const to = process.argv[2];
if (!to) { console.error('Uso: node scripts/testar-email.js o.seu@email.pt'); process.exit(2); }
let c = {};
try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('Não consegui ler ' + file + ': ' + e.message); process.exit(1); }
const s = c.smtp || {};
if (!s.servidor) { console.error('Falta o bloco "smtp" em ' + file); process.exit(1); }
const cfg = { host: s.servidor, port: +s.porta || 587, secure: s.seguro === undefined ? (+s.porta === 465) : !!s.seguro, user: s.utilizador || '', pass: s.palavraPasse || '', from: s.de || s.utilizador, allowPlain: s.semCifra === true, rejectUnauthorized: true };
console.log('A enviar com ' + cfg.host + ':' + cfg.port + (cfg.secure ? ' (SSL/TLS)' : ' (STARTTLS)') + ' como ' + cfg.user + ' ...');
MAIL.send(cfg, { to, subject: 'Teste do Enif DOOH', text: 'Se recebeu esta mensagem, o envio de e-mail da plataforma está a funcionar.' })
  .then(() => console.log('ENVIADO. Veja a caixa de ' + to + ' (e o spam).'))
  .catch(e => { console.error('FALHOU: ' + e.message); process.exit(1); });
