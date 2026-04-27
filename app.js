/* ════════════════════════════════════════════════════════════════
   Mi Lector — app.js  (v4 — paginación robusta)

   Cambios principales vs v3:
   • Motor de paginación nuevo: el padding visual está en #reader-view
     (no en #page-content), y W/H de columnas se calculan a partir del
     padding-box interior del viewer. Esto elimina el bug de
     "múltiples columnas simultáneas" y la última línea tapada.
   • ResizeObserver: repagina al rotar iPad, redimensionar, etc.
   • Repaginación al volver a la pestaña Leer (si estuvo oculta).
   • Restauración de posición vía paragraph anchor (no pageIdx).
   • Highlights con paraIdx + texto (más robustos al re-paginar);
     fallback compatible con highlights viejos.
   • document.fonts.ready + 2x rAF antes de medir.
   • translate3d para forzar GPU acceleration en Safari.

   COMPATIBLE: esquemas de IndexedDB y Drive intactos.
   ════════════════════════════════════════════════════════════════ */
'use strict';

const CLIENT_ID   = '602238897882-g752d4mbev0d2leg8fvnq7lqt6jsof8l.apps.googleusercontent.com';
const SCOPES      = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE  = 'mi-lector-data.json';
const DB_NAME     = 'mi-lector-db';
const DB_VERSION  = 2;
const FONT_MIN    = 14;
const FONT_MAX    = 22;
const THEMES      = ['day', 'sepia', 'night'];
const THEME_ICONS = { day: '☀', sepia: '📜', night: '🌙' };

// ── Estado global ──
let state = { books: [], highlights: [], currentBookId: null, nextId: 1 };
let prefs = { theme: 'day', fontSize: 17 };

// ── Estado del libro abierto ──
let allParagraphs       = [];
let anchorMap           = {};   // { anchorId → paraIdx }  (links internos)
let fileChapterMap      = {};   // { filename → chapterIndex }
let chapterFirstPage    = {};   // { chapterIndex → pageIdx }
let paragraphPageMap    = {};   // { paraIdx → pageIdx }
let currentBookChapters = [];

// ── Estado de paginación ──
let pageWidth           = 0;    // ancho de columna = ancho interior del viewer
let pageHeight          = 0;    // alto de columna = alto interior del viewer
let totalPages          = 0;
let currentPageIdx      = 0;
let currentChapterIndex = 0;
let totalChapters       = 0;
let needsRepagination   = false;
let currentTab          = 'reader';

// ── UI ──
let currentColor        = 'yellow';

// ── Drive ──
let driveReady   = false;
let driveFileId  = null;
let tokenClient  = null;
let driveTimer   = null;
let saveTimer    = null;
let resizeTimer  = null;
let db;

// ════════════════════════════════════════════════════════════════
//  INDEXEDDB
// ════════════════════════════════════════════════════════════════

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('books'))      d.createObjectStore('books', { keyPath: 'id' });
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
    renderSidebar();
    setupNavigation();
    setupResizeObserver();
    setupFontsReadyHook();
    if (state.currentBookId) await selectBook(state.currentBookId);
    renderHighlights();
  } catch (e) {
    console.error('[Init]', e);
    setStatus('Error al iniciar — recargá la página');
  }
  hideLoading();
  loadGapiScript();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
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
    if (old.nextId)        await dbPut('prefs', { key: 'nextId', value: old.nextId });
    if (old.currentBookId) await dbPut('prefs', { key: 'currentBookId', value: old.currentBookId });
    localStorage.removeItem('mi_lector_v2');
  } catch (e) { /* migración silenciosa */ }
}

async function loadState() {
  const books      = await dbGetAll('books');
  state.books      = books.map(b => ({ id: b.id, title: b.title, author: b.author || '' }));
  state.highlights = await dbGetAll('highlights');
  const nid = await dbGet('prefs', 'nextId');         state.nextId        = nid ? nid.value : 1;
  const cur = await dbGet('prefs', 'currentBookId');  state.currentBookId = cur ? cur.value : null;
  const th  = await dbGet('prefs', 'theme');          prefs.theme         = th  ? th.value  : 'day';
  const fs  = await dbGet('prefs', 'fontSize');       prefs.fontSize      = fs  ? fs.value  : 17;
}

async function savePref(key, value) {
  try { await dbPut('prefs', { key, value }); } catch (e) {}
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

async function changeFontSize(delta) {
  const old = prefs.fontSize;
  prefs.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, prefs.fontSize + delta));
  if (prefs.fontSize === old) return;

  document.getElementById('page-content').style.fontSize = prefs.fontSize + 'px';
  savePref('fontSize', prefs.fontSize);
  updateFontBtns();

  if (allParagraphs.length) {
    // Repagina conservando el párrafo visible
    await paginate({ keepAnchor: true });
  }
}

function updateFontBtns() {
  const m = document.getElementById('btn-font-minus');
  const p = document.getElementById('btn-font-plus');
  if (m) m.disabled = prefs.fontSize <= FONT_MIN;
  if (p) p.disabled = prefs.fontSize >= FONT_MAX;
}

/* Cuando las fuentes web (Lora/DM Sans) terminan de cargar
   después del primer paint, re-paginamos para asegurarnos
   de que las medidas estén correctas. */
function setupFontsReadyHook() {
  if (!document.fonts || !document.fonts.ready) return;
  document.fonts.ready.then(() => {
    if (allParagraphs.length && currentTab === 'reader') {
      paginate({ keepAnchor: true });
    }
  });
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

function initDrive() {
  if (!window.google) { setStatus('Cargando Google...'); setTimeout(initDrive, 1500); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID, scope: SCOPES,
    callback: async resp => {
      if (resp.error) { setStatus('Error al conectar Drive'); return; }
      driveReady = true;
      document.getElementById('drive-btn').textContent = 'Drive conectado';
      document.getElementById('drive-btn').classList.add('connected');
      document.getElementById('drive-dot').classList.add('connected');
      document.getElementById('drive-status-text').textContent = 'Google Drive activo';
      setStatus('Conectado — sincronizando...');
      await syncFromDrive();
    }
  });
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

async function syncFromDrive() {
  showLoading('Sincronizando con Drive...');
  try {
    const res   = await gapi.client.drive.files.list({
      spaces: 'appDataFolder', q: `name='${DRIVE_FILE}'`, fields: 'files(id,name)'
    });
    const files = res.result.files;
    if (files && files.length > 0) {
      driveFileId   = files[0].id;
      const content = await gapi.client.drive.files.get({ fileId: driveFileId, alt: 'media' });
      await mergeState(JSON.parse(content.body));
      renderSidebar(); renderHighlights();
      setStatus('Sincronizado con Drive');
    } else {
      await saveToDrive();
      setStatus('Datos guardados en Drive');
    }
  } catch (e) {
    console.error('[Drive sync]', e);
    setStatus('Error sincronizando — datos locales disponibles');
  }
  hideLoading();
}

async function mergeState(remote) {
  const hlIds   = new Set(state.highlights.map(h => h.id));
  const bookIds = new Set(state.books.map(b => b.id));
  for (const h of (remote.highlights || [])) {
    if (!hlIds.has(h.id)) { state.highlights.push(h); await dbPut('highlights', h); }
  }
  for (const b of (remote.books || [])) {
    if (!bookIds.has(b.id)) {
      state.books.push({ id: b.id, title: b.title, author: b.author || '' });
      await dbPut('books', {
        id: b.id, title: b.title, author: b.author || '',
        chapters: [], coverBase64: null
      });
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
          path: `/upload/drive/v3/files/${driveFileId}`,
          method: 'PATCH', params: { uploadType: 'media' }, body: payload
        });
      } else {
        const meta = await gapi.client.drive.files.create({
          resource: { name: DRIVE_FILE, parents: ['appDataFolder'] }, fields: 'id'
        });
        driveFileId = meta.result.id;
        await gapi.client.request({
          path: `/upload/drive/v3/files/${driveFileId}`,
          method: 'PATCH', params: { uploadType: 'media' }, body: payload
        });
      }
      const ind = document.getElementById('sync-indicator');
      ind.textContent = 'Guardado ✓';
      setTimeout(() => { ind.textContent = ''; }, 2000);
    } catch (e) { console.error('[saveToDrive]', e); }
  }, 1200);
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

  if (!chapters.length) { await loadEpubFallback(zip, title); return; }
  await addBook(title, author, chapters, coverBase64);
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
  if (!Object.keys(titles).length) {
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
  return titles;
}

async function loadEpubFallback(zip, title) {
  let html = '';
  const fs = Object.keys(zip.files).filter(f => /\.(html|htm|xhtml)$/i.test(f)).slice(0, 40);
  for (const f of fs) {
    const raw = await zip.files[f].async('text');
    const body = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (body) html += body[1] + '\n';
  }
  await addBook(title, '', [{ index: 0, title: null, html: cleanEpubHtml(html), filename: '' }], null);
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
  await addBook(title, '', [{ index: 0, title: null, html, filename: '' }], null);
}

async function addBook(title, author, chapters, coverBase64) {
  const id = state.nextId++;
  await dbPut('books', { id, title, author, chapters, coverBase64: coverBase64 || null });
  state.books.push({ id, title, author });
  await savePref('nextId', state.nextId);
  await savePref('currentBookId', id);
  saveToDrive();
  renderSidebar();
  await selectBook(id);
  setStatus(`"${title}" cargado — ${chapters.length} capítulo${chapters.length !== 1 ? 's' : ''}`);
}

// ════════════════════════════════════════════════════════════════
//  SELECCIÓN Y APERTURA DE LIBRO
// ════════════════════════════════════════════════════════════════

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
    const full = await dbGet('books', id);
    if (full && full.chapters && full.chapters.length) {
      await openBook(full);
    } else if (full && full.html) {
      // Migración legacy
      await openBook({
        chapters: [{ index: 0, title: null, html: full.html, filename: '' }]
      });
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

async function openBook(fullBook) {
  currentBookChapters = fullBook.chapters;
  totalChapters       = currentBookChapters.length;
  buildParagraphArray(currentBookChapters);
  renderChapterSidebar();

  // Marcar el reader-view como "tiene libro" → habilita zonas tappables y oculta empty state
  document.getElementById('reader-view').classList.add('has-book');

  // Forzar re-render del HTML en el page-content
  const container = document.getElementById('page-content');
  container.dataset.rendered = '';
  container.dataset.bookId = '';

  showLoading('Preparando libro...');
  await paginate({ keepAnchor: false });
  hideLoading();
  await restorePosition();
}

function mountEmptyBook(msg) {
  document.getElementById('reader-view').classList.remove('has-book');
  document.getElementById('empty-reader').innerHTML = msg.replace(/\n/g, '<br>');
  const container = document.getElementById('page-content');
  container.innerHTML = '';
  container.dataset.rendered = '';
  container.dataset.bookId = '';
  clearNavState();
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
//  ▼▼▼  MOTOR DE PAGINACIÓN  ▼▼▼
// ════════════════════════════════════════════════════════════════

/**
 * Recalcula la paginación del libro abierto.
 * @param {Object}  opts
 * @param {boolean} opts.keepAnchor - si true, conserva el párrafo visible al repaginar
 */
async function paginate(opts) {
  opts = opts || {};
  const viewer    = document.getElementById('reader-view');
  const clip      = document.getElementById('page-clip');
  const container = document.getElementById('page-content');

  if (!allParagraphs.length || !currentBookChapters.length) {
    viewer.classList.remove('has-book');
    return;
  }

  // Si el viewer no es visible (display:none), aplazar.
  if (viewer.offsetWidth === 0 || viewer.offsetHeight === 0) {
    needsRepagination = true;
    return;
  }

  // 1. Capturar párrafo ancla (si aplica) ANTES de modificar nada
  let anchorIdx = null;
  if (opts.keepAnchor) anchorIdx = getFirstVisibleParaIdx();

  // 2. Esperar fuentes
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch (e) {}
  }

  // 3. Reset transform y transición ANTES de medir
  container.style.transition = 'none';
  container.style.transform  = 'translate3d(0,0,0)';

  // 4. Esperar a que el reflow se asiente
  await waitForLayout();

  // 5. Medir el padding-box interior del viewer
  const inner = getViewerInnerSize(viewer);
  if (inner.W <= 0 || inner.H <= 0) { needsRepagination = true; return; }

  pageWidth  = inner.W;
  pageHeight = inner.H;

  // 6. Aplicar dimensiones EXACTAS al CLIP (la "ventana" de una página)
  //    y al CONTENT (column-width = mismo ancho que el clip)
  clip.style.width        = inner.W + 'px';
  clip.style.height       = inner.H + 'px';
  clip.style.right        = 'auto';   // override del CSS por defecto
  clip.style.bottom       = 'auto';
  container.style.fontSize    = prefs.fontSize + 'px';
  container.style.columnWidth = inner.W + 'px';
  // height/width del container vienen del CSS (100%/100%)

  // 7. Renderizar HTML del libro (si no se hizo ya, o si cambió de libro)
  const bookKey = String(state.currentBookId);
  if (container.dataset.rendered !== '1' || container.dataset.bookId !== bookKey) {
    renderBookHTML(container);
    container.dataset.rendered = '1';
    container.dataset.bookId = bookKey;
  }

  // 8. Esperar reflow tras inyectar HTML/cambiar dimensiones
  await waitForLayout();

  // 9. Calcular total de páginas — el container ahora es width:100% pero el
  //    contenido en column layout se extiende horizontalmente; usamos
  //    scrollWidth que reporta el ancho TOTAL del column flow.
  totalPages = Math.max(1, Math.ceil((container.scrollWidth - 1) / pageWidth));

  // 10. Construir mapas paragraph→page y chapter→page (solo headers chapter
  //     son baratos; paragraphPageMap se construye lazy si hace falta)
  buildChapterPageMap(container);
  paragraphPageMapBuilt = false;

  // 11. Aplicar highlights guardados
  applyHighlightsToContent();

  // 12. Decidir página destino
  let target = currentPageIdx;
  if (anchorIdx != null) {
    const tp = paragraphToPage(anchorIdx, container);
    if (tp != null) target = tp;
  } else {
    target = Math.min(currentPageIdx, totalPages - 1);
  }
  if (target < 0) target = 0;

  goToPage(target, true);
  needsRepagination = false;
}

function getViewerInnerSize(viewer) {
  const cs = getComputedStyle(viewer);
  const padTop    = parseFloat(cs.paddingTop)    || 0;
  const padBottom = parseFloat(cs.paddingBottom) || 0;
  const padLeft   = parseFloat(cs.paddingLeft)   || 0;
  const padRight  = parseFloat(cs.paddingRight)  || 0;
  // Math.floor para garantizar que el contenido no se desborda por subpíxeles
  return {
    W: Math.floor(viewer.clientWidth  - padLeft - padRight),
    H: Math.floor(viewer.clientHeight - padTop  - padBottom)
  };
}

function waitForLayout() {
  return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

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

/* paragraphPageMap se construye PEREZOSAMENTE: solo cuando alguien
   pregunta "en qué página está el párrafo X" (bookmarks goto, links
   internos, restorePosition, repaginación tras cambio de fuente).
   Esto ahorra ~10000 reads de getBoundingClientRect en libros largos. */
let paragraphPageMapBuilt = false;

function buildParagraphPageMap(container) {
  paragraphPageMap = {};
  if (!container) container = document.getElementById('page-content');
  const W = pageWidth;
  if (W <= 0) return;
  // offsetLeft es relativo al offsetParent. Como el container tiene
  // contain:layout, suele ser su propio offsetParent — pero por seguridad
  // usamos el rect del container como referencia.
  const containerRect = container.getBoundingClientRect();
  container.querySelectorAll('[data-para-idx]').forEach(el => {
    const idx = parseInt(el.dataset.paraIdx, 10);
    const rect = el.getBoundingClientRect();
    const offsetX = rect.left - containerRect.left;
    paragraphPageMap[idx] = Math.max(0, Math.floor(offsetX / W));
  });
  paragraphPageMapBuilt = true;
}

/* Versión barata: solo busca un párrafo específico en lugar de
   construir el mapa completo. Si el mapa ya está construido lo usa. */
function paragraphToPage(paraIdx, container) {
  if (paragraphPageMapBuilt) return paragraphPageMap[paraIdx];
  if (!container) container = document.getElementById('page-content');
  const el = container.querySelector(`[data-para-idx="${paraIdx}"]`);
  if (!el || pageWidth <= 0) return null;
  const containerRect = container.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const offsetX = rect.left - containerRect.left;
  // Si el container tiene transform aplicado, eso afecta su rect — pero
  // como el rect del child también está afectado por el mismo transform,
  // la diferencia (offsetX) es invariante. ✓
  return Math.max(0, Math.floor(offsetX / pageWidth));
}

function buildChapterPageMap(container) {
  chapterFirstPage = { 0: 0 };
  const containerRect = container.getBoundingClientRect();
  const W = pageWidth;
  if (W <= 0) return;
  container.querySelectorAll('[data-chapter]').forEach(el => {
    const ci = parseInt(el.dataset.chapter, 10);
    const rect = el.getBoundingClientRect();
    const offsetX = rect.left - containerRect.left;
    if (!(ci in chapterFirstPage)) {
      chapterFirstPage[ci] = Math.max(0, Math.floor(offsetX / W));
    }
  });
}

/* Devuelve el paraIdx del primer párrafo visible en la página actual.
   Usa elementFromPoint = O(1) en lugar de iterar todos los párrafos. */
function getFirstVisibleParaIdx() {
  const clip = document.getElementById('page-clip');
  if (!clip) return null;
  const r = clip.getBoundingClientRect();
  if (r.width < 5 || r.height < 5) return null;
  // Punto un poco hacia adentro del borde superior izquierdo del clip.
  // Suficiente para caer dentro del primer párrafo visible.
  const x = r.left + 8;
  const y = r.top + 8;
  let el = document.elementFromPoint(x, y);
  if (!el) return null;
  // Subir hasta encontrar un elemento con data-para-idx
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.paraIdx !== undefined) {
      return parseInt(el.dataset.paraIdx, 10);
    }
    el = el.parentElement;
  }
  // Fallback: probar un punto un poco más adentro (por si hay margins)
  el = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.paraIdx !== undefined) {
      return parseInt(el.dataset.paraIdx, 10);
    }
    el = el.parentElement;
  }
  return null;
}

function clearNavState() {
  currentPageIdx = 0; currentChapterIndex = 0; totalPages = 0;
  allParagraphs = []; paragraphPageMap = {}; chapterFirstPage = {};
  currentBookChapters = []; totalChapters = 0;
  const c = document.getElementById('page-content');
  c.style.transition = 'none';
  c.style.transform  = 'translate3d(0,0,0)';
  updateNavButtons(); updateStatusBar();
  document.getElementById('chapter-section').classList.remove('visible');
}

// ════════════════════════════════════════════════════════════════
//  NAVEGACIÓN
// ════════════════════════════════════════════════════════════════

function goToPage(idx, skipTransition) {
  if (!totalPages) return;
  idx = Math.max(0, Math.min(idx, totalPages - 1));
  currentPageIdx = idx;

  const container = document.getElementById('page-content');
  container.style.transition = skipTransition ? 'none' : 'transform 0.18s ease';
  container.style.transform  = `translate3d(${-idx * pageWidth}px, 0, 0)`;

  currentChapterIndex = computeCurrentChapter(idx);
  updateStatusBar();
  updateNavButtons();
  updateChapterSidebar();

  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePosition, 600);
}

function computeCurrentChapter(pageIdx) {
  let ch = 0;
  for (const ciStr in chapterFirstPage) {
    const ci = parseInt(ciStr, 10);
    if (chapterFirstPage[ci] <= pageIdx && ci > ch) ch = ci;
  }
  return ch;
}

function nextPage() { if (currentPageIdx < totalPages - 1) goToPage(currentPageIdx + 1); }
function prevPage() { if (currentPageIdx > 0)              goToPage(currentPageIdx - 1); }

function goToChapter(ci) {
  for (let i = ci; i < totalChapters; i++) {
    if (chapterFirstPage[i] !== undefined) { goToPage(chapterFirstPage[i]); return; }
  }
  for (let i = ci - 1; i >= 0; i--) {
    if (chapterFirstPage[i] !== undefined) { goToPage(chapterFirstPage[i]); return; }
  }
}

function setupNavigation() {
  const viewer = document.getElementById('reader-view');

  // Wheel: cambia página, no scrollea
  let wheelLock = false;
  viewer.addEventListener('wheel', e => {
    e.preventDefault();
    if (wheelLock) return;
    wheelLock = true;
    setTimeout(() => { wheelLock = false; }, 220);
    if (e.deltaY > 0 || e.deltaX > 0) nextPage();
    else                              prevPage();
  }, { passive: false });

  // Bloquear scroll/touch nativo dentro del reader
  viewer.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

  // Swipe horizontal en touch
  let tx = 0, ty = 0, tt = 0;
  viewer.addEventListener('touchstart', e => {
    tx = e.touches[0].clientX;
    ty = e.touches[0].clientY;
    tt = Date.now();
  }, { passive: true });
  viewer.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx;
    const dy = e.changedTouches[0].clientY - ty;
    const dt = Date.now() - tt;
    // Si fue un tap rápido sin desplazamiento, dejamos que la zona tappable lo maneje
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 250) return;
    if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 45) {
      if (dx < 0) nextPage();
      else        prevPage();
    }
  }, { passive: true });

  // Teclado (sólo en pestaña Leer y fuera de inputs)
  document.addEventListener('keydown', e => {
    if (currentTab !== 'reader') return;
    const t = e.target;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    if (['ArrowRight','ArrowDown','PageDown',' '].includes(e.key)) { e.preventDefault(); nextPage(); }
    if (['ArrowLeft', 'ArrowUp',  'PageUp'].includes(e.key))       { e.preventDefault(); prevPage(); }
  });
}

/* ResizeObserver: repagina cuando el viewer cambia de tamaño
   (rotación de iPad, redimensionar ventana, mostrar/ocultar sidebar...) */
function setupResizeObserver() {
  if (!('ResizeObserver' in window)) return;
  const viewer = document.getElementById('reader-view');
  let lastW = 0, lastH = 0;
  const ro = new ResizeObserver(entries => {
    const cr = entries[0].contentRect;
    if (Math.abs(cr.width - lastW) < 1 && Math.abs(cr.height - lastH) < 1) return;
    lastW = cr.width; lastH = cr.height;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      if (allParagraphs.length && currentTab === 'reader') {
        await paginate({ keepAnchor: true });
      }
    }, 120);
  });
  ro.observe(viewer);
}

function updateNavButtons() {
  const prev = document.getElementById('btn-prev');
  const next = document.getElementById('btn-next');
  if (!prev || !next) return;
  prev.disabled = currentPageIdx <= 0 || !totalPages;
  next.disabled = currentPageIdx >= totalPages - 1 || !totalPages;
}

function updateStatusBar() {
  if (!totalPages) { setStatusDirect('Listo'); return; }
  const ch = currentBookChapters[currentChapterIndex];
  const cl = ch && ch.title
    ? `${currentChapterIndex + 1}. ${ch.title}`
    : `Cap. ${currentChapterIndex + 1} de ${totalChapters}`;
  setStatusDirect(`${cl} · Pág. ${currentPageIdx + 1} de ${totalPages}`);
}

// ── Hyperlinks internos ──
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
  if (pi >= 0) {
    const tp = paragraphToPage(pi);
    if (tp != null) goToPage(tp);
  }
}

// ── Sidebar de capítulos ──
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
  const active = document.querySelector('.chapter-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

// ════════════════════════════════════════════════════════════════
//  POSICIÓN GUARDADA
// ════════════════════════════════════════════════════════════════

async function savePosition() {
  if (!state.currentBookId || !totalPages) return;
  const anchorParaIdx = getFirstVisibleParaIdx();
  await savePref(`pos_${state.currentBookId}`, {
    pageIdx: currentPageIdx,
    chapterIndex: currentChapterIndex,
    fontSize: prefs.fontSize,
    anchorParaIdx: anchorParaIdx
  });
}

async function restorePosition() {
  const rec = await dbGet('prefs', `pos_${state.currentBookId}`);
  if (!rec || !rec.value || !totalPages) { goToPage(0, true); return; }
  // Preferir anchorParaIdx (sobrevive a cambios de fuente)
  if (rec.value.anchorParaIdx != null) {
    const tp = paragraphToPage(rec.value.anchorParaIdx);
    if (tp != null) { goToPage(tp, true); return; }
  }
  // Fallback a pageIdx
  goToPage(Math.min(rec.value.pageIdx || 0, totalPages - 1), true);
}

// ════════════════════════════════════════════════════════════════
//  BOOKMARKS
// ════════════════════════════════════════════════════════════════

async function addBookmark() {
  if (!state.currentBookId || !totalPages) { setStatus('Primero abrí un libro'); return; }
  const ch      = currentBookChapters[currentChapterIndex];
  const chapStr = ch && ch.title
    ? `${currentChapterIndex + 1}. ${ch.title}`
    : `Cap. ${currentChapterIndex + 1}`;
  const label   = `${chapStr} · Pág. ${currentPageIdx + 1}`;
  const anchor  = getFirstVisibleParaIdx();
  const id      = state.nextId++;
  await dbPut('bookmarks', {
    id, bookId: state.currentBookId,
    pageIdx: currentPageIdx,
    anchorParaIdx: anchor != null ? anchor : 0,
    label,
    ts: Date.now()
  });
  await savePref('nextId', state.nextId);
  setStatus('🔖 ' + label);
}

async function renderBookmarks() {
  const section = document.getElementById('bookmarks-section');
  const list    = document.getElementById('bookmarks-list');
  const bms     = await dbGetByIndex('bookmarks', 'bookId', state.currentBookId).catch(() => []);
  if (!bms || !bms.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.innerHTML = '';
  bms.sort((a, b) => a.pageIdx - b.pageIdx).forEach(bm => {
    const div = document.createElement('div');
    div.className = 'bookmark-card';
    div.innerHTML = `
      <span class="bookmark-label">${escHtml(bm.label)}</span>
      <div class="bookmark-actions">
        <button class="bookmark-goto" data-para="${bm.anchorParaIdx}" data-page="${bm.pageIdx}">Ir</button>
        <button class="bookmark-delete" data-id="${bm.id}">✕</button>
      </div>`;
    list.appendChild(div);
  });
  list.querySelectorAll('.bookmark-goto').forEach(btn => {
    btn.addEventListener('click', () => {
      showTab('reader');
      // Esperar al próximo frame para asegurarse de que el reader-view es visible
      requestAnimationFrame(() => {
        const para = parseInt(btn.dataset.para, 10);
        let target = paragraphToPage(para);
        if (target == null) target = parseInt(btn.dataset.page, 10);
        goToPage(Math.min(target, totalPages - 1));
      });
    });
  });
  list.querySelectorAll('.bookmark-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      await dbDelete('bookmarks', parseInt(btn.dataset.id, 10));
      renderBookmarks();
      setStatus('Marcador eliminado');
    });
  });
}

// ════════════════════════════════════════════════════════════════
//  HIGHLIGHTS
// ════════════════════════════════════════════════════════════════

function setColor(c) {
  currentColor = c;
  document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
  document.getElementById('color-' + c).classList.add('active');
}

/* Encuentra el ancestro con data-para-idx (un párrafo) — null si no hay. */
function findParaAncestor(node) {
  if (!node) return null;
  let cur = node.nodeType === 1 ? node : node.parentElement;
  while (cur && cur !== document.body) {
    if (cur.dataset && cur.dataset.paraIdx !== undefined) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/* Si la selección actual cruza párrafos (por arrastre fuera de la página
   visible — todo el libro está en el DOM), recortarla al final del primer
   párrafo seleccionado. Esto evita el caso "seleccioné todo el libro". */
function clampSelectionToOnePara() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);

  const pageContent = document.getElementById('page-content');
  if (!pageContent || !pageContent.contains(range.commonAncestorContainer)) return;

  const startPara = findParaAncestor(range.startContainer);
  const endPara   = findParaAncestor(range.endContainer);

  if (!startPara || !endPara) return;
  if (startPara === endPara) return;  // selección en un solo párrafo, todo bien

  // Cruza párrafos — truncar al final del startPara
  const newRange = document.createRange();
  newRange.setStart(range.startContainer, range.startOffset);
  // Buscar el último nodo de texto del startPara
  const walker = document.createTreeWalker(startPara, NodeFilter.SHOW_TEXT);
  let lastText = null, n;
  while ((n = walker.nextNode())) lastText = n;
  if (lastText) {
    newRange.setEnd(lastText, lastText.textContent.length);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
}

document.addEventListener('mouseup', e => {
  if (e.target.closest('#sel-toolbar')) return;
  // Truncar primero, luego mostrar toolbar con la selección final
  clampSelectionToOnePara();
  handleSel();
});
document.addEventListener('touchend', e => {
  if (e.target.closest('#sel-toolbar')) return;
  setTimeout(() => { clampSelectionToOnePara(); handleSel(); }, 120);
});
document.addEventListener('mousedown', e => {
  if (!e.target.closest('#sel-toolbar')) hideSel();
});

function handleSel() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideSel(); return; }
  if (!document.getElementById('page-content').contains(sel.anchorNode)) { hideSel(); return; }
  const range = sel.getRangeAt(0), rect = range.getBoundingClientRect();
  const tb = document.getElementById('sel-toolbar');
  tb.style.display = 'flex';
  tb.style.left    = Math.max(8, rect.left + rect.width / 2 - 60) + 'px';
  tb.style.top     = (rect.top + window.scrollY - 52) + 'px';
}

function hideSel() { document.getElementById('sel-toolbar').style.display = 'none'; }

async function doHighlight() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().trim();
  if (!text || !state.currentBookId) return;

  try {
    const range = sel.getRangeAt(0);

    // Extraer paraIdx del párrafo donde inicia la selección
    let pNode = range.startContainer;
    while (pNode && (pNode.nodeType !== 1 || !pNode.hasAttribute || !pNode.hasAttribute('data-para-idx'))) {
      pNode = pNode.parentNode;
    }
    const paraIdx = pNode && pNode.dataset && pNode.dataset.paraIdx !== undefined
      ? parseInt(pNode.dataset.paraIdx, 10) : null;

    const id = state.nextId++;
    const hl = {
      id, bookId: state.currentBookId,
      text, note: '', color: currentColor, ts: Date.now(),
      paraIdx: (paraIdx != null && !isNaN(paraIdx)) ? paraIdx : undefined
    };

    wrapRange(range, id, currentColor);
    state.highlights.push(hl);
    sel.removeAllRanges();

    await dbPut('highlights', hl);
    await savePref('nextId', state.nextId);
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

/* Aplica todos los highlights del libro al DOM ya renderizado.
   Estrategia:
     1. Si el highlight tiene paraIdx → busca dentro de ese párrafo (preciso).
     2. Si no, fallback: busca el texto en cualquier nodo (compat con highlights viejos). */
function applyHighlightsToContent() {
  const container = document.getElementById('page-content');
  if (!container) return;
  const bookHls = state.highlights.filter(h => h.bookId === state.currentBookId);

  for (const hl of bookHls) {
    if (container.querySelector(`[data-hl-id="${hl.id}"]`)) continue;
    let applied = false;

    // Estrategia 1 — paraIdx (highlights nuevos)
    if (hl.paraIdx !== undefined && hl.paraIdx !== null) {
      const paraEl = container.querySelector(`[data-para-idx="${hl.paraIdx}"]`);
      if (paraEl && paraEl.textContent.includes(hl.text)) {
        applied = wrapTextInElement(paraEl, hl.text, hl.id, hl.color);
      }
    }

    // Estrategia 2 — fallback global (highlights viejos / texto movido)
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
    return;
  }
  const cs = { yellow:'#ca8a04', blue:'#2563eb', green:'#16a34a', pink:'#db2777' };
  const cb = {
    yellow:'rgba(253,224,71,0.30)',
    blue:'rgba(147,197,253,0.35)',
    green:'rgba(134,239,172,0.35)',
    pink:'rgba(249,168,212,0.35)'
  };
  bhs.sort((a, b) => a.ts - b.ts).forEach(h => {
    const card = document.createElement('div');
    card.className = 'hl-card';
    card.innerHTML = `
      <div class="hl-card-inner">
        <div class="hl-strip" style="background:${cs[h.color]||cs.yellow};"></div>
        <div class="hl-card-body">
          <div class="hl-text" style="background:${cb[h.color]||cb.yellow};">${escHtml(h.text)}</div>
          <div class="hl-footer">
            <input class="hl-note" placeholder="Agregar nota..." value="${escHtml(h.note||'')}" data-id="${h.id}">
            <button class="hl-delete" data-id="${h.id}">Borrar</button>
          </div>
        </div>
      </div>`;
    list.appendChild(card);
  });
  list.querySelectorAll('.hl-note').forEach(inp => {
    inp.addEventListener('change', async e => {
      const h = state.highlights.find(h => h.id === parseInt(e.target.dataset.id, 10));
      if (h) {
        h.note = e.target.value;
        await dbPut('highlights', h);
        saveToDrive();
        setStatus('Nota guardada');
      }
    });
  });
  list.querySelectorAll('.hl-delete').forEach(btn =>
    btn.addEventListener('click', e => deleteHighlight(parseInt(e.target.dataset.id, 10))));
}

// ════════════════════════════════════════════════════════════════
//  BORRAR / LIBERAR LIBRO
// ════════════════════════════════════════════════════════════════

async function deleteBook(bookId) {
  const book = state.books.find(b => b.id === bookId);
  if (!book || !confirm(`¿Borrar "${book.title}" y todos sus subrayados?\n\nEsta acción no se puede deshacer.`)) return;
  await dbDelete('books', bookId);
  await dbDeleteAllByIndex('highlights', 'bookId', bookId);
  await dbDeleteAllByIndex('bookmarks',  'bookId', bookId);
  await dbDelete('prefs', `pos_${bookId}`);
  state.books      = state.books.filter(b => b.id !== bookId);
  state.highlights = state.highlights.filter(h => h.bookId !== bookId);
  if (state.currentBookId === bookId) {
    state.currentBookId = null;
    await savePref('currentBookId', null);
    clearNavState();
    mountEmptyBook('Sube un libro para empezar.');
    document.getElementById('book-title-display').textContent = 'Mi Lector';
    document.getElementById('chapter-section').classList.remove('visible');
  }
  saveToDrive();
  renderSidebar();
  renderHighlights();
  setStatus(`"${book.title}" eliminado`);
}

async function freeBookSpace(bookId) {
  const book = state.books.find(b => b.id === bookId);
  if (!book || !confirm(`¿Liberar el espacio de "${book.title}"?\n\nEl contenido se eliminará de este dispositivo, pero tus subrayados se mantienen en Drive.`)) return;
  const full = await dbGet('books', bookId);
  if (!full) return;
  await dbPut('books', { ...full, chapters: [], coverBase64: null });
  if (state.currentBookId === bookId) {
    clearNavState();
    mountEmptyBook('Contenido liberado.<br><br><strong style="color:var(--text)">Volvé a subir el EPUB para leer.</strong>');
    document.getElementById('chapter-section').classList.remove('visible');
  }
  setStatus('Espacio liberado — subrayados conservados');
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
    card.innerHTML = `
      <div class="book-cover" onclick="selectBook(${book.id})">
        ${coverHtml}${!hasCnt ? '<div class="no-content-badge">Sin contenido</div>' : ''}
      </div>
      <div class="book-card-info">
        <div class="book-card-title" title="${escHtml(book.title)}">${escHtml(book.title)}</div>
        ${book.author ? `<div class="book-card-author">${escHtml(book.author)}</div>` : ''}
        <div class="book-card-meta">${prog}<br>${hlc} subrayado${hlc !== 1 ? 's' : ''}</div>
      </div>
      <div class="book-card-actions">
        <button class="btn-card btn-card-open"   onclick="selectBook(${book.id})">Abrir</button>
        <button class="btn-card btn-card-free"   onclick="freeBookSpace(${book.id})" ${!hasCnt ? 'disabled' : ''}>Liberar</button>
        <button class="btn-card btn-card-delete" onclick="deleteBook(${book.id})">🗑</button>
      </div>`;
    grid.appendChild(card);
  }
}

// ════════════════════════════════════════════════════════════════
//  UI — TABS
// ════════════════════════════════════════════════════════════════

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t, i) =>
    t.classList.toggle('active', ['reader','highlights','library'][i] === tab));
  document.getElementById('reader-view').style.display     = tab === 'reader'     ? 'block' : 'none';
  document.getElementById('highlights-view').style.display = tab === 'highlights' ? 'flex'  : 'none';
  document.getElementById('library-view').style.display    = tab === 'library'    ? 'flex'  : 'none';

  if (tab === 'highlights') { renderHighlights(); renderBookmarks(); }
  if (tab === 'library')    renderLibrary();
  if (tab === 'reader' && allParagraphs.length) {
    // Si la paginación quedó pendiente porque el viewer estaba oculto, hacerla ahora.
    // También nos protegemos de cambios de tamaño que ocurrieron mientras el reader
    // estaba con display:none (el ResizeObserver no dispara en ese caso).
    requestAnimationFrame(() => {
      const viewer = document.getElementById('reader-view');
      const inner  = getViewerInnerSize(viewer);
      if (needsRepagination || inner.W !== pageWidth || inner.H !== pageHeight) {
        paginate({ keepAnchor: true });
      }
    });
  }
}

// Estado inicial de pestañas (sin invocar renderers vacíos)
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
      <div class="book-item-info" onclick="selectBook(${b.id})">
        <div class="book-title">${escHtml(b.title)}</div>
        <div class="book-meta">${count} subrayado${count !== 1 ? 's' : ''}</div>
      </div>
      <button class="btn-book-delete" onclick="deleteBook(${b.id})" title="Borrar libro">🗑</button>`;
    list.appendChild(div);
  });
}

function exportTxt() {
  const bhs  = state.highlights.filter(h => h.bookId === state.currentBookId);
  const book = state.books.find(b => b.id === state.currentBookId);
  if (!bhs.length) { setStatus('No hay subrayados para exportar'); return; }
  let txt = `SUBRAYADOS — ${book ? book.title.toUpperCase() : 'LIBRO'}\n${'═'.repeat(50)}\n\n`;
  bhs.forEach((h, i) => {
    txt += `${i + 1}. "${h.text}"\n`;
    if (h.note) txt += `   → ${h.note}\n`;
    txt += '\n';
  });
  txt += `Exportado el ${new Date().toLocaleDateString('es-ES')}`;
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'subrayados.txt'; a.click();
  URL.revokeObjectURL(url);
  setStatus('Archivo exportado');
}

let statusTimer = null;
function setStatus(msg) {
  document.getElementById('status-text').textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(updateStatusBar, 2500);
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
