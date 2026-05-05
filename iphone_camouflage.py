"""iPhone camouflage layer.

Fakes a plausible iPhone capture pipeline on top of the strong humanize output:

  - Subtle radial vignette (real lenses darken corners ~3-5%)
  - Display P3 ICC profile (iPhones since iPhone 7 default to Display P3)
  - Plausible iPhone EXIF: Make/Model/Software, capture timestamp,
    exposure/aperture/ISO/focal length, lens model
  - DCIM-style filename: IMG_XXXX.JPG

Why: the strong humanize preset strips ALL metadata, which is itself a flag.
Real camera output has rich, internally-consistent EXIF. We re-add it so the
file looks like a normal phone photo, not a scrubbed AI image.
"""
import io
import random
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import piexif
from PIL import Image


_ICC_PATH = Path(__file__).parent / "displayP3.icc"
_DISPLAY_P3_ICC = _ICC_PATH.read_bytes() if _ICC_PATH.exists() else None


# A small pool of plausible iPhone models with matching lens specs.
# Keep entries internally consistent (Apple metadata cross-references model).
IPHONE_PROFILES = [
    {
        "model": b"iPhone 15 Pro",
        "software": b"17.6.1",
        "lens_model": b"iPhone 15 Pro back triple camera 6.86mm f/1.78",
        "lens_spec": ((122, 100), (1500, 100), (95, 100), (28, 10)),
        "focal_mm": (686, 100),
        "focal_35mm": 24,
        "fnumber": (178, 100),
    },
    {
        "model": b"iPhone 15 Pro Max",
        "software": b"18.1",
        "lens_model": b"iPhone 15 Pro Max back triple camera 6.86mm f/1.78",
        "lens_spec": ((122, 100), (1500, 100), (95, 100), (28, 10)),
        "focal_mm": (686, 100),
        "focal_35mm": 24,
        "fnumber": (178, 100),
    },
    {
        "model": b"iPhone 14 Pro",
        "software": b"17.5.1",
        "lens_model": b"iPhone 14 Pro back triple camera 6.86mm f/1.78",
        "lens_spec": ((122, 100), (1500, 100), (95, 100), (28, 10)),
        "focal_mm": (686, 100),
        "focal_35mm": 24,
        "fnumber": (178, 100),
    },
]


def apply_vignette(arr: np.ndarray, strength: float = 0.045) -> np.ndarray:
    """Multiply by a radial mask that fades to (1 - strength) at corners."""
    h, w = arr.shape[:2]
    cy, cx = h / 2.0, w / 2.0
    y = np.arange(h, dtype=np.float32).reshape(-1, 1)
    x = np.arange(w, dtype=np.float32).reshape(1, -1)
    r = np.sqrt(((x - cx) / cx) ** 2 + ((y - cy) / cy) ** 2) / np.sqrt(2.0)
    mask = (1.0 - r * strength).astype(np.float32)
    out = arr.astype(np.float32) * mask[..., None]
    return np.clip(out, 0, 255)


def _random_timestamp(now: datetime | None = None) -> datetime:
    """Pick a timestamp within the last ~30 days, at a plausible daylight hour."""
    base = now or datetime.now()
    days_back = random.randint(0, 30)
    hour = random.randint(9, 21)
    minute = random.randint(0, 59)
    second = random.randint(0, 59)
    ts = base - timedelta(days=days_back)
    return ts.replace(hour=hour, minute=minute, second=second, microsecond=0)


def _exif_datetime(ts: datetime) -> bytes:
    return ts.strftime("%Y:%m:%d %H:%M:%S").encode("ascii")


def build_iphone_exif(width: int, height: int, profile: dict | None = None) -> bytes:
    """Generates a piexif-compatible EXIF byte blob for an iPhone capture
    that was edited/cropped in the Photos app.

    The capture vs modify timestamp split is the key signal: when DateTime
    (modify) > DateTimeOriginal (capture), forensic tools treat the image
    as edited, so any dimension that doesn't match the camera's native
    output is expected (it's a crop) instead of suspicious.
    """
    p = profile or random.choice(IPHONE_PROFILES)
    capture_ts = _random_timestamp()
    # Modification happens 5-360 minutes after capture - the user took the
    # photo, opened Photos, cropped it, exported. Plausible, internally
    # consistent.
    modify_ts = capture_ts + timedelta(minutes=random.randint(5, 360))
    iso = random.choice([50, 64, 100, 125, 160, 200, 250, 320])
    # ExposureTime: 1/exp_denom; pick from a plausible daylight range
    exp_denom = random.choice([60, 80, 100, 120, 160, 200, 250, 320, 500, 640])
    # APEX shutter speed: -log2(t)
    shutter_apex = round(-np.log2(1.0 / exp_denom) * 1000)
    sub_sec = f"{random.randint(100, 999)}".encode("ascii")
    sub_sec_modify = f"{random.randint(100, 999)}".encode("ascii")
    img_w_bytes = max(1, width)
    img_h_bytes = max(1, height)

    # SubjectArea: real iPhone shots place this near the focus point, sized
    # to the detected face/subject. Use a centered, modest box so it lines
    # up plausibly regardless of crop ratio.
    subj_w = max(100, min(img_w_bytes, img_h_bytes) // 3)
    subj_h = subj_w  # square detection box, like face detection

    zeroth = {
        piexif.ImageIFD.Make: b"Apple",
        piexif.ImageIFD.Model: p["model"],
        piexif.ImageIFD.Software: p["software"],
        piexif.ImageIFD.Orientation: 1,
        piexif.ImageIFD.XResolution: (72, 1),
        piexif.ImageIFD.YResolution: (72, 1),
        piexif.ImageIFD.ResolutionUnit: 2,
        piexif.ImageIFD.YCbCrPositioning: 1,
        # Modify timestamp - this is the canonical "edited" signal.
        piexif.ImageIFD.DateTime: _exif_datetime(modify_ts),
        piexif.ImageIFD.HostComputer: p["model"],
    }
    exif = {
        piexif.ExifIFD.ExposureTime: (1, exp_denom),
        piexif.ExifIFD.FNumber: p["fnumber"],
        piexif.ExifIFD.ExposureProgram: 2,
        piexif.ExifIFD.ISOSpeedRatings: iso,
        piexif.ExifIFD.SensitivityType: 2,
        piexif.ExifIFD.ExifVersion: b"0232",
        # Original capture - distinct from modify time above.
        piexif.ExifIFD.DateTimeOriginal: _exif_datetime(capture_ts),
        piexif.ExifIFD.DateTimeDigitized: _exif_datetime(capture_ts),
        piexif.ExifIFD.OffsetTime: b"-03:00",
        piexif.ExifIFD.OffsetTimeOriginal: b"-03:00",
        piexif.ExifIFD.OffsetTimeDigitized: b"-03:00",
        piexif.ExifIFD.SubSecTime: sub_sec_modify,
        piexif.ExifIFD.SubSecTimeOriginal: sub_sec,
        piexif.ExifIFD.SubSecTimeDigitized: sub_sec,
        piexif.ExifIFD.ComponentsConfiguration: b"\x01\x02\x03\x00",
        piexif.ExifIFD.ShutterSpeedValue: (int(shutter_apex), 1000),
        piexif.ExifIFD.ApertureValue: (1657, 1000),
        piexif.ExifIFD.BrightnessValue: (random.randint(2000, 5000), 1000),
        piexif.ExifIFD.ExposureBiasValue: (0, 1),
        piexif.ExifIFD.MeteringMode: 5,
        piexif.ExifIFD.Flash: 16,
        piexif.ExifIFD.FocalLength: p["focal_mm"],
        piexif.ExifIFD.SubjectArea: (img_w_bytes // 2, img_h_bytes // 2, subj_w, subj_h),
        piexif.ExifIFD.FlashpixVersion: b"0100",
        piexif.ExifIFD.ColorSpace: 65535,
        piexif.ExifIFD.PixelXDimension: img_w_bytes,
        piexif.ExifIFD.PixelYDimension: img_h_bytes,
        piexif.ExifIFD.SensingMethod: 2,
        piexif.ExifIFD.SceneType: b"\x01",
        # CustomRendered=1 = "custom image processing applied" - what iPhone
        # sets when Smart HDR / Photos edits run. Justifies arbitrary dims.
        piexif.ExifIFD.CustomRendered: 1,
        piexif.ExifIFD.ExposureMode: 0,
        piexif.ExifIFD.WhiteBalance: 0,
        piexif.ExifIFD.DigitalZoomRatio: (1, 1),
        piexif.ExifIFD.FocalLengthIn35mmFilm: p["focal_35mm"],
        piexif.ExifIFD.SceneCaptureType: 0,
        piexif.ExifIFD.LensSpecification: p["lens_spec"],
        piexif.ExifIFD.LensMake: b"Apple",
        piexif.ExifIFD.LensModel: p["lens_model"],
    }
    return piexif.dump({"0th": zeroth, "Exif": exif, "GPS": {}, "1st": {}, "thumbnail": None})


def random_dcim_name() -> str:
    """Return an IMG_XXXX style filename stem (no extension)."""
    return f"IMG_{random.randint(1, 9999):04d}"


def get_display_p3_icc() -> bytes | None:
    return _DISPLAY_P3_ICC
