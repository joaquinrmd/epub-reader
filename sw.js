/* ════════════════════════════════════════════════════════
   Mi Lector — sw.js  (v5 — network-first para shell)

   Estrategia:
   - Shell propio (HTML/CSS/JS de la app): NETWORK-FIRST.
     Siempre intenta traer la versión nueva. Si hay red → la usa
     y actualiza cache. Si no hay red → cae al cache. Esto
     garantiza que cuando subo un fix a GitHub, el usuario lo
     ve en el siguiente refresh sin tener que limpiar cache.
   - Assets externos (Google Fonts, JSZip CDN): CACHE-FIRST.
     Estos no cambian, conviene cachearlos para offline.

   skipWaiting + clientsClaim: el SW nuevo toma control de
   inmediato cuando se instala. No hay que cerrar todas las
   pestañas/PWAs para que se active. Combinado con el reload
   en app.js cuando detecta controllerchange, el update es
   transparente (un blink y ya estás en la versión nueva).
   ════════════════════════════════════════════════════════ */

const VERSION = 'v11-2026-04-28-fetch-upload';
const SHELL_CACHE  = 'mi-lector-shell-'  + VERSION;
const ASSETS_CACHE = 'mi-lector-assets-' + VERSION;

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg'
];

// ── INSTALL: precachear el shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES).catch(() => {}))
      .then(() => self.skipWaiting())  // toma control sin esperar
  );
});

// ── ACTIVATE: borrar caches viejos y reclamar clientes ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== ASSETS_CACHE)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: estrategia diferenciada por tipo de recurso ──
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. Mismo origen (la app) → network-first
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  // 2. Google Fonts → cache-first (los archivos de fuente nunca cambian
  //    en una URL dada, llevan hash en el nombre)
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(req, ASSETS_CACHE));
    return;
  }

  // 3. JSZip CDN → cache-first
  if (url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(cacheFirst(req, ASSETS_CACHE));
    return;
  }

  // 4. APIs de Google (Drive, GAPI, GSI) → siempre red, sin cachear
  if (url.hostname.includes('apis.google.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('accounts.google.com')) {
    return; // dejar pasar por la red sin tocar
  }

  // 5. Cualquier otra cosa → red sin cache
});

// Network-first: intenta red, si falla cae a cache.
async function networkFirst(req, cacheName) {
  try {
    const fresh = await fetch(req);
    // Solo cachear respuestas válidas
    if (fresh && fresh.status === 200 && fresh.type === 'basic') {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    // Fallback final: el index.html, así la PWA al menos arranca offline
    if (req.mode === 'navigate') {
      const indexCached = await caches.match('./index.html');
      if (indexCached) return indexCached;
    }
    throw e;
  }
}

// Cache-first: usa cache si existe, si no va a red y cachea.
async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    return cached || Response.error();
  }
}

// Mensajes desde el cliente (el app.js puede pedir SKIP_WAITING)
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
