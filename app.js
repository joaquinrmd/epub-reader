/* ══════════════════════════════════════════════════
   Mi Lector — app.js  (v3)
   Motor de páginas, capítulos, hyperlinks, biblioteca
   ══════════════════════════════════════════════════ */
'use strict';

// ─── CONSTANTES ───────────────────────────────────
const CLIENT_ID   = '602238897882-g752d4mbev0d2leg8fvnq7lqt6jsof8l.apps.googleusercontent.com';
const SCOPES      = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE  = 'mi-lector-data.json';
const DB_NAME     = 'mi-lector-db';
const DB_VERSION  = 2;
const FONT_MIN    = 14;
const FONT_MAX    = 22;
const THEMES      = ['day', 'sepia', 'night'];
const THEME_ICONS = { day: '☀', sepia: '📜', night: '🌙' };

// ─── ESTADO GLOBAL ────────────────────────────────
let state = {
  books:         [],   // [{ id, title, author }]
  highlights:    [],   // [{ id, bookId, text, note, color, ts }]
  currentBookId: null,
  nextId:        1
};
let prefs = { theme: 'day', fontSize: 17 };

// Motor de páginas
let allParagraphs    = [];  // [{ html, chapterIndex, anchorIds:[] }]
let pages            = [];  // [{ paragraphIndices:[], chapterIndex }]
let paragraphPageMap = {};  // { paraIdx: pageIdx }
let chapterFirstPage = {};  // { chapterIdx: pageIdx }
let anchorMap        = {};  // { anchorId: paraIdx }
let fileChapterMap   = {};  // { filename: chapterIdx }
let currentPageIdx   = 0;
let currentChapterIndex = 0;
let totalChapters    = 0;
let currentBookChapters = [];

let currentColor = 'yellow';
let driveReady   = false;
let driveFileId  = null;
let tokenClient  = null;
let driveTimer   = null;
let saveTimer    = null;
let isPaginating = false;

// ═══════════════════════════════════════════════════
//  INDEXEDDB
// ═══════════════════════════════════════════════════

let db;

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
      if (!d.objectStoreNames.contains('prefs'))      d.createObjectStore('prefs', { keyPath: 'key' });
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
    const st  = tx.objectStore(store);
    const req = fn(st);
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
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).index(indexName).getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbDeleteAllByIndex(storeName, indexName, value) {
  const items = await dbGetByIndex(storeName, indexName, value).catch(() => []);
  for (const item of items) await dbDelete(storeName, item.id).catch(() => {});
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
    if (state.currentBookId) await selectBook(state.currentBookId);
    renderHighlights();
  } catch (e) {
    console.error('[Init]', e);
    setStatus('Error al iniciar — recargá la página');
  }
  hideLoading();
  loadGapiScript();
  registerSW();
  setupNavigation();
};

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
    if (old.nextId)        await dbPut('prefs', { key: 'nextId',        value: old.nextId });
    if (old.currentBookId) await dbPut('prefs', { key: 'currentBookId', value: old.currentBookId });
    localStorage.removeItem('mi_lector_v2');
    console.log('[Migración] localStorage → IndexedDB OK');
  } catch (e) { console.warn('[Migración]', e); }
}

async function loadState() {
  const allBooks      = await dbGetAll('books');
  state.books         = allBooks.map(b => ({ id: b.id, title: b.title, author: b.author || '' }));
  state.highlights    = await dbGetAll('highlights');
  const nextIdRec     = await dbGet('prefs', 'nextId');
  state.nextId        = nextIdRec ? nextIdRec.value : 1;
  const curRec        = await dbGet('prefs', 'currentBookId');
  state.currentBookId = curRec ? curRec.value : null;
  const themeRec      = await dbGet('prefs', 'theme');
  prefs.theme         = themeRec ? themeRec.value : 'day';
  const fontRec       = await dbGet('prefs', 'fontSize');
  prefs.fontSize      = fontRec ? fontRec.value : 17;
}

async function savePref(key, value) {
  try { await dbPut('prefs', { key, value }); } catch (e) {}
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(r  => console.log('[SW]', r.scope))
      .catch(e => console.warn('[SW]', e));
  }
}

// ═══════════════════════════════════════════════════
//  PREFERENCIAS — TEMA Y FUENTE
// ═══════════════════════════════════════════════════

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
  // El tema no requiere recalcular páginas
}

function updateThemeBtn() {
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = THEME_ICONS[prefs.theme];
}

async function changeFontSize(delta) {
  const oldSize = prefs.fontSize;
  prefs.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, prefs.fontSize + delta));
  if (prefs.fontSize === oldSize) return;

  document.getElementById('page-content').style.fontSize = prefs.fontSize + 'px';
  savePref('fontSize', prefs.fontSize);
  updateFontBtns();

  // Recalcular páginas usando el primer párrafo de la página actual como ancla
  if (pages.length > 0) {
    const anchorParaIdx = pages[currentPageIdx]?.paragraphIndices[0] ?? 0;
    await recalculatePages(anchorParaIdx);
  }
}

function updateFontBtns() {
  const minus = document.getElementById('btn-font-minus');
  const plus  = document.getElementById('btn-font-plus');
  if (minus) minus.disabled = prefs.fontSize <= FONT_MIN;
  if (plus)  plus.disabled  = prefs.fontSize >= FONT_MAX;
}

// ═══════════════════════════════════════════════════
//  GOOGLE DRIVE
// ═══════════════════════════════════════════════════

function loadGapiScript() {
  const s1 = document.createElement('script');
  s1.src    = 'https://apis.google.com/js/api.js';
  s1.onload = () => gapi.load('client', () => {
    gapi.client.init({ apiKey: '', discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'] });
  });
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
    const res   = await gapi.client.drive.files.list({ spaces: 'appDataFolder', q: `name='${DRIVE_FILE}'`, fields: 'files(id,name)' });
    const files = res.result.files;
    if (files && files.length > 0) {
      driveFileId = files[0].id;
      const content = await gapi.client.drive.files.get({ fileId: driveFileId, alt: 'media' });
      await mergeState(JSON.parse(content.body));
      renderSidebar();
      renderHighlights();
      setStatus('Sincronizado con Drive');
    } else {
      await saveToDrive();
      setStatus('Datos guardados en Drive');
    }
  } catch (e) {
    console.error('[Drive]', e);
    setStatus('Error sincronizando — datos locales disponibles');
  }
  hideLoading();
}

async function mergeState(remote) {
  const localHlIds   = new Set(state.highlights.map(h => h.id));
  const localBookIds = new Set(state.books.map(b => b.id));
  for (const h of (remote.highlights || [])) {
    if (!localHlIds.has(h.id)) { state.highlights.push(h); await dbPut('highlights', h); }
  }
  for (const b of (remote.books || [])) {
    if (!localBookIds.has(b.id)) {
      state.books.push({ id: b.id, title: b.title, author: b.author || '' });
      await dbPut('books', { id: b.id, title: b.title, author: b.author || '', chapters: [], coverBase64: null });
    }
  }
  if ((remote.nextId || 0) > state.nextId) { state.nextId = remote.nextId; await savePref('nextId', state.nextId); }
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
        await gapi.client.request({ path: `/upload/drive/v3/files/${driveFileId}`, method: 'PATCH', params: { uploadType: 'media' }, body: payload });
      } else {
        const meta  = await gapi.client.drive.files.create({ resource: { name: DRIVE_FILE, parents: ['appDataFolder'] }, fields: 'id' });
        driveFileId = meta.result.id;
        await gapi.client.request({ path: `/upload/drive/v3/files/${driveFileId}`, method: 'PATCH', params: { uploadType: 'media' }, body: payload });
      }
      const ind = document.getElementById('sync-indicator');
      ind.textContent = 'Guardado ✓';
      setTimeout(() => { ind.textContent = ''; }, 2000);
    } catch (e) { console.warn('[Drive save]', e); }
  }, 1200);
}

// ═══════════════════════════════════════════════════
//  EPUB PARSER
// ═══════════════════════════════════════════════════

document.getElementById('file-input').addEventListener('change', async e => {
  for (const file of Array.from(e.target.files)) {
    showLoading('Cargando ' + file.name + '...');
    try {
      if (file.name.toLowerCase().endsWith('.epub')) await loadEpub(file);
      else                                           await loadTxt(file);
    } catch (err) { console.error('[Carga]', err); setStatus('Error cargando ' + file.name); }
    hideLoading();
  }
  e.target.value = '';
});

async function loadEpub(file) {
  const zip     = await JSZip.loadAsync(file);
  let title     = file.name.replace(/\.epub$/i, '');
  let author    = '';
  let chapters  = [];
  let coverBase64 = null;

  // 1. OPF path via container.xml
  let opfPath = null;
  const containerFile = zip.files['META-INF/container.xml'];
  if (containerFile) {
    const cxml = await containerFile.async('text');
    const m    = cxml.match(/full-path="([^"]+)"/i);
    if (m) opfPath = m[1];
  }
  if (!opfPath) opfPath = Object.keys(zip.files).find(f => f.toLowerCase().endsWith('.opf'));
  if (!opfPath) { await loadEpubFallback(zip, title); return; }

  const opfText  = await zip.files[opfPath].async('text');
  const basePath = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // 2. Metadatos
  const titleMatch  = opfText.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
  const authorMatch = opfText.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);
  if (titleMatch)  title  = titleMatch[1].trim();
  if (authorMatch) author = authorMatch[1].trim();

  // 3. Manifest
  const manifest = {};
  for (const m of opfText.matchAll(/<item\s[^>]*>/gi)) {
    const tag   = m[0];
    const idM   = tag.match(/\bid="([^"]+)"/);
    const hrefM = tag.match(/\bhref="([^"]+)"/);
    const typeM = tag.match(/\bmedia-type="([^"]+)"/);
    const propM = tag.match(/\bproperties="([^"]+)"/);
    if (idM && hrefM) {
      manifest[idM[1]] = { href: hrefM[1], mediaType: typeM ? typeM[1] : '', properties: propM ? propM[1] : '' };
    }
  }

  // 4. Portada — buscar item con properties="cover-image" o id="cover"
  const coverItem = Object.values(manifest).find(
    i => i.properties.includes('cover-image') ||
         /image\/(jpeg|png|webp)/.test(i.mediaType) && i.href.toLowerCase().includes('cover')
  );
  if (coverItem) {
    try {
      const coverPath = resolvePath(basePath, coverItem.href);
      const coverFile = zip.files[coverPath] || zip.files[Object.keys(zip.files).find(k => k.endsWith(coverItem.href))];
      if (coverFile) {
        const coverBytes = await coverFile.async('base64');
        coverBase64 = `data:${coverItem.mediaType};base64,${coverBytes}`;
      }
    } catch (e) { console.warn('[Cover]', e); }
  }

  // 5. Spine → capítulos
  const spineIds     = [...opfText.matchAll(/idref="([^"]+)"/g)].map(m => m[1]);
  const chapterTitles = await extractChapterTitles(zip, manifest, basePath, spineIds, opfText);

  let chapCount = 0;
  for (let i = 0; i < spineIds.length; i++) {
    const item = manifest[spineIds[i]];
    if (!item) continue;
    const href     = item.href.split('#')[0];
    const fullPath = resolvePath(basePath, href);
    const htmlFile = zip.files[fullPath] || zip.files[Object.keys(zip.files).find(k => k.endsWith(href))];
    if (!htmlFile) continue;
    const rawHtml  = await htmlFile.async('text');
    const body     = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (!body) continue;
    const cleaned  = cleanEpubHtml(body[1]);
    if (!cleaned.trim()) continue;

    chapters.push({
      index:    chapCount++,
      title:    chapterTitles[i] || null,
      html:     cleaned,
      filename: href.split('/').pop()
    });
  }

  if (chapters.length === 0) { await loadEpubFallback(zip, title); return; }
  await addBook(title, author, chapters, coverBase64);
}

async function extractChapterTitles(zip, manifest, basePath, spineIds, opfText) {
  const titles = {};
  // NCX (EPUB2)
  const ncxItem = Object.values(manifest).find(i => i.href.endsWith('.ncx') || i.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem) {
    try {
      const ncxPath = resolvePath(basePath, ncxItem.href);
      const ncxFile = zip.files[ncxPath] || zip.files[Object.keys(zip.files).find(k => k.endsWith(ncxItem.href))];
      if (ncxFile) {
        const ncxText = await ncxFile.async('text');
        for (const m of ncxText.matchAll(/<navPoint[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content[^>]+src="([^"#]+)/g)) {
          const label    = m[1].trim();
          const src      = m[2].split('/').pop().toLowerCase();
          const spineIdx = spineIds.findIndex(id => manifest[id] && manifest[id].href.split('/').pop().split('#')[0].toLowerCase() === src);
          if (spineIdx >= 0 && !titles[spineIdx]) titles[spineIdx] = label;
        }
      }
    } catch (e) {}
  }
  // NAV (EPUB3)
  if (Object.keys(titles).length === 0) {
    const navItem = Object.values(manifest).find(i => i.properties.includes('nav'));
    if (navItem) {
      try {
        const navPath = resolvePath(basePath, navItem.href);
        const navFile = zip.files[navPath] || zip.files[Object.keys(zip.files).find(k => k.endsWith(navItem.href))];
        if (navFile) {
          const navText = await navFile.async('text');
          for (const m of navText.matchAll(/<a[^>]+href="([^"#]*)[^"]*"[^>]*>([^<]+)<\/a>/g)) {
            const src      = m[1].split('/').pop().toLowerCase();
            const label    = m[2].trim();
            const spineIdx = spineIds.findIndex(id => manifest[id] && manifest[id].href.split('/').pop().split('#')[0].toLowerCase() === src);
            if (spineIdx >= 0 && !titles[spineIdx]) titles[spineIdx] = label;
          }
        }
      } catch (e) {}
    }
  }
  return titles;
}

async function loadEpubFallback(zip, title) {
  let html = '';
  const htmlFiles = Object.keys(zip.files).filter(f => /\.(html|htm|xhtml)$/i.test(f)).slice(0, 40);
  for (const f of htmlFiles) {
    const raw  = await zip.files[f].async('text');
    const body = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (body) html += body[1] + '\n';
  }
  await addBook(title, '', [{ index: 0, title: null, html: cleanEpubHtml(html), filename: '' }], null);
}

function resolvePath(base, href) {
  if (!href || href.startsWith('http')) return href;
  const parts    = (base + href).split('/');
  const resolved = [];
  for (const p of parts) {
    if (p === '..') resolved.pop();
    else if (p && p !== '.') resolved.push(p);
  }
  return resolved.join('/');
}

function cleanEpubHtml(html) {
  // Eliminar scripts, styles, links, imágenes
  // MANTENER ids (necesarios para hyperlinks) y hrefs
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
  const text  = await file.text();
  const title = file.name.replace(/\.txt$/i, '');
  const html  = text.split('\n').filter(l => l.trim()).map(l => `<p>${escHtml(l.trim())}</p>`).join('');
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

// ═══════════════════════════════════════════════════
//  SELECCIÓN DE LIBRO
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
      await openBook(fullBook);
    } else if (fullBook && fullBook.html) {
      // Formato antiguo sin capítulos
      await openBook({ chapters: [{ index: 0, title: null, html: fullBook.html, filename: '' }] });
    } else {
      document.getElementById('page-content').innerHTML = `
        <div id="empty-reader" style="padding-top:60px;">
          Este libro no tiene contenido en este dispositivo.<br><br>
          <strong style="color:var(--text)">Volvé a subir el EPUB para poder leerlo aquí.</strong>
        </div>`;
      clearNavState();
    }
  } catch (e) { console.error('[selectBook]', e); }

  hideLoading();
  renderHighlights();
}

async function openBook(fullBook) {
  currentBookChapters = fullBook.chapters;
  totalChapters       = currentBookChapters.length;

  // Construir mapa de capítulos en sidebar
  renderChapterSidebar();

  // Construir array de párrafos
  buildParagraphArray(currentBookChapters);

  // Calcular páginas
  showLoading('Preparando páginas...');
  await calculatePages();
  hideLoading();

  // Restaurar posición guardada o ir a página 0
  await restorePosition();
}

// ═══════════════════════════════════════════════════
//  CONSTRUCCIÓN DE PÁRRAFOS
// ═══════════════════════════════════════════════════

const BLOCK_TAGS = new Set(['p','h1','h2','h3','h4','h5','h6','blockquote','pre','li','dt','dd','div']);
const SKIP_TAGS  = new Set(['script','style','head','nav','aside','figure']);

function buildParagraphArray(chapters) {
  allParagraphs = [];
  anchorMap     = {};
  fileChapterMap = {};

  for (let chIdx = 0; chIdx < chapters.length; chIdx++) {
    const ch = chapters[chIdx];
    if (ch.filename) fileChapterMap[ch.filename.toLowerCase()] = chIdx;

    const div      = document.createElement('div');
    div.innerHTML  = ch.html;

    extractBlocksFromNode(div, chIdx);
  }
}

function extractBlocksFromNode(node, chapterIndex) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent.trim();
    if (text && node.parentNode && !isBlockTag(node.parentNode.tagName)) {
      allParagraphs.push({ html: `<p>${escHtml(text)}</p>`, chapterIndex, anchorIds: [] });
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const tag = node.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;

  // Si es un bloque de contenido: lo tomamos como un párrafo
  if (tag === 'p' || tag === 'h1' || tag === 'h2' || tag === 'h3' ||
      tag === 'h4' || tag === 'h5' || tag === 'h6' ||
      tag === 'blockquote' || tag === 'pre') {
    const text = node.textContent.trim();
    if (!text) return;

    const ids = collectIds(node);
    const paraIdx = allParagraphs.length;
    ids.forEach(id => { anchorMap[id] = paraIdx; });

    allParagraphs.push({ html: node.outerHTML, chapterIndex, anchorIds: ids });
    return;
  }

  // Contenedor (div, section, article, ul, ol, etc.) — recurrir
  for (const child of node.childNodes) {
    extractBlocksFromNode(child, chapterIndex);
  }
}

function isBlockTag(tagName) {
  return tagName && BLOCK_TAGS.has(tagName.toLowerCase());
}

function collectIds(el) {
  const ids = [];
  if (el.id) ids.push(el.id);
  el.querySelectorAll('[id]').forEach(c => ids.push(c.id));
  return ids;
}

// ═══════════════════════════════════════════════════
//  MOTOR DE PAGINACIÓN
// ═══════════════════════════════════════════════════

async function calculatePages(anchorParaIdx = null) {
  if (!allParagraphs.length || isPaginating) return;
  isPaginating = true;

  const measurer    = document.getElementById('page-measurer');
  const pageContent = document.getElementById('page-content');
  const rect        = pageContent.getBoundingClientRect();
  const innerWidth  = Math.max(rect.width - 120, 180);   // menos padding
  // rect.height ya excluye la barra de estado (es sibling, no hijo)
  // Solo restar padding top(36) + bottom(52) + margen de seguridad(16)
  const pageHeight  = Math.max(rect.height - 104, 200);

  measurer.style.width    = innerWidth + 'px';
  measurer.style.fontSize = prefs.fontSize + 'px';

  // Medir alturas en chunks de 150 para no congelar la UI
  const heights  = [];
  const CHUNK    = 150;

  for (let start = 0; start < allParagraphs.length; start += CHUNK) {
    measurer.innerHTML = '';
    const chunk = allParagraphs.slice(start, start + CHUNK);
    chunk.forEach(para => {
      const el          = document.createElement('div');
      el.innerHTML      = para.html;
      el.style.marginBottom = '1.4rem';
      measurer.appendChild(el);
    });
    // Forzar layout y leer alturas
    void measurer.scrollHeight;
    Array.from(measurer.children).forEach(el => heights.push(el.offsetHeight + 22));
    // Yield al browser
    await new Promise(r => setTimeout(r, 0));
  }
  measurer.innerHTML = '';

  // Construir páginas
  pages            = [];
  paragraphPageMap = {};
  chapterFirstPage = {};
  let curPage      = [];
  let curHeight    = 0;
  // Altura del encabezado de capítulo (aproximado)
  const CHAPTER_HEADER_H = 50;

  for (let i = 0; i < allParagraphs.length; i++) {
    const para = allParagraphs[i];
    const h    = heights[i] || 40;

    // ¿Es el primer párrafo de un capítulo nuevo?
    const isChapterStart = i === 0 ||
      (i > 0 && allParagraphs[i - 1].chapterIndex !== para.chapterIndex);

    const extraH = isChapterStart && para.chapterIndex > 0 ? CHAPTER_HEADER_H : 0;

    if (curHeight + extraH + h > pageHeight && curPage.length > 0) {
      // Cerrar página actual
      const pg = { paragraphIndices: [...curPage], chapterIndex: allParagraphs[curPage[0]].chapterIndex };
      pages.push(pg);
      curPage.forEach(idx => { paragraphPageMap[idx] = pages.length - 1; });
      if (!(pg.chapterIndex in chapterFirstPage)) chapterFirstPage[pg.chapterIndex] = pages.length - 1;
      curPage    = [i];
      curHeight  = h;
    } else {
      curPage.push(i);
      curHeight += extraH + h;
    }
  }
  if (curPage.length > 0) {
    const pg = { paragraphIndices: [...curPage], chapterIndex: allParagraphs[curPage[0]].chapterIndex };
    pages.push(pg);
    curPage.forEach(idx => { paragraphPageMap[idx] = pages.length - 1; });
    if (!(pg.chapterIndex in chapterFirstPage)) chapterFirstPage[pg.chapterIndex] = pages.length - 1;
  }

  isPaginating = false;

  // Si se recalculó por cambio de fuente, ir al ancla
  if (anchorParaIdx !== null) {
    const targetPage = paragraphPageMap[anchorParaIdx] ?? 0;
    renderPage(Math.min(targetPage, pages.length - 1));
  }
}

async function recalculatePages(anchorParaIdx) {
  isPaginating = false; // reset por si estaba bloqueado
  await calculatePages(anchorParaIdx);
}

// ═══════════════════════════════════════════════════
//  RENDERIZADO DE PÁGINA
// ═══════════════════════════════════════════════════

function renderPage(idx, direction = null) {
  if (idx < 0 || idx >= pages.length) return;
  currentPageIdx = idx;

  const page       = pages[idx];
  currentChapterIndex = page.chapterIndex;

  // Construir HTML de la página
  let html       = '';
  let lastChapIdx = -1;

  for (const paraIdx of page.paragraphIndices) {
    const para    = allParagraphs[paraIdx];
    const chapIdx = para.chapterIndex;

    // Encabezado de capítulo cuando cambia
    if (chapIdx !== lastChapIdx && chapIdx > 0) {
      const ch = currentBookChapters[chapIdx];
      if (ch && ch.title) {
        html += `<div class="chapter-header-inline">${escHtml(chapIdx + 1 + '. ' + ch.title)}</div>`;
      }
      lastChapIdx = chapIdx;
    } else if (lastChapIdx === -1) {
      lastChapIdx = chapIdx;
    }

    html += processLinksForRender(para.html);
  }

  const container = document.getElementById('page-content');
  container.innerHTML = html;

  // Animación
  if (direction === 'next') {
    container.classList.remove('anim-prev');
    void container.offsetWidth; // reflow
    container.classList.add('anim-next');
  } else if (direction === 'prev') {
    container.classList.remove('anim-next');
    void container.offsetWidth;
    container.classList.add('anim-prev');
  }

  // Aplicar highlights
  applyHighlightsToPage();

  // Actualizar UI
  updateStatusBar();
  updateNavButtons();
  updateChapterSidebar();

  // Guardar posición (debounced)
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePosition, 600);
}

// Procesar links para render (interceptar links internos)
function processLinksForRender(html) {
  return html.replace(/<a(\s[^>]*)?>/gi, (match, attrs) => {
    if (!attrs) return match;
    const hrefM = attrs.match(/href="([^"]*)"/i);
    if (!hrefM) return match;
    const href  = hrefM[1];

    if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('//')) {
      return `<a${attrs} target="_blank" rel="noopener noreferrer">`;
    }

    // Link interno
    const parts  = href.split('#');
    const file   = parts[0] ? parts[0].split('/').pop().toLowerCase() : '';
    const anchor = parts[1] || '';
    const safeAnchor = anchor.replace(/'/g, "\\'");
    const safeFile   = file.replace(/'/g, "\\'");

    return `<a${attrs} href="javascript:void(0)" onclick="handleInternalLink('${safeAnchor}','${safeFile}')">`;
  });
}

// ─── Navegación por hyperlinks internos ───
function handleInternalLink(anchor, file) {
  let paraIdx = -1;

  if (anchor && anchorMap[anchor] !== undefined) {
    paraIdx = anchorMap[anchor];
  } else if (file && fileChapterMap[file] !== undefined) {
    const chIdx = fileChapterMap[file];
    paraIdx = allParagraphs.findIndex(p => p.chapterIndex === chIdx);
  }

  if (paraIdx >= 0 && paragraphPageMap[paraIdx] !== undefined) {
    goToPage(paragraphPageMap[paraIdx]);
  }
}

// ═══════════════════════════════════════════════════
//  NAVEGACIÓN DE PÁGINAS
// ═══════════════════════════════════════════════════

function nextPage() {
  if (currentPageIdx < pages.length - 1) renderPage(currentPageIdx + 1, 'next');
}

function prevPage() {
  if (currentPageIdx > 0) renderPage(currentPageIdx - 1, 'prev');
}

function goToPage(idx) {
  renderPage(Math.max(0, Math.min(idx, pages.length - 1)));
}

function goToChapter(chapterIdx) {
  if (chapterFirstPage[chapterIdx] !== undefined) {
    goToPage(chapterFirstPage[chapterIdx]);
  }
}

function clearNavState() {
  pages = []; paragraphPageMap = {}; chapterFirstPage = {};
  allParagraphs = []; currentPageIdx = 0;
  updateNavButtons();
  updateStatusBar();
  document.getElementById('chapter-section').classList.remove('visible');
}

function setupNavigation() {
  // Teclado
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown'  || e.key === 'PageDown') nextPage();
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp'    || e.key === 'PageUp')   prevPage();
  });

  // Rueda del mouse → cambiar página (en vez de scrollear)
  const readerView = document.getElementById('reader-view');
  readerView.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.deltaY > 0) nextPage();
    else if (e.deltaY < 0) prevPage();
  }, { passive: false });

  // Touch — prevenir scroll nativo dentro del lector
  readerView.addEventListener('touchmove', e => {
    e.preventDefault();
  }, { passive: false });

  // Swipe (iPad y touch)
  let tx = 0, ty = 0;
  readerView.addEventListener('touchstart', e => {
    tx = e.touches[0].clientX;
    ty = e.touches[0].clientY;
  }, { passive: true });
  readerView.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx;
    const dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 45) {
      if (dx < 0) nextPage();
      else        prevPage();
    }
  }, { passive: true });
}

// ─── Estado de botones ───
function updateNavButtons() {
  const prev = document.getElementById('btn-prev');
  const next = document.getElementById('btn-next');
  if (!prev || !next) return;
  prev.disabled = currentPageIdx <= 0 || pages.length === 0;
  next.disabled = currentPageIdx >= pages.length - 1 || pages.length === 0;
}

// ─── Status bar ───
function updateStatusBar() {
  if (!pages.length) { setStatusDirect('Listo'); return; }
  const page        = pages[currentPageIdx];
  const chapIdx     = page ? page.chapterIndex : 0;
  const ch          = currentBookChapters[chapIdx];
  let chapLabel;
  if (ch && ch.title) {
    chapLabel = `${chapIdx + 1}. ${ch.title}`;
  } else {
    chapLabel = `Cap. ${chapIdx + 1} de ${totalChapters}`;
  }
  const pageLabel = `Pág. ${currentPageIdx + 1} de ${pages.length}`;
  setStatusDirect(`${chapLabel} · ${pageLabel}`);
}

// ═══════════════════════════════════════════════════
//  SIDEBAR DE CAPÍTULOS
// ═══════════════════════════════════════════════════

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
    const label = ch.title ? `${idx + 1}. ${ch.title}` : `Capítulo ${idx + 1}`;
    const div   = document.createElement('div');
    div.className = 'chapter-item' + (idx === currentChapterIndex ? ' active' : '');
    div.textContent = label;
    div.onclick = () => { goToChapter(idx); };
    list.appendChild(div);
  });
}

function updateChapterSidebar() {
  document.querySelectorAll('.chapter-item').forEach((el, idx) => {
    el.classList.toggle('active', idx === currentChapterIndex);
  });
  // Hacer scroll al capítulo activo en el sidebar
  const active = document.querySelector('.chapter-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

// ═══════════════════════════════════════════════════
//  POSICIÓN GUARDADA
// ═══════════════════════════════════════════════════

async function savePosition() {
  if (!state.currentBookId || !pages.length) return;
  const page         = pages[currentPageIdx];
  const anchorParaIdx = page ? page.paragraphIndices[0] : 0;
  await savePref(`pos_${state.currentBookId}`, {
    pageIdx:       currentPageIdx,
    chapterIndex:  currentChapterIndex,
    anchorParaIdx,
    fontSize:      prefs.fontSize
  });
}

async function restorePosition() {
  const rec = await dbGet('prefs', `pos_${state.currentBookId}`);
  if (!rec || !rec.value || !pages.length) { renderPage(0); return; }

  const { pageIdx, anchorParaIdx, fontSize } = rec.value;

  if (fontSize !== prefs.fontSize && anchorParaIdx !== undefined) {
    // Fuente cambió — buscar por párrafo ancla
    const targetPage = paragraphPageMap[anchorParaIdx] ?? 0;
    renderPage(Math.min(targetPage, pages.length - 1));
  } else {
    renderPage(Math.min(pageIdx || 0, pages.length - 1));
  }
}

// ═══════════════════════════════════════════════════
//  BOOKMARKS
// ═══════════════════════════════════════════════════

async function addBookmark() {
  if (!state.currentBookId || !pages.length) { setStatus('Primero abrí un libro'); return; }

  const page    = pages[currentPageIdx];
  const ch      = currentBookChapters[page.chapterIndex];
  const chapStr = ch && ch.title ? `${page.chapterIndex + 1}. ${ch.title}` : `Cap. ${page.chapterIndex + 1}`;
  const label   = `${chapStr} · Pág. ${currentPageIdx + 1}`;

  const id = state.nextId++;
  const bm = {
    id,
    bookId:        state.currentBookId,
    pageIdx:       currentPageIdx,
    anchorParaIdx: page.paragraphIndices[0],
    label,
    ts:            Date.now()
  };
  await dbPut('bookmarks', bm);
  await savePref('nextId', state.nextId);
  setStatus('🔖 ' + label);
}

async function renderBookmarks() {
  const section = document.getElementById('bookmarks-section');
  const list    = document.getElementById('bookmarks-list');

  const bookmarks = await dbGetByIndex('bookmarks', 'bookId', state.currentBookId).catch(() => []);

  if (!bookmarks || bookmarks.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = '';

  bookmarks.sort((a, b) => a.pageIdx - b.pageIdx).forEach(bm => {
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
      const anchorParaIdx = parseInt(btn.dataset.para, 10);
      const savedPage     = parseInt(btn.dataset.page, 10);
      showTab('reader');
      // Buscar la página por el párrafo ancla (más robusto tras cambio de fuente)
      const targetPage = paragraphPageMap[anchorParaIdx] ?? savedPage;
      goToPage(targetPage);
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

// ═══════════════════════════════════════════════════
//  HIGHLIGHTS
// ═══════════════════════════════════════════════════

function setColor(c) {
  currentColor = c;
  document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
  document.getElementById('color-' + c).classList.add('active');
}

document.addEventListener('mouseup', e => {
  if (e.target.closest('#sel-toolbar')) return;
  handleSelection(e);
});
document.addEventListener('touchend', e => {
  if (e.target.closest('#sel-toolbar')) return;
  setTimeout(() => handleSelection(e), 120);
});
document.addEventListener('mousedown', e => {
  if (!e.target.closest('#sel-toolbar')) hideSel();
});

function handleSelection(e) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideSel(); return; }
  if (!document.getElementById('page-content').contains(sel.anchorNode)) { hideSel(); return; }
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
    wrapRange(range, id, currentColor);
    state.highlights.push(hl);
    sel.removeAllRanges();
    await dbPut('highlights', hl);
    await savePref('nextId', state.nextId);
    saveToDrive();
    renderSidebar();
    setStatus('Subrayado guardado');
  } catch (e) {
    setStatus('Seleccioná texto dentro de un mismo párrafo');
  }
  hideSel();
}

function wrapRange(range, id, color) {
  const span        = document.createElement('span');
  span.className    = `hl hl-${color}`;
  span.dataset.hlId = id;
  span.title        = 'Clic para ver notas';
  span.onclick      = () => showTab('highlights');
  range.surroundContents(span);
}

function applyHighlightsToPage() {
  const container = document.getElementById('page-content');
  const text      = container.textContent;
  const bookHls   = state.highlights.filter(h => h.bookId === state.currentBookId);

  bookHls.forEach(hl => {
    if (!text.includes(hl.text)) return;
    if (container.querySelector(`[data-hl-id="${hl.id}"]`)) return;
    try {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf(hl.text);
        if (idx === -1) continue;
        if (node.parentElement.classList.contains('hl')) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + hl.text.length);
        wrapRange(range, hl.id, hl.color);
        break;
      }
    } catch (e) {}
  });
}

async function deleteHighlight(id) {
  state.highlights = state.highlights.filter(h => h.id !== id);
  const span = document.querySelector(`[data-hl-id="${id}"]`);
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
  const list     = document.getElementById('hl-list');
  list.innerHTML = '';
  const bookHls  = state.highlights.filter(h => h.bookId === state.currentBookId);

  if (bookHls.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <strong>Sin subrayados aún</strong>
      Ve a Leer, seleccioná texto y presioná Subrayar
    </div>`;
    return;
  }

  const colorSolid = { yellow:'#ca8a04', blue:'#2563eb', green:'#16a34a', pink:'#db2777' };
  const colorBg    = { yellow:'rgba(253,224,71,0.30)', blue:'rgba(147,197,253,0.35)', green:'rgba(134,239,172,0.35)', pink:'rgba(249,168,212,0.35)' };

  bookHls.sort((a, b) => a.ts - b.ts).forEach(h => {
    const card = document.createElement('div');
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
      const h = state.highlights.find(h => h.id === parseInt(e.target.dataset.id, 10));
      if (h) { h.note = e.target.value; await dbPut('highlights', h); saveToDrive(); setStatus('Nota guardada'); }
    });
  });
  list.querySelectorAll('.hl-delete').forEach(btn => {
    btn.addEventListener('click', e => deleteHighlight(parseInt(e.target.dataset.id, 10)));
  });
}

// ═══════════════════════════════════════════════════
//  BORRAR LIBRO
// ═══════════════════════════════════════════════════

async function deleteBook(bookId) {
  const book = state.books.find(b => b.id === bookId);
  if (!book) return;
  if (!confirm(`¿Borrar "${book.title}" y todos sus subrayados?\n\nEsta acción no se puede deshacer.`)) return;

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
    currentBookChapters = [];
    document.getElementById('page-content').innerHTML = `<div id="empty-reader">Sube un libro para empezar.</div>`;
    document.getElementById('book-title-display').textContent = 'Mi Lector';
    document.getElementById('chapter-section').classList.remove('visible');
  }

  saveToDrive();
  renderSidebar();
  renderHighlights();
  setStatus(`"${book.title}" eliminado`);
}

// ─── Liberar espacio (borrar contenido, mantener highlights) ───
async function freeBookSpace(bookId) {
  const book = state.books.find(b => b.id === bookId);
  if (!book) return;
  if (!confirm(`¿Liberar el espacio de "${book.title}"?\n\nEl contenido se eliminará de este dispositivo, pero tus subrayados se mantienen en Drive. Para volver a leerlo, subí el EPUB nuevamente.`)) return;

  const full = await dbGet('books', bookId);
  if (!full) return;
  await dbPut('books', { ...full, chapters: [], coverBase64: null });

  if (state.currentBookId === bookId) {
    clearNavState();
    currentBookChapters = [];
    document.getElementById('page-content').innerHTML = `
      <div id="empty-reader" style="padding-top:60px;">
        Contenido liberado.<br><br>
        <strong style="color:var(--text)">Volvé a subir el EPUB para leer.</strong>
      </div>`;
    document.getElementById('chapter-section').classList.remove('visible');
  }

  setStatus(`Espacio liberado — subrayados conservados`);
}

// ═══════════════════════════════════════════════════
//  BIBLIOTECA
// ═══════════════════════════════════════════════════

async function renderLibrary() {
  const grid  = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  grid.innerHTML = '';

  if (state.books.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  for (const book of state.books) {
    const hlCount  = state.highlights.filter(h => h.bookId === book.id).length;
    const posRec   = await dbGet('prefs', `pos_${book.id}`).catch(() => null);
    const fullBook = await dbGet('books', book.id).catch(() => null);
    const hasContent = fullBook && fullBook.chapters && fullBook.chapters.length > 0;

    // Progreso
    let progressStr = 'Sin progreso';
    if (posRec && posRec.value) {
      const { chapterIndex } = posRec.value;
      const ch = hasContent && fullBook.chapters[chapterIndex];
      if (ch && ch.title) {
        progressStr = `${chapterIndex + 1}. ${ch.title}`;
      } else if (hasContent) {
        progressStr = `Cap. ${(chapterIndex || 0) + 1} de ${fullBook.chapters.length}`;
      }
    }

    const card = document.createElement('div');
    card.className = 'book-card';

    // Portada
    const coverHtml = fullBook && fullBook.coverBase64
      ? `<img src="${fullBook.coverBase64}" alt="${escHtml(book.title)}" loading="lazy">`
      : `<div class="book-cover-initial">${(book.title[0] || '?').toUpperCase()}</div>`;

    const noContentBadge = !hasContent
      ? `<div class="no-content-badge">Sin contenido</div>` : '';

    card.innerHTML = `
      <div class="book-cover" onclick="selectBook(${book.id})">
        ${coverHtml}
        ${noContentBadge}
      </div>
      <div class="book-card-info">
        <div class="book-card-title" title="${escHtml(book.title)}">${escHtml(book.title)}</div>
        ${book.author ? `<div class="book-card-author">${escHtml(book.author)}</div>` : ''}
        <div class="book-card-meta">
          ${progressStr}<br>
          ${hlCount} subrayado${hlCount !== 1 ? 's' : ''}
        </div>
      </div>
      <div class="book-card-actions">
        <button class="btn-card btn-card-open" onclick="selectBook(${book.id})">Abrir</button>
        <button class="btn-card btn-card-free" onclick="freeBookSpace(${book.id})" ${!hasContent ? 'disabled' : ''}>Liberar</button>
        <button class="btn-card btn-card-delete" onclick="deleteBook(${book.id})">🗑</button>
      </div>`;

    grid.appendChild(card);
  }
}

// ═══════════════════════════════════════════════════
//  UI — TABS, SIDEBAR, EXPORT, STATUS
// ═══════════════════════════════════════════════════

function showTab(tab) {
  const tabs = document.querySelectorAll('.tab');
  tabs[0].classList.toggle('active', tab === 'reader');
  tabs[1].classList.toggle('active', tab === 'highlights');
  tabs[2].classList.toggle('active', tab === 'library');

  document.getElementById('reader-view').style.display     = tab === 'reader'     ? 'flex'  : 'none';
  document.getElementById('highlights-view').style.display = tab === 'highlights' ? 'flex'  : 'none';
  document.getElementById('library-view').style.display    = tab === 'library'    ? 'flex'  : 'none';

  if (tab === 'highlights') { renderHighlights(); renderBookmarks(); }
  if (tab === 'library')    renderLibrary();
}

// Estado inicial
document.getElementById('reader-view').style.display     = 'flex';
document.getElementById('highlights-view').style.display = 'none';
document.getElementById('library-view').style.display    = 'none';

function renderSidebar() {
  const list = document.getElementById('book-list');
  list.innerHTML = '';
  if (state.books.length === 0) {
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

// ─── Status bar ───
let statusTimer = null;

function setStatus(msg) {
  const el = document.getElementById('status-text');
  el.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => updateStatusBar(), 2500);
}

function setStatusDirect(msg) {
  document.getElementById('status-text').textContent = msg;
}

// ─── Loading ───
function showLoading(msg) {
  document.getElementById('loading-text').textContent = msg || 'Cargando...';
  document.getElementById('loading').style.display = 'flex';
}
function hideLoading() {
  document.getElementById('loading').style.display = 'none';
}

// ─── Utils ───
function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
