"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { zipSync } from "fflate";
import { PRESET_GROUPS, RESIZE_PRESETS, findPreset } from "@/lib/presets";
import {
  type CropTransform,
  clampCrop,
  defaultCrop,
  renameWithSize,
  renderCrop,
} from "@/lib/resize";
import { CropEditor } from "./CropEditor";

type Status = "pending" | "loading" | "ready" | "processing" | "done" | "error";

interface Job {
  id: string;
  file: File;
  sourceUrl: string;
  bitmap?: ImageBitmap;
  transform?: CropTransform;
  status: Status;
  resultUrl?: string;
  resultBlob?: Blob;
  resultName?: string;
  error?: string;
}

export default function ResizePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [w, setW] = useState(1152);
  const [h, setH] = useState(2048);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const activePresetId = findPreset(w, h)?.id;

  // Cleanup
  useEffect(() => {
    return () => {
      jobs.forEach((j) => {
        URL.revokeObjectURL(j.sourceUrl);
        if (j.resultUrl) URL.revokeObjectURL(j.resultUrl);
        j.bitmap?.close();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Decode bitmaps for new files
  useEffect(() => {
    const pending = jobs.filter((j) => !j.bitmap && j.status === "pending");
    if (!pending.length) return;
    let cancelled = false;

    pending.forEach(async (job) => {
      try {
        const bitmap = await createImageBitmap(job.file);
        if (cancelled) {
          bitmap.close();
          return;
        }
        setJobs((prev) =>
          prev.map((j) =>
            j.id === job.id
              ? {
                  ...j,
                  bitmap,
                  transform: defaultCrop(bitmap.width, bitmap.height, w, h),
                  status: "ready" as const,
                }
              : j,
          ),
        );
      } catch (e) {
        if (cancelled) return;
        setJobs((prev) =>
          prev.map((j) =>
            j.id === job.id
              ? {
                  ...j,
                  status: "error" as const,
                  error:
                    e instanceof Error ? e.message : "no se pudo decodificar",
                }
              : j,
          ),
        );
      }
    });

    setJobs((prev) =>
      prev.map((j) =>
        pending.find((p) => p.id === j.id) ? { ...j, status: "loading" } : j,
      ),
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.length]);

  // When target dims change, clamp every transform so the image still covers the new frame
  useEffect(() => {
    setJobs((prev) =>
      prev.map((j) => {
        if (!j.bitmap || !j.transform) return j;
        return {
          ...j,
          transform: clampCrop(j.transform, j.bitmap.width, j.bitmap.height, w, h),
        };
      }),
    );
  }, [w, h]);

  const addFiles = useCallback(
    (files: FileList | File[] | null | undefined) => {
      if (!files) return;
      const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (!arr.length) return;
      setJobs((prev) => {
        prev.forEach((j) => {
          URL.revokeObjectURL(j.sourceUrl);
          if (j.resultUrl) URL.revokeObjectURL(j.resultUrl);
          j.bitmap?.close();
        });
        return arr.map((f) => ({
          id:
            globalThis.crypto?.randomUUID?.() ??
            `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file: f,
          sourceUrl: URL.createObjectURL(f),
          status: "pending" as const,
        }));
      });
    },
    [],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  function updateTransform(id: string, transform: CropTransform) {
    setJobs((prev) =>
      prev.map((j) => (j.id === id ? { ...j, transform } : j)),
    );
  }

  function resetTransform(id: string) {
    setJobs((prev) =>
      prev.map((j) => {
        if (j.id !== id || !j.bitmap) return j;
        return {
          ...j,
          transform: defaultCrop(j.bitmap.width, j.bitmap.height, w, h),
        };
      }),
    );
  }

  async function processAll() {
    if (busy || !jobs.length) return;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return;
    setBusy(true);
    setJobs((prev) =>
      prev.map((j) => {
        if (j.resultUrl) URL.revokeObjectURL(j.resultUrl);
        return j.bitmap && j.transform
          ? {
              ...j,
              status: "processing" as const,
              error: undefined,
              resultUrl: undefined,
              resultBlob: undefined,
              resultName: undefined,
            }
          : j;
      }),
    );

    const targets = jobs.filter((j) => j.bitmap && j.transform);
    const results = await Promise.all(
      targets.map(async (job) => {
        try {
          const outType: "image/jpeg" | "image/png" =
            job.file.type === "image/png" ? "image/png" : "image/jpeg";
          const blob = await renderCrop(
            job.bitmap!,
            w,
            h,
            job.transform!,
            outType,
          );
          const forceJpeg = job.file.type !== "image/png";
          const resultName = renameWithSize(job.file.name, w, h, forceJpeg);
          return {
            id: job.id,
            patch: {
              status: "done" as const,
              resultBlob: blob,
              resultUrl: URL.createObjectURL(blob),
              resultName,
            } satisfies Partial<Job>,
          };
        } catch (e) {
          return {
            id: job.id,
            patch: {
              status: "error" as const,
              error: e instanceof Error ? e.message : "error desconocido",
            } satisfies Partial<Job>,
          };
        }
      }),
    );

    setJobs((prev) =>
      prev.map((j) => {
        const r = results.find((x) => x.id === j.id);
        return r ? { ...j, ...r.patch } : j;
      }),
    );
    setBusy(false);
  }

  async function downloadZip() {
    const done = jobs.filter((j) => j.status === "done" && j.resultBlob);
    if (!done.length) return;
    const seen = new Map<string, number>();
    const fileMap: Record<string, Uint8Array> = {};
    for (const j of done) {
      const baseName = j.resultName || `resized_${w}x${h}.jpg`;
      const dot = baseName.lastIndexOf(".");
      const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
      const ext = dot > 0 ? baseName.slice(dot) : "";
      const count = seen.get(baseName) ?? 0;
      seen.set(baseName, count + 1);
      const finalName = count === 0 ? baseName : `${stem}_${count}${ext}`;
      const buf = new Uint8Array(await j.resultBlob!.arrayBuffer());
      fileMap[finalName] = buf;
    }
    const zipped = zipSync(fileMap, { level: 0 });
    const ab = zipped.buffer.slice(
      zipped.byteOffset,
      zipped.byteOffset + zipped.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([ab], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `resized_${w}x${h}_batch.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function clearAll() {
    setJobs((prev) => {
      prev.forEach((j) => {
        URL.revokeObjectURL(j.sourceUrl);
        if (j.resultUrl) URL.revokeObjectURL(j.resultUrl);
        j.bitmap?.close();
      });
      return [];
    });
    if (inputRef.current) inputRef.current.value = "";
  }

  const doneCount = jobs.filter((j) => j.status === "done").length;
  const errorCount = jobs.filter((j) => j.status === "error").length;
  const readyCount = jobs.filter(
    (j) => j.status === "ready" || j.status === "done",
  ).length;
  const totalKB = jobs.reduce((sum, j) => sum + j.file.size, 0) / 1024;

  return (
    <main className="container">
      <header className="header">
        <div>
          <h1 className="title">Resize</h1>
          <p className="subtitle">
            Encuadre manual estilo iPhone Photos · arrastrá para mover, scroll o slider para zoom
          </p>
        </div>
        <nav className="nav-links">
          <Link href="/" className="ghost">
            Humanize
          </Link>
          <Link href="/resize" className="ghost active">
            Resize
          </Link>
          {jobs.length > 0 && (
            <button className="ghost" onClick={clearAll} type="button">
              Limpiar ({jobs.length})
            </button>
          )}
        </nav>
      </header>

      <section className="card">
        <label
          className={dragging ? "dropzone dragging" : "dropzone"}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => addFiles(e.target.files)}
            hidden
          />
          {jobs.length > 0 ? (
            <>
              <strong>
                {jobs.length} {jobs.length === 1 ? "imagen" : "imágenes"} ·{" "}
                {totalKB.toFixed(0)} KB
              </strong>
              <small>click para reemplazar la selección</small>
            </>
          ) : (
            <>
              <strong>Arrastra una o varias imágenes</strong>
              <small>JPG, PNG, WebP · soporta múltiples archivos</small>
            </>
          )}
        </label>

        <div className="preset-groups">
          {PRESET_GROUPS.map((group) => (
            <div key={group} className="preset-group">
              <h3 className="preset-group-title">{group}</h3>
              <div className="preset-chips">
                {RESIZE_PRESETS.filter((p) => p.group === group).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={
                      activePresetId === p.id ? "chip active" : "chip"
                    }
                    onClick={() => {
                      setW(p.w);
                      setH(p.h);
                    }}
                  >
                    <strong>{p.label}</strong>
                    <small>
                      {p.w}×{p.h}
                    </small>
                  </button>
                ))}
              </div>
            </div>
          ))}

          <div className="preset-group">
            <h3 className="preset-group-title">Custom</h3>
            <div className="custom-dims">
              <label>
                <span>Ancho</span>
                <input
                  type="number"
                  min={1}
                  max={16384}
                  value={w}
                  onChange={(e) => setW(Number(e.target.value) || 0)}
                />
              </label>
              <span className="dim-sep">×</span>
              <label>
                <span>Alto</span>
                <input
                  type="number"
                  min={1}
                  max={16384}
                  value={h}
                  onChange={(e) => setH(Number(e.target.value) || 0)}
                />
              </label>
              <span className="dim-px">px</span>
            </div>
          </div>
        </div>

        <div className="actions">
          <button
            className="primary"
            disabled={!readyCount || busy || w < 1 || h < 1}
            onClick={processAll}
            type="button"
          >
            {busy ? (
              <>
                <span className="spinner" aria-hidden />
                Procesando...
              </>
            ) : (
              `Procesar ${readyCount || ""} → ${w}×${h}`.trim()
            )}
          </button>
          {doneCount > 0 && (
            <button
              className="secondary"
              onClick={downloadZip}
              type="button"
              disabled={busy}
            >
              Descargar zip ({doneCount})
            </button>
          )}
        </div>

        {errorCount > 0 && (
          <p className="error">
            {errorCount} {errorCount === 1 ? "imagen falló" : "imágenes fallaron"}
          </p>
        )}
      </section>

      {jobs.length > 0 && (
        <section className="batch-grid editor-grid">
          {jobs.map((j) => (
            <article key={j.id} className={`job-card status-${j.status}`}>
              {j.bitmap && j.transform ? (
                <CropEditor
                  bitmap={j.bitmap}
                  targetW={w}
                  targetH={h}
                  transform={j.transform}
                  onChange={(t) => updateTransform(j.id, t)}
                  onReset={() => resetTransform(j.id)}
                />
              ) : (
                <div className="crop-frame placeholder">
                  {j.status === "error" ? (
                    <span className="placeholder-icon">!</span>
                  ) : (
                    <span className="spinner" aria-hidden />
                  )}
                </div>
              )}

              <div className="job-meta">
                <span className="job-name" title={j.file.name}>
                  {j.file.name}
                </span>
                <span className={`status-tag status-${j.status}`}>
                  {j.status === "pending" && "..."}
                  {j.status === "loading" && "cargando"}
                  {j.status === "ready" && "listo"}
                  {j.status === "processing" && "procesando"}
                  {j.status === "done" && "exportado"}
                  {j.status === "error" && "error"}
                </span>
              </div>
              {j.status === "error" && j.error && (
                <p className="job-error">{j.error}</p>
              )}
              {j.status === "done" && j.resultUrl && (
                <a
                  className="download"
                  href={j.resultUrl}
                  download={j.resultName}
                >
                  Descargar {w}×{h}
                </a>
              )}
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
