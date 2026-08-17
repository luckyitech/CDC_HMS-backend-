"""HMIS V4 — HS70A simulator.

Generates synthetic ultrasound DICOMs and sends them to the bridge over real
DICOM C-STORE, exactly as the HS70A would. Lets you exercise the ENTIRE
pipeline (bridge → convert → upload → HMIS gallery → PDF export) on a
laptop with no ultrasound machine.

Usage:
    python send_test_study.py <UHID>                 # 4 images incl. 1 cine clip
    python send_test_study.py <UHID> --count 7       # more stills
    python send_test_study.py UNKNOWN-123            # exercise the Unassigned queue
    python send_test_study.py <UHID> --host 127.0.0.1 --port 11112

The bridge must be running (python main.py). Watch the HMIS patient chart's
Ultrasound tab — images should appear live within ~2 s of the upload.
"""
import argparse
import sys
from datetime import datetime

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
from pynetdicom import AE

US_IMAGE = "1.2.840.10008.5.1.4.1.1.6.1"        # Ultrasound Image Storage
US_MULTI = "1.2.840.10008.5.1.4.1.1.3.1"        # Ultrasound Multi-frame Image Storage

# One study per simulator run — all images share this UID (groups in the Studio)
STUDY_UID = generate_uid()

# Demographics stamped on every image (override with --name / --dob)
PATIENT_NAME = "SIMULATED^PATIENT"
PATIENT_DOB = "19900115"


def _base(sop_class: str, patient_id: str, description: str) -> Dataset:
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = sop_class
    ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID
    ds.PatientID = patient_id
    ds.PatientName = PATIENT_NAME
    ds.PatientBirthDate = PATIENT_DOB
    ds.StudyInstanceUID = STUDY_UID
    ds.StudyDate = datetime.now().strftime("%Y%m%d")
    ds.StudyDescription = description
    ds.Modality = "US"
    return ds


def _speckle(rows: int, cols: int, seed: int) -> np.ndarray:
    """Ultrasound-ish speckle: dark sector fan with bright structures."""
    rng = np.random.default_rng(seed)
    img = (rng.gamma(2.0, 28.0, (rows, cols))).clip(0, 255)
    yy, xx = np.mgrid[0:rows, 0:cols]
    # fan-shaped sector mask (apex top-centre)
    dx = (xx - cols / 2) / (cols / 2)
    dy = yy / rows
    mask = (np.abs(dx) < dy * 0.9 + 0.05) & (dy > 0.02)
    img[~mask] = 0
    # a bright rounded "structure"
    cy, cx = int(rows * 0.55), int(cols * 0.5) + (seed % 5 - 2) * 20
    rr = (yy - cy) ** 2 + (xx - cx) ** 2
    img[rr < (rows * 0.12) ** 2] = np.clip(img[rr < (rows * 0.12) ** 2] + 90, 0, 255)
    return img.astype(np.uint8)


def make_still(patient_id: str, idx: int) -> Dataset:
    ds = _base(US_IMAGE, patient_id, f"Simulated view {idx}")
    arr = _speckle(480, 640, idx)
    ds.Rows, ds.Columns = arr.shape
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.PixelData = arr.tobytes()
    return ds


def make_mono1_still(patient_id: str, idx: int) -> Dataset:
    """16-bit MONOCHROME1 — exercises windowing + inversion in convert.py."""
    ds = _base(US_IMAGE, patient_id, f"Simulated view {idx} (mono1)")
    arr = (4095 - _speckle(480, 640, idx).astype(np.uint16) * 16)
    ds.Rows, ds.Columns = arr.shape
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME1"
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.WindowCenter = 2048
    ds.WindowWidth = 4096
    ds.PixelData = arr.tobytes()
    return ds


def make_color_still(patient_id: str, idx: int) -> Dataset:
    """RGB still — like a colour-Doppler capture."""
    ds = _base(US_IMAGE, patient_id, f"Simulated Doppler {idx}")
    gray = _speckle(480, 640, idx)
    arr = np.stack([gray, gray, gray], axis=-1)
    # red/blue "flow" patches
    arr[200:280, 250:330, 0] = 220
    arr[220:300, 330:400, 2] = 220
    ds.Rows, ds.Columns = arr.shape[:2]
    ds.SamplesPerPixel = 3
    ds.PhotometricInterpretation = "RGB"
    ds.PlanarConfiguration = 0
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.PixelData = arr.tobytes()
    return ds


def make_cine(patient_id: str, frames: int = 12) -> Dataset:
    ds = _base(US_MULTI, patient_id, "Simulated cine clip")
    stack = np.stack([_speckle(300, 400, 100 + i) for i in range(frames)])
    ds.NumberOfFrames = frames
    ds.Rows, ds.Columns = stack.shape[1:3]
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.PixelData = stack.tobytes()
    return ds


def send(ds: Dataset, host: str, port: int, ae_title: str) -> bool:
    ae = AE(ae_title="HS70A_SIM")
    ae.add_requested_context(ds.SOPClassUID, ExplicitVRLittleEndian)
    assoc = ae.associate(host, port, ae_title=ae_title)
    if not assoc.is_established:
        print(f"  ✗ could not associate with {host}:{port} (AE {ae_title}) — is the bridge running?")
        return False
    status = assoc.send_c_store(ds)
    assoc.release()
    ok = status and status.Status == 0x0000
    print(f"  {'✓' if ok else '✗'} {ds.StudyDescription}  (status 0x{status.Status:04X})" if status
          else f"  ✗ {ds.StudyDescription} — no response")
    return ok


def main():
    p = argparse.ArgumentParser(description="Send synthetic ultrasound DICOMs to the bridge (HS70A simulator)")
    p.add_argument("uhid", help="Patient ID to stamp on the images (the UHID, or an unknown ID to test the Unassigned queue)")
    p.add_argument("--count", type=int, default=4, help="Total images to send (default 4; last one is a cine clip)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=11112)
    p.add_argument("--ae", default="WARDPC", help="Called AE title (default WARDPC)")
    p.add_argument("--name", default="SIMULATED^PATIENT", help="DICOM patient name, LAST^FIRST")
    p.add_argument("--dob", default="19900115", help="Patient birth date, YYYYMMDD")
    args = p.parse_args()

    global PATIENT_NAME, PATIENT_DOB
    PATIENT_NAME = args.name
    PATIENT_DOB = args.dob

    print(f"Sending {args.count} simulated image(s) for patient '{args.uhid}' → {args.host}:{args.port}")
    makers = [make_still, make_mono1_still, make_color_still]
    sent = 0
    for i in range(1, args.count):
        ds = makers[(i - 1) % len(makers)](args.uhid, i)
        sent += send(ds, args.host, args.port, args.ae)
    # last one: cine clip (exercises middle-frame extraction + CLIP badge)
    sent += send(make_cine(args.uhid), args.host, args.port, args.ae)

    print(f"Done: {sent}/{args.count} accepted. Check the Ultrasound tab (or Admin → Ultrasound Queue).")
    sys.exit(0 if sent == args.count else 1)


if __name__ == "__main__":
    main()
