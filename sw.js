// sw.js — rende l'app utilizzabile senza rete.
// Strategia: cache + aggiornamento in background (stale-while-revalidate).
// Tutti i file sono nostri (nessuna libreria esterna): dopo la prima apertura funziona offline.
// Quando cambiate i file dell'app, incrementate CACHE per forzare il ricaricamento.
const CACHE = 'skyjo-v2';
const CORE = [
  './', './index.html', './styles.css', './app.js', './ui.js', './fx-dom.js',
  './skyjo-engine.js', './skyjo-store.js', './skyjo-stats.js', './skyjo-fx.js',
  './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // es. segnalazione PeerJS: sempre dalla rete

  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
    const refresh = fetch(req)
      .then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || Response.error();
  })());
});
