/*
 * Fridge PWA — service worker (readable source).
 * Minified / uglified into /docs/sw.js by scripts/build.mjs.
 */
'use strict';

var CACHE = 'fridge-v1';
var DAY = 86400000;
var SCOPE = self.registration.scope;
var ASSETS = [
  './',
  './index.html',
  './help/',
  './help/index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  './icon-96.png'
];

function assetURL(path) {
  return new URL(path, SCOPE).href;
}

/* ---------- install / activate / fetch (offline-first) ---------- */

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) {
        return cache.addAll(ASSETS.map(assetURL));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (key) {
          return key !== CACHE;
        }).map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (response) {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        return response;
      }).catch(function () {
        return caches.match(request).then(function (cached) {
          return cached || caches.match(assetURL('./index.html'));
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      });
    })
  );
});

/* ---------- notifications ---------- */

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      return self.clients.openWindow(assetURL('./'));
    })
  );
});

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Fridge', {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-96.png',
    tag: data.tag || 'fridge-push',
    data: { url: './' }
  }));
});

self.addEventListener('periodicsync', function (event) {
  if (event.tag === 'expiry-check') event.waitUntil(checkExpiry());
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'check-expiry') event.waitUntil(checkExpiry());
});

/* ---------- minimal IndexedDB access (same store as the app) ---------- */

function openDB() {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.open('fridge-pwa', 1);
    request.onupgradeneeded = function () {
      var db = request.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

function withStore(mode, action) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('items', mode);
      var store = tx.objectStore('items');
      var request = action(store);
      tx.oncomplete = function () { resolve(request && request.result); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  });
}

function notify(title, body, tag) {
  return self.registration.showNotification(title, {
    body: body,
    tag: tag,
    icon: 'icon-192.png',
    badge: 'icon-96.png',
    data: { url: './' }
  });
}

function checkExpiry() {
  return withStore('readwrite', function (store) { return store.getAll(); })
    .then(function (items) {
      var now = Date.now();
      var jobs = [];
      var changed = false;

      items.forEach(function (item) {
        var flag = null;
        var title = null;
        var body = null;

        if (item.expiresAt <= now && !item.notifiedExpired) {
          flag = 'notifiedExpired';
          title = 'Expired: ' + item.name;
          body = 'Was due ' + new Date(item.expiresAt).toISOString();
        } else if (item.expiresAt > now && item.expiresAt - now <= DAY && !item.notifiedSoon) {
          flag = 'notifiedSoon';
          title = 'Expiring soon: ' + item.name;
          body = 'Expires ' + new Date(item.expiresAt).toISOString();
        }

        if (flag) {
          item[flag] = true;
          changed = true;
          jobs.push(
            notify(title, body, 'fridge-' + item.id).catch(function () { /* permission may be absent */ }),
            withStore('readwrite', function (store) { return store.put(item); })
          );
        }
      });

      return Promise.all(jobs);
    })
    .catch(function () { /* no items or storage unavailable */ });
}
