/**
 * Buildert Service Worker — v3  (file stays named buildert_sw_1.js)
 *
 * v3 is YOUR v2 with three small touches — the structure and strategy were
 * already right, so this is a polish pass, not a rebuild:
 *   1. A network response that arrives AFTER the 4s timeout (slow backstage
 *      wifi) now still refreshes the cache, so the NEXT open is up to date.
 *      v2 discarded it.
 *   2. Tapping a notification when the app was fully closed now also opens
 *      the chat: openWindow() gets the {type:'open-chat'} message too, after
 *      a short boot delay. v2 only messaged already-open windows.
 *   3. A 'skip-waiting' message hook, so a future in-app "update now" button
 *      can activate a fresh worker without closing all tabs.
 * Cache name stays 'buildert-shell-v2' ON PURPOSE: the offline copy phones
 * already hold remains valid — a rename would throw it away for nothing.
 *
 * Job: make the mobile app OPEN with zero signal. Strategy:
 *   • Navigations (opening the app): network-first with a 4s timeout,
 *     falling back to the last cached copy. Every successful load refreshes
 *     the cache, so updates flow normally whenever there IS signal.
 *   • Same-origin static files (icons, manifest): cache-first.
 *   • The sync worker API (different origin) is NEVER intercepted — the
 *     app's own offline queue owns that failure path, and caching API
 *     responses would only serve stale project state.
 */
const CACHE = 'buildert-shell-v2';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// v3: on timeout the promise rejects (caller falls back to cache), but the
// in-flight fetch keeps going and refreshes the cache when it lands — a slow
// first open still means a fresh SECOND open.
function networkWithTimeout(req, ms, cache) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, ms);
    fetch(req).then(r => {
      clearTimeout(t);
      if (timedOut) {
        if (r && r.ok && cache) cache.put(req, r.clone()).catch(() => {});
        return;
      }
      resolve(r);
    }, e => { clearTimeout(t); if (!timedOut) reject(e); });
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // API & CDNs: hands off
  if (e.request.method !== 'GET') return;

  // App shell: the page itself
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await networkWithTimeout(e.request, 4000, cache);
        if (fresh && fresh.ok) cache.put(e.request, fresh.clone());
        return fresh;
      } catch (err) {
        const hit = await cache.match(e.request, { ignoreSearch: true });
        if (hit) return hit;
        // Last resort: any cached navigation (covers renamed html files)
        const all = await cache.keys();
        for (const k of all) {
          if (k.mode === 'navigate' || /\.html?$/.test(new URL(k.url).pathname) || new URL(k.url).pathname.endsWith('/')) {
            const h2 = await cache.match(k);
            if (h2) return h2;
          }
        }
        return new Response(
          '<meta charset="utf-8"><body style="background:#0a0f14;color:#8aa;font-family:sans-serif;text-align:center;padding-top:30vh">' +
          '<h2 style="color:#00d4ff">Buildert is offline</h2><p>Open the app once with signal to store it on this phone.</p>',
          { headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  // Static same-origin assets: cache-first
  if (/\.(png|json|ico|svg|webmanifest)$/.test(url.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try {
        const fresh = await fetch(e.request);
        if (fresh && fresh.ok) cache.put(e.request, fresh.clone());
        return fresh;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
  }
});

// ── 🔔 Push ──────────────────────────────────────────────────────────
// Pushes arrive without payload (VAPID-only design), so the notification is
// generic; the app's own channel badges take over once opened. The tag makes
// a burst of messages collapse into one notification instead of ten.
self.addEventListener('push', (e) => {
  e.waitUntil(self.registration.showNotification('Buildert', {
    body: '\ud83d\udcac Nieuw bericht in de crew-chat',
    tag: 'buildert-chat',
    renotify: false,
    icon: 'buildert_icon_192.png',
    badge: 'buildert_icon_192.png',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clientsArr) {
      if ('focus' in c) { await c.focus(); c.postMessage({ type: 'open-chat' }); return; }
    }
    // v3: app fully closed → open it AND still land in the chat
    const w = await self.clients.openWindow('./index.html');
    if (w) setTimeout(() => { try { w.postMessage({ type: 'open-chat' }); } catch (err) {} }, 2500);
  })());
});

// v3: lets the page activate a freshly-installed worker on demand
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'skip-waiting') self.skipWaiting();
});
