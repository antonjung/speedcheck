const CACHE_NAME = "speedcheck-1.0.19"; // kept in sync with VERSION / BUILD_VERSION by deploy.sh on every deploy
const PRECACHE_URLS = [
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "icon-192.png",
  "icon-512.png",
  "favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests for the app shell. This app has no
  // other network dependencies (geolocation is an on-device API).
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Network-first so a new deploy shows up on the next load; fall back to the
  // cache when offline.
  event.respondWith(
    fetch(event.request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
