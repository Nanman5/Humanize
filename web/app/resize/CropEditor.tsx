"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type CropTransform,
  clampCrop,
  coverScale,
} from "@/lib/resize";

interface Props {
  bitmap: ImageBitmap;
  targetW: number;
  targetH: number;
  transform: CropTransform;
  onChange: (t: CropTransform) => void;
  onReset?: () => void;
  maxDisplaySize?: number;
}

export function CropEditor({
  bitmap,
  targetW,
  targetH,
  transform,
  onChange,
  onReset,
  maxDisplaySize = 280,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{
    x: number;
    y: number;
    transform: CropTransform;
  } | null>(null);
  const pointerId = useRef<number | null>(null);

  const { displayW, displayH, displayRatio } = useMemo(() => {
    const aspect = targetW / targetH;
    let w: number;
    let h: number;
    if (aspect >= 1) {
      w = maxDisplaySize;
      h = maxDisplaySize / aspect;
    } else {
      h = maxDisplaySize;
      w = maxDisplaySize * aspect;
    }
    return { displayW: w, displayH: h, displayRatio: w / targetW };
  }, [targetW, targetH, maxDisplaySize]);

  const minScale = useMemo(
    () => coverScale(bitmap.width, bitmap.height, targetW, targetH),
    [bitmap.width, bitmap.height, targetW, targetH],
  );

  const zoom = transform.scale / minScale;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(displayW * dpr);
    canvas.height = Math.round(displayH * dpr);
    canvas.style.width = `${displayW}px`;
    canvas.style.height = `${displayH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0a0a0d";
    ctx.fillRect(0, 0, displayW, displayH);

    const drawW = bitmap.width * transform.scale * displayRatio;
    const drawH = bitmap.height * transform.scale * displayRatio;
    const dx =
      (displayW - drawW) / 2 + transform.offsetX * transform.scale * displayRatio;
    const dy =
      (displayH - drawH) / 2 + transform.offsetY * transform.scale * displayRatio;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(bitmap, dx, dy, drawW, drawH);
  }, [bitmap, displayW, displayH, displayRatio, transform]);

  function applyDelta(deltaDispX: number, deltaDispY: number, base: CropTransform) {
    const dxSrc = deltaDispX / (base.scale * displayRatio);
    const dySrc = deltaDispY / (base.scale * displayRatio);
    const next = clampCrop(
      {
        scale: base.scale,
        offsetX: base.offsetX + dxSrc,
        offsetY: base.offsetY + dySrc,
      },
      bitmap.width,
      bitmap.height,
      targetW,
      targetH,
    );
    onChange(next);
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    pointerId.current = e.pointerId;
    setDragging(true);
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      transform,
    };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragging || !dragStart.current) return;
    e.preventDefault();
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    applyDelta(dx, dy, dragStart.current.transform);
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (canvas && pointerId.current !== null) {
      try {
        canvas.releasePointerCapture(pointerId.current);
      } catch {}
    }
    pointerId.current = null;
    setDragging(false);
    dragStart.current = null;
    e.preventDefault();
  }

  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = clampCrop(
      { ...transform, scale: transform.scale * factor },
      bitmap.width,
      bitmap.height,
      targetW,
      targetH,
    );
    onChange(next);
  }

  function handleZoomChange(value: number) {
    const next = clampCrop(
      { ...transform, scale: minScale * value },
      bitmap.width,
      bitmap.height,
      targetW,
      targetH,
    );
    onChange(next);
  }

  return (
    <div className="crop-editor">
      <div
        className="crop-frame"
        style={{ width: displayW, height: displayH }}
      >
        <canvas
          ref={canvasRef}
          className={dragging ? "crop-canvas dragging" : "crop-canvas"}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        />
      </div>
      <div className="crop-controls">
        <input
          type="range"
          className="zoom-slider"
          min={1}
          max={4}
          step={0.01}
          value={Math.min(4, Math.max(1, zoom))}
          onChange={(e) => handleZoomChange(Number(e.target.value))}
          aria-label="Zoom"
        />
        <span className="zoom-value">{zoom.toFixed(2)}×</span>
        {onReset && (
          <button
            type="button"
            className="ghost crop-reset"
            onClick={onReset}
            disabled={
              zoom < 1.001 &&
              Math.abs(transform.offsetX) < 0.5 &&
              Math.abs(transform.offsetY) < 0.5
            }
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
