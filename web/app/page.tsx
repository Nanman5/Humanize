"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { zipSync } from "fflate";

const PRESETS = [
  { id: "light", label: "Light", desc: "Solo strip de metadatos + JPEG re-encode" },
  { id: "strong", label: "Strong", desc: "Pipeline completo: ruido, regrade, JPEG" },
  { id: "iphone", label: "iPhone", desc: "Strong + vignette + EXIF iPhone + Display P3" },
] as const;

type PresetId = (typeof PRESETS)[number]["id"];
type Status = "pending" | "processing" | "done" | "error";

interface Job {
  id: string;
  file: File;
  sourceUrl: string;
  status: Status;
  resultUrl?: string;
  resultBlob?: Blob;
  resultName?: string;
  error?: string;
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [preset, setPreset] = useState<PresetId>("strong");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      jobs.forEach((j) => {
        URL.revokeObjectURL(j.sourceUrl);
        if (j.resultUrl) URL.revokeObjectURL(j.resultUrl);
      });
    };
  }, [jobs]);

  const addFiles = useCallback(
    (files: FileList | File[] | null | undefined) => {
      if (!files) return;
      const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (!arr.length) return;
      setJobs((prev) => {
        prev.forEach((j) => {
          URL.revokeObjectURL(j.sourceUrl);
          if (j.resultUrl) URL.revokeObjectURL(j.resultUrl);
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

  async function processOne(job: Job): Promise<Partial<Job>> {
    const fd = new FormData();
    fd.append("file", job.file);
    fd.append("preset", preset);
    const res = await fetch("/api/humanize", { method: "POST", body: fd });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") || "";
    const match = cd.match(/filename="([^"]+)"/);
    const resultName = match ? match[1] : "humanized.jpg";
    return {
      status: "done",
      resultBlob: blob,
      resultUrl: URL.createObjectURL(blob),
      resultName,
    };
  }

  async function processAll() {
    if (busy || !jobs.length) return;
    setBusy(true);
    setJobs((prev) =>
      prev.map((j) => ({
        ...j,
        status: "processing" as const,
        error: undefined,
        resultUrl: j.resultUrl
          ? (URL.revokeObjectURL(j.resultUrl), undefined)
          : undefined,
        resultBlob: undefined,
        resultName: undefined,
      })),
    );

    const targets = jobs.map((j) => ({ id: j.id, file: j.file }));

    const results = await Promise.all(
      targets.map(async (t) => {
        try {
          const updated = await processOne({
            id: t.id,
            file: t.file,
            sourceUrl: "",
            status: "processing",
          });
          return { id: t.id, patch: updated };
        } catch (e) {
          return {
            id: t.id,
            patch: {
              status: "error" as const,
              error: e instanceof Error ? e.message : "error desconocido",
            },
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
      const baseName = j.resultName || "humanized.jpg";
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
    a.download = "humanized_batch.zip";
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
      });
      return [];
    });
    if (inputRef.current) inputRef.current.value = "";
  }

  const doneCount = jobs.filter((j) => j.status === "done").length;
  const errorCount = jobs.filter((j) => j.status === "error").length;
  const totalKB = jobs.reduce((sum, j) => sum + j.file.size, 0) / 1024;

  return (
    <main className="container">
      <header className="header">
        <div>
          <h1 className="title">Humanize</h1>
          <p className="subtitle">
            Reduce huellas de detección de IA · batch processing
          </p>
        </div>
        {jobs.length > 0 && (
          <button className="ghost" onClick={clearAll} type="button">
            Limpiar ({jobs.length})
          </button>
        )}
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

        <div className="presets" role="radiogroup" aria-label="Preset">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={preset === p.id}
              className={preset === p.id ? "preset active" : "preset"}
              onClick={() => setPreset(p.id)}
              type="button"
            >
              <strong>{p.label}</strong>
              <small>{p.desc}</small>
            </button>
          ))}
        </div>

        <div className="actions">
          <button
            className="primary"
            disabled={!jobs.length || busy}
            onClick={processAll}
            type="button"
          >
            {busy ? (
              <>
                <span className="spinner" aria-hidden />
                Procesando {jobs.length}...
              </>
            ) : (
              `Procesar ${jobs.length || ""}`.trim()
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
        <section className="batch-grid">
          {jobs.map((j) => (
            <article key={j.id} className={`job-card status-${j.status}`}>
              <div className="job-row">
                <div className="job-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={j.sourceUrl} alt="" />
                  <span className="thumb-label">Original</span>
                </div>
                <div className="job-thumb">
                  {j.resultUrl ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={j.resultUrl} alt="" />
                      <span className="thumb-label">Procesada</span>
                    </>
                  ) : (
                    <div className="thumb-placeholder">
                      {j.status === "processing" ? (
                        <span className="spinner" aria-hidden />
                      ) : j.status === "error" ? (
                        <span className="placeholder-icon">!</span>
                      ) : (
                        <span className="placeholder-icon">?</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="job-meta">
                <span className="job-name" title={j.file.name}>
                  {j.file.name}
                </span>
                <span className={`status-tag status-${j.status}`}>
                  {j.status === "pending" && "pendiente"}
                  {j.status === "processing" && "procesando"}
                  {j.status === "done" && "listo"}
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
                  Descargar
                </a>
              )}
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
