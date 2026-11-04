// Offline shell: every file is precached together, so a page never mixes two releases.
// Change VERSION whenever any file below changes; that is what triggers the update.
const VERSION = 'v2';
const CACHE = `daily-gantt-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/core.js',
  'js/markdown.js',
  'js/ui.js',
  'js/store.js',
  'js/sync.js',
  'js/sheet.js',
  'js/views.js',
  'js/gantt.js',
  'js/planner.js',
  'js/calendar.js',
  'js/diary.js',
  'js/main.js',
  'js/xlsx.js',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the HTTP cache, or a release could precache the previous one's files.
  const requests = FILES.map((f) => new Request(f, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(requests)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('daily-gantt-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) => hit || fetch(e.request).catch(() => (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error())),
    ),
  );
});
