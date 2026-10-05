/* Jimo Cafe POS アプリ版 Service Worker
 * 画面ファイルを端末に保存し、オフラインでも開けるようにする。
 * サーバー（Google Apps Script）との通信は扱わない（api.js 側で送信待ちとして保存）。
 * 画面を更新したら VERSION を上げる。
 */
var VERSION = 'jcpos-v1';
var FILES = ['./', './index.html', './kitchen.html', './api.js', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];
var FONT_CACHE = 'jcpos-fonts';

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== FONT_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
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
  // 同じサイトのファイル：保存版をすぐ返し、裏で最新版を取りにいく（次回から反映）
  e.respondWith(caches.open(VERSION).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});
