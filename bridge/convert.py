"""HMIS V4 DICOM bridge — DICOM → PNG conversion.

Handles the HS70A's output formats (reimplemented from the discarded
prototype, per the project handoff):
- YBR_* photometric interpretations → RGB colour-space conversion
- MONOCHROME1 → inverted so bright = echogenic, as expected
- Non-uint8 pixel data → windowed (WindowCenter/Width if present, else min–max)
- Multi-frame cine clips → middle frame extracted (flagged is_multiframe)
"""
import logging

import numpy as np
from PIL import Image
from pydicom.dataset import Dataset
from pydicom.pixels import convert_color_space

log = logging.getLogger("bridge.convert")


def _first_float(value):
    """WindowCenter/Width may be single- or multi-valued — return first as float."""
    if value is None:
        return None
    try:
        return float(value[0])
    except (TypeError, IndexError):
        pass
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _window(arr: np.ndarray, ds: Dataset) -> np.ndarray:
    """Scale non-uint8 grayscale pixel data to uint8 using DICOM windowing."""
    arr = arr.astype(np.float64)

    center = _first_float(getattr(ds, "WindowCenter", None))
    width = _first_float(getattr(ds, "WindowWidth", None))

    if center is not None and width is not None and width > 1:
        lo = center - width / 2.0
        hi = center + width / 2.0
        arr = np.clip(arr, lo, hi)
        arr = (arr - lo) / (hi - lo) * 255.0
    else:
        lo, hi = float(arr.min()), float(arr.max())
        if hi > lo:
            arr = (arr - lo) / (hi - lo) * 255.0
        else:
            arr = np.zeros_like(arr)

    return arr.astype(np.uint8)


def dicom_to_png(ds: Dataset, out_path: str) -> dict:
    """Convert a pydicom Dataset's pixel data to a PNG file.

    Returns metadata: {"is_multiframe": bool, "frames": int}
    """
    arr = ds.pixel_array  # decompresses via pylibjpeg handlers as needed

    # --- Multi-frame (cine clip): take the middle frame ---
    frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    is_multiframe = frames > 1
    if is_multiframe:
        arr = arr[frames // 2]

    photometric = str(getattr(ds, "PhotometricInterpretation", "")).upper()

    if photometric.startswith("YBR"):
        # Colour ultrasound stored as YBR — convert to RGB
        arr = convert_color_space(arr, photometric, "RGB", per_frame=False)
        img = Image.fromarray(arr.astype(np.uint8), mode="RGB")
    elif arr.ndim == 3 and arr.shape[-1] == 3:
        # Already RGB
        img = Image.fromarray(arr.astype(np.uint8), mode="RGB")
    else:
        # Grayscale — window to uint8 if needed
        if arr.dtype != np.uint8:
            arr = _window(arr, ds)
        if photometric == "MONOCHROME1":
            arr = 255 - arr  # invert: MONOCHROME1 stores bright-as-low
        img = Image.fromarray(arr, mode="L")

    img.save(out_path, format="PNG")
    log.info("Converted %s -> %s (%s, %d frame(s))",
             getattr(ds, "SOPInstanceUID", "?"), out_path, photometric or "?", frames)
    return {"is_multiframe": is_multiframe, "frames": frames}
