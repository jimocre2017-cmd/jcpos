/* Jimo Cafe POS アプリ版 Service Worker
 * 画面ファイルを端末に保存し、オフラインでも開けるようにする。
 * サーバー（Google Apps Script）との通信は扱わない（api.js 側で送信待ちとして保存）。
 *
 * 更新の仕組み：
 * - 画面ファイルは「ネット優先」。オンラインなら毎回最新版を読み、ネットが無い・遅い時だけ保存版を使う。
 * - 画面を更新したら VERSION を上げる。端末側（api.js）が定期的にこのファイルを確認し、
 *   VERSION が変わっていれば自動で新しい版に切り替わる（再インストール不要）。
 */
var VERSION = 'jcpos-v4';
var FILES = ['./', './index.html', './kitchen.html', './api.js', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];
var FONT_CACHE = 'jcpos-fonts';
var NET_TIMEOUT_MS = 4000; // これ以上かかったら保存版で表示（電波が弱い時も待たせない）

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    // ブラウザのHTTPキャッシュを通さず、必ず最新ファイルを保存する
    return Promise.all(FILES.map(function (f) {
      return fetch(new Request(f, { cache: 'reload' })).then(function (res) { if (res.ok) return c.put(f, res); });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== FONT_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// 画面からの問い合わせに今のバージョンを返す
self.addEventListener('message', function (e) {
  if (e.data === 'version' && e.source) e.source.postMessage({ type: 'jcpos-version', version: VERSION });
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Google フォント：一度読んだら端末に保存（オフラインでも同じ見た目に）
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONT_CACHE).then(function (cache) {
      return cache.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; });
      });
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;
  // sw.js 自体はブラウザに任せる（更新確認を邪魔しない）
  if (url.pathname.endsWith('/sw.js')) return;

  // 同じサイトのファイル：ネット優先。届いたら保存版も更新。ネットが無い・遅い時は保存版。
  e.respondWith(caches.open(VERSION).then(function (cache) {
    var net = fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    var fallback = function () {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) { return hit || net; });
    };
    var timer = new Promise(function (resolve) { setTimeout(resolve, NET_TIMEOUT_MS); }).then(function () {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) { return hit || net; });
    });
    return Promise.race([net.catch(fallback), timer]).catch(fallback);
  }));
});
