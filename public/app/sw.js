/* Avisos push da Enif DOOH: mostra o aviso mesmo com a página fechada e abre a app quando se carrega nele. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(String(d.title || 'Enif DOOH'), {
    body: String(d.body || ''),
    tag: String(d.tag || 'enif'),
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: String(d.url || '/app/') }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/app/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    const open = list.find(function (c) { return c.url.indexOf(self.location.origin + '/app/') === 0; });
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
