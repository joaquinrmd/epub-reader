/* ══════════════════════════════════════════════════
   Mi Lector — Service Worker
   Estrategia: Cache First para el shell de la app
   ══════════════════════════════════════════════════ */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `mi-lector-shell-${CACHE_VERSION}`;

// Assets estáticos del shell — se cachean en el install
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;1,400&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&display=swap'
];

// Orígenes que nunca deben cachearse (Drive API, auth)
const NO_CACHE_ORIGINS = [
  'https://www.googleapis.com',
  'https://accounts.google.com',
  'https://oauth2.googleapis.com',
  'https://apis.google.com'
];

// ─── INSTALL: pre-cachear el shell ───
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => {
      return Promise.allSettled(
        SHELL_ASSETS.map(url =>
          cache.add(url).catch(err => {
            console.warn(`[SW] No se pudo cachear: ${url}`, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE: limpiar caches viejos ───
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('mi-lector-') && key !== SHELL_CACHE)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH: Cache First para el shell, Network Only para Drive API ───
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // No cachear requests de Drive/Google Auth
  if (NO_CACHE_ORIGINS.some(origin => request.url.startsWith(origin))) {
    return; // dejar que el browser maneje normalmente
  }

  // Solo cachear GET
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        // Cache First: devolver desde cache, revalidar en background
        const networkFetch = fetch(request).then(response => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            caches.open(SHELL_CACHE).then(cache => cache.put(request, response.clone()));
          }
          return response;
        }).catch(() => {}); // silenciar errores de red en background
        return cached;
      }

      // No está en cache — ir a la red
      return fetch(request).then(response => {
        if (!response || response.status !== 200) return response;

        // Cachear fonts y assets de CDN
        const shouldCache =
          url.origin === self.location.origin ||
          url.hostname === 'fonts.googleapis.com' ||
          url.hostname === 'fonts.gstatic.com' ||
          url.hostname === 'cdnjs.cloudflare.com';

        if (shouldCache) {
          caches.open(SHELL_CACHE).then(cache => {
            cache.put(request, response.clone());
          });
        }

        return response;
      }).catch(() => {
        // Sin red y sin cache — devolver página offline si existe
        if (request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
