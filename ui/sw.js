// Blip's app shell. iPhone-first: the installed PWA must open instantly and
// render the last saved chats with no network. Private API responses never go
// through this cache; the page keeps its own small offline store.
const VERSION = "blip-shell-2026-10-31-2";
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

async function shellResponse(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match("/");
  const fresh = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put("/", response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await fresh) || new Response("Blip is offline.", { status: 503, headers: { "content-type": "text/plain" } });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Private, authenticated data stays out of the HTTP cache.
  if (url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(shellResponse(request));
    return;
  }
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
