"""FastAPI server exposing the humanize pipeline.

Replaces the Gradio frontend so a Next.js client can drive the same
pipeline over HTTP. Run with:

    .venv/bin/uvicorn api:app --port 8000 --reload
"""
import asyncio

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from humanize import VALID_PRESETS, process_image_bytes
from iphone_camouflage import random_dcim_name


app = FastAPI(title="Humanize API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "presets": list(VALID_PRESETS)}


@app.post("/api/humanize")
async def humanize(
    file: UploadFile = File(...),
    preset: str = Form("strong"),
) -> Response:
    if preset not in VALID_PRESETS:
        raise HTTPException(400, f"invalid preset {preset!r}; expected {VALID_PRESETS}")

    src = await file.read()
    if not src:
        raise HTTPException(400, "empty upload")

    try:
        out = await asyncio.to_thread(process_image_bytes, src, preset=preset)
    except Exception as exc:
        raise HTTPException(500, f"pipeline error: {exc}") from exc

    name = f"{random_dcim_name()}.JPG" if preset == "iphone" else "humanized.jpg"
    return Response(
        content=out,
        media_type="image/jpeg",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )
