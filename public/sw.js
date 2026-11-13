'use strict';
// Service worker: makes Field Ops installable ("Add to Home Screen") and lets the app open with no signal.
//  - The app's own files (HTML, JS, CSS, icons) are fetched from the network first, so an update shows up right away;
//    the last copy is kept and used only when the network is down.
//  - /api/* and customer pages (/p/...) are never cached: data always comes live from the server.
const CACHE = 'fieldops-shell-v37';
const SHELL = ['/', '/styles.css', '/app.js', '/lookup.js', '/ext.js', '/billing.js', '/import.js', '/projects.js', '/report_doc.js', '/workbook.js', '/field.js', '/notify.js', '/kpi.js', '/estimating.js', '/pipeline.js', '/plaid.js',
  '/brand/a4y-logo.png', '/brand/favicon.png', '/icons/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => null).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/p/') || url.pathname.startsWith('/uploads/')) return;
  const isPage = req.mode === 'navigate';
  if (isPage && url.pathname !== '/' && url.pathname !== '/index.html') return; // other pages (privacy, printouts) pass straight through
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(isPage ? '/' : req, copy)); }
    return res;
  }).catch(() => caches.match(isPage ? '/' : req).then(hit => hit || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }))));
});

// ---- notifications: "you're on a new job", "your visit moved" (sent by server/push.js)
self.addEventListener('push', e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch { m = { title: 'Field Ops', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Field Ops', { body: m.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    data: { url: m.url || '#/' }, tag: m.url || undefined, renotify: true }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = '/' + (e.notification.data && e.notification.data.url || '#/');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === self.location.origin);
    if (open) return open.focus().then(c => c.navigate ? c.navigate(target) : c);
    return self.clients.openWindow(target);
  }));
});
