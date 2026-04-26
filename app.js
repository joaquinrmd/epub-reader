/* ══════════════════════════════════════════════════
   Mi Lector — app.js
   Fase 1: IndexedDB + Service Worker + Temas + Fuente
   ══════════════════════════════════════════════════ */
'use strict';

// ─── CONSTANTES ───
const CLIENT_ID    = '602238897882-g752d4mbev0d2leg8fvnq7lqt6jsof8l.apps.googleusercontent.com';
const SCOPES       = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE   = 'mi-lector-data.json';
const DB_NAME      = 'mi-lector-db';
const DB_VERSION   = 1;
const FONT_MIN     = 14;
const FONT_MAX     = 22;
const THEMES       = ['day', 'sepia', 'night'];
const THEME_ICONS  = { day: '☀', sepia: '📜', night: '🌙' };

// ─── ESTADO EN MEMORIA (liviano — sin HTML de libros) ───
let state = {
  books: [],       // [{ id, title, author }]
  highlights: [],  // [{ id, bookId, text, note, color, ts }]
  currentBookId: null,
  nextId: 1
};

let prefs = {
  theme:    'day',
  fontSize: 17
};

let currentColor = 'yellow';
let driveReady   = false;
let driveFileId  = null;
let tokenClient  = null;
let driveTimer   = null;

// ═══════════════════════════════════════════════════
//  INDEXEDDB
// ═══════════════════════════════════════════════════

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const d = e.target.result;
      // books: almacena { id, title, author, html }
      if (!d.objectStoreNames.contains('books')) {
        d.createObjectStore('books', { keyPath: 'id' });
      }
      // highlights: almacena { id, bookId, text, note, color, ts }
      if (!d.objectStoreNames.contains('highlights')) {
        const hs = d.createObjectStore('highlights', { keyPath: 'id' });
        hs.createIndex('bookId', 'bookId', { unique: false });
      }
      // prefs: almacena { key, value }
      if (!d.objectStoreNames.contains('prefs')) {
        d.createObjectStore('prefs', { keyPath: 'key' });
      }
    };

    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

// Helpers genéricos con promesas
function dbOp(storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req   = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

const dbGet    = (s, k)  => dbOp(s, 'readonly',  st => st.get(k));
const dbPut    = (s, v)  => dbOp(s, 'readwrite', st => st.put(v));
const dbDelete = (s, k)  => dbOp(s, 'readwrite', st => st.delete(k));
const dbGetAll = (s)     => dbOp(s, 'readonly',  st => st.getAll());

function dbGetByIndex(storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const idx   = store.index(indexName);
    const req   = idx.getAll(value);
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

    // Si había un libro seleccionado, cargarlo
    if (state.currentBookId) {
      await selectBook(state.currentBookId);
    }
  } catch (e) {
    console.error('[Init] Error al arrancar:', e);
    setStatus('Error al iniciar — intenta recargar la página');
  }
  hideLoading();
  loadGapiScript();
  registerSW();
};

// ─── Migración desde localStorage (usuarios de v1) ───
async function migrateFromLocalStorage() {
  try {
    const raw = localStorage.getItem('mi_lector_v2');
    if (!raw) return;

    const old = JSON.parse(raw);
    console.log('[Migración] Encontrado datos en localStorage, migrando...');

    for (const book of (old.books || [])) {
      const exists = await dbGet('books', book.id);
      if (!exists) await dbPut('books', book); // conserva el html si lo tenía
    }

    for (const hl of (old.highlights || [])) {
      const exists = await dbGet('highlights', hl.id);
      if (!exists) await dbPut('highlights', hl);
    }

    if (old.nextId)        await dbPut('prefs', { key: 'nextId',        value: old.nextId });
    if (old.currentBookId) await dbPut('prefs', { key: 'currentBookId', value: old.currentBookId });

    localStorage.removeItem('mi_lector_v2');
    console.log('[Migración] Completada — localStorage limpiado');
  } catch (e) {
    console.warn('[Migración] Error:', e);
  }
}

// ─── Cargar estado desde IndexedDB ───
async function loadState() {
  const allBooks     = await dbGetAll('books');
  state.books        = allBooks.map(b => ({ id: b.id, title: b.title, author: b.author || '' }));
  state.highlights   = await dbGetAll('highlights');

  const nextIdRec    = await dbGet('prefs', 'nextId');
  state.nextId       = nextIdRec ? nextIdRec.value : 1;

  const curBookRec   = await dbGet('prefs', 'currentBookId');
  state.currentBookId = curBookRec ? curBookRec.value : null;

  const themeRec     = await dbGet('prefs', 'theme');
  prefs.theme        = themeRec ? themeRec.value : 'day';

  const fontRec      = await dbGet('prefs', 'fontSize');
  prefs.fontSize     = fontRec ? fontRec.value : 17;
}

async function savePref(key, value) {
  try { await dbPut('prefs', { key, value }); } catch (e) {}
}

// ─── Service Worker ───
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('[SW] Registrado, scope:', reg.scope))
      .catch(e  => console.warn('[SW] Error:', e));
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

      const btn  = document.getElementById('drive-btn');
      const dot  = document.getElementById('drive-dot');
      const text = document.getElementById('drive-status-text');

      btn.textContent = 'Drive conectado';
      btn.classList.add('connected');
      dot.classList.add('connected');
      text.textContent = 'Google Drive activo';

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
      fields:  'files(id,name)'
    });
    const files = res.result.files;

    if (files && files.length > 0) {
      driveFileId = files[0].id;
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
    console.error('[Drive] Error al sincronizar:', e);
    setStatus('Error sincronizando — datos locales disponibles');
  }
  hideLoading();
}

// Merge inteligente: agrega lo que no hay localmente
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
      // Solo guardamos metadatos; el HTML no existe aún en este dispositivo
      await dbPut('books', { id: b.id, title: b.title, author: b.author || '', html: '' });
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
      // Drive solo almacena metadatos + highlights (no el HTML de libros)
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
          fields:  'id'
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
      console.warn('[Drive] Error al guardar:', e);
    }
  }, 1200);
}

// ═══════════════════════════════════════════════════
//  LIBROS — CARGA Y GESTIÓN
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
  const zip  = await JSZip.loadAsync(file);
  let content = '';
  let title   = file.name.replace(/\.epub$/i, '');
  let author  = '';

  // ── Leer metadatos y spine desde el OPF ──
  const opfFile = Object.keys(zip.files).find(f => f.toLowerCase().endsWith('.opf'));
  if (opfFile) {
    const opfText = await zip.files[opfFile].async('text');

    const titleMatch  = opfText.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
    const authorMatch = opfText.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);
    if (titleMatch)  title  = titleMatch[1].trim();
    if (authorMatch) author = authorMatch[1].trim();

    // Orden del spine
    const spineIds  = [...opfText.matchAll(/idref="([^"]+)"/g)].map(m => m[1]);
    const manifestM = [...opfText.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"[^>]*>/g)];
    const manifest  = {};
    manifestM.forEach(m => { manifest[m[1]] = m[2]; });

    const basePath = opfFile.includes('/')
      ? opfFile.substring(0, opfFile.lastIndexOf('/') + 1)
      : '';

    for (const id of spineIds) {
      const href = manifest[id];
      if (!href) continue;

      const fullPath = basePath + href.split('#')[0];
      const htmlFile = zip.files[fullPath]
        || zip.files[Object.keys(zip.files).find(k => k.endsWith(href.split('#')[0]))];

      if (htmlFile) {
        const html      = await htmlFile.async('text');
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyMatch) content += bodyMatch[1] + '\n';
      }
    }
  }

  // Fallback: si no encontramos contenido vía spine
  if (!content) {
    const htmlFiles = Object.keys(zip.files)
      .filter(f => /\.(html|htm|xhtml)$/i.test(f))
      .slice(0, 30);

    for (const f of htmlFiles) {
      const html      = await zip.files[f].async('text');
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (bodyMatch) content += bodyMatch[1] + '\n';
    }
  }

  const cleanHtml = cleanEpubHtml(content);
  await addBook(title, author, cleanHtml);
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
  const text  = await file.text();
  const title = file.name.replace(/\.txt$/i, '');
  const html  = text.split('\n')
    .filter(l => l.trim())
    .map(l => `<p>${escHtml(l.trim())}</p>`)
    .join('');
  await addBook(title, '', html);
}

async function addBook(title, author, html) {
  const id = state.nextId++;

  // Guardar libro completo en IndexedDB (incluye HTML)
  await dbPut('books', { id, title, author, html });

  // Metadatos en memoria
  state.books.push({ id, title, author });

  // Persistir nextId y libro actual
  await savePref('nextId', state.nextId);
  await savePref('currentBookId', id);

  saveToDrive();
  renderSidebar();
  await selectBook(id);
  setStatus(`"${title}" cargado`);
}

async function selectBook(id) {
  state.currentBookId = id;
  await savePref('currentBookId', id);

  const book = state.books.find(b => b.id === id);
  if (!book) return;

  document.getElementById('book-title-display').textContent =
    book.title + (book.author ? ' — ' + book.author : '');

  renderSidebar();
  showTab('reader');

  // Cargar HTML del libro desde IndexedDB
  showLoading('Abriendo libro...');
  try {
    const fullBook = await dbGet('books', id);
    if (fullBook && fullBook.html) {
      renderReader(fullBook);
    } else {
      // Libro importado de otro dispositivo — no tiene HTML local
      document.getElementById('reader-view').innerHTML =
        `<div id="empty-reader" style="padding-top:60px;">
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

function renderReader(book) {
  const view = document.getElementById('reader-view');
  view.innerHTML = book.html || '';
  view.style.fontSize = prefs.fontSize + 'px';
  restoreHighlightsInDom(book.id);
}

function restoreHighlightsInDom(bookId) {
  const bookHls = state.highlights.filter(h => h.bookId === bookId);
  bookHls.forEach(h => {
    try { applyHighlightById(h); } catch (e) {}
  });
}

// ═══════════════════════════════════════════════════
//  HIGHLIGHTS — GESTIÓN
// ═══════════════════════════════════════════════════

function setColor(c) {
  currentColor = c;
  document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
  document.getElementById('color-' + c).classList.add('active');
}

// ── Selección de texto ──
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

  const readerView = document.getElementById('reader-view');
  if (!readerView.contains(sel.anchorNode)) { hideSel(); return; }

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
    const hl    = {
      id,
      bookId: state.currentBookId,
      text,
      note:  '',
      color: currentColor,
      ts:    Date.now()
    };

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
  const span         = document.createElement('span');
  span.className     = 'hl hl-' + color;
  span.dataset.hlId  = id;
  span.title         = 'Clic para ver notas';
  span.onclick       = () => showTab('highlights');
  range.surroundContents(span);
}

function applyHighlightById(hl) {
  const view   = document.getElementById('reader-view');
  const text   = hl.text;
  const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
  let node;

  while ((node = walker.nextNode())) {
    const idx = node.textContent.indexOf(text);
    if (idx === -1) continue;
    if (node.parentElement.classList.contains('hl')) continue;

    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + text.length);
    wrapRangeWithHighlight(range, hl.id, hl.color);
    break;
  }
}

async function deleteHighlight(id) {
  state.highlights = state.highlights.filter(h => h.id !== id);

  // Quitar el span del DOM y dejar el texto suelto
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

// ─── Renderizar panel de subrayados ───
function renderHighlights() {
  const list   = document.getElementById('hl-list');
  list.innerHTML = '';

  const bookHls = state.highlights.filter(h => h.bookId === state.currentBookId);

  if (bookHls.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <strong>Sin subrayados aún</strong>
      Ve a Leer, selecciona texto y presiona Subrayar
    </div>`;
    return;
  }

  const colorSolid = {
    yellow: '#ca8a04',
    blue:   '#2563eb',
    green:  '#16a34a',
    pink:   '#db2777'
  };
  const colorBg = {
    yellow: 'rgba(253,224,71,0.30)',
    blue:   'rgba(147,197,253,0.35)',
    green:  'rgba(134,239,172,0.35)',
    pink:   'rgba(249,168,212,0.35)'
  };

  bookHls.sort((a, b) => a.ts - b.ts).forEach(h => {
    const strip = colorSolid[h.color] || colorSolid.yellow;
    const bg    = colorBg[h.color]    || colorBg.yellow;

    const card = document.createElement('div');
    card.className = 'hl-card';
    card.innerHTML = `
      <div class="hl-card-inner">
        <div class="hl-strip" style="background:${strip};"></div>
        <div class="hl-card-body">
          <div class="hl-text" style="background:${bg};">${escHtml(h.text)}</div>
          <div class="hl-footer">
            <input class="hl-note" placeholder="Agregar nota..." value="${escHtml(h.note || '')}" data-id="${h.id}">
            <button class="hl-delete" data-id="${h.id}">Borrar</button>
          </div>
        </div>
      </div>`;
    list.appendChild(card);
  });

  // Guardar notas al cambiar
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

  // Borrar highlight
  list.querySelectorAll('.hl-delete').forEach(btn => {
    btn.addEventListener('click', e => deleteHighlight(parseInt(e.target.dataset.id, 10)));
  });
}

// ═══════════════════════════════════════════════════
//  UI — PESTAÑAS, SIDEBAR, EXPORT, STATUS
// ═══════════════════════════════════════════════════

function showTab(tab) {
  const tabs = document.querySelectorAll('.tab');
  tabs[0].classList.toggle('active', tab === 'reader');
  tabs[1].classList.toggle('active', tab === 'highlights');

  document.getElementById('reader-view').style.display     = tab === 'reader'     ? 'block' : 'none';
  document.getElementById('highlights-view').style.display = tab === 'highlights' ? 'flex'  : 'none';

  if (tab === 'highlights') renderHighlights();
}

// Inicializar tab visible
document.getElementById('reader-view').style.display     = 'block';
document.getElementById('highlights-view').style.display = 'none';

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
    div.onclick   = () => selectBook(b.id);
    div.innerHTML = `
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
  a.href     = url;
  a.download = 'subrayados.txt';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Archivo exportado');
}

// ─── Status bar ───
let statusTimer = null;

function setStatus(msg) {
  const el = document.getElementById('status-text');
  el.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    const count = state.highlights.filter(h => h.bookId === state.currentBookId).length;
    el.textContent = count + ' subrayado' + (count !== 1 ? 's' : '') + ' en este libro';
  }, 2500);
}

// ─── Loading overlay ───
function showLoading(msg) {
  document.getElementById('loading-text').textContent = msg || 'Cargando...';
  document.getElementById('loading').style.display = 'flex';
}

function hideLoading() {
  document.getElementById('loading').style.display = 'none';
}

// ─── Utilidades ───
function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
