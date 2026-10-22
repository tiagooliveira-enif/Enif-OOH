'use strict';
const isNil = v => v === null || v === undefined;
/* Modelo de audiência: as MESMAS contas do protótipo e da aplicação (curva por hora, local do ecrã, ambiente).
   Usado no relatório final enviado por e-mail, para os números coincidirem com os da página de relatórios. */
const fmt = new Intl.NumberFormat('pt-PT');
/* ---------- audience model (average footfall per hour, relative) ---------- */
const curve = [2, 1, 1, 1, 2, 4, 9, 22, 34, 38, 40, 46, 52, 50, 44, 42, 48, 60, 66, 58, 44, 28, 14, 6];
const sumH = (a, b)=>{let t = 0; for (let h = a; h < b; h++)t += curve[h]; return t;};
const TOTAL = sumH(0, 24);
const K = 184300 / TOTAL;
const REF_SCREENS = 52;   
const ENV = [['aeroporto', 'Aeroporto', 1.9], ['transportes', 'Estação ou terminal de transportes', 1.6], ['centro-comercial', 'Centro comercial', 1.5], ['rua', 'Rua ou praça com muito movimento', 1.35], ['retalho', 'Mercado ou retalho', 1.1], ['turismo', 'Zona turística ou marina', 1.0], ['universidade', 'Universidade ou campus', 0.95], ['saude', 'Clínica ou hospital', 0.9], ['hotel', 'Hotel', 0.8], ['escritorio', 'Escritório ou empresa', 0.7], ['outro', 'Outro', 1.0]];
const CITIES = [['Lisboa', 38.7223, -9.1393, 1.15], ['Porto', 41.1579, -8.6291, 1.15], ['Braga', 41.5454, -8.4265, 1.0], ['Coimbra', 40.2033, -8.4103, 1.0], ['Faro', 37.0194, -7.9304, 1.0], ['Setúbal', 38.5244, -8.8882, 0.95], ['Aveiro', 40.6405, -8.6538, 0.95], ['Matosinhos', 41.1821, -8.6891, 1.0], ['Vila Nova de Gaia', 41.1239, -8.6118, 1.0], ['Vilamoura', 37.0786, -8.1170, 0.9], ['Funchal', 32.6669, -16.9241, 1.0], ['Ponta Delgada', 37.7412, -25.6756, 0.9], ['Évora', 38.5714, -7.9135, 0.9], ['Viseu', 40.6566, -7.9139, 0.9], ['Leiria', 39.7437, -8.8071, 0.9], ['Guimarães', 41.4444, -8.2962, 0.95]];
const REF_PASS = 10000; // pessoas/dia que passam junto a um ecrã "médio" (fator 1)
function hav(a, b, c, d) {const t = x=>x * Math.PI / 180, dl = t(c - a), dn = t(d - b), q = Math.pow(Math.sin(dl / 2), 2) + Math.cos(t(a)) * Math.cos(t(c)) * Math.pow(Math.sin(dn / 2), 2); return 12742 * Math.asin(Math.sqrt(q));}
function locInfo(s) {
  const L = s.loc || {}, env = ENV.find(e=>e.length && e[0] === L.env), why = [];
  const hasC = !isNil(L.lat) && !isNil(L.lng);
  let cityF = 0.9, central = 1;
  const byName = CITIES.find(c=>c[0].toLowerCase() === String(s.city || '').toLowerCase());
  if (hasC) {
    let best = null;
    CITIES.forEach(function(c) {const d = hav(L.lat, L.lng, c[1], c[2]); if (!best || d < best.d)best = {c:c, d:d};});
    if (best && best.d < 30) {cityF = best.c[3]; central = 0.9 + 0.35 * Math.exp(-best.d / 4); why.push('a ' + (Math.round(best.d * 10) / 10).toString().replace('.', ',') + ' km do centro de ' + best.c[0]);}
    else {cityF = 0.9; why.push('longe dos grandes centros urbanos');}
  } else if (byName)cityF = byName[3];
  if (env)why.unshift(env[1]);
  let f, conf;
  if (L.pop) {f = Math.max(0.15, Math.min(5, L.pop / REF_PASS)); conf = 'alta'; why.push('contagem de ' + fmt.format(L.pop) + ' pessoas por dia');}
  else if (env) {f = env[2] * cityF * central; conf = hasC ? 'média' : 'baixa';}
  else {const n = parseInt(s.id.slice(4), 10) || 1; f = (0.75 + ((n * 37) % 11) / 20) * cityF; conf = 'baixa';}
  return {f:f, conf:conf, why:why, hasC:hasC};
}
function weighRows(rows, screens) {
  const sec = {}, sc = {}, fc = {};
  screens.forEach(function(s) {sc[s.id] = s;});
  rows.forEach(function(r) {const k = r.s + '|' + r.d + '|' + r.h; sec[k] = (sec[k] || 0) + (r.sec || 0);});
  return rows.map(function(r) {
    const s = sc[r.s], T = sec[r.s + '|' + r.d + '|' + r.h] || 0;
    if (!s || !r.n || !T) return {r:r, impr:0};
    const f = !isNil(fc[r.s]) ? fc[r.s] : (fc[r.s] = locInfo(s).f);
    const cover = Math.min(1, T / 3600);
    return {r:r, impr:curve[r.h] * K / REF_SCREENS * f * cover * ((r.sec || 0) / T)};
  });
}

module.exports = { curve, K, REF_SCREENS, locInfo, weighRows };
