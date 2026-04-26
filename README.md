# Mi Lector — EPUB Reader

Lector de EPUB y TXT con subrayados por colores, notas, sincronización en Google Drive y soporte offline (PWA).

## Estructura del repositorio

```
mi-lector/
├── index.html        ← HTML de la app
├── styles.css        ← Estilos y variables de tema
├── app.js            ← Lógica principal (IndexedDB, Drive, UI)
├── sw.js             ← Service Worker (cache offline)
├── manifest.json     ← Manifiesto PWA (instalable)
├── icons/
│   ├── icon-192.svg  ← Ícono app (192px)
│   └── icon-512.svg  ← Ícono app (512px)
└── README.md
```

---

## 1 · Activar GitHub Pages

1. Subir todos los archivos al repositorio `joaquinrmd/mi-lector` (o al nombre que prefieras).
2. Ir a **Settings → Pages** en el repositorio de GitHub.
3. En **Source**, seleccionar `Deploy from a branch`.
4. En **Branch**, elegir `main` y carpeta `/ (root)`.
5. Guardar. GitHub Pages publicará la app en:
   `https://joaquinrmd.github.io/mi-lector/`

> **Nota:** Si el repositorio se llama exactamente `joaquinrmd.github.io`, la URL será `https://joaquinrmd.github.io/` (sin subfolder).

---

## 2 · Configurar Google Cloud Console para Drive

La app usa Google OAuth para sincronizar subrayados en Google Drive (`appDataFolder`). Al deployar en GitHub Pages hay que agregar el nuevo origen autorizado.

### Paso a paso

1. Ir a [console.cloud.google.com](https://console.cloud.google.com/).
2. Seleccionar el proyecto asociado al CLIENT_ID `602238897882-...`.
3. En el menú lateral: **APIs y servicios → Credenciales**.
4. Hacer clic en el **OAuth 2.0 Client ID** de tipo "Aplicación web".
5. En **Orígenes de JavaScript autorizados**, agregar:
   ```
   https://joaquinrmd.github.io
   ```
   (Solo el origen, sin path ni slash final.)
6. En **URIs de redireccionamiento autorizados** — para esta app no se necesita agregar nada (usa el flujo implícito de `google.accounts.oauth2`).
7. Guardar. Los cambios pueden tardar hasta 5 minutos en propagarse.

### Verificar que funciona

Abrir `https://joaquinrmd.github.io/mi-lector/` y hacer clic en **Conectar Google Drive**. Debería aparecer el popup de autenticación de Google sin errores.

---

## 3 · Instalar como app (PWA)

### iPad / iPhone (Safari)
1. Abrir `https://joaquinrmd.github.io/mi-lector/` en Safari.
2. Tocar el botón de **Compartir** (cuadrado con flecha arriba).
3. Seleccionar **Agregar a pantalla de inicio**.
4. Confirmar. La app aparecerá como ícono en el Home Screen.

### Windows / macOS (Chrome o Edge)
1. Abrir la URL en Chrome o Edge.
2. En la barra de direcciones aparece un ícono de instalación (⊕ o similar).
3. Hacer clic en **Instalar**.
4. La app se abre en su propia ventana, sin barras del navegador.

---

## 4 · Arquitectura de datos

| Almacenamiento     | Qué guarda                                      |
|--------------------|--------------------------------------------------|
| **IndexedDB**      | Contenido HTML de libros + highlights + prefs    |
| **Google Drive**   | Highlights + metadatos de libros (sin HTML)     |
| **Service Worker** | Shell de la app (HTML, CSS, JS) para offline    |

> El contenido HTML de los EPUBs **no se sube a Drive** — puede ser demasiado grande y no necesita sincronizarse (el archivo EPUB original es portátil). Si abrís la app en un dispositivo nuevo, los highlights aparecen (vienen de Drive), pero los libros hay que volver a subirlos.

---

## 5 · Temas visuales

| Tema   | Fondo       | Texto      | Uso sugerido         |
|--------|-------------|------------|----------------------|
| ☀ Día   | `#f7f4ef`  | `#1a1a1a`  | Luz natural          |
| 📜 Sepia | `#f4ecd8` | `#2c1a0e`  | Interior / tarde     |
| 🌙 Noche | `#1a1a1a` | `#e0d9ce`  | Oscuridad / noche    |

Cambiar con el botón de tema en el header. La preferencia se guarda en IndexedDB.

---

## 6 · Control de fuente

Botones **A−** y **A+** en el header ajustan el tamaño entre 14px y 22px. La preferencia persiste entre sesiones.

---

## 7 · Migración desde la versión anterior

Si tenías datos en la versión anterior del lector (guardados en `localStorage`), se migran automáticamente a IndexedDB la primera vez que abras esta versión. No se pierde nada.

---

## Fases futuras previstas

- **Fase 2:** Mejor parser EPUB (edge cases), progress tracking por libro, subir/bajar EPUBs desde Drive.
- **Fase 3:** Panel "Preparar para Obsidian" — exportar highlights como Literature Notes `.md` a una carpeta `/Lector-Inbox/` en Drive.
- **Fase 5–7:** Plugin de Obsidian (TypeScript) que detecta las notas en esa carpeta y las integra al vault Zettelkasten.
