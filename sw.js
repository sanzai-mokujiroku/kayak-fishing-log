// 釣行記録 サービスワーカー: アプリ本体をキャッシュし、電波の無い場所でも起動できるようにする。
// アプリを更新したら CACHE の番号を上げる(古いキャッシュを破棄するため)。
const CACHE = "fishing-log-v11";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-180.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// アプリ本体(HTML/JS)はネットワーク優先＝オンラインなら常に最新を配信。
// 圏外の時だけキャッシュにフォールバック（海の上でも起動できる）。
// アイコン等はキャッシュ優先で高速に。
function isShell(req, url) {
  return req.mode === "navigate"
    || url.pathname.endsWith("/")
    || url.pathname.endsWith("/index.html")
    || url.pathname.endsWith("/app.js");
}
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  if (isShell(e.request, url)) {
    // ネットワーク優先
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // その他はキャッシュ優先
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
