'use strict';
/* Movimento à volta de um ecrã: conta pontos de interesse (lojas, restaurantes, paragens, escolas, hospitais)
   num raio de 250 m, com dados do OpenStreetMap (API Overpass). Só se consulta ao guardar as coordenadas. */
const https = require('node:https'), http = require('node:http');

const RADIUS = 250;
const KINDS = [['shops', 'lojas', 1], ['food', 'restaurantes e cafés', 1], ['transit', 'paragens e estações', 3], ['edu', 'escolas', 2], ['health', 'hospitais e clínicas', 2]];

function query(lat, lng) {
  const a = '(around:' + RADIUS + ',' + lat.toFixed(6) + ',' + lng.toFixed(6) + ')';
  return '[out:json][timeout:15];(' +
    'nwr' + a + '[shop];' +
    'nwr' + a + '[amenity~"^(restaurant|cafe|fast_food|bar|pub|food_court)$"];' +
    'nwr' + a + '[highway=bus_stop];' +
    'nwr' + a + '[railway~"^(station|subway_entrance|tram_stop)$"];' +
    'nwr' + a + '[amenity~"^(school|kindergarten|college|university)$"];' +
    'nwr' + a + '[amenity~"^(hospital|clinic)$"];' +
    ');out tags;';
}
function classify(tags) {
  const t = tags || {};
  if (t.shop) return 'shops';
  if (/^(restaurant|cafe|fast_food|bar|pub|food_court)$/.test(t.amenity || '')) return 'food';
  if (t.highway === 'bus_stop' || /^(station|subway_entrance|tram_stop)$/.test(t.railway || '')) return 'transit';
  if (/^(school|kindergarten|college|university)$/.test(t.amenity || '')) return 'edu';
  if (/^(hospital|clinic)$/.test(t.amenity || '')) return 'health';
  return null;
}
const countElements = els => {
  const out = { r: RADIUS, shops: 0, food: 0, transit: 0, edu: 0, health: 0 };
  (els || []).forEach(e => { const k = classify(e.tags); if (k) out[k]++; });
  return out;
};
const score = p => KINDS.reduce((a, k) => a + (p[k[0]] || 0) * k[2], 0);
const factor = p => 0.85 + 0.55 * (1 - Math.exp(-score(p) / 40));

/* pergunta ao Overpass; as mensagens de erro são simples e sem endereços */
function fetchPoi(lat, lng, opts) {
  opts = opts || {};
  const url = new URL(opts.url || 'https://overpass-api.de/api/interpreter');
  const body = 'data=' + encodeURIComponent(query(lat, lng));
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    if (url.protocol !== 'https:' && !opts.allowHttp) return reject(new Error('Serviço de mapas inválido.'));
    const req = lib.request(url, { method: 'POST', timeout: 20000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Enif-DOOH-localizacao' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('O serviço de mapas está ocupado (código ' + res.statusCode + '). Tente daqui a pouco.')); }
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > 4e6) { req.destroy(); reject(new Error('Resposta do serviço de mapas demasiado grande.')); } else chunks.push(c); });
      res.on('end', () => { try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(Object.assign(countElements(j.elements), { at: Date.now() })); } catch (e) { reject(new Error('Resposta inesperada do serviço de mapas.')); } });
      res.on('error', () => reject(new Error('Falha a ler o serviço de mapas.')));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('O serviço de mapas demorou demasiado a responder.')); });
    req.on('error', () => reject(new Error('Não foi possível ligar ao serviço de mapas.')));
    req.end(body);
  });
}
module.exports = { RADIUS, KINDS, countElements, score, factor, fetchPoi };
