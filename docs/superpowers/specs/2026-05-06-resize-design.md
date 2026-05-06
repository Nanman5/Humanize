# Resize a resoluciones exactas

## Objetivo

Permitir redimensionar imágenes a dimensiones exactas (ej: 1152×2048) desde la web, tanto como herramienta independiente como paso opcional dentro del pipeline de humanize.

## Decisiones

- **Cliente-side (Canvas API).** El resize es trivial; no hace sentido round-trip a Python. Cero cambios en `humanize.py` / `api.py`. Cero dependencias nuevas.
- **Cover con encuadre manual** (en `/resize`) **o auto-centrado** (en humanize). En la página standalone, cada imagen tiene un editor estilo iPhone Photos: arrastrar para reposicionar y zoom (rueda + slider). En el flujo humanize, sigue siendo cover automático centrado para no romper el batch.
- **Doble integración.** Página standalone `/resize` con encuadre manual + sección opcional auto-cover en la página de humanize.

## Arquitectura

```
web/lib/presets.ts   ← lista única de presets (tipada, agrupada por categoría)
web/lib/resize.ts    ← función pura resizeCover(blob, w, h): Promise<Blob>
web/app/resize/      ← página standalone
web/app/page.tsx     ← página existente; agrega sección "Resize después de humanizar"
```

### `lib/resize.ts` API

```ts
interface CropTransform { scale: number; offsetX: number; offsetY: number }

coverScale(srcW, srcH, targetW, targetH): number
defaultCrop(srcW, srcH, targetW, targetH): CropTransform
clampCrop(t, srcW, srcH, targetW, targetH): CropTransform
renderCrop(bitmap, targetW, targetH, transform, outType, quality): Promise<Blob>
resizeCover(blob, targetW, targetH): Promise<Blob>   // wrapper: defaultCrop + renderCrop
renameWithSize(name, w, h, forceJpegIfPng): string
```

- `scale` y `offset` son en espacio de la imagen fuente. `clampCrop` garantiza que la imagen aún cubre el frame.
- `renderCrop` usa `OffscreenCanvas` con fallback a `<canvas>`.
- `resizeCover` es el shortcut "automático" usado por la integración humanize.

### `app/resize/CropEditor.tsx`

Componente canvas que muestra el frame al aspect ratio target, con la imagen renderizada vía `drawImage`. Pointer events para drag (`setPointerCapture`), wheel para zoom (`Math.exp(-deltaY * 0.0015)` por tick), slider HTML range para zoom 1×–4× sobre el `coverScale` mínimo. Devuelve cambios al padre via `onChange`.

### Presets

```ts
export type Preset = { id: string; label: string; w: number; h: number; group: string };
```

Inicial:

- **Wallpapers iPhone:** 1170×2532, 1284×2778, 1290×2796, 1152×2048
- **Instagram:** 1080×1080, 1080×1350, 1080×1920
- **TikTok:** 1080×1920

Agregar uno nuevo = una línea en `presets.ts`.

### Página standalone `/resize`

Reutiliza patrones de la página actual (drag&drop, batch grid, ZIP download). UI:

1. Dropzone (multi-archivo). Cada archivo se decodifica a `ImageBitmap` async; estado por job: `pending → loading → ready`.
2. Selector de preset: chips agrupados por categoría + inputs custom W/H. Cambiar el target dispara `clampCrop` sobre todos los transforms existentes (mantienen zoom intent, recortando offsets fuera de bounds).
3. Cada job-card monta un `<CropEditor>` con su `bitmap` y `transform` (inicializado a `defaultCrop`). El usuario puede arrastrar y zoomear independientemente cada imagen.
4. "Procesar" corre `renderCrop` con el transform de cada job en paralelo.
5. Cada resultado: preview + descarga individual; botón "Descargar ZIP" cuando hay ≥1 listo.

El bitmap se mantiene vivo hasta `clearAll()` o reemplazo de archivos (memoria liberada con `bitmap.close()`).

### Integración en humanize (página existente)

En `web/app/page.tsx` agregar sección colapsable **"Resize después de humanizar"** entre los presets y el botón Procesar:

- Toggle on/off.
- Mismo selector de preset/custom (componente compartido si vale la pena, sino duplicado pequeño es ok).
- Si está activo, después de recibir el blob del backend se aplica `resizeCover` antes de guardarlo en el job.
- El nombre del archivo conserva el `.jpg` que devuelve el backend.

### Navegación

Link en el header entre `/` y `/resize`.

## Lo que NO se hace

- **No** se cambian `humanize.py`, `api.py`, ni `app.py` (Gradio). El standalone no tiene equivalente Gradio.
- **No** se agregan dependencias (Canvas API es nativa).
- **No** se implementan modos letterbox/stretch — solo cover.
- **No** se agrega un endpoint `/resize` en FastAPI (innecesario; todo client-side).

## Riesgos

- **Compatibilidad `OffscreenCanvas` / `convertToBlob`.** Soportado en Chrome 69+, Firefox 105+, Safari 16.4+. Si falla, fallback a `<canvas>` + `toBlob`. (Implementación inicial: solo OffscreenCanvas; agregar fallback solo si reportan errores.)
- **Memoria con archivos grandes.** `createImageBitmap` decodifica completo en memoria. Para imágenes >50MB podría haber pico de RAM. No hay mitigación práctica sin upload, y los inputs típicos del usuario son outputs de generadores (~4-8MB). Aceptable.
