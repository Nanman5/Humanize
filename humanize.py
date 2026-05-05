"""AI-detection reduction pipeline.

Three presets:
  - light:   metadata strip + JPEG re-encode only (fast, lowest quality hit)
  - strong:  full pipeline (upscale/rotate/crop/noise/screenshot/JPEG)
  - iphone:  strong + lens vignette + Display P3 ICC + plausible iPhone EXIF.
             Output looks like a real iPhone capture, not a scrubbed AI image.

Pipeline (strong/iphone presets):
  1. Drops all metadata (kills C2PA manifest, XMP CreatorTool, EXIF Software)
  2. Upscales +7%, micro-rotates 0.4 deg, crops borders, resizes back -
     breaks pixel-aligned watermark structures
  3. Adds imperceptible Gaussian noise - disrupts diffusion-model
     frequency-domain fingerprints
  4. (iphone only) Subtle radial vignette - mimics phone lens falloff
  5. Screenshots through real Chromium - introduces the actual display
     compositor's fingerprint (different JPEG/PNG encoder, ICC handling,
     subpixel resampling). Replaces the old per-channel regrade.
  6. Re-encodes as JPEG with 4:2:2 subsampling, optimized, progressive
  7. (iphone only) Embeds Display P3 ICC profile + plausible iPhone EXIF

SynthID CAVEAT: this pipeline degrades but does not guarantee neutralizing
Google's SynthID watermark. Full neutralization requires img2img through a
different model.
"""
import io

import numpy as np
from PIL import Image, ImageCms

from iphone_camouflage import (
    apply_vignette,
    build_iphone_exif,
    get_display_p3_icc,
)
from screenshot import screenshot as chrome_screenshot


VALID_PRESETS = ("light", "strong", "iphone")


def process_image_bytes(src_bytes: bytes, preset: str = "strong") -> bytes:
    if preset not in VALID_PRESETS:
        raise ValueError(f"unknown preset {preset!r}; expected one of {VALID_PRESETS}")

    img = Image.open(io.BytesIO(src_bytes)).convert("RGB")
    w, h = img.size

    if preset == "light":
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=95, optimize=True,
                 subsampling=1, progressive=True)
        return buf.getvalue()

    scale_up = 1.07
    img = img.resize((int(w * scale_up), int(h * scale_up)), Image.LANCZOS)
    img = img.rotate(0.4, resample=Image.BICUBIC, expand=False)

    cw, ch = img.size
    border = max(6, int(min(cw, ch) * 0.005))
    img = img.crop((border, border, cw - border, ch - border))
    img = img.resize((w, h), Image.LANCZOS)

    arr = np.asarray(img).astype(np.float32)
    noise = np.random.normal(0.0, 1.8, arr.shape)
    arr = np.clip(arr + noise, 0, 255)

    if preset == "iphone":
        arr = apply_vignette(arr)

    interim = Image.fromarray(arr.astype(np.uint8))
    interim_buf = io.BytesIO()
    interim.save(interim_buf, "JPEG", quality=95)

    captured_png = chrome_screenshot(interim_buf.getvalue(), src_mime="image/jpeg")
    out = Image.open(io.BytesIO(captured_png)).convert("RGB")

    save_kwargs = dict(format="JPEG", quality=92, optimize=True,
                       subsampling=1, progressive=True)

    if preset == "iphone":
        icc = get_display_p3_icc()
        if icc:
            # Pixels coming out of Chromium are sRGB (we forced
            # --force-color-profile=srgb). Tagging them as Display P3
            # without converting would make color-managed viewers
            # over-saturate (warm shift on skin/reds). Convert pixels
            # to P3 space first, then embed the P3 ICC.
            srgb_profile = ImageCms.createProfile("sRGB")
            p3_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            out = ImageCms.profileToProfile(
                out, srgb_profile, p3_profile, outputMode="RGB"
            )
            save_kwargs["icc_profile"] = icc
        save_kwargs["exif"] = build_iphone_exif(w, h)

    buf = io.BytesIO()
    out.save(buf, **save_kwargs)
    return buf.getvalue()
