export interface CropTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function coverScale(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
): number {
  return Math.max(targetW / srcW, targetH / srcH);
}

export function defaultCrop(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
): CropTransform {
  return {
    scale: coverScale(srcW, srcH, targetW, targetH),
    offsetX: 0,
    offsetY: 0,
  };
}

export function clampCrop(
  t: CropTransform,
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
): CropTransform {
  const minScale = coverScale(srcW, srcH, targetW, targetH);
  const scale = Math.max(minScale, t.scale);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const maxOffX = (drawW - targetW) / 2 / scale;
  const maxOffY = (drawH - targetH) / 2 / scale;
  const offsetX = Math.max(-maxOffX, Math.min(maxOffX, t.offsetX));
  const offsetY = Math.max(-maxOffY, Math.min(maxOffY, t.offsetY));
  return { scale, offsetX, offsetY };
}

function renderToCanvas(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap | HTMLCanvasElement,
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  t: CropTransform,
) {
  const drawW = srcW * t.scale;
  const drawH = srcH * t.scale;
  const dx = (targetW - drawW) / 2 + t.offsetX * t.scale;
  const dy = (targetH - drawH) / 2 + t.offsetY * t.scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap as CanvasImageSource, dx, dy, drawW, drawH);
}

export async function renderCrop(
  bitmap: ImageBitmap,
  targetW: number,
  targetH: number,
  transform: CropTransform,
  outType: "image/jpeg" | "image/png" = "image/jpeg",
  quality = 0.92,
): Promise<Blob> {
  const w = Math.round(targetW);
  const h = Math.round(targetH);
  if (w < 1 || h < 1 || w > 16384 || h > 16384) {
    throw new Error("dimensiones fuera de rango (1–16384)");
  }

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no se pudo obtener contexto 2D");
    renderToCanvas(ctx, bitmap, bitmap.width, bitmap.height, w, h, transform);
    return await canvas.convertToBlob({ type: outType, quality });
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no se pudo obtener contexto 2D");
  renderToCanvas(ctx, bitmap, bitmap.width, bitmap.height, w, h, transform);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob devolvió null"))),
      outType,
      quality,
    );
  });
}

export async function resizeCover(
  blob: Blob,
  targetW: number,
  targetH: number,
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const outType: "image/jpeg" | "image/png" =
      blob.type === "image/png" ? "image/png" : "image/jpeg";
    const transform = defaultCrop(
      bitmap.width,
      bitmap.height,
      targetW,
      targetH,
    );
    return await renderCrop(bitmap, targetW, targetH, transform, outType);
  } finally {
    bitmap.close();
  }
}

export function renameWithSize(
  name: string,
  w: number,
  h: number,
  forceJpegIfPng = false,
): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot).toLowerCase() : ".jpg";
  if (forceJpegIfPng && ext === ".png") ext = ".jpg";
  return `${stem}_${w}x${h}${ext}`;
}
