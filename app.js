/* ════════════════════════════════════════════════════════════════
   Mi Lector — app.js  (v7 — scroll vertical)

   Cambios vs v6:
   • SE FUE el motor de paginación completo. Adiós column-fill,
     paginate(), goToPage(), wrapper de clipping, ResizeObserver
     del column flow, tap-zones, swipe horizontal, wheel-paging.
   • El reader es scroll vertical nativo. iPad y desktop lo manejan
     perfecto, sin trabajo extra del browser ni nuestro.
   • La selección NO se desborda porque el usuario solo puede
     arrastrar dentro del viewport visible. Sin trucos de clamp.
   • Highlights se aplican UNA vez al renderizar el HTML. Como el
     DOM es estable (sin re-paginación), persisten para siempre.
   • Cambio de fuente = solo cambia `font-size`. INSTANTÁNEO.
   • Posición guardada vía paraIdx del primer párrafo visible.
     Restaurar = scrollIntoView de ese párrafo.
   • Status bar nuevo: barra de progreso fina + "Cap. X · YY%".

   COMPATIBLE: esquemas de IndexedDB y Drive intactos.
   Highlights antiguos siguen funcionando vía búsqueda por texto.
   ════════════════════════════════════════════════════════════════ */
'use strict';

const CLIENT_ID   = '602238897882-g752d4mbev0d2leg8fvnq7lqt6jsof8l.apps.googleusercontent.com';
const SCOPES      = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
const INBOX_FOLDER_NAME = 'Lector-Inbox';
const DRIVE_FILE  = 'mi-lector-data.json';
const DB_NAME     = 'mi-lector-db';
const DB_VERSION  = 2;
const FONT_MIN    = 14;
const FONT_MAX    = 22;
const THEMES      = ['day', 'sepia', 'night'];
const THEME_ICONS = { day: '☀', sepia: '📜', night: '🌙' };

// ── Estado global ──
let state = { books: [], highlights: [], currentBookId: null };
let prefs = { theme: 'day', fontSize: 17 };

/* Generador de IDs únicos universales para evitar colisiones entre
   dispositivos cuando sincronizan vía Drive. Formato:
     {prefix}-{timestamp}-{random}
   Por ejemplo: hl-1730312345678-x9k2pq

   Esto reemplaza al sistema viejo de nextId++ que generaba IDs
   numéricos secuenciales independientes en cada dispositivo (compu
   y iPad podían ambos generar id=47 y al sincronizar se pisaban). */
function generateId(prefix) {
  const ts = Date.now();
  const rnd = Math.random().toString(36).substring(2, 10);
  return `${prefix}-${ts}-${rnd}`;
}

// ── Estado del libro abierto ──
let allParagraphs       = [];
let anchorMap           = {};   // { anchorId → paraIdx }   (links internos)
let fileChapterMap      = {};   // { filename → chapterIndex }
let currentBookChapters = [];
let currentChapterIndex = 0;
let totalChapters       = 0;
let currentTab          = 'reader';

// ── UI ──
let currentColor   = 'yellow';

// ── Drive ──
let driveReady   = false;
let driveFileId  = null;
let tokenClient  = null;
let driveTimer   = null;
let saveTimer    = null;
let scrollRaf    = 0;
let db;

// ════════════════════════════════════════════════════════════════
//  INDEXEDDB
// ════════════════════════════════════════════════════════════════

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('highlights')) {
        const hs = d.createObjectStore('highlights', { keyPath: 'id' });
        hs.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!d.objectStoreNames.contains('prefs')) d.createObjectStore('prefs', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('bookmarks')) {
        const bs = d.createObjectStore('bookmarks', { keyPath: 'id' });
        bs.createIndex('bookId', 'bookId', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbOp(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

const dbGet    = (s, k) => dbOp(s, 'readonly',  st => st.get(k));
const dbPut    = (s, v) => dbOp(s, 'readwrite', st => st.put(v));
const dbDelete = (s, k) => dbOp(s, 'readwrite', st => st.delete(k));
const dbGetAll = s      => dbOp(s, 'readonly',  st => st.getAll());

function dbGetByIndex(sn, in_, val) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(sn, 'readonly').objectStore(sn).index(in_).getAll(val);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbDeleteAllByIndex(sn, in_, val) {
  const items = await dbGetByIndex(sn, in_, val).catch(() => []);
  for (const item of items) await dbDelete(sn, item.id).catch(() => {});
}

// ════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════

window.addEventListener('load', async () => {
  showLoading('Iniciando...');
  try {
    db = await openDB();
    await migrateFromLocalStorage();
    await loadState();
    applyPrefs();
    await applySidebarPref();
    renderSidebar();
    setupReaderScroll();
    setupSelectionHandlers();
    setupKeyboard();
    setupSearch();
    if (state.currentBookId) await selectBook(state.currentBookId);
    renderHighlights();
  } catch (e) {
    console.error('[Init]', e);
    setStatus('Error al iniciar — recargá la página');
  }
  hideLoading();
  loadGapiScript();
  setupServiceWorker();
  tryAutoreconnectDrive();
});

async function migrateFromLocalStorage() {
  try {
    const raw = localStorage.getItem('mi_lector_v2');
    if (!raw) return;
    const old = JSON.parse(raw);
    for (const b of (old.books || [])) {
      if (!(await dbGet('books', b.id))) {
        await dbPut('books', {
          id: b.id, title: b.title, author: b.author || '',
          chapters: [{ index: 0, title: null, html: b.html || '', filename: '' }],
          coverBase64: null
        });
      }
    }
    for (const h of (old.highlights || [])) {
      if (!(await dbGet('highlights', h.id))) await dbPut('highlights', h);
    }
    if (old.currentBookId) await dbPut('prefs', { key: 'currentBookId', value: old.currentBookId });
    localStorage.removeItem('mi_lector_v2');
  } catch (e) {}
}

async function loadState() {
  const books      = await dbGetAll('books');
  state.books      = books.map(b => ({
    id: b.id,
    title: b.title,
    author: b.author || '',
    fileType: b.fileType || 'epub',
    driveEpubFileId: b.driveEpubFileId || null,
    remoteKnown: !!b.remoteKnown
  }));
  state.highlights = await dbGetAll('highlights');
  const cur = await dbGet('prefs', 'currentBookId');  state.currentBookId = cur ? cur.value : null;
  const th  = await dbGet('prefs', 'theme');          prefs.theme         = th  ? th.value  : 'day';
  const fs  = await dbGet('prefs', 'fontSize');       prefs.fontSize      = fs  ? fs.value  : 17;
}

async function savePref(key, value) {
  try { await dbPut('prefs', { key, value }); } catch (e) {}
}

// ════════════════════════════════════════════════════════════════
//  SERVICE WORKER (auto-update)
// ════════════════════════════════════════════════════════════════

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          installing.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });
    setTimeout(() => reg.update().catch(() => {}), 1500);
  }).catch(() => {});

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

// ════════════════════════════════════════════════════════════════
//  PREFERENCIAS
// ════════════════════════════════════════════════════════════════

function applyPrefs() {
  document.documentElement.setAttribute('data-theme', prefs.theme);
  document.getElementById('page-content').style.fontSize = prefs.fontSize + 'px';
  updateThemeBtn();
  updateFontBtns();
}

function cycleTheme() {
  prefs.theme = THEMES[(THEMES.indexOf(prefs.theme) + 1) % THEMES.length];
  document.documentElement.setAttribute('data-theme', prefs.theme);
  savePref('theme', prefs.theme);
  updateThemeBtn();
}
function updateThemeBtn() {
  const b = document.getElementById('btn-theme');
  if (b) b.textContent = THEME_ICONS[prefs.theme];
}

/* Cambio de fuente: solo actualiza la propiedad font-size.
   El navegador re-acomoda el texto inline. NO hay que recalcular
   nada porque no hay paginación. INSTANTÁNEO. */
function changeFontSize(delta) {
  const old = prefs.fontSize;
  prefs.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, prefs.fontSize + delta));
  if (prefs.fontSize === old) return;

  // Capturar párrafo visible para mantener la posición de lectura
  const anchorIdx = getFirstVisibleParaIdx();

  document.getElementById('page-content').style.fontSize = prefs.fontSize + 'px';
  savePref('fontSize', prefs.fontSize);
  updateFontBtns();

  // Re-scroll al mismo párrafo (su posición Y cambió porque la fuente cambió)
  if (anchorIdx != null) {
    requestAnimationFrame(() => scrollToParaIdx(anchorIdx, 'auto'));
  }
}

function updateFontBtns() {
  const m = document.getElementById('btn-font-minus');
  const p = document.getElementById('btn-font-plus');
  if (m) m.disabled = prefs.fontSize <= FONT_MIN;
  if (p) p.disabled = prefs.fontSize >= FONT_MAX;
}

// ════════════════════════════════════════════════════════════════
//  GOOGLE DRIVE
// ════════════════════════════════════════════════════════════════

function loadGapiScript() {
  const s1 = document.createElement('script');
  s1.src    = 'https://apis.google.com/js/api.js';
  s1.onload = () => gapi.load('client', () =>
    gapi.client.init({
      apiKey: '',
      discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest']
    }));
  document.head.appendChild(s1);
  const s2 = document.createElement('script');
  s2.src = 'https://accounts.google.com/gsi/client';
  document.head.appendChild(s2);
}

function initDrive(silent) {
  if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
    if (!silent) setStatus('Cargando Google...');
    setTimeout(() => initDrive(silent), 800);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID, scope: SCOPES,
    callback: async resp => {
      if (resp.error) {
        if (!silent) setStatus('Error al conectar Drive');
        // Si el error es no_session/interaction_required, dejar el flag
        // de autoconnect — la próxima vez tal vez funcione. Pero si es
        // access_denied, sí limpiar.
        if (resp.error === 'access_denied') {
          savePref('driveAutoconnect', false);
        }
        return;
      }
      driveReady = true;
      // Guardar el token con expiración para usarlo si la app se recarga
      // antes de que expire (Google da tokens de ~1 hora)
      if (resp.access_token && resp.expires_in) {
        const expiresAt = Date.now() + (resp.expires_in * 1000) - 30000; // -30s buffer
        savePref('driveToken', { token: resp.access_token, expiresAt, scope: SCOPES });
        // Setearlo en gapi también para que las llamadas usen este token
        if (window.gapi && gapi.client) {
          gapi.client.setToken({ access_token: resp.access_token });
        }
      }
      markDriveAsConnected();
      savePref('driveAutoconnect', true);
      if (!silent) setStatus('Conectado — sincronizando...');
      else        setStatus('Drive sincronizando...');
      await syncFromDrive();
    }
  });
  // prompt vacío = sin UI si hay sesión activa de Google. Si no, fallará
  // silenciosamente con error 'no_session' / 'interaction_required'.
  tryRequestToken(silent);
}

/* Marca la UI como "Drive conectado" — incluye mostrar el botón
   "Sincronizar ahora" que solo tiene sentido con conexión activa. */
function markDriveAsConnected() {
  driveReady = true;
  const btn = document.getElementById('drive-btn');
  if (btn) {
    btn.textContent = 'Drive conectado';
    btn.classList.add('connected');
  }
  const dot = document.getElementById('drive-dot');
  if (dot) dot.classList.add('connected');
  const statusText = document.getElementById('drive-status-text');
  if (statusText) statusText.textContent = 'Google Drive activo';
  const syncBtn = document.getElementById('sync-now-btn');
  if (syncBtn) syncBtn.style.display = 'block';
}

function tryRequestToken(silent) {
  try {
    tokenClient.requestAccessToken({ prompt: silent ? 'none' : '' });
  } catch (e) {
    console.error('[tokenRequest]', e);
    if (!silent) setStatus('Error pidiendo token');
  }
}

/* Intenta autoreconectar al iniciar:
   1. Si tenemos un token guardado que aún no expiró, usarlo directamente.
      Esto evita ir a Google completamente — la app abre con Drive listo.
   2. Si no hay token vigente pero el flag driveAutoconnect está, intentar
      requestAccessToken({ prompt: 'none' }) — silencioso. */
async function tryAutoreconnectDrive() {
  const auto = await dbGet('prefs', 'driveAutoconnect').catch(() => null);
  if (!auto || !auto.value) return;

  const tokRec = await dbGet('prefs', 'driveToken').catch(() => null);
  // Si el scope cambió desde la última vez, el token guardado no sirve —
  // ignorarlo para forzar reautorización con el scope nuevo.
  const tokenScopeMatches = tokRec && tokRec.value && tokRec.value.scope === SCOPES;
  if (tokRec && tokRec.value && tokRec.value.expiresAt > Date.now() && tokenScopeMatches) {
    // Tenemos token vigente con el scope correcto — usarlo
    waitForGapiThen(() => {
      gapi.client.setToken({ access_token: tokRec.value.token });
      markDriveAsConnected();
      setStatus('Drive sincronizando...');
      syncFromDrive();
    });
    return;
  }

  // Sin token vigente, o scope cambió — pedir uno nuevo silencioso
  waitForGapiThen(() => initDrive(true));
}

/* Espera a que tanto gapi como google.accounts estén listos antes de ejecutar fn. */
function waitForGapiThen(fn) {
  let attempts = 0;
  const check = () => {
    attempts++;
    const ok = window.gapi && gapi.client && window.google &&
               google.accounts && google.accounts.oauth2;
    if (ok) { fn(); return; }
    if (attempts > 40) return;  // ~20s de espera total
    setTimeout(check, 500);
  };
  check();
}

async function syncFromDrive() {
  showLoading('Sincronizando con Drive...');
  try {
    const token = (window.gapi && gapi.client && gapi.client.getToken &&
                   gapi.client.getToken().access_token);
    if (!token) throw new Error('sin token');

    // Buscar el JSON
    const listResp = await fetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent("name='" + DRIVE_FILE + "'")}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!listResp.ok) throw new Error('list falló: ' + listResp.status);
    const listData = await listResp.json();

    if (listData.files && listData.files.length > 0) {
      driveFileId = listData.files[0].id;
      const getResp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!getResp.ok) throw new Error('get falló: ' + getResp.status);
      const remoteData = await getResp.json();
      await mergeState(remoteData);
      await reconcileBooksWithDrive();
      renderSidebar();
      renderHighlights();
      if (currentTab === 'library') renderLibrary();
      setStatus('Sincronizado con Drive');
    } else {
      // No existe JSON remoto, crear uno con el estado local
      await uploadJsonToDrive();
      setStatus('Datos guardados en Drive');
    }
  } catch (e) {
    console.error('[syncFromDrive]', e);
    setStatus('Error sincronizando: ' + (e.message || '').substring(0, 80));
  }
  hideLoading();
}

/* Reconcilia los libros locales con los archivos book-{id}.{epub,txt} que
   existen en appDataFolder. Esto cubre dos casos:
   1. Libros viejos subidos antes de que existiera el campo driveEpubFileId.
   2. Libros donde el upload terminó pero el JSON aún no se guardó (race).
   Lista una sola vez TODOS los archivos book-* del appDataFolder y los
   matchea con los libros locales. Mucho más rápido que pedir uno por uno. */
async function reconcileBooksWithDrive() {
  if (!driveReady) return;
  const token = (window.gapi && gapi.client && gapi.client.getToken &&
                 gapi.client.getToken().access_token);
  if (!token) return;
  try {
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent("name contains 'book-'")}&fields=files(id,name)&pageSize=500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return;
    const data = await resp.json();
    const files = data.files || [];
    const byName = {};
    for (const f of files) byName[f.name] = f.id;

    let changed = false;
    for (const book of state.books) {
      const ext = book.fileType === 'txt' ? 'txt' : 'epub';
      const filename = `book-${book.id}.${ext}`;
      const driveId = byName[filename];
      if (driveId && book.driveEpubFileId !== driveId) {
        book.driveEpubFileId = driveId;
        const full = await dbGet('books', book.id);
        if (full) {
          full.driveEpubFileId = driveId;
          await dbPut('books', full);
        }
        changed = true;
      }
    }
    if (changed) saveToDrive();
  } catch (e) {
    console.error('[reconcileBooksWithDrive]', e);
  }
}

/* Mergea el estado remoto (JSON de Drive) con el local.

   Estrategia para detectar borrados:
   - Cuando un libro/highlight aparece en el JSON remoto, lo marcamos
     localmente con `remoteKnown: true`.
   - En sucesivos syncs, si un item estaba marcado como remoteKnown pero
     YA NO aparece en el remoto, significa que fue borrado en otro
     dispositivo → lo borramos localmente.
   - Items sin `remoteKnown` son nuevos en ESTE dispositivo y aún no
     subieron — no se tocan, esperan a que el próximo saveToDrive los
     suba al JSON remoto. */
async function mergeState(remote) {
  const remoteHlIds   = new Set((remote.highlights || []).map(h => h.id));
  const remoteBookIds = new Set((remote.books      || []).map(b => b.id));

  // ─── HIGHLIGHTS ───
  // 1. Agregar highlights nuevos del remoto
  const localHlIds = new Set(state.highlights.map(h => h.id));
  for (const h of (remote.highlights || [])) {
    if (!localHlIds.has(h.id)) {
      h.remoteKnown = true;
      state.highlights.push(h);
      await dbPut('highlights', h);
    } else {
      // Ya existe — marcarlo como conocido por remoto (si no lo estaba)
      const local = state.highlights.find(lh => lh.id === h.id);
      if (local && !local.remoteKnown) {
        local.remoteKnown = true;
        await dbPut('highlights', local);
      }
    }
  }
  // 2. Borrar highlights que estaban marcados como remoteKnown pero ya no aparecen
  const hlsToDelete = state.highlights.filter(h =>
    h.remoteKnown && !remoteHlIds.has(h.id)
  );
  for (const h of hlsToDelete) {
    await dbDelete('highlights', h.id).catch(() => {});
    // Despintar el span del DOM si está visible (libro actualmente abierto)
    const span = document.querySelector(`[data-hl-id="${h.id}"]`);
    if (span) {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      // Normalizar para juntar nodos de texto adyacentes
      if (parent.normalize) parent.normalize();
    }
  }
  if (hlsToDelete.length) {
    state.highlights = state.highlights.filter(h => !hlsToDelete.some(d => d.id === h.id));
  }

  // 3. Pintar highlights nuevos del remoto en el DOM (si el libro actual es el mismo)
  if (typeof applyHighlightsToContent === 'function' && state.currentBookId) {
    applyHighlightsToContent();
  }

  // ─── BOOKS ───
  const localBookIds = new Set(state.books.map(b => b.id));
  for (const b of (remote.books || [])) {
    if (!localBookIds.has(b.id)) {
      // Libro nuevo en este dispositivo — viene con driveEpubFileId si está en Drive
      const driveEpubFileId = b.driveEpubFileId || null;
      const fileType = b.fileType || 'epub';
      state.books.push({
        id: b.id,
        title: b.title,
        author: b.author || '',
        fileType,
        driveEpubFileId,
        remoteKnown: true
      });
      await dbPut('books', {
        id: b.id, title: b.title, author: b.author || '',
        chapters: [], coverBase64: null,
        fileType,
        driveEpubFileId,
        remoteKnown: true
      });
    } else {
      // Libro ya existe localmente
      const local = state.books.find(lb => lb.id === b.id);
      if (local) {
        local.remoteKnown = true;
        // Actualizar driveEpubFileId si vino remoto y no lo teníamos
        if (b.driveEpubFileId && !local.driveEpubFileId) {
          local.driveEpubFileId = b.driveEpubFileId;
        }
        if (b.fileType && !local.fileType) local.fileType = b.fileType;
      }
      const fullLocal = await dbGet('books', b.id);
      if (fullLocal) {
        fullLocal.remoteKnown = true;
        if (b.driveEpubFileId && !fullLocal.driveEpubFileId) {
          fullLocal.driveEpubFileId = b.driveEpubFileId;
        }
        if (b.fileType && !fullLocal.fileType) fullLocal.fileType = b.fileType;
        await dbPut('books', fullLocal);
      }
    }
  }
  // Borrar libros que estaban marcados como remoteKnown pero ya no aparecen
  const booksToDelete = state.books.filter(b =>
    b.remoteKnown && !remoteBookIds.has(b.id)
  );
  for (const b of booksToDelete) {
    // Borrar de IndexedDB y todos sus datos relacionados
    await dbDelete('books', b.id).catch(() => {});
    await dbDeleteAllByIndex('highlights', 'bookId', b.id).catch(() => {});
    await dbDeleteAllByIndex('bookmarks',  'bookId', b.id).catch(() => {});
    await dbDelete('prefs', `pos_${b.id}`).catch(() => {});
    // Si era el libro abierto, limpiar UI
    if (state.currentBookId === b.id) {
      state.currentBookId = null;
      await savePref('currentBookId', null);
      mountEmptyBook('Este libro fue borrado en otro dispositivo.');
      document.getElementById('book-title-display').textContent = 'Mi Lector';
    }
  }
  if (booksToDelete.length) {
    const toDeleteIds = new Set(booksToDelete.map(b => b.id));
    state.books      = state.books.filter(b => !toDeleteIds.has(b.id));
    state.highlights = state.highlights.filter(h => !toDeleteIds.has(h.bookId));
  }
}

/* Hace el upload real del JSON de estado a Drive con fetch directo.
   Devuelve true si se subió bien, false si falló. Lanza errores que
   el caller puede capturar para mostrar mensajes específicos. */
async function uploadJsonToDrive() {
  if (!driveReady) throw new Error('Drive no conectado');
  const token = (window.gapi && gapi.client && gapi.client.getToken &&
                 gapi.client.getToken().access_token);
  if (!token) throw new Error('Sin access token');

  const payload = JSON.stringify({
    books: state.books.map(b => ({
      id: b.id,
      title: b.title,
      author: b.author,
      fileType: b.fileType || 'epub',
      driveEpubFileId: b.driveEpubFileId || null
    })),
    highlights: state.highlights.map(h => {
      const { remoteKnown, ...rest } = h;
      return rest;
    })
  });

  // Si no tenemos driveFileId cacheado, buscar el archivo
  if (!driveFileId) {
    const listResp = await fetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent("name='" + DRIVE_FILE + "'")}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!listResp.ok) throw new Error('list falló: ' + listResp.status);
    const data = await listResp.json();
    if (data.files && data.files.length > 0) {
      driveFileId = data.files[0].id;
    } else {
      // Crear el archivo primero
      const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: DRIVE_FILE,
          parents: ['appDataFolder'],
          mimeType: 'application/json'
        })
      });
      if (!createResp.ok) throw new Error('create falló: ' + createResp.status);
      const meta = await createResp.json();
      driveFileId = meta.id;
    }
  }

  // Subir el contenido (PATCH con uploadType=media)
  const uploadResp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: payload
    }
  );
  if (!uploadResp.ok) {
    const txt = await uploadResp.text().catch(() => '');
    throw new Error(`upload falló: ${uploadResp.status} — ${txt.substring(0, 200)}`);
  }

  // Verificar leyendo el archivo de vuelta
  const verifyResp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${driveFileId}?fields=id,size,modifiedTime`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!verifyResp.ok) throw new Error('verify falló: ' + verifyResp.status);
  const verifyData = await verifyResp.json();
  const remoteSize = parseInt(verifyData.size, 10);
  const localSize = new Blob([payload]).size;
  if (Math.abs(remoteSize - localSize) > 50) {
    throw new Error(`tamaño no coincide: local=${localSize} remoto=${remoteSize}`);
  }

  console.log(`[saveToDrive] OK — ${localSize} bytes, ${state.books.length} libros, ${state.highlights.length} highlights`);

  // Marcar todos los items como remoteKnown (baseline para detección de borrados)
  for (const b of state.books) {
    if (!b.remoteKnown) {
      b.remoteKnown = true;
      const full = await dbGet('books', b.id);
      if (full) {
        full.remoteKnown = true;
        await dbPut('books', full);
      }
    }
  }
  for (const h of state.highlights) {
    if (!h.remoteKnown) {
      h.remoteKnown = true;
      await dbPut('highlights', h);
    }
  }

  return { localSize, remoteSize, books: state.books.length, highlights: state.highlights.length };
}

/* Versión debounced para llamadas automáticas (después de cada cambio).
   Evita subir 10 veces seguidas si el usuario hace varios cambios rápidos. */
async function saveToDrive() {
  if (!driveReady) return;
  clearTimeout(driveTimer);
  driveTimer = setTimeout(async () => {
    try {
      await uploadJsonToDrive();
      const ind = document.getElementById('sync-indicator');
      if (ind) {
        ind.textContent = 'Guardado ✓';
        setTimeout(() => { ind.textContent = ''; }, 2000);
      }
    } catch (e) {
      console.error('[saveToDrive]', e);
      const ind = document.getElementById('sync-indicator');
      if (ind) {
        ind.textContent = 'Error guardando';
        setTimeout(() => { ind.textContent = ''; }, 4000);
      }
    }
  }, 1200);
}

/* Versión inmediata para el botón "Sincronizar ahora".
   Hace BAJADA + MERGE + SUBIDA en orden, todo síncrono y con feedback. */
async function forceSyncNow() {
  if (!driveReady) {
    setStatus('Conectá Drive primero');
    return;
  }
  showLoading('Sincronizando...');
  try {
    // 1. Bajar el JSON remoto actual
    const token = (window.gapi && gapi.client && gapi.client.getToken &&
                   gapi.client.getToken().access_token);
    if (!token) throw new Error('Sin access token — reconectá Drive');

    let remoteData = { books: [], highlights: [] };
    if (!driveFileId) {
      // Intentar localizar el archivo
      const listResp = await fetch(
        `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent("name='" + DRIVE_FILE + "'")}&fields=files(id,name)`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (listResp.ok) {
        const data = await listResp.json();
        if (data.files && data.files.length > 0) driveFileId = data.files[0].id;
      }
    }
    if (driveFileId) {
      const getResp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (getResp.ok) {
        try { remoteData = await getResp.json(); }
        catch (e) { console.warn('[forceSync] JSON remoto inválido', e); }
      }
    }

    // 2. Mergear remoto con local
    await mergeState(remoteData);
    await reconcileBooksWithDrive();

    // 3. Subir el resultado mergeado
    const result = await uploadJsonToDrive();

    // 4. Re-renderizar todo
    renderSidebar();
    renderHighlights();
    if (currentTab === 'library') renderLibrary();

    hideLoading();
    setStatus(`✓ Sincronizado: ${result.books} libros, ${result.highlights} subrayados`);
    console.log('[forceSync] OK', result);
  } catch (e) {
    hideLoading();
    console.error('[forceSync]', e);
    setStatus('Error sincronizando: ' + (e.message || 'desconocido').substring(0, 80));
  }
}

// ════════════════════════════════════════════════════════════════
//  DRIVE — EPUBs COMPLETOS (sync entre dispositivos)
// ════════════════════════════════════════════════════════════════

/* Sube el archivo original (EPUB o TXT) a Drive como book-{id}.epub
   o book-{id}.txt en appDataFolder.

   Estrategia (la que sí funciona, después del intento fallido con
   multipart base64): dos requests con fetch directo.
   1. POST /drive/v3/files con metadata → crea el archivo "vacío" y
      devuelve un ID. Si ya existe, hacemos PATCH al existente.
   2. PATCH /upload/drive/v3/files/{id}?uploadType=media con el blob
      crudo en el body. Esto sube los bytes reales sin base64 ni
      multipart.

   Verifica con HEAD/GET el tamaño después para confirmar que el
   upload realmente llegó (en lugar de mostrar "✓" engañoso). */
async function uploadBookFileToDrive(bookId, file, fileType) {
  if (!driveReady) return;

  const ind = document.getElementById('sync-indicator');
  if (ind) ind.textContent = 'Subiendo...';

  // Helper para conseguir el access token (lo necesitamos para fetch directo)
  const getToken = () => {
    if (window.gapi && gapi.client) {
      const t = gapi.client.getToken();
      if (t && t.access_token) return t.access_token;
    }
    return null;
  };
  const token = getToken();
  if (!token) {
    console.error('[upload] sin access_token');
    if (ind) ind.textContent = 'Error: sin token';
    return;
  }

  try {
    const ext = fileType === 'txt' ? 'txt' : 'epub';
    const filename = `book-${bookId}.${ext}`;
    const contentType = ext === 'epub' ? 'application/epub+zip' : 'text/plain';
    const fileSize = file.size;

    // 1. ¿Ya existe este archivo en Drive? Si sí, lo reemplazamos.
    let existingId = null;
    try {
      const listResp = await fetch(
        `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent("name='" + filename + "'")}&fields=files(id,name)`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (listResp.ok) {
        const data = await listResp.json();
        if (data.files && data.files.length > 0) {
          existingId = data.files[0].id;
        }
      }
    } catch (e) {
      console.warn('[upload] list falló', e);
    }

    let driveId = existingId;

    // 2. Si no existe, crear el archivo (metadata only, content vacío)
    if (!driveId) {
      const createResp = await fetch(
        'https://www.googleapis.com/drive/v3/files',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: filename,
            parents: ['appDataFolder'],
            mimeType: contentType
          })
        }
      );
      if (!createResp.ok) {
        const txt = await createResp.text().catch(() => '');
        throw new Error(`create falló: ${createResp.status} — ${txt}`);
      }
      const meta = await createResp.json();
      driveId = meta.id;
    }

    // 3. Subir los bytes con uploadType=media (PATCH al archivo)
    const blob = file instanceof Blob ? file : new Blob([await file.arrayBuffer()]);
    const uploadResp = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${driveId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': contentType
        },
        body: blob
      }
    );
    if (!uploadResp.ok) {
      const txt = await uploadResp.text().catch(() => '');
      throw new Error(`upload de bytes falló: ${uploadResp.status} — ${txt}`);
    }

    // 4. VERIFICAR — pedir el size del archivo recién subido y compararlo
    //    con el local. Si difiere, hubo un problema y no marcamos éxito.
    const verifyResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveId}?fields=id,size,name`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!verifyResp.ok) {
      throw new Error('verificación falló: ' + verifyResp.status);
    }
    const verifyData = await verifyResp.json();
    const remoteSize = parseInt(verifyData.size, 10);
    if (isNaN(remoteSize) || Math.abs(remoteSize - fileSize) > 100) {
      throw new Error(`tamaño no coincide: local=${fileSize} drive=${remoteSize}`);
    }

    console.log(`[upload] ${filename} OK — ${fileSize} bytes en Drive`);

    // 5. Guardar el driveFileId en el record del libro
    const book = state.books.find(b => b.id === bookId);
    if (book) book.driveEpubFileId = driveId;
    const full = await dbGet('books', bookId);
    if (full) {
      full.driveEpubFileId = driveId;
      await dbPut('books', full);
    }

    // 6. Actualizar el JSON de Drive con el nuevo driveEpubFileId
    saveToDrive();

    if (ind) {
      ind.textContent = `Subido a Drive ✓ (${formatBytes(fileSize)})`;
      setTimeout(() => { ind.textContent = ''; }, 3500);
    }
  } catch (e) {
    console.error('[uploadBookFileToDrive]', e);
    if (ind) {
      ind.textContent = 'Error subiendo: ' + (e.message || 'desconocido').substring(0, 50);
      setTimeout(() => { ind.textContent = ''; }, 5000);
    }
    setStatus('Error al subir el libro a Drive — revisá la consola');
  }
}

/* Helper de formato de bytes para mostrar al usuario */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* Baja el EPUB de un libro desde Drive y lo procesa con el parser
   existente. Usa fetch directo para garantizar que los bytes binarios
   lleguen sin corromperse (gapi.client.request los devolvía como string,
   eso era frágil). */
async function downloadBookFromDrive(bookId) {
  if (!driveReady) {
    setStatus('Conectá Drive primero');
    return false;
  }

  const book = state.books.find(b => b.id === bookId);
  const full = await dbGet('books', bookId);
  if (!book && !full) return false;

  const driveId = (book && book.driveEpubFileId) ||
                  (full && full.driveEpubFileId);
  if (!driveId) {
    setStatus('Este libro no tiene archivo en Drive');
    return false;
  }

  const fileType = (book && book.fileType) || (full && full.fileType) || 'epub';

  showLoading('Descargando "' + (book ? book.title : 'libro') + '" desde Drive...');

  try {
    const token = (window.gapi && gapi.client && gapi.client.getToken &&
                   gapi.client.getToken().access_token);
    if (!token) throw new Error('sin access_token');

    // Descargar con fetch — alt=media devuelve los bytes crudos
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`download falló: ${resp.status} — ${txt}`);
    }
    // Bytes binarios crudos
    const arrayBuf = await resp.arrayBuffer();
    console.log(`[download] ${driveId} OK — ${arrayBuf.byteLength} bytes`);

    const blob = new Blob([arrayBuf], {
      type: fileType === 'epub' ? 'application/epub+zip' : 'text/plain'
    });
    const fakeName = (book ? book.title : 'libro').replace(/[^\w\s.-]/g, '_') +
                     (fileType === 'epub' ? '.epub' : '.txt');
    const fakeFile = new File([blob], fakeName, { type: blob.type });

    if (fileType === 'epub') {
      await parseAndReplaceBookContent(bookId, fakeFile);
    } else {
      const text = await fakeFile.text();
      const html = text.split('\n').filter(l => l.trim())
        .map(l => `<p>${escHtml(l.trim())}</p>`).join('');
      const fullRec = await dbGet('books', bookId);
      if (fullRec) {
        fullRec.chapters = [{ index: 0, title: null, html, filename: '' }];
        await dbPut('books', fullRec);
      }
    }

    hideLoading();
    setStatus('Libro descargado');
    if (state.currentBookId === bookId) {
      await selectBook(bookId);
    } else {
      renderLibrary();
    }
    return true;
  } catch (e) {
    console.error('[downloadBookFromDrive]', e);
    hideLoading();
    setStatus('Error al descargar: ' + (e.message || 'desconocido').substring(0, 60));
    return false;
  }
}

/* Parsea el EPUB descargado y guarda los chapters en el libro existente
   (mismo bookId — no crea uno nuevo). Necesario para que los highlights
   ya guardados sigan funcionando. */
async function parseAndReplaceBookContent(bookId, file) {
  const zip = await JSZip.loadAsync(file);
  let chapters = [], coverBase64 = null;

  let opfPath = null;
  const cf = zip.files['META-INF/container.xml'];
  if (cf) {
    const t = await cf.async('text');
    const m = t.match(/full-path="([^"]+)"/i);
    if (m) opfPath = m[1];
  }
  if (!opfPath) opfPath = Object.keys(zip.files).find(f => f.toLowerCase().endsWith('.opf'));
  if (!opfPath) {
    // Fallback: agarrar todos los HTML
    let html = '';
    const fs = Object.keys(zip.files).filter(f => /\.(html|htm|xhtml)$/i.test(f)).slice(0, 40);
    for (const f of fs) {
      const raw = await zip.files[f].async('text');
      const body = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (body) html += body[1] + '\n';
    }
    chapters = [{ index: 0, title: null, html: cleanEpubHtml(html), filename: '' }];
  } else {
    const opfText  = await zip.files[opfPath].async('text');
    const basePath = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

    const manifest = {};
    for (const m of opfText.matchAll(/<item\s[^>]*>/gi)) {
      const tag = m[0];
      const idM = tag.match(/\bid="([^"]+)"/);
      const hrefM = tag.match(/\bhref="([^"]+)"/);
      const tpM = tag.match(/\bmedia-type="([^"]+)"/);
      const prM = tag.match(/\bproperties="([^"]+)"/);
      if (idM && hrefM) {
        manifest[idM[1]] = {
          href: hrefM[1],
          mediaType: tpM ? tpM[1] : '',
          properties: prM ? prM[1] : ''
        };
      }
    }

    const coverItem = Object.values(manifest).find(i =>
      i.properties.includes('cover-image') ||
      (/image\/(jpeg|png|webp)/.test(i.mediaType) && i.href.toLowerCase().includes('cover'))
    );
    if (coverItem) {
      try {
        const cp = resolvePath(basePath, coverItem.href);
        const cf2 = zip.files[cp] || zip.files[Object.keys(zip.files).find(k => k.endsWith(coverItem.href))];
        if (cf2) {
          const bytes = await cf2.async('base64');
          coverBase64 = `data:${coverItem.mediaType};base64,${bytes}`;
        }
      } catch (e) {}
    }

    const spineIds = [...opfText.matchAll(/idref="([^"]+)"/g)].map(m => m[1]);
    const chapterTitles = await extractChapterTitles(zip, manifest, basePath, spineIds);
    let chapCount = 0;
    for (let i = 0; i < spineIds.length; i++) {
      const item = manifest[spineIds[i]];
      if (!item) continue;
      const href     = item.href.split('#')[0];
      const fullPath = resolvePath(basePath, href);
      const hf       = zip.files[fullPath] || zip.files[Object.keys(zip.files).find(k => k.endsWith(href))];
      if (!hf) continue;
      const raw  = await hf.async('text');
      const body = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (!body) continue;
      const cleaned = cleanEpubHtml(body[1]);
      if (!cleaned.trim()) continue;
      chapters.push({
        index: chapCount++,
        title: chapterTitles[i] || null,
        html: cleaned,
        filename: href.split('/').pop()
      });
    }
  }

  // Sobrescribir el libro existente conservando el id, highlights, etc.
  const fullRec = await dbGet('books', bookId);
  if (!fullRec) return;
  fullRec.chapters = chapters;
  if (coverBase64 && !fullRec.coverBase64) fullRec.coverBase64 = coverBase64;
  await dbPut('books', fullRec);
}

/* Borra el archivo EPUB de Drive cuando se borra el libro localmente. */
async function deleteBookFromDrive(driveId) {
  if (!driveReady || !driveId) return;
  const token = (window.gapi && gapi.client && gapi.client.getToken &&
                 gapi.client.getToken().access_token);
  if (!token) return;
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${driveId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (e) {
    console.error('[deleteBookFromDrive]', e);
  }
}

// ════════════════════════════════════════════════════════════════
//  EPUB / TXT — IMPORT
// ════════════════════════════════════════════════════════════════

document.getElementById('file-input').addEventListener('change', async e => {
  for (const file of Array.from(e.target.files)) {
    showLoading('Cargando ' + file.name + '...');
    try {
      if (file.name.toLowerCase().endsWith('.epub')) await loadEpub(file);
      else                                           await loadTxt(file);
    } catch (err) {
      console.error('[loadFile]', err);
      setStatus('Error cargando ' + file.name);
    }
    hideLoading();
  }
  e.target.value = '';
});

async function loadEpub(file) {
  const zip = await JSZip.loadAsync(file);
  let title = file.name.replace(/\.epub$/i, ''), author = '', chapters = [], coverBase64 = null;

  // 1. OPF via container.xml
  let opfPath = null;
  const cf = zip.files['META-INF/container.xml'];
  if (cf) {
    const t = await cf.async('text');
    const m = t.match(/full-path="([^"]+)"/i);
    if (m) opfPath = m[1];
  }
  if (!opfPath) opfPath = Object.keys(zip.files).find(f => f.toLowerCase().endsWith('.opf'));
  if (!opfPath) { await loadEpubFallback(zip, title); return; }

  const opfText  = await zip.files[opfPath].async('text');
  const basePath = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // 2. Metadatos
  const tm = opfText.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
  const am = opfText.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);
  if (tm) title  = tm[1].trim();
  if (am) author = am[1].trim();

  // 3. Manifest
  const manifest = {};
  for (const m of opfText.matchAll(/<item\s[^>]*>/gi)) {
    const tag = m[0];
    const idM = tag.match(/\bid="([^"]+)"/);
    const hrefM = tag.match(/\bhref="([^"]+)"/);
    const tpM = tag.match(/\bmedia-type="([^"]+)"/);
    const prM = tag.match(/\bproperties="([^"]+)"/);
    if (idM && hrefM) {
      manifest[idM[1]] = {
        href: hrefM[1],
        mediaType: tpM ? tpM[1] : '',
        properties: prM ? prM[1] : ''
      };
    }
  }

  // 4. Portada
  const coverItem = Object.values(manifest).find(i =>
    i.properties.includes('cover-image') ||
    (/image\/(jpeg|png|webp)/.test(i.mediaType) && i.href.toLowerCase().includes('cover'))
  );
  if (coverItem) {
    try {
      const cp = resolvePath(basePath, coverItem.href);
      const cf2 = zip.files[cp] || zip.files[Object.keys(zip.files).find(k => k.endsWith(coverItem.href))];
      if (cf2) {
        const bytes = await cf2.async('base64');
        coverBase64 = `data:${coverItem.mediaType};base64,${bytes}`;
      }
    } catch (e) {}
  }

  // 5. Spine + títulos de capítulos
  const spineIds      = [...opfText.matchAll(/idref="([^"]+)"/g)].map(m => m[1]);
  const chapterTitles = await extractChapterTitles(zip, manifest, basePath, spineIds);
  let chapCount = 0;

  for (let i = 0; i < spineIds.length; i++) {
    const item = manifest[spineIds[i]];
    if (!item) continue;
    const href     = item.href.split('#')[0];
    const fullPath = resolvePath(basePath, href);
    const hf       = zip.files[fullPath] || zip.files[Object.keys(zip.files).find(k => k.endsWith(href))];
    if (!hf) continue;
    const raw  = await hf.async('text');
    const body = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (!body) continue;
    const cleaned = cleanEpubHtml(body[1]);
    if (!cleaned.trim()) continue;
    chapters.push({
      index: chapCount++,
      title: chapterTitles[i] || null,
      html: cleaned,
      filename: href.split('/').pop()
    });
  }

  if (!chapters.length) { await loadEpubFallback(zip, title, file); return; }
  await addBook(title, author, chapters, coverBase64, file);
}

async function extractChapterTitles(zip, manifest, basePath, spineIds) {
  const titles = {};
  // EPUB2: NCX
  const ncxItem = Object.values(manifest).find(i =>
    i.href.endsWith('.ncx') || i.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem) {
    try {
      const np = resolvePath(basePath, ncxItem.href);
      const nf = zip.files[np] || zip.files[Object.keys(zip.files).find(k => k.endsWith(ncxItem.href))];
      if (nf) {
        const nt = await nf.async('text');
        for (const m of nt.matchAll(/<navPoint[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content[^>]+src="([^"#]+)/g)) {
          const src = m[2].split('/').pop().toLowerCase();
          const si  = spineIds.findIndex(id => manifest[id] &&
            manifest[id].href.split('/').pop().split('#')[0].toLowerCase() === src);
          if (si >= 0 && !titles[si]) titles[si] = m[1].trim();
        }
      }
    } catch (e) {}
  }
  // EPUB3: NAV
  if (Object.keys(titles).length < spineIds.length) {
    const navItem = Object.values(manifest).find(i => i.properties.includes('nav'));
    if (navItem) {
      try {
        const nvp = resolvePath(basePath, navItem.href);
        const nvf = zip.files[nvp] || zip.files[Object.keys(zip.files).find(k => k.endsWith(navItem.href))];
        if (nvf) {
          const nvt = await nvf.async('text');
          for (const m of nvt.matchAll(/<a[^>]+href="([^"#]*)[^"]*"[^>]*>([^<]+)<\/a>/g)) {
            const src = m[1].split('/').pop().toLowerCase();
            const si  = spineIds.findIndex(id => manifest[id] &&
              manifest[id].href.split('/').pop().split('#')[0].toLowerCase() === src);
            if (si >= 0 && !titles[si]) titles[si] = m[2].trim();
          }
        }
      } catch (e) {}
    }
  }
  // Fallback: leer primer h1/h2/h3 del archivo si NCX/NAV no lo listó
  for (let i = 0; i < spineIds.length; i++) {
    if (titles[i]) continue;
    const item = manifest[spineIds[i]];
    if (!item) continue;
    const fullPath = resolvePath(basePath, item.href.split('#')[0]);
    const hf = zip.files[fullPath] || zip.files[Object.keys(zip.files).find(k => k.endsWith(item.href.split('#')[0]))];
    if (!hf) continue;
    try {
      const raw = await hf.async('text');
      for (const tag of ['h1', 'h2', 'h3']) {
        const hm = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
        if (hm) {
          const txt = hm[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          if (txt && txt.length < 200) { titles[i] = txt; break; }
        }
      }
    } catch (e) {}
  }
  return titles;
}

async function loadEpubFallback(zip, title, file) {
  let html = '';
  const fs = Object.keys(zip.files).filter(f => /\.(html|htm|xhtml)$/i.test(f)).slice(0, 40);
  for (const f of fs) {
    const raw = await zip.files[f].async('text');
    const body = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (body) html += body[1] + '\n';
  }
  await addBook(title, '', [{ index: 0, title: null, html: cleanEpubHtml(html), filename: '' }], null, file);
}

function resolvePath(base, href) {
  if (!href || href.startsWith('http')) return href;
  const parts = (base + href).split('/'), resolved = [];
  for (const p of parts) {
    if (p === '..') resolved.pop();
    else if (p && p !== '.') resolved.push(p);
  }
  return resolved.join('/');
}

function cleanEpubHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/class="[^"]*"/gi, '')
    .replace(/style="[^"]*"/gi, '')
    .replace(/<\/?(?:html|head|body|meta|title)[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .trim();
}

async function loadTxt(file) {
  const text = await file.text();
  const title = file.name.replace(/\.txt$/i, '');
  const html = text.split('\n').filter(l => l.trim())
    .map(l => `<p>${escHtml(l.trim())}</p>`).join('');
  await addBook(title, '', [{ index: 0, title: null, html, filename: '' }], null, file);
}

async function addBook(title, author, chapters, coverBase64, originalFile) {
  const id = generateId('book');
  const fileType = originalFile && originalFile.name.toLowerCase().endsWith('.epub')
    ? 'epub' : 'txt';

  await dbPut('books', {
    id, title, author, chapters,
    coverBase64: coverBase64 || null,
    fileType,
    driveEpubFileId: null
  });
  state.books.push({ id, title, author, fileType, driveEpubFileId: null });
  await savePref('currentBookId', id);
  saveToDrive();
  renderSidebar();
  await selectBook(id);
  setStatus(`"${title}" cargado`);

  // Si Drive está conectado AHORA, subir en background. Si no, no se sube
  // — el usuario va a tener que volver a subirlo en otros dispositivos.
  if (driveReady && originalFile) {
    uploadBookFileToDrive(id, originalFile, fileType).catch(e =>
      console.error('[uploadBookFile]', e));
  }
}

// ════════════════════════════════════════════════════════════════
//  SELECCIÓN Y APERTURA DE LIBRO
// ════════════════════════════════════════════════════════════════

async function selectBook(id) {
  state.currentBookId = id;
  await savePref('currentBookId', id);
  const book = state.books.find(b => b.id === id);
  if (!book) return;

  // Cerrar buscador si estaba abierto (los matches eran del libro anterior)
  if (search.open) closeSearch();

  // Limpiar modo selección de export (los IDs eran del libro anterior)
  exportSelection.active = false;
  exportSelection.selected.clear();

  document.getElementById('book-title-display').textContent =
    book.title + (book.author ? ' — ' + book.author : '');

  renderSidebar();
  showTab('reader');
  showLoading('Abriendo libro...');

  try {
    const full = await dbGet('books', id);
    if (full && full.chapters && full.chapters.length) {
      await openBook(full);
    } else if (full && full.html) {
      // Migración legacy
      await openBook({
        chapters: [{ index: 0, title: null, html: full.html, filename: '' }]
      });
    } else if (driveReady) {
      // No hay contenido local. Si Drive está conectado, intentar buscar el
      // archivo en Drive — incluso si driveEpubFileId no está cacheado, puede
      // existir como book-{id}.epub (libros viejos subidos antes de que el
      // campo existiera).
      hideLoading();
      let driveId = full && full.driveEpubFileId;
      if (!driveId) {
        // Intentar localizarlo por nombre
        showLoading('Buscando en Drive...');
        driveId = await findBookInDrive(id, (full && full.fileType) || 'epub');
        hideLoading();
        if (driveId && full) {
          // Cachear el ID encontrado
          full.driveEpubFileId = driveId;
          await dbPut('books', full);
          const local = state.books.find(b => b.id === id);
          if (local) local.driveEpubFileId = driveId;
          saveToDrive();
        }
      }
      if (driveId) {
        mountEmptyBook('Este libro está en Drive pero no en este dispositivo.<br><br>' +
                       `<button onclick="downloadBookFromDrive(${id})" ` +
                       'style="padding:10px 18px;border-radius:8px;background:var(--accent);' +
                       'color:#fff;border:none;cursor:pointer;font-family:inherit;' +
                       'font-size:13px;font-weight:500;pointer-events:auto;">' +
                       'Descargar desde Drive</button>');
      } else {
        mountEmptyBook('Este libro no tiene contenido en este dispositivo ni en Drive.<br>Volvé a subir el EPUB para leerlo aquí.');
      }
      renderHighlights();
      renderLibrary();
      return;
    } else if (full && full.driveEpubFileId && !driveReady) {
      mountEmptyBook('Este libro está en Drive. Conectá Drive para descargarlo.');
    } else {
      mountEmptyBook('Este libro no tiene contenido en este dispositivo. Volvé a subir el EPUB para leerlo aquí.');
    }
  } catch (e) {
    console.error('[selectBook]', e);
    mountEmptyBook('Error al abrir el libro.');
  }
  hideLoading();
  renderHighlights();
}

/* Busca book-{id}.{epub|txt} en appDataFolder. Devuelve el driveFileId o null. */
async function findBookInDrive(bookId, fileType) {
  if (!driveReady) return null;
  const token = (window.gapi && gapi.client && gapi.client.getToken &&
                 gapi.client.getToken().access_token);
  if (!token) return null;
  try {
    const ext = fileType === 'txt' ? 'txt' : 'epub';
    const filename = `book-${bookId}.${ext}`;
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent("name='" + filename + "'")}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.files && data.files.length > 0) return data.files[0].id;
    return null;
  } catch (e) {
    console.error('[findBookInDrive]', e);
    return null;
  }
}

async function openBook(fullBook) {
  currentBookChapters = fullBook.chapters;
  totalChapters       = currentBookChapters.length;
  buildParagraphArray(currentBookChapters);
  renderChapterSidebar();

  document.getElementById('reader-view').classList.add('has-book');

  const container = document.getElementById('page-content');
  renderBookHTML(container);

  // Aplicar highlights guardados al DOM ya renderizado
  applyHighlightsToContent();

  // Restaurar posición
  await restorePosition();
  updateProgress();
}

function mountEmptyBook(msg) {
  document.getElementById('reader-view').classList.remove('has-book');
  document.getElementById('empty-reader').innerHTML = msg.replace(/\n/g, '<br>');
  const container = document.getElementById('page-content');
  container.innerHTML = '';
  document.getElementById('chapter-section').classList.remove('visible');
  setProgress(0);
  setStatusDirect('Listo');
}

// ════════════════════════════════════════════════════════════════
//  CONSTRUCCIÓN DEL ARRAY DE PÁRRAFOS
// ════════════════════════════════════════════════════════════════

const SKIP_TAGS = new Set(['script','style','head','nav','aside','figure','svg']);
const PARA_TAGS = new Set(['p','h1','h2','h3','h4','h5','h6','blockquote','pre','li','dt','dd']);

function buildParagraphArray(chapters) {
  allParagraphs = []; anchorMap = {}; fileChapterMap = {};
  for (let ci = 0; ci < chapters.length; ci++) {
    const ch = chapters[ci];
    if (ch.filename) fileChapterMap[ch.filename.toLowerCase()] = ci;
    const div = document.createElement('div');
    div.innerHTML = ch.html;
    extractBlocks(div, ci);
  }
}

function extractBlocks(node, ci) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent.trim();
    const pt   = node.parentNode && node.parentNode.tagName ? node.parentNode.tagName.toLowerCase() : '';
    if (text && !PARA_TAGS.has(pt)) addPara(`<p>${escHtml(text)}</p>`, ci, []);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const tag = node.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;
  if (PARA_TAGS.has(tag)) {
    const text = node.textContent.trim();
    if (!text) return;
    const ids = collectIds(node);
    addPara(node.outerHTML, ci, ids);
    return;
  }
  const hasBlockKids = Array.from(node.children).some(c => PARA_TAGS.has(c.tagName.toLowerCase()));
  if (hasBlockKids) {
    for (const child of node.childNodes) extractBlocks(child, ci);
  } else {
    const text = node.textContent.trim();
    if (!text) return;
    const ids = collectIds(node);
    addPara(`<p>${escHtml(text)}</p>`, ci, ids);
  }
}

function addPara(html, chapterIndex, anchorIds) {
  const idx = allParagraphs.length;
  anchorIds.forEach(id => { anchorMap[id] = idx; });
  allParagraphs.push({ html, chapterIndex, anchorIds });
}

function collectIds(el) {
  const ids = [];
  if (el.id) ids.push(el.id);
  el.querySelectorAll('[id]').forEach(c => ids.push(c.id));
  return ids;
}

// ════════════════════════════════════════════════════════════════
//  RENDER DEL HTML DEL LIBRO
// ════════════════════════════════════════════════════════════════

function renderBookHTML(container) {
  let html = '', lastCi = -1;
  for (let i = 0; i < allParagraphs.length; i++) {
    const para = allParagraphs[i];
    const ci   = para.chapterIndex;
    if (ci !== lastCi && ci > 0) {
      const ch = currentBookChapters[ci];
      const lbl = ch && ch.title ? `${ci + 1}. ${ch.title}` : `Capítulo ${ci + 1}`;
      html += `<div class="chapter-header-inline" data-chapter="${ci}">${escHtml(lbl)}</div>`;
    }
    lastCi = ci;
    const withIdx = para.html.replace(/^(<[a-z][a-z0-9]*)/i, `$1 data-para-idx="${i}"`);
    html += processLinksForRender(withIdx);
  }
  container.innerHTML = html;
}

function processLinksForRender(html) {
  return html.replace(/<a(\s[^>]*)?>/gi, (match, attrs) => {
    if (!attrs) return match;
    const hm = attrs.match(/href="([^"]*)"/i);
    if (!hm) return match;
    const href = hm[1];
    if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('//')) {
      return `<a${attrs} target="_blank" rel="noopener noreferrer">`;
    }
    const parts  = href.split('#');
    const file   = parts[0] ? parts[0].split('/').pop().toLowerCase() : '';
    const anchor = (parts[1] || '').replace(/'/g, "\\'");
    return `<a${attrs} href="javascript:void(0)" onclick="handleInternalLink('${anchor}','${file.replace(/'/g, "\\'")}')">`;
  });
}

function handleInternalLink(anchor, file) {
  let pi = -1;
  if (anchor && anchorMap[anchor] !== undefined) {
    pi = anchorMap[anchor];
  } else if (file && fileChapterMap[file] !== undefined) {
    pi = allParagraphs.findIndex(p => p.chapterIndex === fileChapterMap[file]);
  }
  if (pi >= 0) scrollToParaIdx(pi);
}

// ════════════════════════════════════════════════════════════════
//  NAVEGACIÓN POR SCROLL
// ════════════════════════════════════════════════════════════════

function setupReaderScroll() {
  const viewer = document.getElementById('reader-view');
  // Throttle con rAF para no saturar el render. Actualiza posición
  // y guarda con debounce.
  viewer.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      updateProgress();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(savePosition, 700);
    });
  }, { passive: true });
}

function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (currentTab !== 'reader') return;
    const t = e.target;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    const viewer = document.getElementById('reader-view');
    if (!viewer) return;
    // PageUp/PageDown/Space → scroll por viewport
    if (e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      viewer.scrollBy({ top: viewer.clientHeight * 0.92, behavior: 'smooth' });
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      viewer.scrollBy({ top: -viewer.clientHeight * 0.92, behavior: 'smooth' });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      viewer.scrollBy({ top: 80, behavior: 'auto' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      viewer.scrollBy({ top: -80, behavior: 'auto' });
    } else if (e.key === 'Home') {
      e.preventDefault();
      viewer.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (e.key === 'End') {
      e.preventDefault();
      viewer.scrollTo({ top: viewer.scrollHeight, behavior: 'smooth' });
    }
  });
}

function scrollToParaIdx(paraIdx, behavior) {
  const container = document.getElementById('page-content');
  if (!container) return;
  const el = container.querySelector(`[data-para-idx="${paraIdx}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: behavior || 'smooth', block: 'start' });
}

function goToChapter(ci) {
  const container = document.getElementById('page-content');
  if (!container) return;
  // Capítulo 0 = arranque del libro. Los demás tienen header con data-chapter.
  if (ci === 0) {
    document.getElementById('reader-view').scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const header = container.querySelector(`[data-chapter="${ci}"]`);
  if (header) {
    header.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    // Fallback: primer párrafo del capítulo
    const firstPi = allParagraphs.findIndex(p => p.chapterIndex === ci);
    if (firstPi >= 0) scrollToParaIdx(firstPi);
  }
}

/* getFirstVisibleParaIdx — busca el primer párrafo visible usando
   elementFromPoint (O(1)) para no iterar miles de elementos. */
function getFirstVisibleParaIdx() {
  const viewer = document.getElementById('reader-view');
  if (!viewer) return null;
  const r = viewer.getBoundingClientRect();
  if (r.width < 5 || r.height < 5) return null;

  // Probar varios puntos en la zona superior del viewport por si hay
  // headers/elementos no-paragraph al principio
  const points = [
    [r.left + r.width / 2, r.top + 20],
    [r.left + r.width / 2, r.top + 60],
    [r.left + r.width / 2, r.top + r.height * 0.2],
    [r.left + 30,           r.top + 40]
  ];
  for (const [x, y] of points) {
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.paraIdx !== undefined) {
        return parseInt(el.dataset.paraIdx, 10);
      }
      el = el.parentElement;
    }
  }
  return null;
}

function updateProgress() {
  const viewer = document.getElementById('reader-view');
  if (!viewer || !allParagraphs.length) {
    setProgress(0);
    setStatusDirect('Listo');
    return;
  }
  // Progreso: scrollTop / (scrollHeight - clientHeight)
  const sh = viewer.scrollHeight - viewer.clientHeight;
  const pct = sh > 0 ? Math.min(100, Math.max(0, (viewer.scrollTop / sh) * 100)) : 0;
  setProgress(pct);

  // Capítulo actual: el del primer párrafo visible
  const idx = getFirstVisibleParaIdx();
  if (idx != null && allParagraphs[idx]) {
    currentChapterIndex = allParagraphs[idx].chapterIndex;
  }
  const ch = currentBookChapters[currentChapterIndex];
  const cl = ch && ch.title
    ? `${currentChapterIndex + 1}. ${ch.title}`
    : `Cap. ${currentChapterIndex + 1} de ${totalChapters}`;
  setStatusDirect(`${cl} · ${pct.toFixed(0)}%`);
  updateChapterSidebar();
}

function setProgress(pct) {
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = pct + '%';
}

// ════════════════════════════════════════════════════════════════
//  SIDEBAR DE CAPÍTULOS
// ════════════════════════════════════════════════════════════════

function renderChapterSidebar() {
  const section = document.getElementById('chapter-section');
  const list    = document.getElementById('chapter-list');
  list.innerHTML = '';
  if (!currentBookChapters || !currentBookChapters.length) {
    section.classList.remove('visible');
    return;
  }
  section.classList.add('visible');
  currentBookChapters.forEach((ch, idx) => {
    const div = document.createElement('div');
    div.className   = 'chapter-item' + (idx === currentChapterIndex ? ' active' : '');
    div.textContent = ch.title ? `${idx + 1}. ${ch.title}` : `Capítulo ${idx + 1}`;
    div.onclick     = () => goToChapter(idx);
    list.appendChild(div);
  });
}

function updateChapterSidebar() {
  document.querySelectorAll('.chapter-item').forEach((el, i) =>
    el.classList.toggle('active', i === currentChapterIndex));
}

// ════════════════════════════════════════════════════════════════
//  POSICIÓN GUARDADA
// ════════════════════════════════════════════════════════════════

async function savePosition() {
  if (!state.currentBookId || !allParagraphs.length) return;
  const anchorParaIdx = getFirstVisibleParaIdx();
  await savePref(`pos_${state.currentBookId}`, {
    chapterIndex: currentChapterIndex,
    fontSize: prefs.fontSize,
    anchorParaIdx: anchorParaIdx
  });
}

async function restorePosition() {
  const rec = await dbGet('prefs', `pos_${state.currentBookId}`);
  // 2x rAF para asegurar que el layout terminó antes de scrollIntoView
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (!rec || !rec.value) {
    document.getElementById('reader-view').scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (rec.value.anchorParaIdx != null) {
    scrollToParaIdx(rec.value.anchorParaIdx, 'auto');
  } else {
    document.getElementById('reader-view').scrollTo({ top: 0, behavior: 'auto' });
  }
}

// ════════════════════════════════════════════════════════════════
//  BOOKMARKS
// ════════════════════════════════════════════════════════════════

async function addBookmark() {
  if (!state.currentBookId || !allParagraphs.length) {
    setStatus('Primero abrí un libro');
    return;
  }
  const ch      = currentBookChapters[currentChapterIndex];
  const chapStr = ch && ch.title
    ? `${currentChapterIndex + 1}. ${ch.title}`
    : `Cap. ${currentChapterIndex + 1}`;
  const viewer  = document.getElementById('reader-view');
  const sh      = viewer.scrollHeight - viewer.clientHeight;
  const pct     = sh > 0 ? Math.round((viewer.scrollTop / sh) * 100) : 0;
  const label   = `${chapStr} · ${pct}%`;
  const anchor  = getFirstVisibleParaIdx();
  const id      = generateId('bm');
  await dbPut('bookmarks', {
    id, bookId: state.currentBookId,
    anchorParaIdx: anchor != null ? anchor : 0,
    label,
    ts: Date.now()
  });
  setStatus('🔖 ' + label);
}

async function renderBookmarks() {
  const section = document.getElementById('bookmarks-section');
  const list    = document.getElementById('bookmarks-list');
  const bms     = await dbGetByIndex('bookmarks', 'bookId', state.currentBookId).catch(() => []);
  if (!bms || !bms.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.innerHTML = '';
  bms.sort((a, b) => (a.anchorParaIdx || 0) - (b.anchorParaIdx || 0)).forEach(bm => {
    const div = document.createElement('div');
    div.className = 'bookmark-card';
    div.innerHTML = `
      <span class="bookmark-label">${escHtml(bm.label)}</span>
      <div class="bookmark-actions">
        <button class="bookmark-goto" data-para="${bm.anchorParaIdx || 0}">Ir</button>
        <button class="bookmark-delete" data-id="${bm.id}">✕</button>
      </div>`;
    list.appendChild(div);
  });
  list.querySelectorAll('.bookmark-goto').forEach(btn => {
    btn.addEventListener('click', () => {
      showTab('reader');
      requestAnimationFrame(() => {
        scrollToParaIdx(parseInt(btn.dataset.para, 10));
      });
    });
  });
  list.querySelectorAll('.bookmark-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      await dbDelete('bookmarks', btn.dataset.id);
      renderBookmarks();
      setStatus('Marcador eliminado');
    });
  });
}

// ════════════════════════════════════════════════════════════════
//  HIGHLIGHTS
// ════════════════════════════════════════════════════════════════

/* Esconde/muestra el sidebar. La preferencia se guarda en IndexedDB. */
function toggleSidebar() {
  document.body.classList.toggle('sidebar-hidden');
  const hidden = document.body.classList.contains('sidebar-hidden');
  savePref('sidebarHidden', hidden);
}

async function applySidebarPref() {
  const rec = await dbGet('prefs', 'sidebarHidden').catch(() => null);
  if (rec && rec.value === true) {
    document.body.classList.add('sidebar-hidden');
  }
}

function setColor(c) {
  currentColor = c;
  document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
  document.getElementById('color-' + c).classList.add('active');
}

/* Estado para que el subrayado funcione en iPad.
   En iOS, tocar un botón cancela la selección antes de que corra el handler,
   así que window.getSelection() devuelve isCollapsed=true cuando llega
   doHighlight(). Solución: clonamos el Range y el texto cuando se muestra
   el toolbar y los reusamos en doHighlight() sin volver a pedir la selección. */
let pendingHighlight = null;  // { range: Range, text: string, paraIdx: number|null }

function setupSelectionHandlers() {
  document.addEventListener('mouseup', e => {
    if (!e.target.closest('#sel-toolbar')) handleSel();
  });
  // En touchend esperamos un tick para que la selección se establezca,
  // y luego mostramos el toolbar.
  document.addEventListener('touchend', e => {
    if (!e.target.closest('#sel-toolbar')) setTimeout(handleSel, 150);
  });
  // No ocultamos en mousedown si el clic es en el toolbar (sino se cierra
  // antes de que el botón Subrayar reciba el evento).
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#sel-toolbar')) hideSel();
  });

  // En el botón Subrayar usamos pointerdown con preventDefault para evitar
  // que iOS limpie la selección antes de que corra doHighlight.
  // (Nota: en mobile, "click" llega DESPUÉS de que iOS ya canceló la
  //  selección. Por eso disparamos el highlight en pointerdown.)
  const btnHl = document.getElementById('btn-hl');
  if (btnHl) {
    btnHl.addEventListener('pointerdown', e => {
      // Prevenimos default para que el touch NO quite la selección
      e.preventDefault();
      e.stopPropagation();
      doHighlight();
    });
  }
  const btnCancel = document.getElementById('btn-cancel-sel');
  if (btnCancel) {
    btnCancel.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      hideSel();
      // Limpiar la selección visible también
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    });
  }
}

function handleSel() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideSel(); return; }
  const pageContent = document.getElementById('page-content');
  if (!pageContent.contains(sel.anchorNode)) { hideSel(); return; }

  const range = sel.getRangeAt(0);

  // Capturar el paraIdx del párrafo donde empieza la selección
  let pNode = range.startContainer;
  while (pNode && (pNode.nodeType !== 1 || !pNode.hasAttribute || !pNode.hasAttribute('data-para-idx'))) {
    pNode = pNode.parentNode;
  }
  const paraIdx = pNode && pNode.dataset && pNode.dataset.paraIdx !== undefined
    ? parseInt(pNode.dataset.paraIdx, 10) : null;

  // Guardar el range CLONADO y el texto. El clon evita que cuando iOS
  // limpie la selección, perdamos la referencia.
  pendingHighlight = {
    range: range.cloneRange(),
    text: sel.toString().trim(),
    paraIdx: (paraIdx != null && !isNaN(paraIdx)) ? paraIdx : null
  };

  // Posicionar el toolbar — preferentemente ABAJO de la selección para
  // no solapar con el menú nativo de iOS (que sale arriba por default).
  const rect = range.getBoundingClientRect();
  const tb = document.getElementById('sel-toolbar');
  tb.style.display = 'flex';

  // Medir el toolbar después de hacerlo visible
  const tbRect = tb.getBoundingClientRect();
  const tbW = tbRect.width || 140;
  const tbH = tbRect.height || 40;

  // Centrar horizontalmente respecto a la selección, dentro del viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = rect.left + rect.width / 2 - tbW / 2;
  if (left < 8) left = 8;
  if (left + tbW > vw - 8) left = vw - 8 - tbW;

  // Vertical: abajo de la selección con margen, salvo que no haya espacio,
  // en cuyo caso arriba.
  const SPACE = 14;  // margen para no pegar al texto
  let top;
  if (rect.bottom + SPACE + tbH < vh - 8) {
    // Espacio abajo
    top = rect.bottom + SPACE;
  } else if (rect.top - SPACE - tbH > 8) {
    // No hay espacio abajo, arriba sí
    top = rect.top - SPACE - tbH;
  } else {
    // Última opción: pegado al borde inferior visible
    top = vh - tbH - 8;
  }

  tb.style.left = left + 'px';
  tb.style.top  = top  + 'px';
}

function hideSel() {
  document.getElementById('sel-toolbar').style.display = 'none';
  pendingHighlight = null;
}

async function doHighlight() {
  // Usamos el pendingHighlight capturado por handleSel, NO window.getSelection,
  // porque en iOS la selección ya se canceló cuando tocaste el botón.
  if (!pendingHighlight || !state.currentBookId) {
    hideSel();
    return;
  }
  const { range, text, paraIdx } = pendingHighlight;
  if (!text) { hideSel(); return; }

  try {
    const id = generateId('hl');
    const hl = {
      id, bookId: state.currentBookId,
      text, note: '', color: currentColor, ts: Date.now(),
      paraIdx: paraIdx != null ? paraIdx : undefined
    };

    wrapRange(range, id, currentColor);
    state.highlights.push(hl);

    // Limpiar selección si todavía existe
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();

    await dbPut('highlights', hl);
    saveToDrive();
    renderSidebar();
    setStatus('Subrayado guardado');
  } catch (e) {
    console.error('[doHighlight]', e);
    setStatus('Seleccioná texto dentro de un mismo párrafo');
  }
  hideSel();
}

function wrapRange(range, id, color) {
  const span = document.createElement('span');
  span.className = `hl hl-${color}`;
  span.dataset.hlId = id;
  span.title = 'Clic para ver notas';
  span.onclick = () => showTab('highlights');
  range.surroundContents(span);
}

function applyHighlightsToContent() {
  const container = document.getElementById('page-content');
  if (!container) return;
  const bookHls = state.highlights.filter(h => h.bookId === state.currentBookId);

  for (const hl of bookHls) {
    if (container.querySelector(`[data-hl-id="${hl.id}"]`)) continue;
    let applied = false;

    if (hl.paraIdx !== undefined && hl.paraIdx !== null) {
      const paraEl = container.querySelector(`[data-para-idx="${hl.paraIdx}"]`);
      if (paraEl && paraEl.textContent.includes(hl.text)) {
        applied = wrapTextInElement(paraEl, hl.text, hl.id, hl.color);
      }
    }

    if (!applied) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.parentElement || node.parentElement.classList.contains('hl')) continue;
        const idx = node.textContent.indexOf(hl.text);
        if (idx === -1) continue;
        try {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + hl.text.length);
          wrapRange(range, hl.id, hl.color);
          applied = true;
        } catch (e) {}
        break;
      }
    }
  }
}

function wrapTextInElement(paraEl, text, id, color) {
  const walker = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.parentElement || node.parentElement.classList.contains('hl')) continue;
    const idx = node.textContent.indexOf(text);
    if (idx === -1) continue;
    try {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      wrapRange(range, id, color);
      return true;
    } catch (e) { return false; }
  }
  return false;
}

async function deleteHighlight(id) {
  state.highlights = state.highlights.filter(h => h.id !== id);
  const span = document.querySelector(`[data-hl-id="${id}"]`);
  if (span) {
    const p = span.parentNode;
    while (span.firstChild) p.insertBefore(span.firstChild, span);
    p.removeChild(span);
  }
  await dbDelete('highlights', id);
  saveToDrive();
  renderHighlights();
  renderSidebar();
  setStatus('Subrayado eliminado');
}

function renderHighlights() {
  const list = document.getElementById('hl-list');
  list.innerHTML = '';
  const bhs = state.highlights.filter(h => h.bookId === state.currentBookId);
  if (!bhs.length) {
    list.innerHTML = `<div class="empty-state"><strong>Sin subrayados aún</strong>Ve a Leer, seleccioná texto y presioná Subrayar</div>`;
    updateExportButton();
    return;
  }
  const cs = { yellow:'#ca8a04', blue:'#2563eb', green:'#16a34a', pink:'#db2777' };
  const cb = {
    yellow:'rgba(253,224,71,0.30)',
    blue:'rgba(147,197,253,0.35)',
    green:'rgba(134,239,172,0.35)',
    pink:'rgba(249,168,212,0.35)'
  };

  bhs.sort((a, b) => {
    // Si hay paraIdx, ordenar por orden en el libro
    const pa = a.paraIdx != null ? a.paraIdx : 999999;
    const pb = b.paraIdx != null ? b.paraIdx : 999999;
    if (pa !== pb) return pa - pb;
    return (a.ts || 0) - (b.ts || 0);
  }).forEach(h => {
    const card = document.createElement('div');
    card.className = 'hl-card' + (exportSelection.active ? ' selectable' : '') +
                     (exportSelection.selected.has(h.id) ? ' selected' : '');
    const isChecked = exportSelection.selected.has(h.id);

    const checkboxHtml = exportSelection.active
      ? `<input type="checkbox" class="hl-checkbox" data-id="${h.id}" ${isChecked ? 'checked' : ''}>`
      : '';

    card.innerHTML = `
      <div class="hl-card-inner">
        ${checkboxHtml}
        <div class="hl-strip" style="background:${cs[h.color]||cs.yellow};"></div>
        <div class="hl-card-body">
          <div class="hl-text hl-clickable" style="background:${cb[h.color]||cb.yellow};" data-id="${h.id}" title="Ir a esta parte del libro">${escHtml(h.text)}</div>
          <div class="hl-footer">
            <input class="hl-note" placeholder="Agregar nota..." value="${escHtml(h.note||'')}" data-id="${h.id}">
            <button class="hl-delete" data-id="${h.id}">Borrar</button>
          </div>
        </div>
      </div>`;
    list.appendChild(card);
  });

  // Listeners
  list.querySelectorAll('.hl-note').forEach(inp => {
    inp.addEventListener('change', async e => {
      const h = state.highlights.find(h => h.id === e.target.dataset.id);
      if (h) {
        h.note = e.target.value;
        // Cuando se edita la nota, hay que volver a marcarlo como NO sincronizado
        // (sino el saveToDrive futuro NO lo subiría con la nota actualizada).
        // Truco: forzar un saveToDrive ahora.
        await dbPut('highlights', h);
        saveToDrive();
        setStatus('Nota guardada');
      }
    });
  });
  list.querySelectorAll('.hl-delete').forEach(btn =>
    btn.addEventListener('click', e => deleteHighlight(e.target.dataset.id)));
  list.querySelectorAll('.hl-checkbox').forEach(cb => {
    cb.addEventListener('change', e => {
      toggleHighlightSelection(e.target.dataset.id);
      // Actualizar visual del card sin re-renderizar todo
      const card = e.target.closest('.hl-card');
      if (card) card.classList.toggle('selected', e.target.checked);
    });
  });

  // Click en el texto del highlight → ir a esa parte del libro
  list.querySelectorAll('.hl-clickable').forEach(el => {
    el.addEventListener('click', e => {
      // No hacer nada si estamos en modo selección (ahí el click toggle el checkbox)
      if (exportSelection.active) return;
      const id = e.currentTarget.dataset.id;
      goToHighlight(id);
    });
  });

  updateExportButton();
  updateSelectionToolbar();
}

/* Navega al texto del highlight dentro del libro: cambia a la pestaña Leer
   y hace scroll al span correspondiente. Si el span no existe en el DOM
   (porque no se pintó por algún motivo), intenta pintarlo primero. */
function goToHighlight(id) {
  const hl = state.highlights.find(h => h.id === id);
  if (!hl) {
    setStatus('No se encontró ese subrayado');
    return;
  }

  // 1. Cambiar a la pestaña Leer
  showTab('reader');

  // 2. Buscar el span en el DOM. Si no está, intentar aplicar highlights ahora.
  let span = document.querySelector(`[data-hl-id="${CSS.escape(id)}"]`);
  if (!span) {
    // Intentar pintar todos los highlights del libro actual
    if (typeof applyHighlightsToContent === 'function') applyHighlightsToContent();
    span = document.querySelector(`[data-hl-id="${CSS.escape(id)}"]`);
  }

  // 3. Si está, scroll suave hasta él. Si no, fallback al párrafo paraIdx.
  setTimeout(() => {
    if (span) {
      span.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Flash visual: subrayar más fuerte por un segundo
      span.classList.add('hl-flash');
      setTimeout(() => span.classList.remove('hl-flash'), 1600);
    } else if (hl.paraIdx != null) {
      const para = document.querySelector(`[data-para-idx="${hl.paraIdx}"]`);
      if (para) {
        para.scrollIntoView({ behavior: 'smooth', block: 'center' });
        para.classList.add('hl-flash');
        setTimeout(() => para.classList.remove('hl-flash'), 1600);
      } else {
        setStatus('No se pudo localizar el subrayado en el texto');
      }
    } else {
      setStatus('No se pudo localizar el subrayado en el texto');
    }
  }, 50);
}

/* Muestra/oculta la barrita "Seleccionar todos / Limpiar" arriba de la lista. */
function updateSelectionToolbar() {
  const bar = document.getElementById('selection-toolbar');
  if (!bar) return;
  if (exportSelection.active) {
    bar.style.display = 'flex';
    const counter = document.getElementById('selection-counter');
    if (counter) {
      const n = exportSelection.selected.size;
      const total = state.highlights.filter(h => h.bookId === state.currentBookId).length;
      counter.textContent = n === 0 ? `0 / ${total}` : `${n} / ${total}`;
    }
  } else {
    bar.style.display = 'none';
  }
}

// ════════════════════════════════════════════════════════════════
//  BORRAR / LIBERAR LIBRO
// ════════════════════════════════════════════════════════════════

async function deleteBook(bookId) {
  const book = state.books.find(b => b.id === bookId);
  if (!book) return;
  const inDrive = book.driveEpubFileId || (await dbGet('books', bookId).catch(() => null) || {}).driveEpubFileId;
  const msg = inDrive
    ? `¿Borrar "${book.title}"?\n\nSe eliminará de este dispositivo, de Drive y todos sus subrayados. Esta acción no se puede deshacer.`
    : `¿Borrar "${book.title}" y todos sus subrayados?\n\nEsta acción no se puede deshacer.`;
  if (!confirm(msg)) return;
  // Borrar de Drive primero (mientras tenemos el id en memoria)
  if (inDrive) await deleteBookFromDrive(inDrive);
  await dbDelete('books', bookId);
  await dbDeleteAllByIndex('highlights', 'bookId', bookId);
  await dbDeleteAllByIndex('bookmarks',  'bookId', bookId);
  await dbDelete('prefs', `pos_${bookId}`);
  state.books      = state.books.filter(b => b.id !== bookId);
  state.highlights = state.highlights.filter(h => h.bookId !== bookId);
  if (state.currentBookId === bookId) {
    state.currentBookId = null;
    await savePref('currentBookId', null);
    mountEmptyBook('Sube un libro para empezar.');
    document.getElementById('book-title-display').textContent = 'Mi Lector';
  }
  saveToDrive();
  renderSidebar();
  renderHighlights();
  setStatus(`"${book.title}" eliminado`);
}

async function freeBookSpace(bookId) {
  const book = state.books.find(b => b.id === bookId);
  if (!book) return;
  const full = await dbGet('books', bookId);
  const inDrive = !!(full && full.driveEpubFileId);
  const msg = inDrive
    ? `¿Liberar el espacio de "${book.title}"?\n\nEl contenido se eliminará de este dispositivo. Tus subrayados y el archivo en Drive se mantienen — podés volver a descargar cuando quieras.`
    : `¿Liberar el espacio de "${book.title}"?\n\nEl contenido se eliminará de este dispositivo, pero tus subrayados se mantienen en Drive. Para volver a leer tendrás que subir el EPUB de nuevo.`;
  if (!confirm(msg)) return;
  if (!full) return;
  // Conservar metadatos importantes
  await dbPut('books', {
    ...full,
    chapters: [],
    coverBase64: full.coverBase64  // mantener portada para la biblioteca
  });
  if (state.currentBookId === bookId) {
    if (inDrive) {
      mountEmptyBook('Contenido liberado.<br><br>' +
                     `<button onclick="downloadBookFromDrive(${bookId})" ` +
                     'style="padding:10px 18px;border-radius:8px;background:var(--accent);' +
                     'color:#fff;border:none;cursor:pointer;font-family:inherit;' +
                     'font-size:13px;font-weight:500;pointer-events:auto;">' +
                     'Descargar desde Drive</button>');
    } else {
      mountEmptyBook('Contenido liberado.<br><br><strong style="color:var(--text)">Volvé a subir el EPUB para leer.</strong>');
    }
  }
  setStatus('Espacio liberado');
  renderSidebar();
}

// ════════════════════════════════════════════════════════════════
//  BIBLIOTECA
// ════════════════════════════════════════════════════════════════

async function renderLibrary() {
  const grid  = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  grid.innerHTML = '';
  if (!state.books.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  for (const book of state.books) {
    const hlc    = state.highlights.filter(h => h.bookId === book.id).length;
    const posRec = await dbGet('prefs', `pos_${book.id}`).catch(() => null);
    const full   = await dbGet('books', book.id).catch(() => null);
    const hasCnt = full && full.chapters && full.chapters.length > 0;
    const inDrive = !!(full && full.driveEpubFileId);
    let prog = 'Sin progreso';
    if (posRec && posRec.value) {
      const ci = posRec.value.chapterIndex || 0;
      const ch = hasCnt && full.chapters[ci];
      if (ch && ch.title)   prog = `${ci + 1}. ${ch.title}`;
      else if (hasCnt)      prog = `Cap. ${ci + 1} de ${full.chapters.length}`;
    }
    const card = document.createElement('div');
    card.className = 'book-card';
    const coverHtml = full && full.coverBase64
      ? `<img src="${full.coverBase64}" alt="${escHtml(book.title)}" loading="lazy">`
      : `<div class="book-cover-initial">${(book.title[0] || '?').toUpperCase()}</div>`;

    // Badge: "Sin contenido" si no hay local Y no hay en Drive,
    // "En Drive" si no hay local pero sí en Drive.
    let badge = '';
    if (!hasCnt) {
      badge = inDrive
        ? '<div class="no-content-badge in-drive">En Drive</div>'
        : '<div class="no-content-badge">Sin contenido</div>';
    }

    // Botones según estado:
    // - Local: Abrir | Liberar | 🗑
    // - En Drive (sin local): Descargar | 🗑
    // - Sin contenido y sin Drive: Abrir (deshabilitado) | 🗑
    let actionsHtml;
    if (hasCnt) {
      actionsHtml = `
        <button class="btn-card btn-card-open" onclick="selectBook('${book.id}')">Abrir</button>
        <button class="btn-card btn-card-free" onclick="freeBookSpace('${book.id}')">Liberar</button>
        <button class="btn-card btn-card-delete" onclick="deleteBook('${book.id}')">🗑</button>`;
    } else if (inDrive) {
      actionsHtml = `
        <button class="btn-card btn-card-download" onclick="downloadBookFromDrive('${book.id}')">Descargar</button>
        <button class="btn-card btn-card-delete" onclick="deleteBook('${book.id}')">🗑</button>`;
    } else {
      actionsHtml = `
        <button class="btn-card btn-card-open" disabled>Abrir</button>
        <button class="btn-card btn-card-delete" onclick="deleteBook('${book.id}')">🗑</button>`;
    }

    card.innerHTML = `
      <div class="book-cover" onclick="${hasCnt ? `selectBook('${book.id}')` : (inDrive ? `downloadBookFromDrive('${book.id}')` : '')}">
        ${coverHtml}${badge}
      </div>
      <div class="book-card-info">
        <div class="book-card-title" title="${escHtml(book.title)}">${escHtml(book.title)}</div>
        ${book.author ? `<div class="book-card-author">${escHtml(book.author)}</div>` : ''}
        <div class="book-card-meta">${prog}<br>${hlc} subrayado${hlc !== 1 ? 's' : ''}</div>
      </div>
      <div class="book-card-actions">${actionsHtml}</div>`;
    grid.appendChild(card);
  }
}

// ════════════════════════════════════════════════════════════════
//  BÚSQUEDA DENTRO DEL LIBRO
// ════════════════════════════════════════════════════════════════

/* Estado del buscador. Los matches se almacenan como
   { paraIdx, start, end } — start y end son offsets dentro del
   textContent del párrafo. Eso nos permite encontrar el rango
   exacto en el DOM cuando navegamos a un match. */
const search = {
  query: '',
  matches: [],
  currentIdx: -1,
  open: false,
  searchToken: 0,    // identifier para cancelar búsquedas en curso
  debounceTimer: 0
};

/* Normaliza para búsqueda case-insensitive y sin acentos.
   "fácil" → "facil", "Niño" → "nino". */
function normalizeForSearch(s) {
  if (!s) return '';
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function toggleSearch() {
  if (search.open) closeSearch();
  else             openSearch();
}

function openSearch() {
  if (!allParagraphs.length) {
    setStatus('Primero abrí un libro');
    return;
  }
  search.open = true;
  document.getElementById('search-bar').style.display = 'flex';
  document.getElementById('btn-search').classList.add('active');
  // Asegurar que estamos en la pestaña Leer (sino no se ve)
  if (currentTab !== 'reader') showTab('reader');
  const input = document.getElementById('search-input');
  input.focus();
  input.select();
}

function closeSearch() {
  search.open = false;
  document.getElementById('search-bar').style.display = 'none';
  document.getElementById('btn-search').classList.remove('active');
  clearSearchHighlights();
  search.query = '';
  search.matches = [];
  search.currentIdx = -1;
  document.getElementById('search-input').value = '';
  updateSearchCounter();
}

/* Búsqueda en chunks con requestIdleCallback — para no trabar el UI
   en libros grandes. Cada chunk procesa N párrafos. */
async function performSearch(query) {
  // Cancelar búsqueda anterior si la hay
  search.searchToken++;
  const myToken = search.searchToken;

  search.query = query;
  search.matches = [];
  search.currentIdx = -1;

  if (!query || query.length < 2) {
    clearSearchHighlights();
    updateSearchCounter();
    return;
  }

  const needle = normalizeForSearch(query);
  const total = allParagraphs.length;

  // Pre-calcular textContent normalizado de cada párrafo en chunks.
  // Procesamos 200 párrafos por idle callback.
  const CHUNK = 200;
  let i = 0;

  const processChunk = (deadline) => {
    if (myToken !== search.searchToken) return;  // cancelada
    const limit = Math.min(i + CHUNK, total);
    for (; i < limit; i++) {
      const para = allParagraphs[i];
      // Sacar el texto plano del HTML del párrafo
      const tmp = document.createElement('div');
      tmp.innerHTML = para.html;
      const plainText = tmp.textContent || '';
      const normText  = normalizeForSearch(plainText);
      let pos = 0;
      while (true) {
        const found = normText.indexOf(needle, pos);
        if (found === -1) break;
        search.matches.push({ paraIdx: i, start: found, end: found + needle.length });
        pos = found + needle.length;
      }
    }
    if (i < total) {
      // Más chunks pendientes
      if ('requestIdleCallback' in window) {
        requestIdleCallback(processChunk, { timeout: 100 });
      } else {
        setTimeout(() => processChunk(null), 0);
      }
      // Mientras tanto, ya podemos ir mostrando el conteo parcial
      updateSearchCounter(true);
    } else {
      // Búsqueda completa
      finishSearch();
    }
  };

  if ('requestIdleCallback' in window) {
    requestIdleCallback(processChunk, { timeout: 100 });
  } else {
    setTimeout(() => processChunk(null), 0);
  }
}

function finishSearch() {
  applySearchHighlights();
  if (search.matches.length > 0) {
    search.currentIdx = 0;
    scrollToCurrentMatch();
  }
  updateSearchCounter();
}

/* Aplica los resaltados temporales en el DOM. Importante: hacemos
   esto por párrafo, modificando solo los párrafos que tienen matches.
   Los highlights permanentes (.hl) se preservan. */
function applySearchHighlights() {
  clearSearchHighlights();
  const container = document.getElementById('page-content');
  if (!container || !search.matches.length) return;

  // Agrupar matches por párrafo
  const byPara = {};
  for (let mi = 0; mi < search.matches.length; mi++) {
    const m = search.matches[mi];
    if (!byPara[m.paraIdx]) byPara[m.paraIdx] = [];
    byPara[m.paraIdx].push({ ...m, globalIdx: mi });
  }

  for (const paraIdx in byPara) {
    const paraEl = container.querySelector(`[data-para-idx="${paraIdx}"]`);
    if (!paraEl) continue;
    wrapMatchesInElement(paraEl, byPara[paraIdx]);
  }
}

/* Envuelve los matches dentro de un párrafo. Recorre nodos de texto y
   convierte los rangos [start, end] (offsets en el texto plano) en
   <span class="search-match"> en el DOM. Los offsets se calculan sobre
   el texto NORMALIZADO; pero `slice` sobre texto raw funciona igual
   porque normalize() preserva el largo en caracteres comunes (las
   tildes son combining diacritics que se quitan con NFD pero luego
   restamos al normalizar). Ojo: para evitar drift, usamos un mapping
   entre raw y normalized usando la misma técnica de cada nodo. */
function wrapMatchesInElement(paraEl, matches) {
  // Recorrer nodos de texto, manteniendo un offset acumulado de "texto plano"
  const nodes = [];
  const walker = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT, {
    acceptNode: n => {
      // Saltar nodos dentro de highlights permanentes (.hl) o ya marcados (.search-match)
      let p = n.parentElement;
      while (p && p !== paraEl) {
        if (p.classList && (p.classList.contains('search-match'))) return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  // Calcular el offset acumulado normalizado de cada nodo
  // (necesario porque normalize() puede cambiar el largo en algunos casos
  // raros de Unicode — usamos length normalizada para los offsets)
  let acc = 0;
  const nodeRanges = [];
  for (const node of nodes) {
    const norm = normalizeForSearch(node.textContent);
    nodeRanges.push({ node, accStart: acc, accEnd: acc + norm.length, normLen: norm.length, rawLen: node.textContent.length });
    acc += norm.length;
  }

  // Para cada match, encontrar los nodos que toca y crear los spans.
  // Procesar de atrás hacia adelante para no invalidar offsets al modificar.
  const sortedMatches = matches.slice().sort((a, b) => b.start - a.start);
  for (const m of sortedMatches) {
    wrapSingleMatch(nodeRanges, m);
  }
}

function wrapSingleMatch(nodeRanges, match) {
  // Encontrar el nodo donde empieza y donde termina el match
  let startNodeInfo = null, endNodeInfo = null;
  for (const info of nodeRanges) {
    if (startNodeInfo === null && match.start >= info.accStart && match.start < info.accEnd) {
      startNodeInfo = info;
    }
    if (match.end > info.accStart && match.end <= info.accEnd) {
      endNodeInfo = info;
    }
  }
  if (!startNodeInfo || !endNodeInfo) return;

  // Si el match cruza nodos (raro, ej. <em>texto</em> en medio), lo saltamos.
  // Es un trade-off: la mayoría de matches están dentro de un solo nodo de texto.
  if (startNodeInfo !== endNodeInfo) return;

  // Offsets relativos al nodo
  const localStart = match.start - startNodeInfo.accStart;
  const localEnd   = match.end   - startNodeInfo.accStart;

  // Asumimos que el largo raw == largo normalizado. Eso es cierto para
  // texto en español (las tildes en NFD se eliminan en normalize, pero
  // el texto raw es NFC normalmente, y `length` en JS es UTF-16 codeunits).
  // Para un buscador tipo Ctrl+F esto es suficientemente preciso.
  const node = startNodeInfo.node;
  const rawText = node.textContent;
  // Si los largos no coinciden exactamente, los offsets pueden estar
  // un poco corridos — usamos clamping para que no rompa.
  const start = Math.min(localStart, rawText.length);
  const end   = Math.min(localEnd,   rawText.length);
  if (start >= end) return;

  try {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const span = document.createElement('span');
    span.className = 'search-match';
    span.dataset.matchIdx = match.globalIdx;
    range.surroundContents(span);
  } catch (e) { /* surroundContents falla si el rango cruza tags inline */ }
}

function clearSearchHighlights() {
  const container = document.getElementById('page-content');
  if (!container) return;
  container.querySelectorAll('.search-match').forEach(span => {
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();  // unifica nodos de texto adyacentes
  });
}

function updateSearchCounter(partial) {
  const counter = document.getElementById('search-counter');
  const prevBtn = document.getElementById('btn-search-prev');
  const nextBtn = document.getElementById('btn-search-next');
  const n = search.matches.length;
  if (n === 0) {
    counter.textContent = search.query ? 'Sin resultados' : '0 resultados';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
  } else {
    const cur = search.currentIdx >= 0 ? search.currentIdx + 1 : 0;
    counter.textContent = partial
      ? `${n}+ resultados...`
      : `${cur} de ${n}`;
    prevBtn.disabled = false;
    nextBtn.disabled = false;
  }
}

function scrollToCurrentMatch() {
  // Quitar marca de "current" del anterior
  const container = document.getElementById('page-content');
  container.querySelectorAll('.search-match-current').forEach(el =>
    el.classList.remove('search-match-current'));

  if (search.currentIdx < 0 || search.currentIdx >= search.matches.length) return;

  const match = search.matches[search.currentIdx];
  // Buscar el span correspondiente
  const span = container.querySelector(`.search-match[data-match-idx="${search.currentIdx}"]`);
  if (span) {
    span.classList.add('search-match-current');
    // scrollIntoView con block:'center' para que quede en el medio del viewport
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    // Fallback: scroll al párrafo
    scrollToParaIdx(match.paraIdx);
  }
  updateSearchCounter();
}

function searchNext() {
  if (!search.matches.length) return;
  search.currentIdx = (search.currentIdx + 1) % search.matches.length;
  scrollToCurrentMatch();
}

function searchPrev() {
  if (!search.matches.length) return;
  search.currentIdx = (search.currentIdx - 1 + search.matches.length) % search.matches.length;
  scrollToCurrentMatch();
}

/* Setup de listeners del buscador. Lo llamamos al final del init. */
function setupSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;

  // Input con debounce de 200ms
  input.addEventListener('input', e => {
    const val = e.target.value;
    clearTimeout(search.debounceTimer);
    search.debounceTimer = setTimeout(() => performSearch(val), 200);
  });

  // Enter = next, Shift+Enter = prev, Esc = cerrar
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) searchPrev(); else searchNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  });

  // Ctrl+F / Cmd+F a nivel global → abre/enfoca buscador
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openSearch();
    } else if (e.key === 'Escape' && search.open) {
      e.preventDefault();
      closeSearch();
    }
  });
}



function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t, i) =>
    t.classList.toggle('active', ['reader','highlights','library'][i] === tab));
  document.getElementById('reader-view').style.display     = tab === 'reader'     ? 'block' : 'none';
  document.getElementById('highlights-view').style.display = tab === 'highlights' ? 'flex'  : 'none';
  document.getElementById('library-view').style.display    = tab === 'library'    ? 'flex'  : 'none';

  if (tab === 'highlights') { renderHighlights(); renderBookmarks(); }
  if (tab === 'library')    renderLibrary();
}

// Estado inicial de pestañas
document.getElementById('reader-view').style.display     = 'block';
document.getElementById('highlights-view').style.display = 'none';
document.getElementById('library-view').style.display    = 'none';

// ════════════════════════════════════════════════════════════════
//  UI — SIDEBAR / EXPORT / STATUS
// ════════════════════════════════════════════════════════════════

function renderSidebar() {
  const list = document.getElementById('book-list');
  list.innerHTML = '';
  if (!state.books.length) {
    list.innerHTML = '<p style="font-size:12px;color:#555;padding:16px 12px;line-height:1.6;">Sube un epub o txt para empezar</p>';
    return;
  }
  state.books.forEach(b => {
    const count = state.highlights.filter(h => h.bookId === b.id).length;
    const div   = document.createElement('div');
    div.className = 'book-item' + (b.id === state.currentBookId ? ' active' : '');
    div.innerHTML = `
      <div class="book-item-info" onclick="selectBook('${b.id}')">
        <div class="book-title">${escHtml(b.title)}</div>
        <div class="book-meta">${count} subrayado${count !== 1 ? 's' : ''}</div>
      </div>
      <button class="btn-book-delete" onclick="deleteBook('${b.id}')" title="Borrar libro">🗑</button>`;
    list.appendChild(div);
  });
}

// ════════════════════════════════════════════════════════════════
//  EXPORT A OBSIDIAN (vía Drive /Lector-Inbox/)
// ════════════════════════════════════════════════════════════════

/* Estado del modo selección en la pestaña Subrayados.
   Vive solo mientras la pestaña está abierta. */
const exportSelection = {
  active: false,         // ¿estamos en modo selección?
  selected: new Set()    // IDs de highlights seleccionados
};

function toggleSelectionMode() {
  exportSelection.active = !exportSelection.active;
  if (!exportSelection.active) exportSelection.selected.clear();
  renderHighlights();
}

function toggleHighlightSelection(id) {
  if (exportSelection.selected.has(id)) exportSelection.selected.delete(id);
  else                                  exportSelection.selected.add(id);
  updateExportButton();
}

function selectAllHighlights() {
  const bhs = state.highlights.filter(h => h.bookId === state.currentBookId);
  for (const h of bhs) exportSelection.selected.add(h.id);
  renderHighlights();
}

function clearSelection() {
  exportSelection.selected.clear();
  renderHighlights();
}

function updateExportButton() {
  const btn = document.getElementById('export-btn');
  if (!btn) return;
  const n = exportSelection.selected.size;
  if (exportSelection.active && n > 0) {
    btn.textContent = `Exportar ${n} a Drive`;
  } else {
    btn.textContent = 'Exportar a Drive';
  }
}

/* Genera el markdown con el formato Literature Note del briefing original. */
function buildMarkdown(book, highlights) {
  const lines = [];
  lines.push('---');
  lines.push('tipo: literatura');
  lines.push('fuente: libro');
  if (book.author) lines.push(`autor: ${book.author}`);
  lines.push('estado: pendiente');
  lines.push(`exportado: ${new Date().toISOString().split('T')[0]}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${book.title}`);
  lines.push('');
  lines.push('## Highlights');
  lines.push('');
  // Ordenar por orden en el libro (paraIdx) si están disponibles, sino por timestamp
  const sorted = highlights.slice().sort((a, b) => {
    const pa = a.paraIdx != null ? a.paraIdx : 999999;
    const pb = b.paraIdx != null ? b.paraIdx : 999999;
    if (pa !== pb) return pa - pb;
    return (a.ts || 0) - (b.ts || 0);
  });
  for (const h of sorted) {
    // Quote: cada línea del texto prefijada con "> "
    const quoted = h.text.split('\n').map(l => `> ${l}`).join('\n');
    lines.push(quoted);
    if (h.note && h.note.trim()) {
      lines.push(`— ${h.note.trim()}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* Crea o devuelve el ID de la carpeta Lector-Inbox.
   El ID se cachea en prefs — si el usuario mueve o renombra la carpeta,
   el ID sigue siendo válido. Si la borra, se crea una nueva. */
async function getOrCreateInboxFolder() {
  if (!driveReady) throw new Error('Drive no conectado');
  const token = (window.gapi && gapi.client && gapi.client.getToken &&
                 gapi.client.getToken().access_token);
  if (!token) throw new Error('Sin access token');

  // 1. Chequear cache
  const cached = await dbGet('prefs', 'inboxFolderId').catch(() => null);
  if (cached && cached.value) {
    // Verificar que la carpeta sigue existiendo (puede haberla borrado)
    const verifyResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${cached.value}?fields=id,trashed`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (verifyResp.ok) {
      const data = await verifyResp.json();
      if (!data.trashed) return cached.value;
    }
    // Si llegamos acá, la carpeta cacheada ya no existe — limpiar y crear nueva
    await dbDelete('prefs', 'inboxFolderId').catch(() => {});
  }

  // 2. Buscar por nombre en el Drive del usuario (en root)
  // Solo busca carpetas que la app pueda ver con scope drive.file
  const searchResp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent("name='" + INBOX_FOLDER_NAME + "' and mimeType='application/vnd.google-apps.folder' and trashed=false")}&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (searchResp.ok) {
    const searchData = await searchResp.json();
    if (searchData.files && searchData.files.length > 0) {
      const folderId = searchData.files[0].id;
      await savePref('inboxFolderId', folderId);
      return folderId;
    }
  }

  // 3. No existe — crearla en root
  const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: INBOX_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });
  if (!createResp.ok) {
    const txt = await createResp.text().catch(() => '');
    throw new Error(`No pude crear carpeta: ${createResp.status} — ${txt.substring(0, 100)}`);
  }
  const meta = await createResp.json();
  await savePref('inboxFolderId', meta.id);
  return meta.id;
}

/* Sube un .md a la carpeta Lector-Inbox. Si ya existe un archivo con el
   mismo nombre (mismo libro), lo reemplaza para que no haya duplicados. */
async function uploadMarkdownToInbox(filename, markdown, folderId) {
  const token = gapi.client.getToken().access_token;

  // Buscar archivo existente con el mismo nombre en la carpeta
  let existingId = null;
  const listResp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent("name='" + filename + "' and '" + folderId + "' in parents and trashed=false")}&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (listResp.ok) {
    const data = await listResp.json();
    if (data.files && data.files.length > 0) existingId = data.files[0].id;
  }

  let driveId = existingId;
  if (!driveId) {
    // Crear archivo
    const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: filename,
        parents: [folderId],
        mimeType: 'text/markdown'
      })
    });
    if (!createResp.ok) {
      const txt = await createResp.text().catch(() => '');
      throw new Error(`create md falló: ${createResp.status} — ${txt.substring(0, 100)}`);
    }
    const meta = await createResp.json();
    driveId = meta.id;
  }

  // Subir contenido
  const uploadResp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${driveId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/markdown; charset=UTF-8'
      },
      body: markdown
    }
  );
  if (!uploadResp.ok) {
    const txt = await uploadResp.text().catch(() => '');
    throw new Error(`upload md falló: ${uploadResp.status} — ${txt.substring(0, 100)}`);
  }
  return { driveId, replaced: !!existingId };
}

/* Función principal. Decide qué highlights exportar según el modo:
   - Modo selección activo + alguno seleccionado: solo los seleccionados.
   - Modo selección activo + ninguno seleccionado: error, "elegí al menos uno".
   - Modo selección NO activo: todos los highlights del libro actual. */
async function exportToObsidian() {
  if (!driveReady) {
    setStatus('Conectá Drive primero para exportar');
    return;
  }
  const book = state.books.find(b => b.id === state.currentBookId);
  if (!book) { setStatus('Abrí un libro primero'); return; }

  const all = state.highlights.filter(h => h.bookId === state.currentBookId);
  let toExport;
  if (exportSelection.active) {
    if (exportSelection.selected.size === 0) {
      setStatus('Seleccioná al menos un subrayado');
      return;
    }
    toExport = all.filter(h => exportSelection.selected.has(h.id));
  } else {
    toExport = all;
  }
  if (!toExport.length) {
    setStatus('No hay subrayados para exportar');
    return;
  }

  showLoading('Exportando a Drive...');
  try {
    const folderId = await getOrCreateInboxFolder();
    const md = buildMarkdown(book, toExport);
    const safeTitle = book.title.replace(/[^\w\sáéíóúÁÉÍÓÚñÑ.-]/g, '_').substring(0, 80);
    const filename = `${safeTitle}.md`;
    const result = await uploadMarkdownToInbox(filename, md, folderId);

    hideLoading();
    const action = result.replaced ? 'reemplazado' : 'creado';
    setStatus(`✓ ${toExport.length} subrayado${toExport.length !== 1 ? 's' : ''} ${action} en /Lector-Inbox/${filename}`);
    console.log('[exportToObsidian] OK', { filename, count: toExport.length, replaced: result.replaced });

    // Salir del modo selección si estaba activo
    if (exportSelection.active) {
      exportSelection.active = false;
      exportSelection.selected.clear();
      renderHighlights();
    }
  } catch (e) {
    hideLoading();
    console.error('[exportToObsidian]', e);
    setStatus('Error exportando: ' + (e.message || '').substring(0, 80));
  }
}

let statusTimer = null;
function setStatus(msg) {
  document.getElementById('status-text').textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(updateProgress, 2500);
}
function setStatusDirect(msg) { document.getElementById('status-text').textContent = msg; }
function showLoading(msg) {
  document.getElementById('loading-text').textContent = msg || 'Cargando...';
  document.getElementById('loading').style.display = 'flex';
}
function hideLoading() { document.getElementById('loading').style.display = 'none'; }

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
