# Resize a resoluciones exactas

## Objetivo

Permitir redimensionar imágenes a dimensiones exactas (ej: 1152×2048) desde la web, tanto como herramienta independiente como paso opcional dentro del pipeline de humanize.

## Decisiones

- **Cliente-side (Canvas API).** El resize es trivial; no hace sentido round-trip a Python. Cero cambios en `humanize.py` / `api.py`. Cero dependencias nuevas.
- **Modo cover.** La imagen escala para llenar el rectángulo y recorta lo que sobra (centrado). El usuario indicó que las diferencias de aspect ratio serán mínimas, por lo que el recorte invisible es preferible a letterbox (bandas) o stretch (deformación).
- **Doble integración.** Página standalone `/resize` + sección opcional en la página de humanize.

## Arquitectura

```
web/lib/presets.ts   ← lista única de presets (tipada, agrupada por categoría)
web/lib/resize.ts    ← función pura resizeCover(blob, w, h): Promise<Blob>
web/app/resize/      ← página standalone
web/app/page.tsx     ← página existente; agrega sección "Resize después de humanizar"
```

### `resizeCover(blob, w, h)`

```ts
export async function resizeCover(blob: Blob, w: number, h: number): Promise<Blob>
```

- `createImageBitmap(blob)` decodifica la imagen.
- Calcula factor de escala = `max(w / srcW, h / srcH)` (cover).
- Calcula offsets centrados.
- Pinta en `OffscreenCanvas(w, h)` con `drawImage(img, sx, sy, sw, sh, 0, 0, w, h)`.
- `convertToBlob({ type: blob.type === "image/png" ? "image/png" : "image/jpeg", quality: 0.92 })`.

Mantener formato del blob de entrada (PNG → PNG, cualquier otro → JPEG q=0.92, que es lo que el backend ya devuelve).

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

1. Dropzone (multi-archivo).
2. Selector de preset: chips agrupados por categoría + dos inputs `W` y `H` que se sincronizan con el chip activo (clickear un chip rellena los inputs; editar los inputs deselecciona el chip).
3. Botón "Procesar" → corre `resizeCover` por archivo en paralelo (`Promise.all`).
4. Grid de resultados con preview + descarga individual.
5. Botón "Descargar ZIP" cuando hay ≥1 resultado.

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
