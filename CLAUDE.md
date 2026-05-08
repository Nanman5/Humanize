# Humanize

AI-detection reduction pipeline for images. Takes outputs from image generators (Midjourney, DALL·E, Imagen/Gemini, SD/Flux, ChatGPT) and post-processes them so they read as captures from a real device — most strongly, an iPhone.

> **For agents adapting this into another project**: skip to "Adapting to a new codebase" below. Everything you need is in three Python files plus one ICC asset.

---

## Architecture

```
src bytes ──► humanize.py ──► out bytes
                  │
                  ├─ iphone_camouflage.py   (vignette, EXIF, ICC loader)
                  └─ screenshot.py          (Chromium pass via Playwright)

Wrappers (interchangeable):
  app.py     — Gradio standalone UI (single-file, no JS build)
  api.py     — FastAPI backend (used by web/)
  web/       — Next.js 15 + React 19 batch UI with zip download
```

The pipeline lives in **`humanize.py`**. `process_image_bytes(src_bytes, preset)` is the only entry point you need.

## Pipeline (strong / iphone presets)

1. **Strip metadata** — re-decode through Pillow. Kills C2PA manifest, XMP CreatorTool, EXIF Software (the dead-giveaways for AI generators).
2. **Geometric warp** — upscale +7%, micro-rotate 0.4°, crop borders, resize back. Breaks pixel-aligned watermark structures (e.g. older Stable Diffusion grids, some C2PA spatial signatures).
3. **Gaussian noise σ=1.8** — disrupts diffusion-model frequency-domain fingerprints. Imperceptible at normal viewing distance.
4. **Vignette** (iphone only) — radial darkening ~4.5% at corners. Mimics phone lens falloff.
5. **Chromium screenshot pass** — saves intermediate JPEG, renders it in headless Chromium (Playwright), captures viewport as PNG. Replaces the older per-channel regrade. Chromium is launched with `--force-color-profile=srgb` so screenshot pixels stay in sRGB regardless of the host display profile (Macs default to Display P3 and would otherwise warm-shift the output).
6. **Final JPEG** — q=92, 4:2:2 subsampling, optimized, progressive.
7. **iPhone camouflage** (iphone only):
   - Convert pixels sRGB → Display P3 via `ImageCms` (so embedded P3 ICC tag matches the actual gamut)
   - Embed Display P3 ICC profile
   - Embed plausible iPhone EXIF: random profile from `IPHONE_PROFILES`, capture timestamp 0–30 days ago, modify timestamp 5–360 min later, plausible exposure/ISO/lens/focal data, `CustomRendered=1`. The capture/modify split is the key signal — forensic tools treat the file as edited, so dimensions that don't match the camera's native output are expected (it's a crop) instead of suspicious.
8. (light preset) — only does step 1 + JPEG q=95 re-encode.

## What this does NOT defeat

- **Google SynthID** — embedded in the latent space of Imagen/Gemini outputs, survives JPEG/resize/noise. Needs img2img through a different model (SD/Flux with denoise 0.2–0.3) before this pipeline.
- **Detectors trained with augmentations** (Hive, Sensity, recent academic SOTA) — they learn to ignore noise/JPEG/resize. The screenshot pass helps but isn't a guarantee. Combine with img2img for serious evasion.
- **Perceptual hashing against known-AI datasets** — if the image has circulated publicly before, hash matches regardless of post-processing. You need semantic variation (img2img), not pixel filters.
- **Semantic AI tells** — six fingers, deformed text, impossible lighting, AI-typical compositions. No filter fixes content; fix it at generation.

---

## Adapting to a new codebase

The pipeline is **four files** with no app-specific coupling:

```
humanize.py            ← orchestration; only public function: process_image_bytes
iphone_camouflage.py   ← vignette + EXIF builder + ICC loader
screenshot.py          ← Chromium pass (optional, see below)
displayP3.icc          ← required asset for iphone preset
```

### Minimum viable port

1. Copy those four files into the target project (anywhere on `sys.path`).
2. Add to requirements: `pillow numpy piexif`. If you keep the Chromium pass, also `playwright` and run `playwright install chromium` once (~300MB).
3. Call:
   ```python
   from humanize import process_image_bytes
   out_bytes = process_image_bytes(src_bytes, preset="iphone")
   ```
   That's it. Output is JPEG bytes ready to write to disk or stream over HTTP.

### Skipping Chromium (lighter port)

If the 300MB Chromium dep is a non-starter:

1. In `humanize.py`, delete the `from screenshot import ...` line and the `chrome_screenshot(...)` call (steps 5/6 of the pipeline).
2. Re-add a per-channel regrade in its place — it's a weaker substitute but keeps the channel-statistics evasion vector. Use `np.random.uniform(0.004, 0.008)` magnitude with random sign so the image isn't consistently warm or cool.

### Async / batch usage

`process_image_bytes` is synchronous. The Chromium pass uses `playwright.sync_api`, which **cannot** be called from inside an async event loop. From FastAPI/async code, wrap with `asyncio.to_thread` (see `api.py`). The Playwright browser is per-thread (via `threading.local`), so the FastAPI thread pool naturally parallelizes — N workers = N Chromium instances. Steady-state throughput is ~125ms per image on Apple Silicon.

---

## Knobs (tune these to taste)

| Location | Knob | Effect |
|---|---|---|
| `humanize.py` `noise = np.random.normal(0.0, 1.8, ...)` | noise sigma | Higher = stronger evasion, more visible grain. Range 1.5–3.0 is reasonable. |
| `humanize.py` `img.rotate(0.4, ...)` | rotation degrees | Higher = stronger resample artifact, visible past ~0.8°. |
| `humanize.py` `scale_up = 1.07` | upscale factor | Combined with the rotate+crop, controls how much pixel grid is destroyed. |
| `humanize.py` save quality `92` | final JPEG quality | 88–95 typical. Lower = smaller file, more compression artifacts. |
| `iphone_camouflage.py` `apply_vignette(arr, strength=0.045)` | vignette strength | 0.03–0.06 plausible for phone lenses. |
| `iphone_camouflage.py` `IPHONE_PROFILES` | EXIF persona pool | Add/swap entries. Keep Make/Model/Software/lens fields internally consistent. |
| `iphone_camouflage.py` `_random_timestamp(...)` | capture timestamp window | Currently last ~30 days, 9am–9pm. |
| `screenshot.py` browser launch args | rendering | `--force-color-profile=srgb` is critical — without it, macOS Display P3 displays warm-shift the output. |

## Adding a new device persona (e.g. Samsung, Pixel)

1. Add an entry to `IPHONE_PROFILES` (rename the constant if you're branching out): Make, Model, Software, LensModel, LensSpecification, focal_mm, focal_35mm, fnumber.
2. The capture/modify timestamp split (step 7 of the pipeline) is the key forensic signal. Keep it.
3. If targeting a non-iPhone device, drop the Display P3 ICC step — sRGB is more common outside Apple. Just remove the `ImageCms.profileToProfile` call and the `icc_profile` save kwarg.

---

## Project layout

```
.
├── api.py                  FastAPI HTTP wrapper around process_image_bytes
├── app.py                  Gradio standalone UI (alternative to web/)
├── humanize.py             Pipeline orchestration
├── iphone_camouflage.py    Vignette, EXIF builder, ICC loader, DCIM filename
├── screenshot.py           Chromium pass via Playwright
├── displayP3.icc           Display P3 ICC profile (required asset)
├── requirements.txt        pillow / numpy / piexif / fastapi / playwright / gradio
├── CLAUDE.md               This file
└── web/                    Next.js batch UI (App Router, TypeScript, fflate for client-side zip)
    ├── app/page.tsx        Drag-and-drop, parallel processing, zip download
    ├── app/globals.css
    ├── next.config.ts      Rewrites /api/* to FastAPI on :8002
    └── package.json
```

## Run locally

```bash
# backend
.venv/bin/uvicorn api:app --port 8002 --reload \
  --reload-dir /Users/hernanlopez/Projects/TOOLS/Humanize

# frontend (in web/)
npm run dev   # Next on :3003
```

Or the standalone Gradio: `.venv/bin/python app.py` (auto-picks port 7860).

## Dev environment notes

- `.venv` is local; recreate with `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`.
- `playwright install chromium` is a one-time step after pip install.
- Ports in use during dev: FastAPI `:8002`, Next `:3003`. Both configurable.


<!-- BEGIN:mini-deploy -->
## Mini Deployment

This repo deploys to the home Mac mini via `git push mini`. Master doc: `~/Projects/TOOLS/MINI_DEPLOY.md`.

- **Slug / branch**: `humanize` / `main`
- **Mini paths**: bare `~/srv/humanize.git`, working tree `~/srv/humanize`
- **Stack**: Python (`requirements.txt`)
- **Auto-start (pm2)**: ❌ — code is synced and venv is built, but no service runs. Add an `ecosystem.config.js` to enable.
- **Mini venv**: `~/srv/humanize/.venv/` (built by `uv pip install -r requirements.txt`)

```bash
git push mini main
ssh statim@statims-mini.lan 'ls ~/srv/humanize/.venv/bin'
```

GitHub backup is wired through the bare repo's `github` remote (configure once with `git --git-dir=~/srv/humanize.git remote add github git@github.com:Nanman5/Humanize.git` after registering the mini's deploy key in GitHub).
<!-- END:mini-deploy -->
