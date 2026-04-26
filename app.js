/* ══════════════════════════════════════════════════
   Mi Lector — app.js
   Fase 2: Capítulos lazy, progreso, bookmarks, scroll
   ══════════════════════════════════════════════════ */
'use strict';

// ─── CONSTANTES ───
const CLIENT_ID   = '602238897882-g752d4mbev0d2leg8fvnq7lqt6jsof8l.apps.googleusercontent.com';
const SCOPES      = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE  = 'mi-lector-data.json';
const DB_NAME     = 'mi-lector-db';
const DB_VERSION  = 2;          // subimos a 2 para agregar store bookmarks
const FONT_MIN    = 14;
const FONT_MAX    = 22;
const THEMES      = ['day', 'sepia', 'night'];
const THEME_ICONS = { day: '☀', sepia: '📜', night: '🌙' };

// Cuántos px antes del fondo empezamos a cargar el siguiente capítulo
const LOAD_THRESHOLD = 600;

// ─── ESTADO EN MEMORIA ───
let state = {
  books: [],        // [{ id, title, author }]  — sin html, sin capítulos
  highlights: [],   // [{ id, bookId, text, note, color, ts }]
  currentBookId: null,
  nextId: 1
};
let prefs = { theme: 'day', fontSize: 17 };

// Estado del lector activo
let currentBookChapters = [];  // [{ index, title, html }]
let totalChapters       = 0;
let currentChapterIndex = 0;
let renderedChapters    = new Set();
let savedReaderScroll   = 0;   // guardado en memoria al cambiar de pestaña

let currentColor = 'yellow';
let driveReady   = false;
let driveFileId  = null;
let tokenClient  = null;
let driveTimer   = null;
let scrollSaveTimer  = null;
let progressTimer    = null;

// ═══════════════════════════════════════════════════
//  INDEXEDDB
// ═══════════════════════════════════════════════════

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('books')) {
        d.createObjectStore('books', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('highlights')) {
        const hs = d.createObjectStore('highlights', { keyPath: 'id' });
        hs.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!d.objectStoreNames.contains('prefs')) {
        d.createObjectStore('prefs', { keyPath: 'key' });
      }
      // NUEVO en v2: marcadores
      if (!d.objectStoreNames.contains('bookmarks')) {
        const bs = d.createObjectStore('bookmarks', { keyPath: 'id' });
        bs.createIndex('bookId', 'bookId', { unique: false });
      }
    };

    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbOp(storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req   = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

const dbGet    = (s, k) => dbOp(s, 'readonly',  st => st.get(k));
const dbPut    = (s, v) => dbOp(s, 'readwrite', st => st.put(v));
const dbDelete = (s, k) => dbOp(s, 'readwrite', st => st.delete(k));
const dbGetAll = s      => dbOp(s, 'readonly',  st => st.getAll());

function dbGetByIndex(storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req   = store.index(indexName).getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ═══════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════

window.onload = async () => {
  showLoading('Iniciando...');
  try {
    db = await openDB();
    await migrateFromLocalStorage();
    await loadState();
    applyPrefs();
    renderSidebar();
    renderHighlights();
    if (state.currentBookId) {
      await selectBook(state.currentBookId);
    }
  } catch (e) {
    console.error('[Init]', e);
    setStatus('Error al iniciar — intenta recargar la página');
  }
  hideLoading();
  loadGapiScript();
  registerSW();
  setupScrollListener();
};

// ─── Migración desde localStorage ───
async function migrateFromLocalStorage() {
  try {
    const raw = localStorage.getItem('mi_lector_v2');
    if (!raw) return;
    const old = JSON.parse(raw);

    for (const book of (old.books || [])) {
      const exists = await dbGet('books', book.id);
      if (!exists) {
        // Convertir formato viejo { html } → { chapters: [{ index:0, title:null, html }] }
        const converted = {
          id:       book.id,
          title:    book.title,
          author:   book.author || '',
          chapters: [{ index: 0, title: null, html: book.html || '' }]
        };
        await dbPut('books', converted);
      }
    }

    for (const hl of (old.highlights || [])) {
      const exists = await dbGet('highlights', hl.id);
      if (!exists) await dbPut('highlights', hl);
    }

    if (old.nextId)        await dbPut('prefs', { key: 'nextId',        value: old.nextId });
    if (old.currentBookId) await dbPut('prefs', { key: 'currentBookId', value: old.currentBookId });

    localStorage.removeItem('mi_lector_v2');
    console.log('[Migración] localStorage → IndexedDB completado');
  } catch (e) {
    console.warn('[Migración]', e);
  }
}

async function loadState() {
  const allBooks       = await dbGetAll('books');
  state.books          = allBooks.map(b => ({ id: b.id, title: b.title, author: b.author || '' }));
  state.highlights     = await dbGetAll('highlights');

  const nextIdRec      = await dbGet('prefs', 'nextId');
  state.nextId         = nextIdRec ? nextIdRec.value : 1;

  const curBookRec     = await dbGet('prefs', 'currentBookId');
  state.currentBookId  = curBookRec ? curBookRec.value : null;

  const themeRec       = await dbGet('prefs', 'theme');
  prefs.theme          = themeRec ? themeRec.value : 'day';

  const fontRec        = await dbGet('prefs', 'fontSize');
  prefs.fontSize       = fontRec ? fontRec.value : 17;
}

async function savePref(key, value) {
  try { await dbPut('prefs', { key, value }); } catch (e) {}
}

// ─── Service Worker ───
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(r  => console.log('[SW] scope:', r.scope))
      .catch(e => console.warn('[SW]', e));
  }
}

// ═══════════════════════════════════════════════════
//  PREFERENCIAS — TEMA Y FUENTE
// ═══════════════════════════════════════════════════

function applyPrefs() {
  document.documentElement.setAttribute('data-theme', prefs.theme);
  document.getElementById('reader-view').style.fontSize = prefs.fontSize + 'px';
  updateThemeBtn();
  updateFontBtns();
}

function cycleTheme() {
  const idx   = THEMES.indexOf(prefs.theme);
  prefs.theme = THEMES[(idx + 1) % THEMES.length];
  document.documentElement.setAttribute('data-theme', prefs.theme);
  savePref('theme', prefs.theme);
  updateThemeBtn();
}

function updateThemeBtn() {
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = THEME_ICONS[prefs.theme];
}

function changeFontSize(delta) {
  prefs.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, prefs.fontSize + delta));
  document.getElementById('reader-view').style.fontSize = prefs.fontSize + 'px';
  savePref('fontSize', prefs.fontSize);
  updateFontBtns();
}

function updateFontBtns() {
  const minus = document.getElementById('btn-font-minus');
  const plus  = document.getElementById('btn-font-plus');
  if (minus) minus.disabled = prefs.fontSize <= FONT_MIN;
  if (plus)  plus.disabled  = prefs.fontSize >= FONT_MAX;
}

// ═══════════════════════════════════════════════════
//  SCROLL — LAZY LOADING Y PROGRESO
// ═══════════════════════════════════════════════════

function setupScrollListener() {
  const content = document.getElementById('content');

  content.addEventListener('scroll', () => {
    if (!state.currentBookId) return;

    // Actualizar progreso con throttle
    clearTimeout(progressTimer);
    progressTimer = setTimeout(updateProgress, 80);

    // Lazy load del siguiente capítulo
    checkLoadNextChapter();

    // Guardar posición en IndexedDB (debounced)
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(saveScrollPosition, 700);
  });
}

function updateProgress() {
  if (!state.currentBookId || totalChapters === 0) return;

  const content = document.getElementById('content');

  // ¿En qué capítulo estamos? El que tenga su borde superior más cerca del tope visible
  let currentIdx = 0;
  const blocks   = document.querySelectorAll('.chapter-block');
  const contentTop = content.getBoundingClientRect().top;

  blocks.forEach(block => {
    const blockTop = block.getBoundingClientRect().top;
    if (blockTop <= contentTop + 120) {
      currentIdx = parseInt(block.dataset.chapter, 10);
    }
  });

  currentChapterIndex = currentIdx;

  // Porcentaje global (basado en scroll del contenedor)
  const { scrollTop, scrollHeight, clientHeight } = content;
  const scrollable  = scrollHeight - clientHeight;
  const percentage  = scrollable > 0 ? Math.round((scrollTop / scrollable) * 100) : 0;

  // Etiqueta de capítulo
  const chapter     = currentBookChapters[currentIdx];
  let chapterLabel;
  if (chapter && chapter.title) {
    chapterLabel = `${currentIdx + 1}. ${chapter.title}`;
  } else {
    chapterLabel = `Capítulo ${currentIdx + 1} de ${totalChapters}`;
  }

  document.getElementById('status-text').textContent = `${chapterLabel} · ${percentage}%`;
}

function checkLoadNextChapter() {
  const content = document.getElementById('content');
  const { scrollTop, scrollHeight, clientHeight } = content;
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

  if (distanceFromBottom < LOAD_THRESHOLD) {
    const maxRendered = Math.max(...renderedChapters);
    if (maxRendered < totalChapters - 1) {
      appendChapter(maxRendered + 1);
    }
  }
}

async function saveScrollPosition() {
  if (!state.currentBookId) return;
  const content = document.getElementById('content');
  await savePref(`pos_${state.currentBookId}`, {
    chapterIndex: currentChapterIndex,
    scrollTop:    content.scrollTop
  });
}

async function restoreScrollPosition() {
  if (!state.currentBookId) return;
  const rec = await dbGet('prefs', `pos_${state.currentBookId}`);
  if (!rec || !rec.value) return;

  const { chapterIndex, scrollTop } = rec.value;

  // Asegurar que los capítulos hasta el guardado estén renderizados
  for (let i = 0; i <= Math.min(chapterIndex + 1, totalChapters - 1); i++) {
    appendChapter(i);
  }

  // Dar tiempo al DOM para renderizar antes de hacer scroll
  setTimeout(() => {
    document.getElementById('content').scrollTop = scrollTop;
    updateProgress();
  }, 60);
}

// ═══════════════════════════════════════════════════
//  GOOGLE DRIVE
// ═══════════════════════════════════════════════════

function loadGapiScript() {
  const s1 = document.createElement('script');
  s1.src    = 'https://apis.google.com/js/api.js';
  s1.onload = () => gapi.load('client', initGapiClient);
  document.head.appendChild(s1);

  const s2 = document.createElement('script');
  s2.src = 'https://accounts.google.com/gsi/client';
  document.head.appendChild(s2);
}

async function initGapiClient() {
  await gapi.client.init({
    apiKey: '',
    discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest']
  });
}

function initDrive() {
  if (!window.google) {
    setStatus('Cargando Google... espera un momento');
    setTimeout(initDrive, 1500);
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async resp => {
      if (resp.error) { setStatus('Error al conectar Drive'); return; }
      driveReady = true;
      document.getElementById('drive-btn').textContent = 'Drive conectado';
      document.getElementById('drive-btn').classList.add('connected');
      document.getElementById('drive-dot').classList.add('connected');
      document.getElementById('drive-status-text').textContent = 'Google Drive activo';
      setStatus('Conectado a Drive — sincronizando...');
      await syncFromDrive();
    }
  });

  tokenClient.requestAccessToken({ prompt: 'consent' });
}

async function syncFromDrive() {
  showLoading('Sincronizando con Drive...');
  try {
    const res   = await gapi.client.drive.files.list({
      spaces: 'appDataFolder',
      q:      `name='${DRIVE_FILE}'`,
      fields: 'files(id,name)'
    });
    const files = res.result.files;

    if (files && files.length > 0) {
      driveFileId   = files[0].id;
      const content = await gapi.client.drive.files.get({ fileId: driveFileId, alt: 'media' });
      const remote  = JSON.parse(content.body);
      await mergeState(remote);
      renderSidebar();
      renderHighlights();
      setStatus('Sincronizado con Drive');
    } else {
      await saveToDrive();
      setStatus('Datos guardados en Drive');
    }
  } catch (e) {
    console.error('[Drive] syncFromDrive:', e);
    setStatus('Error sincronizando — datos locales disponibles');
  }
  hideLoading();
}

async function mergeState(remote) {
  const localHlIds   = new Set(state.highlights.map(h => h.id));
  const localBookIds = new Set(state.books.map(b => b.id));

  for (const h of (remote.highlights || [])) {
    if (!localHlIds.has(h.id)) {
      state.highlights.push(h);
      await dbPut('highlights', h);
    }
  }

  for (const b of (remote.books || [])) {
    if (!localBookIds.has(b.id)) {
      state.books.push({ id: b.id, title: b.title, author: b.author || '' });
      await dbPut('books', { id: b.id, title: b.title, author: b.author || '', chapters: [] });
    }
  }

  if ((remote.nextId || 0) > state.nextId) {
    state.nextId = remote.nextId;
    await savePref('nextId', state.nextId);
  }
}

async function saveToDrive() {
  if (!driveReady) return;
  clearTimeout(driveTimer);

  driveTimer = setTimeout(async () => {
    try {
      const payload = JSON.stringify({
        books:      state.books.map(b => ({ id: b.id, title: b.title, author: b.author })),
        highlights: state.highlights,
        nextId:     state.nextId
      });

      if (driveFileId) {
        await gapi.client.request({
          path:   `/upload/drive/v3/files/${driveFileId}`,
          method: 'PATCH',
          params: { uploadType: 'media' },
          body:   payload
        });
      } else {
        const meta  = await gapi.client.drive.files.create({
          resource: { name: DRIVE_FILE, parents: ['appDataFolder'] },
          fields: 'id'
        });
        driveFileId = meta.result.id;
        await gapi.client.request({
          path:   `/upload/drive/v3/files/${driveFileId}`,
          method: 'PATCH',
          params: { uploadType: 'media' },
          body:   payload
        });
      }

      const ind = document.getElementById('sync-indicator');
      ind.textContent = 'Guardado en Drive ✓';
      setTimeout(() => { ind.textContent = ''; }, 2000);
    } catch (e) {
      console.warn('[Drive] saveToDrive:', e);
    }
  }, 1200);
}

// ═══════════════════════════════════════════════════
//  EPUB PARSER
// ═══════════════════════════════════════════════════

document.getElementById('file-input').addEventListener('change', async e => {
  for (const file of Array.from(e.target.files)) {
    showLoading('Cargando ' + file.name + '...');
    try {
      if (file.name.toLowerCase().endsWith('.epub')) {
        await loadEpub(file);
      } else {
        await loadTxt(file);
      }
    } catch (err) {
      console.error('[Carga]', err);
      setStatus('Error cargando ' + file.name);
    }
    hideLoading();
  }
  e.target.value = '';
});

async function loadEpub(file) {
  const zip = await JSZip.loadAsync(file);
  let title  = file.name.replace(/\.epub$/i, '');
  let author = '';
  let chapters = [];

  // 1. Encontrar OPF via container.xml (más confiable que buscar por extensión)
  let opfPath = null;
  const containerFile = zip.files['META-INF/container.xml'];
  if (containerFile) {
    const containerXml = await containerFile.async('text');
    const m = containerXml.match(/full-path="([^"]+)"/i);
    if (m) opfPath = m[1];
  }
  if (!opfPath) {
    opfPath = Object.keys(zip.files).find(f => f.toLowerCase().endsWith('.opf'));
  }
  if (!opfPath) {
    // Fallback: EPUB muy roto, agarrar todo el HTML que haya
    return await loadEpubFallback(zip, title, file.name);
  }

  const opfText  = await zip.files[opfPath].async('text');
  const basePath = opfPath.includes('/')
    ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1)
    : '';

  // 2. Metadatos
  const titleMatch  = opfText.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
  const authorMatch = opfText.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);
  if (titleMatch)  title  = titleMatch[1].trim();
  if (authorMatch) author = authorMatch[1].trim();

  // 3. Manifest: id → { href, mediaType }
  const manifest = {};
  for (const m of opfText.matchAll(/<item\s[^>]*>/gi)) {
    const tag      = m[0];
    const idM      = tag.match(/\bid="([^"]+)"/);
    const hrefM    = tag.match(/\bhref="([^"]+)"/);
    const typeM    = tag.match(/\bmedia-type="([^"]+)"/);
    if (idM && hrefM) {
      manifest[idM[1]] = { href: hrefM[1], mediaType: typeM ? typeM[1] : '' };
    }
  }

  // 4. Spine (orden de lectura)
  const spineIds = [...opfText.matchAll(/idref="([^"]+)"/g)].map(m => m[1]);

  // 5. Títulos de capítulos desde NCX o NAV
  const chapterTitles = await extractChapterTitles(zip, manifest, basePath, spineIds);

  // 6. Parsear cada capítulo en el orden del spine
  let chapterCount = 0;
  for (let i = 0; i < spineIds.length; i++) {
    const item = manifest[spineIds[i]];
    if (!item) continue;

    const href     = item.href.split('#')[0];
    const fullPath = resolvePath(basePath, href);
    const htmlFile = zip.files[fullPath]
      || zip.files[Object.keys(zip.files).find(k => k.endsWith(href))];
    if (!htmlFile) continue;

    const rawHtml   = await htmlFile.async('text');
    const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (!bodyMatch) continue;

    const cleanHtml = cleanEpubHtml(bodyMatch[1]);
    if (!cleanHtml.trim()) continue;

    // Título: NCX/NAV primero, luego primer heading del capítulo, luego nada
    let chapterTitle = chapterTitles[i] || null;
    if (!chapterTitle) {
      const hMatch = cleanHtml.match(/<h[1-3][^>]*>\s*([^<]+)\s*<\/h[1-3]>/i);
      if (hMatch) chapterTitle = hMatch[1].trim();
    }

    chapters.push({ index: chapterCount++, title: chapterTitle, html: cleanHtml });
  }

  if (chapters.length === 0) {
    return await loadEpubFallback(zip, title, file.name);
  }

  await addBook(title, author, chapters);
}

// Extrae títulos desde NCX (EPUB2) o nav.xhtml (EPUB3)
async function extractChapterTitles(zip, manifest, basePath, spineIds) {
  const titles = {};

  // Buscar NCX
  const ncxItem = Object.values(manifest).find(
    item => item.href.endsWith('.ncx') || item.mediaType === 'application/x-dtbncx+xml'
  );

  if (ncxItem) {
    try {
      const ncxPath = resolvePath(basePath, ncxItem.href);
      const ncxFile = zip.files[ncxPath]
        || zip.files[Object.keys(zip.files).find(k => k.endsWith(ncxItem.href))];
      if (ncxFile) {
        const ncxText = await ncxFile.async('text');
        // Extraer navPoints: texto + src
        for (const m of ncxText.matchAll(/<navPoint[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content[^>]+src="([^"#]+)/g)) {
          const label = m[1].trim();
          const src   = m[2].split('/').pop().toLowerCase();
          // Buscar a qué índice del spine corresponde
          const idx = spineIds.findIndex(id => {
            const item = Object.values(manifest).find(i => i.href.split('/').pop().toLowerCase() === src);
            return item && Object.entries(manifest).find(([k,v]) => v === item && k === id);
          });
          // Fallback más simple: comparar nombre de archivo
          const spineIdx = spineIds.findIndex(id => {
            const item = manifest[id];
            return item && item.href.split('/').pop().split('#')[0].toLowerCase() === src;
          });
          if (spineIdx >= 0 && !titles[spineIdx]) titles[spineIdx] = label;
        }
      }
    } catch (e) {}
  }

  // Buscar NAV (EPUB3)
  const navItem = Object.entries(manifest).find(
    ([, item]) => item.mediaType === 'application/xhtml+xml' &&
                  (item.href.toLowerCase().includes('nav') || item.href.toLowerCase().includes('toc'))
  );

  if (navItem && Object.keys(titles).length === 0) {
    try {
      const navPath = resolvePath(basePath, navItem[1].href);
      const navFile = zip.files[navPath]
        || zip.files[Object.keys(zip.files).find(k => k.endsWith(navItem[1].href))];
      if (navFile) {
        const navText = await navFile.async('text');
        for (const m of navText.matchAll(/<a[^>]+href="([^"#]+)[^"]*"[^>]*>([^<]+)<\/a>/g)) {
          const src      = m[1].split('/').pop().toLowerCase();
          const label    = m[2].trim();
          const spineIdx = spineIds.findIndex(id => {
            const item = manifest[id];
            return item && item.href.split('/').pop().split('#')[0].toLowerCase() === src;
          });
          if (spineIdx >= 0 && !titles[spineIdx]) titles[spineIdx] = label;
        }
      }
    } catch (e) {}
  }

  return titles;
}

// Si el EPUB es demasiado raro, carga todo como un solo capítulo
async function loadEpubFallback(zip, title, filename) {
  let html = '';
  const htmlFiles = Object.keys(zip.files)
    .filter(f => /\.(html|htm|xhtml)$/i.test(f))
    .slice(0, 40);
  for (const f of htmlFiles) {
    const raw  = await zip.files[f].async('text');
    const body = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (body) html += body[1] + '\n';
  }
  const chapters = [{ index: 0, title: null, html: cleanEpubHtml(html) }];
  await addBook(title, '', chapters);
}

function resolvePath(base, href) {
  if (href.startsWith('/')) return href.slice(1);
  // Manejar ../ en hrefs
  const parts = (base + href).split('/');
  const resolved = [];
  for (const p of parts) {
    if (p === '..') resolved.pop();
    else if (p !== '.') resolved.push(p);
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
    .replace(/id="[^"]*"/gi, '')
    .replace(/style="[^"]*"/gi, '')
    .replace(/<\/?(?:html|head|body|meta|title)[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadTxt(file) {
  const text     = await file.text();
  const title    = file.name.replace(/\.txt$/i, '');
  const html     = text.split('\n')
    .filter(l => l.trim())
    .map(l => `<p>${escHtml(l.trim())}</p>`)
    .join('');
  const chapters = [{ index: 0, title: null, html }];
  await addBook(title, '', chapters);
}

async function addBook(title, author, chapters) {
  const id = state.nextId++;
  await dbPut('books', { id, title, author, chapters });
  state.books.push({ id, title, author });
  await savePref('nextId', state.nextId);
  await savePref('currentBookId', id);
  saveToDrive();
  renderSidebar();
  await selectBook(id);
  setStatus(`"${title}" cargado — ${chapters.length} capítulo${chapters.length !== 1 ? 's' : ''}`);
}

// ═══════════════════════════════════════════════════
//  SELECCIÓN Y APERTURA DE LIBROS
// ═══════════════════════════════════════════════════

async function selectBook(id) {
  state.currentBookId = id;
  await savePref('currentBookId', id);

  const book = state.books.find(b => b.id === id);
  if (!book) return;

  document.getElementById('book-title-display').textContent =
    book.title + (book.author ? ' — ' + book.author : '');

  renderSidebar();
  showTab('reader');

  showLoading('Abriendo libro...');
  try {
    const fullBook = await dbGet('books', id);
    if (fullBook && fullBook.chapters && fullBook.chapters.length > 0) {
      renderReader(fullBook);
      await restoreScrollPosition();
    } else if (fullBook && fullBook.html) {
      // Compatibilidad con formato viejo (sin capítulos)
      renderReader({ chapters: [{ index: 0, title: null, html: fullBook.html }] });
      await restoreScrollPosition();
    } else {
      document.getElementById('reader-view').innerHTML = `
        <div id="empty-reader" style="padding-top:60px;">
          Este libro fue encontrado en Google Drive pero su contenido<br>
          no está disponible en este dispositivo.<br><br>
          <strong style="color:var(--text)">Vuelve a subir el archivo EPUB o TXT para poder leerlo aquí.</strong>
        </div>`;
    }
  } catch (e) {
    console.error('[selectBook]', e);
  }
  hideLoading();
  renderHighlights();
}

// ═══════════════════════════════════════════════════
//  RENDERIZADO POR CAPÍTULOS (LAZY)
// ═══════════════════════════════════════════════════

function renderReader(book) {
  const view = document.getElementById('reader-view');
  view.innerHTML = '';
  renderedChapters.clear();
  currentChapterIndex = 0;

  // Soportar tanto formato nuevo (chapters[]) como viejo (html string)
  if (book.chapters && book.chapters.length > 0) {
    currentBookChapters = book.chapters;
  } else {
    currentBookChapters = [{ index: 0, title: null, html: book.html || '' }];
  }
  totalChapters = currentBookChapters.length;

  view.style.fontSize = prefs.fontSize + 'px';

  // Renderizar primer capítulo (y segundo si es corto)
  appendChapter(0);
  if (totalChapters > 1) appendChapter(1);

  updateProgress();
}

function appendChapter(idx) {
  if (idx < 0 || idx >= totalChapters) return;
  if (renderedChapters.has(idx)) return;

  const chapter = currentBookChapters[idx];
  const view    = document.getElementById('reader-view');

  const block         = document.createElement('div');
  block.className     = 'chapter-block';
  block.dataset.chapter = idx;

  // Encabezado si hay título
  if (chapter.title) {
    const header      = document.createElement('div');
    header.className  = 'chapter-header';
    header.textContent = `${idx + 1}. ${chapter.title}`;
    block.appendChild(header);
  }

  // Contenido del capítulo
  const content = document.createElement('div');
  content.innerHTML = chapter.html;
  block.appendChild(content);

  view.appendChild(block);
  renderedChapters.add(idx);

  // Aplicar highlights que caigan en este capítulo
  const bookHls = state.highlights.filter(h => h.bookId === state.currentBookId);
  bookHls.forEach(hl => {
    try { applyHighlightInBlock(hl, block); } catch (e) {}
  });
}

// ═══════════════════════════════════════════════════
//  HIGHLIGHTS
// ═══════════════════════════════════════════════════

function setColor(c) {
  currentColor = c;
  document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
  document.getElementById('color-' + c).classList.add('active');
}

// Selección de texto
document.addEventListener('mouseup', e => {
  if (e.target.closest('#sel-toolbar')) return;
  handleSelection();
});

document.addEventListener('touchend', e => {
  if (e.target.closest('#sel-toolbar')) return;
  setTimeout(handleSelection, 100);
});

document.addEventListener('mousedown', e => {
  if (!e.target.closest('#sel-toolbar')) hideSel();
});

function handleSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideSel(); return; }
  if (!document.getElementById('reader-view').contains(sel.anchorNode)) { hideSel(); return; }

  const range = sel.getRangeAt(0);
  const rect  = range.getBoundingClientRect();
  const tb    = document.getElementById('sel-toolbar');
  tb.style.display = 'flex';
  tb.style.left    = Math.max(8, rect.left + rect.width / 2 - 60) + 'px';
  tb.style.top     = (rect.top + window.scrollY - 52) + 'px';
}

function hideSel() {
  document.getElementById('sel-toolbar').style.display = 'none';
}

async function doHighlight() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().trim();
  if (!text || !state.currentBookId) return;

  try {
    const range = sel.getRangeAt(0);
    const id    = state.nextId++;
    const hl    = { id, bookId: state.currentBookId, text, note: '', color: currentColor, ts: Date.now() };

    wrapRangeWithHighlight(range, id, currentColor);
    state.highlights.push(hl);
    sel.removeAllRanges();

    await dbPut('highlights', hl);
    await savePref('nextId', state.nextId);
    saveToDrive();
    renderSidebar();
    setStatus('Subrayado guardado');
  } catch (e) {
    setStatus('Selecciona texto dentro de un mismo párrafo');
  }
  hideSel();
}

function wrapRangeWithHighlight(range, id, color) {
  const span        = document.createElement('span');
  span.className    = 'hl hl-' + color;
  span.dataset.hlId = id;
  span.title        = 'Clic para ver notas';
  span.onclick      = () => showTab('highlights');
  range.surroundContents(span);
}

// Aplica un highlight dentro de un bloque específico (un capítulo)
function applyHighlightInBlock(hl, block) {
  if (document.querySelector(`[data-hl-id="${hl.id}"]`)) return; // ya aplicado
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const idx = node.textContent.indexOf(hl.text);
    if (idx === -1) continue;
    if (node.parentElement.classList.contains('hl')) continue;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + hl.text.length);
    wrapRangeWithHighlight(range, hl.id, hl.color);
    break;
  }
}

// Aplica un highlight buscando en todo el reader (para highlights ya existentes al cargar)
function applyHighlightById(hl) {
  const view   = document.getElementById('reader-view');
  const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const idx = node.textContent.indexOf(hl.text);
    if (idx === -1) continue;
    if (node.parentElement.classList.contains('hl')) continue;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + hl.text.length);
    wrapRangeWithHighlight(range, hl.id, hl.color);
    break;
  }
}

async function deleteHighlight(id) {
  state.highlights = state.highlights.filter(h => h.id !== id);
  const span       = document.querySelector(`[data-hl-id="${id}"]`);
  if (span) {
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
  await dbDelete('highlights', id);
  saveToDrive();
  renderHighlights();
  renderSidebar();
  setStatus('Subrayado eliminado');
}

function renderHighlights() {
  const list    = document.getElementById('hl-list');
  list.innerHTML = '';

  const bookHls = state.highlights.filter(h => h.bookId === state.currentBookId);
  if (bookHls.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <strong>Sin subrayados aún</strong>
      Ve a Leer, selecciona texto y presiona Subrayar
    </div>`;
    return;
  }

  const colorSolid = { yellow:'#ca8a04', blue:'#2563eb', green:'#16a34a', pink:'#db2777' };
  const colorBg    = {
    yellow: 'rgba(253,224,71,0.30)',
    blue:   'rgba(147,197,253,0.35)',
    green:  'rgba(134,239,172,0.35)',
    pink:   'rgba(249,168,212,0.35)'
  };

  bookHls.sort((a, b) => a.ts - b.ts).forEach(h => {
    const card     = document.createElement('div');
    card.className = 'hl-card';
    card.innerHTML = `
      <div class="hl-card-inner">
        <div class="hl-strip" style="background:${colorSolid[h.color]||colorSolid.yellow};"></div>
        <div class="hl-card-body">
          <div class="hl-text" style="background:${colorBg[h.color]||colorBg.yellow};">${escHtml(h.text)}</div>
          <div class="hl-footer">
            <input class="hl-note" placeholder="Agregar nota..." value="${escHtml(h.note||'')}" data-id="${h.id}">
            <button class="hl-delete" data-id="${h.id}">Borrar</button>
          </div>
        </div>
      </div>`;
    list.appendChild(card);
  });

  list.querySelectorAll('.hl-note').forEach(input => {
    input.addEventListener('change', async e => {
      const id = parseInt(e.target.dataset.id, 10);
      const h  = state.highlights.find(h => h.id === id);
      if (h) {
        h.note = e.target.value;
        await dbPut('highlights', h);
        saveToDrive();
        setStatus('Nota guardada');
      }
    });
  });

  list.querySelectorAll('.hl-delete').forEach(btn => {
    btn.addEventListener('click', e => deleteHighlight(parseInt(e.target.dataset.id, 10)));
  });
}

// ═══════════════════════════════════════════════════
//  BOOKMARKS
// ═══════════════════════════════════════════════════

async function addBookmark() {
  if (!state.currentBookId) { setStatus('Primero abrí un libro'); return; }

  const content    = document.getElementById('content');
  const scrollTop  = content.scrollTop;
  const chapter    = currentBookChapters[currentChapterIndex];

  // Etiqueta automática basada en el capítulo actual
  let label;
  if (chapter && chapter.title) {
    label = `${currentChapterIndex + 1}. ${chapter.title}`;
  } else {
    label = `Capítulo ${currentChapterIndex + 1} de ${totalChapters}`;
  }

  const id = state.nextId++;
  const bm = {
    id,
    bookId:       state.currentBookId,
    chapterIndex: currentChapterIndex,
    scrollTop,
    label,
    ts: Date.now()
  };

  await dbPut('bookmarks', bm);
  await savePref('nextId', state.nextId);
  setStatus('🔖 Marcador guardado — ' + label);
}

async function renderBookmarks() {
  const section = document.getElementById('bookmarks-section');
  const list    = document.getElementById('bookmarks-list');

  let bookmarks = [];
  try {
    bookmarks = await dbGetByIndex('bookmarks', 'bookId', state.currentBookId);
  } catch (e) {}

  if (!bookmarks || bookmarks.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = '';

  bookmarks
    .sort((a, b) => a.chapterIndex - b.chapterIndex || a.scrollTop - b.scrollTop)
    .forEach(bm => {
      const div      = document.createElement('div');
      div.className  = 'bookmark-card';
      div.innerHTML  = `
        <span class="bookmark-label">${escHtml(bm.label)}</span>
        <div class="bookmark-actions">
          <button class="bookmark-goto" data-chapter="${bm.chapterIndex}" data-scroll="${bm.scrollTop}">Ir</button>
          <button class="bookmark-delete" data-id="${bm.id}">✕</button>
        </div>`;
      list.appendChild(div);
    });

  // Ir al marcador
  list.querySelectorAll('.bookmark-goto').forEach(btn => {
    btn.addEventListener('click', async e => {
      const chapterIdx = parseInt(e.target.dataset.chapter, 10);
      const scrollTop  = parseInt(e.target.dataset.scroll, 10);

      showTab('reader');

      // Asegurar que el capítulo destino esté renderizado
      for (let i = 0; i <= Math.min(chapterIdx + 1, totalChapters - 1); i++) {
        appendChapter(i);
      }

      setTimeout(() => {
        document.getElementById('content').scrollTop = scrollTop;
        updateProgress();
      }, 80);
    });
  });

  // Borrar marcador
  list.querySelectorAll('.bookmark-delete').forEach(btn => {
    btn.addEventListener('click', async e => {
      const id = parseInt(e.target.dataset.id, 10);
      await dbDelete('bookmarks', id);
      renderBookmarks();
      setStatus('Marcador eliminado');
    });
  });
}

// ═══════════════════════════════════════════════════
//  UI — TABS, SIDEBAR, EXPORT, STATUS
// ═══════════════════════════════════════════════════

function showTab(tab) {
  const tabs = document.querySelectorAll('.tab');
  tabs[0].classList.toggle('active', tab === 'reader');
  tabs[1].classList.toggle('active', tab === 'highlights');

  const readerView     = document.getElementById('reader-view');
  const highlightsView = document.getElementById('highlights-view');
  const content        = document.getElementById('content');

  if (tab === 'reader') {
    highlightsView.style.display = 'none';
    readerView.style.display     = 'block';
    // Restaurar scroll guardado al volver al lector
    setTimeout(() => {
      content.scrollTop = savedReaderScroll;
      updateProgress();
    }, 0);
  } else {
    // Guardar scroll en memoria antes de salir del lector
    savedReaderScroll = content.scrollTop;
    readerView.style.display     = 'none';
    highlightsView.style.display = 'flex';
    renderHighlights();
    renderBookmarks();
  }
}

// Estado inicial de tabs
document.getElementById('reader-view').style.display     = 'block';
document.getElementById('highlights-view').style.display = 'none';

function renderSidebar() {
  const list     = document.getElementById('book-list');
  list.innerHTML = '';

  if (state.books.length === 0) {
    list.innerHTML = '<p style="font-size:12px;color:#555;padding:16px 12px;line-height:1.6;">Sube un epub o txt para empezar</p>';
    return;
  }

  state.books.forEach(b => {
    const count    = state.highlights.filter(h => h.bookId === b.id).length;
    const div      = document.createElement('div');
    div.className  = 'book-item' + (b.id === state.currentBookId ? ' active' : '');
    div.onclick    = () => selectBook(b.id);
    div.innerHTML  = `
      <div class="book-title">${escHtml(b.title)}</div>
      <div class="book-meta">${count} subrayado${count !== 1 ? 's' : ''}</div>`;
    list.appendChild(div);
  });
}

function exportTxt() {
  const bookHls = state.highlights.filter(h => h.bookId === state.currentBookId);
  const book    = state.books.find(b => b.id === state.currentBookId);
  if (!bookHls.length) { setStatus('No hay subrayados para exportar'); return; }

  let txt = `SUBRAYADOS — ${book ? book.title.toUpperCase() : 'LIBRO'}\n${'═'.repeat(50)}\n\n`;
  bookHls.forEach((h, i) => {
    txt += `${i + 1}. "${h.text}"\n`;
    if (h.note) txt += `   → ${h.note}\n`;
    txt += '\n';
  });
  txt += `Exportado el ${new Date().toLocaleDateString('es-ES')}`;

  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'subrayados.txt'; a.click();
  URL.revokeObjectURL(url);
  setStatus('Archivo exportado');
}

let statusTimer = null;
function setStatus(msg) {
  const el        = document.getElementById('status-text');
  el.textContent  = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    // Si hay un libro activo, volver a mostrar el progreso
    if (state.currentBookId && totalChapters > 0) {
      updateProgress();
    } else {
      el.textContent = 'Listo';
    }
  }, 2500);
}

function showLoading(msg) {
  document.getElementById('loading-text').textContent = msg || 'Cargando...';
  document.getElementById('loading').style.display = 'flex';
}
function hideLoading() {
  document.getElementById('loading').style.display = 'none';
}

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
