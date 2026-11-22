// Offline shell: every file is precached together, so a page never mixes two releases.
// Change VERSION whenever any file below changes; that is what triggers the update.
const VERSION = 'v8';
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
  'js/pinch.js',
  'js/week.js',
  'js/gcal.js',
  'js/project.js',
  'js/main.js',
  'js/xlsx.js',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // Each file is fetched under a URL unique to this release, so no HTTP cache (Safari's
  // included) can hand back the previous release's copy and mix two releases in one cache.
  // It is stored under its plain URL, which is what the page asks for.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(FILES.map((f) => {
        const url = new URL(f, self.location.href);
        url.searchParams.set('v', VERSION);
        return fetch(url, { cache: 'no-store' }).then((res) => {
          if (!res.ok) throw new Error(`${f}: ${res.status}`);
          return c.put(f, res);
        });
      })))
      .then(() => self.skipWaiting()),
  );
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
