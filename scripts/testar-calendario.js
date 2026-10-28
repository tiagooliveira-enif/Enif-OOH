#!/usr/bin/env node
/* Lê o calendário Google (endereço secreto iCal do enif-config.json) e mostra quantos eventos há nos próximos 14 dias
   e quantos têm a palavra-chave. Uso: CONFIG_FILE=/etc/enif/enif-config.json node scripts/testar-calendario.js */
const fs = require('fs'), path = require('path');
const CAL = require('../lib/calendar');
const file = process.env.CONFIG_FILE || path.join(__dirname, '..', 'enif-config.json');
let c = {}; try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('Não consegui ler ' + file + ': ' + e.message); process.exit(1); }
const cal = c.calendario || {}, url = String(cal.link || '').trim(), kw = String(cal.palavra || 'SPOTS DIGITAIS').toLowerCase();
if (!url) { console.error('Falta o link do calendário em "calendario" no enif-config.json.'); process.exit(1); }
CAL.fetchIcs(url, {}).then(txt => {
  const ev = CAL.eventsBetween(txt, Date.now() - 3600000, Date.now() + 14 * 86400000, 'Europe/Lisbon');
  const com = ev.filter(e => (e.title + ' ' + e.desc).toLowerCase().includes(kw));
  console.log('Calendário lido: ' + ev.length + ' evento(s) nos próximos 14 dias; ' + com.length + ' com a palavra «' + cal.palavra + '».');
  com.slice(0, 5).forEach(e => console.log('  - ' + new Date(e.at).toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon' }) + '  ' + e.title));
}).catch(e => { console.error('FALHOU a leitura do calendário: ' + e.message); process.exit(1); });
