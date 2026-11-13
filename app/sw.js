// Cache para funcionar offline. Mude CACHE ao publicar uma versão nova do app.
const CACHE = "corretor-v1.0.1";
const ARQS = ["./", "index.html", "app.js", "reader.js", "vendor/jsQR.js", "manifest.webmanifest", "icone.svg", "icone-192.png", "icone-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQS))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
// rede primeiro (pega atualizações), cache se estiver offline
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then((r) => {
    const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return r;
  }).catch(() => caches.match(e.request)));
});
