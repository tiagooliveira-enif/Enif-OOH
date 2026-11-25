'use strict';
/* Push web sem dependências externas: chaves VAPID (RFC 8292) e cifra do conteúdo aes128gcm (RFC 8291 / RFC 8188).
   Só usa node:crypto e node:https. O servidor de push (Google, Mozilla, Apple, Microsoft) nunca vê o texto do aviso. */
const crypto = require('node:crypto');
const https = require('node:https');

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');

/* só estes servidores de push são aceites (evita que alguém faça o servidor ligar-se a endereços à sua escolha) */
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
function allowedEndpoint(endpoint) {
  try {
    const u = new URL(String(endpoint));
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && PUSH_HOSTS.some(r => r.test(u.hostname)) && String(endpoint).length <= 1000;
  } catch (e) { return false; }
}

/* par de chaves VAPID: devolve a chave privada (PKCS8, base64url) e a pública (65 bytes, base64url) */
function newVapid() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { priv: b64u(privateKey.export({ format: 'der', type: 'pkcs8' })), pub: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])) };
}

/* cabeçalho Authorization: vapid t=<jwt>, k=<chave pública> */
function vapidHeader(endpoint, vapid, subject, now) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor((now || Date.now()) / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: unb64u(vapid.priv), format: 'der', type: 'pkcs8' });
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + vapid.pub;
}

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

/* cifra o texto para um navegador (p256dh e auth vêm da subscrição). Os parâmetros opcionais servem só para testes. */
function encrypt(plaintext, p256dh, auth, opt) {
  opt = opt || {};
  const uaPub = unb64u(p256dh), authSecret = unb64u(auth);
  if (uaPub.length !== 65 || uaPub[0] !== 4 || authSecret.length !== 16) throw new Error('Subscrição de push inválida');
  const ecdh = opt.ecdh || (() => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return e; })();
  const asPub = ecdh.getPublicKey(), salt = opt.salt || crypto.randomBytes(16);
  const secret = ecdh.computeSecret(uaPub);
  const prk = hkdf(authSecret, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);          // 0x02 = último (e único) bloco
  if (data.length > 3993) throw new Error('Aviso demasiado grande');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce), body = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}

/* operação inversa (só para testes e verificação): descobre o texto a partir do corpo recebido */
function decrypt(body, uaPrivate, uaPublic, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(unb64u(uaPrivate));
  const uaPub = unb64u(uaPublic), secret = ecdh.computeSecret(asPub);
  const prk = hkdf(unb64u(auth), secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  let i = plain.length - 1; while (i > 0 && plain[i] === 0) i--;
  return plain.subarray(0, i).toString('utf8');                                    // retira o delimitador 0x02
}

/* envia um aviso. Devolve { ok, status, gone }: gone=true quando a subscrição já não existe (404/410) e deve ser apagada. */
function send(sub, payload, vapid, subject, opt) {
  opt = opt || {};
  return new Promise(resolve => {
    let body;
    try { body = encrypt(JSON.stringify(payload), sub.p256dh, sub.auth); } catch (e) { return resolve({ ok: false, status: 0, gone: true, error: e.message }); }
    if (!allowedEndpoint(sub.endpoint) && !opt.allowAny) return resolve({ ok: false, status: 0, gone: true, error: 'Servidor de push não permitido' });
    const u = new URL(sub.endpoint);
    const req = (opt.lib || https).request({ method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, timeout: 15000, headers: {
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, TTL: String(opt.ttl || 6 * 3600), Urgency: 'high',
      Authorization: vapidHeader(sub.endpoint, vapid, subject)
    } }, res => {
      res.resume(); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, gone: res.statusCode === 404 || res.statusCode === 410 }));
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', e => resolve({ ok: false, status: 0, gone: false, error: e.message }));
    req.end(body);
  });
}

module.exports = { newVapid, vapidHeader, encrypt, decrypt, send, allowedEndpoint, b64u, unb64u };
