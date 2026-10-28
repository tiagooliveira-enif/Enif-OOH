#!/usr/bin/env node
/* Envia um e-mail ao administrador (usado pela cópia externa quando falha).
   Uso: CONFIG_FILE=/etc/enif/enif-config.json node scripts/avisar-email.js "Assunto" "Texto" */
const fs = require('fs'), path = require('path');
const MAIL = require('../lib/mail');
const file = process.env.CONFIG_FILE || path.join(__dirname, '..', 'enif-config.json');
let c = {}; try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('Não consegui ler ' + file); process.exit(1); }
const s = c.smtp || {}, to = c.emailRecuperacao || c.email;
if (!s.servidor || !to) { console.error('Falta o SMTP ou o e-mail do administrador.'); process.exit(1); }
const cfg = { host: s.servidor, port: +s.porta || 587, secure: s.seguro === undefined ? (+s.porta === 465) : !!s.seguro, user: s.utilizador || '', pass: s.palavraPasse || '', from: s.de || s.utilizador, allowPlain: s.semCifra === true, rejectUnauthorized: true };
MAIL.send(cfg, { to: c.email || to, subject: process.argv[2] || 'Aviso do Enif DOOH', text: process.argv[3] || '' }).then(() => console.log('E-mail enviado.')).catch(e => { console.error('Falhou o e-mail: ' + e.message); process.exit(1); });
