'use strict';
const crypto = require('node:crypto');

/* Permissões: as mesmas do protótipo. «admin» é à parte (utilizadores). */
const PERMS = ['ecras.ver', 'ecras.gerir', 'playlist.gerir', 'campanhas.ver', 'campanhas.gerir', 'conteudos.ver', 'conteudos.gerir', 'relatorios.ver', 'relatorios.exportar', 'alertas.resolver'];

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function checkPassword(pw, salt, hash) {
  if (!salt || !hash) return false;
  const a = Buffer.from(crypto.scryptSync(String(pw), salt, 64).toString('hex')), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const can = (u, p) => !!u && (u.admin || (u.perms || []).indexOf(p) > -1);

/* limita tentativas de entrada por e-mail */
function limiter(max, windowMs) {
  const m = new Map();
  return {
    blocked(k) { const e = m.get(k); return !!e && Date.now() - e.t < windowMs && e.n >= max; },
    fail(k) { const e = m.get(k); if (!e || Date.now() - e.t >= windowMs) m.set(k, { n: 1, t: Date.now() }); else e.n++; },
    ok(k) { m.delete(k); }
  };
}
module.exports = { PERMS, hashPassword, checkPassword, can, limiter };
