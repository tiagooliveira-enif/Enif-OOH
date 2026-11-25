'use strict';
/* Push web (lib/webpush.js): cifra aes128gcm conforme o exemplo oficial do RFC 8291 (Apêndice A), cabeçalho VAPID verificável,
   só servidores de push conhecidos e envio com resposta 201 / 410 (subscrição apagada). */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const W = require('../lib/webpush');
let n = 0; const ok = (name, c) => { assert.ok(c, name); n++; console.log('PASS ' + name); };

// exemplo do RFC 8291, Apêndice A: com a mesma chave, sal e texto, o resultado tem de ser byte a byte igual
const UA_PUB = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', UA_PRIV = 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const RFC_BODY = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
const asKey = crypto.createECDH('prime256v1'); asKey.setPrivateKey(W.unb64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
const mine = W.encrypt('When I grow up, I want to be a watermelon', UA_PUB, AUTH, { ecdh: asKey, salt: W.unb64u('DGv6ra1nlYgDCS1FRnbzlw') });
ok('cifra igual ao exemplo oficial do RFC 8291', W.b64u(mine) === RFC_BODY);
ok('decifra o exemplo oficial do RFC 8291', W.decrypt(W.unb64u(RFC_BODY), UA_PRIV, UA_PUB, AUTH) === 'When I grow up, I want to be a watermelon');

// ida e volta com chaves novas e texto com acentos
const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16), pub = W.b64u(ua.getPublicKey());
const txt = JSON.stringify({ title: 'Ecrã sem ligação · Lisboa', body: 'ECR-005 sem sinal há 15 minutos. ção ✓' });
const b1 = W.encrypt(txt, pub, W.b64u(auth)), b2 = W.encrypt(txt, pub, W.b64u(auth));
ok('ida e volta devolve o texto original', W.decrypt(b1, W.b64u(ua.getPrivateKey()), pub, W.b64u(auth)) === txt);
ok('cada envio usa sal e chave novos', !b1.equals(b2));
ok('chave de outra pessoa não decifra', (() => { const o = crypto.createECDH('prime256v1'); o.generateKeys(); try { W.decrypt(b1, W.b64u(o.getPrivateKey()), pub, W.b64u(auth)); return false; } catch (e) { return true; } })());
ok('corpo adulterado não decifra', (() => { const t = Buffer.from(b1); t[t.length - 20] ^= 1; try { W.decrypt(t, W.b64u(ua.getPrivateKey()), pub, W.b64u(auth)); return false; } catch (e) { return true; } })());
ok('subscrição inválida é recusada', (() => { try { W.encrypt('x', 'abc', 'def'); return false; } catch (e) { return /inválida/.test(e.message); } })());
ok('aviso grande demais é recusado', (() => { try { W.encrypt('x'.repeat(4000), pub, W.b64u(auth)); return false; } catch (e) { return /grande/.test(e.message); } })());

// VAPID: a assinatura confere com a chave pública e o destinatário é o servidor de push
const v = W.newVapid(), ep = 'https://fcm.googleapis.com/fcm/send/abc123';
const hdr = W.vapidHeader(ep, v, 'mailto:teste@enif.pt', 1700000000000), m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(hdr);
ok('cabeçalho VAPID bem formado', !!m && m[4] === v.pub && W.unb64u(v.pub).length === 65 && W.unb64u(v.pub)[0] === 4);
const claims = JSON.parse(W.unb64u(m[2]).toString());
ok('VAPID: destinatário e validade certos', claims.aud === 'https://fcm.googleapis.com' && claims.sub === 'mailto:teste@enif.pt' && claims.exp === 1700000000 + 12 * 3600);
const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: W.b64u(W.unb64u(v.pub).subarray(1, 33)), y: W.b64u(W.unb64u(v.pub).subarray(33)) }, format: 'jwk' });
ok('VAPID: assinatura confere com a chave pública', crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: pubKey, dsaEncoding: 'ieee-p1363' }, W.unb64u(m[3])));

// só servidores de push conhecidos
ok('aceita Google, Mozilla, Apple e Microsoft', ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=x'].every(W.allowedEndpoint));
ok('recusa outros endereços (SSRF)', ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x', 'ftp://fcm.googleapis.com/x', 'lixo', ''].every(e => !W.allowedEndpoint(e)));

// envio: 201 = enviado; 410 = a subscrição já não existe
const fake = status => ({ request: (o, cb) => { const h = {}; const r = { on: (ev, f) => { if (ev === 'timeout') h.t = f; return r; }, destroy() {}, end: body => { ok('envio traz cabeçalhos e corpo cifrado', o.headers['Content-Encoding'] === 'aes128gcm' && /^vapid t=/.test(o.headers.Authorization) && o.headers['Content-Length'] === body.length && o.hostname === 'fcm.googleapis.com'); const res = { statusCode: status, resume() {}, on: (ev, f) => { if (ev === 'end') setImmediate(f); } }; cb(res); } }; return r; } });
(async () => {
  const sub = { endpoint: ep, p256dh: pub, auth: W.b64u(auth) };
  const a = await W.send(sub, { title: 't' }, v, 'mailto:x@enif.pt', { lib: fake(201) }), b = await W.send(sub, { title: 't' }, v, 'mailto:x@enif.pt', { lib: fake(410) });
  ok('resposta 201 conta como enviado', a.ok && !a.gone);
  ok('resposta 410 manda apagar a subscrição', !b.ok && b.gone);
  const c = await W.send({ endpoint: 'https://evil.com/x', p256dh: pub, auth: W.b64u(auth) }, { title: 't' }, v, 'mailto:x@enif.pt');
  ok('endereço não permitido nem sai do servidor', !c.ok && c.gone);
  console.log(n + ' verificações OK');
})();
