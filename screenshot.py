"""Headless Chromium screenshot pass.

Passes each image through a real display compositor (Chromium via
Playwright). Adds the genuine fingerprint of "rendered on a screen and
captured":

  - Different ICC handling (Chromium converts to the screen's color space)
  - Different JPEG/PNG encoder than Pillow (libjpeg-turbo via Skia)
  - Subpixel resampling from the rasterizer
  - Compositor gamma + dithering quirks

Compared to a regrade or noise pass, this is harder for detectors to
fingerprint because the transformation is the actual screen pipeline,
not a mathematical perturbation a detector can be trained against.

Implementation notes
--------------------
- Playwright sync API is bound to the thread that started it. We keep a
  per-thread Playwright + Browser via threading.local; the FastAPI
  threadpool reuses ~N threads, so we end up with ~N browsers (each ~150MB
  RAM). Browser launch is ~1-2s; subsequent screenshots are ~150-300ms.
- We never close the browser; it dies with the worker thread. This is
  fine for a long-lived dev server. For prod, register an atexit hook.
"""
import atexit
import base64
import io
import threading

from PIL import Image
from playwright.sync_api import Browser, sync_playwright


_local = threading.local()
_all_browsers: list[Browser] = []
_browsers_lock = threading.Lock()


def _get_browser() -> Browser:
    """Lazy per-thread Chromium. First call in a thread takes ~1-2s."""
    if not hasattr(_local, "browser"):
        pw = sync_playwright().start()
        browser = pw.chromium.launch(
            args=[
                "--no-sandbox",
                "--disable-gpu",
                # Render in sRGB regardless of the display profile. Without
                # this, on a Display P3 monitor (any modern Mac) Chromium
                # bakes the display profile into the screenshot pixels but
                # emits no ICC tag, so downstream viewers interpret the
                # P3-gamut values as sRGB and over-saturate (warm shift).
                "--force-color-profile=srgb",
                "--disable-features=ColorCorrectRendering",
            ],
        )
        _local.pw = pw
        _local.browser = browser
        with _browsers_lock:
            _all_browsers.append(browser)
    return _local.browser


def screenshot(img_bytes: bytes, src_mime: str = "image/jpeg") -> bytes:
    """Round-trip image through Chromium; return PNG bytes."""
    img = Image.open(io.BytesIO(img_bytes))
    w, h = img.size

    b64 = base64.b64encode(img_bytes).decode("ascii")
    html = (
        "<!doctype html><html><head><style>"
        "html,body{margin:0;padding:0;background:#000;}"
        f"img{{display:block;width:{w}px;height:{h}px;}}"
        "</style></head>"
        f'<body><img src="data:{src_mime};base64,{b64}"></body></html>'
    )

    browser = _get_browser()
    context = browser.new_context(
        viewport={"width": w, "height": h},
        device_scale_factor=1,
    )
    try:
        page = context.new_page()
        page.set_content(html, wait_until="load")
        return page.screenshot(type="png", full_page=False)
    finally:
        context.close()


@atexit.register
def _shutdown() -> None:
    with _browsers_lock:
        for b in _all_browsers:
            try:
                b.close()
            except Exception:
                pass
