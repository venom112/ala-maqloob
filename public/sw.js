// Keeps the app shell and pictures available offline so the installed app opens at once.
// The game itself needs the connection to the server, so nothing about it is cached.
const V = 'ala-v17';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/img/back.jpg', '/img/coin1.webp', '/img/coin5.webp', '/img/coin10.webp', '/img/logo.jpg', '/img/fatwa.jpg', '/img/lawyer.jpg', '/img/shadow.jpg', '/img/officer.jpg', '/img/pickpocket.jpg', '/img/sparrow.jpg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;
  if (u.origin !== location.origin) {
    // fonts: use the copy we have, refresh it in the background
    if (/fonts\.(googleapis|gstatic)\.com$/.test(u.host)) {
      e.respondWith(caches.open(V).then(c => c.match(r).then(hit => { const net = fetch(r).then(x => { c.put(r, x.clone()); return x; }).catch(() => hit); return hit || net; })));
    }
    return;
  }
  if (u.pathname === '/ws' || u.pathname === '/healthz' || u.pathname.startsWith('/api/') || u.pathname.startsWith('/admin')) return;   // never cache the API or the admin panel
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(x => { const c = x.clone(); caches.open(V).then(ch => ch.put('/', c)); return x; }).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(x => { if (x.ok) { const c = x.clone(); caches.open(V).then(ch => ch.put(r, c)); } return x; })));
});
