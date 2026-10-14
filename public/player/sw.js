/* Guarda a página do player para o ecrã arrancar mesmo sem internet. */
var SHELL = 'enif-shell-v1', KEY = '/player/shell';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.mode !== 'navigate') return;
  e.respondWith(
    fetch(r).then(function (res) {
      if (res.ok) { var c = res.clone(); caches.open(SHELL).then(function (ca) { ca.put(KEY, c); }); }
      return res;
    }).catch(function () { return caches.open(SHELL).then(function (ca) { return ca.match(KEY); }); })
  );
});
