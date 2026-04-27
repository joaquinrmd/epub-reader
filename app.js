/* ══════════════════════════════════════════════════
   Mi Lector — app.js  (v3 CSS Columns)
   El browser calcula los saltos de página — sin errores
   ══════════════════════════════════════════════════ */
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

let state = { books: [], highlights: [], currentBookId: null, nextId: 1 };
let prefs = { theme: 'day', fontSize: 17 };

// CSS Columns state
let allParagraphs       = [];
let anchorMap           = {};
let fileChapterMap      = {};
let chapterFirstPage    = {};
let paragraphPageMap    = {};
let currentPageIdx      = 0;
let currentChapterIndex = 0;
let totalChapters       = 0;
let totalPages          = 0;
let currentBookChapters = [];
let currentColor        = 'yellow';

let driveReady  = false;
let driveFileId = null;
let tokenClient = null;
let driveTimer  = null;
let saveTimer   = null;
let db;

// ═══════════════════════════════════════════════════
//  INDEXEDDB
// ═══════════════════════════════════════════════════

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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  setupNavigation();
};

async function migrateFromLocalStorage() {
  try {
    const raw = localStorage.getItem('mi_lector_v2');
    if (!raw) return;
    const old = JSON.parse(raw);
    for (const b of (old.books || [])) {
      if (!(await dbGet('books', b.id)))
        await dbPut('books', { id: b.id, title: b.title, author: b.author || '',
          chapters: [{ index: 0, title: null, html: b.html || '', filename: '' }], coverBase64: null });
    }
    for (const h of (old.highlights || []))
      if (!(await dbGet('highlights', h.id))) await dbPut('highlights', h);
    if (old.nextId)        await dbPut('prefs', { key: 'nextId', value: old.nextId });
    if (old.currentBookId) await dbPut('prefs', { key: 'currentBookId', value: old.currentBookId });
    localStorage.removeItem('mi_lector_v2');
  } catch (e) {}
}

async function loadState() {
  const books     = await dbGetAll('books');
  state.books     = books.map(b => ({ id: b.id, title: b.title, author: b.author || '' }));
  state.highlights = await dbGetAll('highlights');
  const nid = await dbGet('prefs', 'nextId');         state.nextId        = nid ? nid.value : 1;
  const cur = await dbGet('prefs', 'currentBookId');  state.currentBookId = cur ? cur.value : null;
  const th  = await dbGet('prefs', 'theme');          prefs.theme         = th  ? th.value  : 'day';
  const fs  = await dbGet('prefs', 'fontSize');       prefs.fontSize      = fs  ? fs.value  : 17;
}

async function savePref(key, value) { try { await dbPut('prefs', { key, value }); } catch (e) {} }

// ═══════════════════════════════════════════════════
//  PREFERENCIAS
// ═══════════════════════════════════════════════════

function applyPrefs() {
  document.documentElement.setAttribute('data-theme', prefs.theme);
  document.getElementById('page-content').style.fontSize = prefs.fontSize + 'px';
  updateThemeBtn(); updateFontBtns();
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

  const container = document.getElementById('page-content');
  const viewer    = document.getElementById('reader-view');
  const anchorIdx = getFirstVisibleParaIdx(viewer);

  // Aplicar nuevo tamaño — CSS columns se ajusta automáticamente
  container.style.fontSize   = prefs.fontSize + 'px';
  container.style.transition = 'none';
  container.style.transform  = 'translateX(0)';
  savePref('fontSize', prefs.fontSize);
  updateFontBtns();

  if (!allParagraphs.length) return;

  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  totalPages = computeTotalPages(container, viewer);
  buildParagraphPageMap(viewer);
  buildChapterPageMap(viewer);

  const target = paragraphPageMap[anchorIdx] ?? 0;
  goToPage(Math.min(target, totalPages - 1), null, true);
}

function updateFontBtns() {
  const m = document.getElementById('btn-font-minus');
  const p = document.getElementById('btn-font-plus');
  if (m) m.disabled = prefs.fontSize <= FONT_MIN;
  if (p) p.disabled = prefs.fontSize >= FONT_MAX;
}

// ═══════════════════════════════════════════════════
//  GOOGLE DRIVE
// ═══════════════════════════════════════════════════

function loadGapiScript() {
  const s1 = document.createElement('script');
  s1.src    = 'https://apis.google.com/js/api.js';
  s1.onload = () => gapi.load('client', () =>
    gapi.client.init({ apiKey: '', discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'] }));
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
      driveFileId   = files[0].id;
      const content = await gapi.client.drive.files.get({ fileId: driveFileId, alt: 'media' });
      await mergeState(JSON.parse(content.body));
      renderSidebar(); renderHighlights();
      setStatus('Sincronizado con Drive');
    } else {
      await saveToDrive();
      setStatus('Datos guardados en Drive');
    }
  } catch (e) { setStatus('Error sincronizando — datos locales disponibles'); }
  hideLoading();
}

async function mergeState(remote) {
  const hlIds   = new Set(state.highlights.map(h => h.id));
  const bookIds = new Set(state.books.map(b => b.id));
  for (const h of (remote.highlights || []))
    if (!hlIds.has(h.id)) { state.highlights.push(h); await dbPut('highlights', h); }
  for (const b of (remote.books || []))
    if (!bookIds.has(b.id)) {
      state.books.push({ id: b.id, title: b.title, author: b.author || '' });
      await dbPut('books', { id: b.id, title: b.title, author: b.author || '', chapters: [], coverBase64: null });
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
        highlights: state.highlights, nextId: state.nextId
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
    } catch (e) {}
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
    } catch (err) { setStatus('Error cargando ' + file.name); }
    hideLoading();
  }
  e.target.value = '';
});

async function loadEpub(file) {
  const zip = await JSZip.loadAsync(file);
  let title = file.name.replace(/\.epub$/i, ''), author = '', chapters = [], coverBase64 = null;

  let opfPath = null;
  const cf = zip.files['META-INF/container.xml'];
  if (cf) { const t = await cf.async('text'); const m = t.match(/full-path="([^"]+)"/i); if (m) opfPath = m[1]; }
  if (!opfPath) opfPath = Object.keys(zip.files).find(f => f.toLowerCase().endsWith('.opf'));
  if (!opfPath) { await loadEpubFallback(zip, title); return; }

  const opfText  = await zip.files[opfPath].async('text');
  const basePath = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  const tm = opfText.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
  const am = opfText.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);
  if (tm) title  = tm[1].trim();
  if (am) author = am[1].trim();

  const manifest = {};
  for (const m of opfText.matchAll(/<item\s[^>]*>/gi)) {
    const tag = m[0];
    const idM = tag.match(/\bid="([^"]+)"/), hrefM = tag.match(/\bhref="([^"]+)"/);
    const tpM = tag.match(/\bmedia-type="([^"]+)"/), prM = tag.match(/\bproperties="([^"]+)"/);
    if (idM && hrefM) manifest[idM[1]] = { href: hrefM[1], mediaType: tpM ? tpM[1] : '', properties: prM ? prM[1] : '' };
  }

  const coverItem = Object.values(manifest).find(i =>
    i.properties.includes('cover-image') || (/image\/(jpeg|png|webp)/.test(i.mediaType) && i.href.toLowerCase().includes('cover')));
  if (coverItem) {
    try {
      const cp = resolvePath(basePath, coverItem.href);
      const cf2 = zip.files[cp] || zip.files[Object.keys(zip.files).find(k => k.endsWith(coverItem.href))];
      if (cf2) { const bytes = await cf2.async('base64'); coverBase64 = `data:${coverItem.mediaType};base64,${bytes}`; }
    } catch (e) {}
  }

  const spineIds     = [...opfText.matchAll(/idref="([^"]+)"/g)].map(m => m[1]);
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
    chapters.push({ index: chapCount++, title: chapterTitles[i] || null, html: cleaned, filename: href.split('/').pop() });
  }

  if (!chapters.length) { await loadEpubFallback(zip, title); return; }
  await addBook(title, author, chapters, coverBase64);
}

async function extractChapterTitles(zip, manifest, basePath, spineIds) {
  const titles = {};
  const ncxItem = Object.values(manifest).find(i => i.href.endsWith('.ncx') || i.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem) {
    try {
      const np = resolvePath(basePath, ncxItem.href);
      const nf = zip.files[np] || zip.files[Object.keys(zip.files).find(k => k.endsWith(ncxItem.href))];
      if (nf) {
        const nt = await nf.async('text');
        for (const m of nt.matchAll(/<navPoint[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content[^>]+src="([^"#]+)/g)) {
          const src = m[2].split('/').pop().toLowerCase();
          const si  = spineIds.findIndex(id => manifest[id] && manifest[id].href.split('/').pop().split('#')[0].toLowerCase() === src);
          if (si >= 0 && !titles[si]) titles[si] = m[1].trim();
        }
      }
    } catch (e) {}
  }
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
            const si  = spineIds.findIndex(id => manifest[id] && manifest[id].href.split('/').pop().split('#')[0].toLowerCase() === src);
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
  for (const p of parts) { if (p === '..') resolved.pop(); else if (p && p !== '.') resolved.push(p); }
  return resolved.join('/');
}

function cleanEpubHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link[^>]*>/gi, '').replace(/<img[^>]*>/gi, '')
    .replace(/class="[^"]*"/gi, '').replace(/style="[^"]*"/gi, '')
    .replace(/<\/?(?:html|head|body|meta|title)[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ').trim();
}

async function loadTxt(file) {
  const text = await file.text(), title = file.name.replace(/\.txt$/i, '');
  const html = text.split('\n').filter(l => l.trim()).map(l => `<p>${escHtml(l.trim())}</p>`).join('');
  await addBook(title, '', [{ index: 0, title: null, html, filename: '' }], null);
}

async function addBook(title, author, chapters, coverBase64) {
  const id = state.nextId++;
  await dbPut('books', { id, title, author, chapters, coverBase64: coverBase64 || null });
  state.books.push({ id, title, author });
  await savePref('nextId', state.nextId);
  await savePref('currentBookId', id);
  saveToDrive(); renderSidebar();
  await selectBook(id);
  setStatus(`"${title}" cargado — ${chapters.length} capítulo${chapters.length !== 1 ? 's' : ''}`);
}

// ═══════════════════════════════════════════════════
//  SELECCIÓN Y APERTURA
// ═══════════════════════════════════════════════════

async function selectBook(id) {
  state.currentBookId = id;
  await savePref('currentBookId', id);
  const book = state.books.find(b => b.id === id);
  if (!book) return;
  document.getElementById('book-title-display').textContent = book.title + (book.author ? ' — ' + book.author : '');
  renderSidebar(); showTab('reader'); showLoading('Abriendo libro...');
  try {
    const full = await dbGet('books', id);
    if (full?.chapters?.length) {
      await openBook(full);
    } else if (full?.html) {
      await openBook({ chapters: [{ index: 0, title: null, html: full.html, filename: '' }] });
    } else {
      document.getElementById('page-content').innerHTML =
        `<div id="empty-reader" style="padding-top:60px;">
           Este libro no tiene contenido en este dispositivo.<br><br>
           <strong style="color:var(--text)">Volvé a subir el EPUB para leerlo aquí.</strong>
         </div>`;
      clearNavState();
    }
  } catch (e) { console.error('[selectBook]', e); }
  hideLoading(); renderHighlights();
}

async function openBook(fullBook) {
  currentBookChapters = fullBook.chapters;
  totalChapters       = currentBookChapters.length;
  renderChapterSidebar();
  buildParagraphArray(currentBookChapters);
  showLoading('Preparando libro...');
  await layoutBook();
  hideLoading();
  await restorePosition();
}

// ═══════════════════════════════════════════════════
//  CONSTRUCCIÓN DE PÁRRAFOS
// ═══════════════════════════════════════════════════

const SKIP_TAGS = new Set(['script','style','head','nav','aside','figure','svg']);

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

const PARA_TAGS = new Set(['p','h1','h2','h3','h4','h5','h6','blockquote','pre','li','dt','dd']);

function extractBlocks(node, ci) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent.trim();
    const pt   = node.parentNode?.tagName?.toLowerCase() || '';
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

// ═══════════════════════════════════════════════════
//  LAYOUT — CSS COLUMNS
// ═══════════════════════════════════════════════════

async function layoutBook() {
  const container = document.getElementById('page-content');
  const viewer    = document.getElementById('reader-view');

  container.style.transition = 'none';
  container.style.transform  = 'translateX(0)';
  container.style.fontSize   = prefs.fontSize + 'px';
  currentPageIdx = 0;

  // Construir HTML completo con data-para-idx y encabezados de capítulo
  let html = '', lastCi = -1;
  for (let i = 0; i < allParagraphs.length; i++) {
    const para = allParagraphs[i];
    const ci   = para.chapterIndex;
    if (ci !== lastCi) {
      if (lastCi >= 0 && ci > 0) {
        const ch = currentBookChapters[ci];
        if (ch?.title)
          html += `<div class="chapter-header-inline" data-chapter="${ci}">${escHtml(ci + 1 + '. ' + ch.title)}</div>`;
      }
      lastCi = ci;
    }
    const withIdx = para.html.replace(/^(<[a-z][a-z0-9]*)/i, `$1 data-para-idx="${i}"`);
    html += processLinksForRender(withIdx);
  }

  container.innerHTML = html;

  // Esperar fonts y doble reflow para que CSS columns se calcule correctamente
  if (document.fonts?.ready) await document.fonts.ready;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  totalPages = computeTotalPages(container, viewer);
  buildParagraphPageMap(viewer);
  buildChapterPageMap(viewer);
  applyHighlightsToPage();
}

function computeTotalPages(container, viewer) {
  return Math.max(1, Math.round(container.scrollWidth / viewer.clientWidth));
}

function buildParagraphPageMap(viewer) {
  paragraphPageMap = {};
  const vr = viewer.getBoundingClientRect(), vw = viewer.clientWidth;
  document.getElementById('page-content').querySelectorAll('[data-para-idx]').forEach(el => {
    const idx    = parseInt(el.dataset.paraIdx, 10);
    const rect   = el.getBoundingClientRect();
    const absL   = rect.left - vr.left + currentPageIdx * vw;
    paragraphPageMap[idx] = Math.max(0, Math.round(absL / vw));
  });
}

function buildChapterPageMap(viewer) {
  chapterFirstPage = { 0: 0 };
  const vr = viewer.getBoundingClientRect(), vw = viewer.clientWidth;
  document.getElementById('page-content').querySelectorAll('[data-chapter]').forEach(el => {
    const ci   = parseInt(el.dataset.chapter, 10);
    const absL = el.getBoundingClientRect().left - vr.left + currentPageIdx * vw;
    if (!(ci in chapterFirstPage)) chapterFirstPage[ci] = Math.max(0, Math.round(absL / vw));
  });
}

function getFirstVisibleParaIdx(viewer) {
  const vr = viewer.getBoundingClientRect(), vw = viewer.clientWidth;
  const els = document.getElementById('page-content').querySelectorAll('[data-para-idx]');
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (rect.left >= vr.left - 10 && rect.left < vr.left + vw - 10) return parseInt(el.dataset.paraIdx, 10);
  }
  return 0;
}

function clearNavState() {
  currentPageIdx = 0; currentChapterIndex = 0; totalPages = 0;
  allParagraphs = []; paragraphPageMap = {}; chapterFirstPage = {};
  const c = document.getElementById('page-content');
  c.style.transition = 'none'; c.style.transform = 'translateX(0)';
  updateNavButtons(); updateStatusBar();
  document.getElementById('chapter-section').classList.remove('visible');
}

// ═══════════════════════════════════════════════════
//  NAVEGACIÓN
// ═══════════════════════════════════════════════════

function goToPage(idx, direction = null, skipTransition = false) {
  if (idx < 0 || idx >= totalPages) return;
  currentPageIdx = idx;
  const container = document.getElementById('page-content');
  const viewer    = document.getElementById('reader-view');
  container.style.transition = skipTransition ? 'none' : 'transform 0.18s ease';
  container.style.transform  = `translateX(${-idx * viewer.clientWidth}px)`;
  currentChapterIndex = getCurrentChapter(idx);
  updateStatusBar(); updateNavButtons(); updateChapterSidebar();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePosition, 600);
}

function getCurrentChapter(pageIdx) {
  let ch = 0;
  for (const [ci, fp] of Object.entries(chapterFirstPage)) {
    const c = parseInt(ci);
    if (fp <= pageIdx && c > ch) ch = c;
  }
  return ch;
}

function nextPage() { if (currentPageIdx < totalPages - 1) goToPage(currentPageIdx + 1); }
function prevPage() { if (currentPageIdx > 0)              goToPage(currentPageIdx - 1); }

function goToChapter(ci) {
  for (let i = ci; i < totalChapters; i++) { if (chapterFirstPage[i] !== undefined) { goToPage(chapterFirstPage[i]); return; } }
  for (let i = ci - 1; i >= 0; i--)        { if (chapterFirstPage[i] !== undefined) { goToPage(chapterFirstPage[i]); return; } }
}

function setupNavigation() {
  const viewer = document.getElementById('reader-view');
  viewer.addEventListener('wheel', e => { e.preventDefault(); if (e.deltaY > 0) nextPage(); else prevPage(); }, { passive: false });
  viewer.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
  let tx = 0, ty = 0;
  viewer.addEventListener('touchstart', e => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  viewer.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 45) { if (dx < 0) nextPage(); else prevPage(); }
  }, { passive: true });
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (['ArrowRight','ArrowDown','PageDown'].includes(e.key))  nextPage();
    if (['ArrowLeft', 'ArrowUp',  'PageUp'].includes(e.key))   prevPage();
  });
}

function updateNavButtons() {
  const prev = document.getElementById('btn-prev'), next = document.getElementById('btn-next');
  if (!prev || !next) return;
  prev.disabled = currentPageIdx <= 0 || !totalPages;
  next.disabled = currentPageIdx >= totalPages - 1 || !totalPages;
}

function updateStatusBar() {
  if (!totalPages) { setStatusDirect('Listo'); return; }
  const ch = currentBookChapters[currentChapterIndex];
  const cl = ch?.title ? `${currentChapterIndex + 1}. ${ch.title}` : `Cap. ${currentChapterIndex + 1} de ${totalChapters}`;
  setStatusDirect(`${cl} · Pág. ${currentPageIdx + 1} de ${totalPages}`);
}

// Hyperlinks internos
function processLinksForRender(html) {
  return html.replace(/<a(\s[^>]*)?>/gi, (match, attrs) => {
    if (!attrs) return match;
    const hm = attrs.match(/href="([^"]*)"/i);
    if (!hm) return match;
    const href = hm[1];
    if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('//'))
      return `<a${attrs} target="_blank" rel="noopener noreferrer">`;
    const parts  = href.split('#');
    const file   = parts[0] ? parts[0].split('/').pop().toLowerCase() : '';
    const anchor = (parts[1] || '').replace(/'/g, "\\'");
    return `<a${attrs} href="javascript:void(0)" onclick="handleInternalLink('${anchor}','${file.replace(/'/g, "\\'")}')">`;
  });
}

function handleInternalLink(anchor, file) {
  let pi = -1;
  if (anchor && anchorMap[anchor] !== undefined)    pi = anchorMap[anchor];
  else if (file && fileChapterMap[file] !== undefined) pi = allParagraphs.findIndex(p => p.chapterIndex === fileChapterMap[file]);
  if (pi >= 0 && paragraphPageMap[pi] !== undefined) goToPage(paragraphPageMap[pi]);
}

// Sidebar capítulos
function renderChapterSidebar() {
  const section = document.getElementById('chapter-section');
  const list    = document.getElementById('chapter-list');
  list.innerHTML = '';
  if (!currentBookChapters?.length) { section.classList.remove('visible'); return; }
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
  document.querySelectorAll('.chapter-item').forEach((el, i) => el.classList.toggle('active', i === currentChapterIndex));
  document.querySelector('.chapter-item.active')?.scrollIntoView({ block: 'nearest' });
}

// ═══════════════════════════════════════════════════
//  POSICIÓN GUARDADA
// ═══════════════════════════════════════════════════

async function savePosition() {
  if (!state.currentBookId) return;
  await savePref(`pos_${state.currentBookId}`, { pageIdx: currentPageIdx, chapterIndex: currentChapterIndex, fontSize: prefs.fontSize });
}

async function restorePosition() {
  const rec = await dbGet('prefs', `pos_${state.currentBookId}`);
  if (!rec?.value || !totalPages) { goToPage(0, null, true); return; }
  goToPage(Math.min(rec.value.pageIdx || 0, totalPages - 1), null, true);
}

// ═══════════════════════════════════════════════════
//  BOOKMARKS
// ═══════════════════════════════════════════════════

async function addBookmark() {
  if (!state.currentBookId || !totalPages) { setStatus('Primero abrí un libro'); return; }
  const ch      = currentBookChapters[currentChapterIndex];
  const chapStr = ch?.title ? `${currentChapterIndex + 1}. ${ch.title}` : `Cap. ${currentChapterIndex + 1}`;
  const label   = `${chapStr} · Pág. ${currentPageIdx + 1}`;
  const anchor  = getFirstVisibleParaIdx(document.getElementById('reader-view'));
  const id      = state.nextId++;
  await dbPut('bookmarks', { id, bookId: state.currentBookId, pageIdx: currentPageIdx, anchorParaIdx: anchor, label, ts: Date.now() });
  await savePref('nextId', state.nextId);
  setStatus('🔖 ' + label);
}

async function renderBookmarks() {
  const section = document.getElementById('bookmarks-section');
  const list    = document.getElementById('bookmarks-list');
  const bms     = await dbGetByIndex('bookmarks', 'bookId', state.currentBookId).catch(() => []);
  if (!bms?.length) { section.style.display = 'none'; return; }
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
      const target = paragraphPageMap[parseInt(btn.dataset.para)] ?? parseInt(btn.dataset.page);
      goToPage(Math.min(target, totalPages - 1));
    });
  });
  list.querySelectorAll('.bookmark-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      await dbDelete('bookmarks', parseInt(btn.dataset.id));
      renderBookmarks(); setStatus('Marcador eliminado');
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

document.addEventListener('mouseup', e => { if (!e.target.closest('#sel-toolbar')) handleSel(); });
document.addEventListener('touchend', e => { if (!e.target.closest('#sel-toolbar')) setTimeout(handleSel, 120); });
document.addEventListener('mousedown', e => { if (!e.target.closest('#sel-toolbar')) hideSel(); });

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
    const range = sel.getRangeAt(0), id = state.nextId++;
    const hl = { id, bookId: state.currentBookId, text, note: '', color: currentColor, ts: Date.now() };
    wrapRange(range, id, currentColor);
    state.highlights.push(hl); sel.removeAllRanges();
    await dbPut('highlights', hl); await savePref('nextId', state.nextId);
    saveToDrive(); renderSidebar(); setStatus('Subrayado guardado');
  } catch (e) { setStatus('Seleccioná texto dentro de un mismo párrafo'); }
  hideSel();
}

function wrapRange(range, id, color) {
  const span = document.createElement('span');
  span.className = `hl hl-${color}`; span.dataset.hlId = id;
  span.title = 'Clic para ver notas'; span.onclick = () => showTab('highlights');
  range.surroundContents(span);
}

// Con CSS columns, todo el contenido está en DOM — aplicar de una sola vez
function applyHighlightsToPage() {
  const container = document.getElementById('page-content');
  const text      = container.textContent;
  state.highlights.filter(h => h.bookId === state.currentBookId).forEach(hl => {
    if (!text.includes(hl.text) || container.querySelector(`[data-hl-id="${hl.id}"]`)) return;
    try {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf(hl.text);
        if (idx === -1 || node.parentElement.classList.contains('hl')) continue;
        const range = document.createRange();
        range.setStart(node, idx); range.setEnd(node, idx + hl.text.length);
        wrapRange(range, hl.id, hl.color);
        break;
      }
    } catch (e) {}
  });
}

async function deleteHighlight(id) {
  state.highlights = state.highlights.filter(h => h.id !== id);
  const span = document.querySelector(`[data-hl-id="${id}"]`);
  if (span) { const p = span.parentNode; while (span.firstChild) p.insertBefore(span.firstChild, span); p.removeChild(span); }
  await dbDelete('highlights', id); saveToDrive(); renderHighlights(); renderSidebar(); setStatus('Subrayado eliminado');
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
  const cb = { yellow:'rgba(253,224,71,0.30)', blue:'rgba(147,197,253,0.35)', green:'rgba(134,239,172,0.35)', pink:'rgba(249,168,212,0.35)' };
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
      const h = state.highlights.find(h => h.id === parseInt(e.target.dataset.id));
      if (h) { h.note = e.target.value; await dbPut('highlights', h); saveToDrive(); setStatus('Nota guardada'); }
    });
  });
  list.querySelectorAll('.hl-delete').forEach(btn => btn.addEventListener('click', e => deleteHighlight(parseInt(e.target.dataset.id))));
}

// ═══════════════════════════════════════════════════
//  BORRAR / LIBERAR LIBRO
// ═══════════════════════════════════════════════════

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
    state.currentBookId = null; await savePref('currentBookId', null);
    clearNavState(); currentBookChapters = [];
    document.getElementById('page-content').innerHTML = `<div id="empty-reader">Sube un libro para empezar.</div>`;
    document.getElementById('book-title-display').textContent = 'Mi Lector';
    document.getElementById('chapter-section').classList.remove('visible');
  }
  saveToDrive(); renderSidebar(); renderHighlights(); setStatus(`"${book.title}" eliminado`);
}

async function freeBookSpace(bookId) {
  const book = state.books.find(b => b.id === bookId);
  if (!book || !confirm(`¿Liberar el espacio de "${book.title}"?\n\nEl contenido se eliminará de este dispositivo, pero tus subrayados se mantienen en Drive.`)) return;
  const full = await dbGet('books', bookId);
  if (!full) return;
  await dbPut('books', { ...full, chapters: [], coverBase64: null });
  if (state.currentBookId === bookId) {
    clearNavState(); currentBookChapters = [];
    document.getElementById('page-content').innerHTML =
      `<div id="empty-reader" style="padding-top:60px;">Contenido liberado.<br><br><strong style="color:var(--text)">Volvé a subir el EPUB para leer.</strong></div>`;
    document.getElementById('chapter-section').classList.remove('visible');
  }
  setStatus('Espacio liberado — subrayados conservados');
}

// ═══════════════════════════════════════════════════
//  BIBLIOTECA
// ═══════════════════════════════════════════════════

async function renderLibrary() {
  const grid = document.getElementById('library-grid'), empty = document.getElementById('library-empty');
  grid.innerHTML = '';
  if (!state.books.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  for (const book of state.books) {
    const hlc    = state.highlights.filter(h => h.bookId === book.id).length;
    const posRec = await dbGet('prefs', `pos_${book.id}`).catch(() => null);
    const full   = await dbGet('books', book.id).catch(() => null);
    const hasCnt = full?.chapters?.length > 0;
    let prog = 'Sin progreso';
    if (posRec?.value) {
      const { chapterIndex: ci } = posRec.value;
      const ch = hasCnt && full.chapters[ci];
      if (ch?.title) prog = `${ci + 1}. ${ch.title}`;
      else if (hasCnt) prog = `Cap. ${(ci || 0) + 1} de ${full.chapters.length}`;
    }
    const card = document.createElement('div');
    card.className = 'book-card';
    const coverHtml = full?.coverBase64
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

// ═══════════════════════════════════════════════════
//  UI
// ═══════════════════════════════════════════════════

function showTab(tab) {
  document.querySelectorAll('.tab').forEach((t, i) =>
    t.classList.toggle('active', ['reader','highlights','library'][i] === tab));
  document.getElementById('reader-view').style.display     = tab === 'reader'     ? 'block' : 'none';
  document.getElementById('highlights-view').style.display = tab === 'highlights' ? 'flex'  : 'none';
  document.getElementById('library-view').style.display    = tab === 'library'    ? 'flex'  : 'none';
  if (tab === 'highlights') { renderHighlights(); renderBookmarks(); }
  if (tab === 'library')    renderLibrary();
}

document.getElementById('reader-view').style.display     = 'block';
document.getElementById('highlights-view').style.display = 'none';
document.getElementById('library-view').style.display    = 'none';

function renderSidebar() {
  const list = document.getElementById('book-list');
  list.innerHTML = '';
  if (!state.books.length) { list.innerHTML = '<p style="font-size:12px;color:#555;padding:16px 12px;line-height:1.6;">Sube un epub o txt para empezar</p>'; return; }
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
  const bhs = state.highlights.filter(h => h.bookId === state.currentBookId);
  const book = state.books.find(b => b.id === state.currentBookId);
  if (!bhs.length) { setStatus('No hay subrayados para exportar'); return; }
  let txt = `SUBRAYADOS — ${book ? book.title.toUpperCase() : 'LIBRO'}\n${'═'.repeat(50)}\n\n`;
  bhs.forEach((h, i) => { txt += `${i + 1}. "${h.text}"\n`; if (h.note) txt += `   → ${h.note}\n`; txt += '\n'; });
  txt += `Exportado el ${new Date().toLocaleDateString('es-ES')}`;
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = 'subrayados.txt'; a.click(); URL.revokeObjectURL(url);
  setStatus('Archivo exportado');
}

let statusTimer = null;
function setStatus(msg) {
  document.getElementById('status-text').textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(updateStatusBar, 2500);
}
function setStatusDirect(msg) { document.getElementById('status-text').textContent = msg; }
function showLoading(msg) { document.getElementById('loading-text').textContent = msg || 'Cargando...'; document.getElementById('loading').style.display = 'flex'; }
function hideLoading()    { document.getElementById('loading').style.display = 'none'; }

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
