"""HMIS V4 DICOM bridge — entry point.

Headless Storage SCP for the Samsung HS70A:
  HS70A --(DICOM C-STORE, LAN)--> this bridge --(HTTPS)--> CDC HMS API

Per received object:
  1. Save raw .dcm to incoming/{PatientID}/          (local archive)
  2. Convert pixel data to PNG                        (convert.py)
  3. Queue + upload to /api/ultrasound/ingest         (uploader.py, retries)

C-STORE returns 0x0000 immediately after the local save + conversion —
the upload happens on a background thread so the HS70A never waits on
the internet connection.

Run:  python main.py
"""
import logging
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from pynetdicom import AE, AllStoragePresentationContexts, evt
from pynetdicom.sop_class import Verification

import config
import convert
import uploader

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(config.LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("bridge")

_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def _safe_name(value: str, fallback: str) -> str:
    value = _SAFE.sub("_", str(value or "").strip())
    return value or fallback


def handle_store(event):
    """C-STORE handler. Must return quickly — the HS70A errors on slow ACKs."""
    try:
        ds = event.dataset
        ds.file_meta = event.file_meta

        sop_uid = str(getattr(ds, "SOPInstanceUID", "")) or f"NOUID.{datetime.now().timestamp()}"
        patient_id = str(getattr(ds, "PatientID", "")).strip() or "UNKNOWN"
        study_date_raw = str(getattr(ds, "StudyDate", "") or "")
        study_desc = str(getattr(ds, "StudyDescription", "") or "")
        study_uid = str(getattr(ds, "StudyInstanceUID", "") or "")
        # DICOM person names use ^ separators (MBOYA^YVETTE) — flatten to spaces
        patient_name = " ".join(str(getattr(ds, "PatientName", "") or "").split("^")).strip()
        birth_raw = str(getattr(ds, "PatientBirthDate", "") or "")
        birth_date = ""
        if len(birth_raw) == 8 and birth_raw.isdigit():
            birth_date = f"{birth_raw[0:4]}-{birth_raw[4:6]}-{birth_raw[6:8]}"

        # 1. Archive the raw DICOM locally
        patient_dir = config.INCOMING_DIR / _safe_name(patient_id, "UNKNOWN")
        patient_dir.mkdir(parents=True, exist_ok=True)
        dcm_path = patient_dir / f"{_safe_name(sop_uid, 'object')}.dcm"
        ds.save_as(dcm_path, enforce_file_format=True)

        # 2. Convert to PNG (same folder, same stem)
        png_path = dcm_path.with_suffix(".png")
        meta = convert.dicom_to_png(ds, str(png_path))

        # 3. Queue for upload (background thread drains it)
        study_date = ""
        if len(study_date_raw) == 8 and study_date_raw.isdigit():
            study_date = f"{study_date_raw[0:4]}-{study_date_raw[4:6]}-{study_date_raw[6:8]}"

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        uploader.enqueue(png_path, {
            "sopInstanceUid": sop_uid,
            "dicomPatientId": patient_id,
            "patientName": patient_name,
            "patientBirthDate": birth_date,
            "studyInstanceUid": study_uid,
            "studyDate": study_date,
            "studyDescription": study_desc,
            "isMultiframe": meta["is_multiframe"],
            "fileName": f"US_{timestamp}.png",
            "receivedAt": datetime.now(timezone.utc).isoformat(),
        })

        log.info("Stored %s for patient '%s'%s", sop_uid, patient_id,
                 " (cine clip — middle frame)" if meta["is_multiframe"] else "")
        return 0x0000
    except Exception:
        log.exception("C-STORE handling failed")
        # 0xC211: processing failure — the HS70A will show a send error
        return 0xC211


def handle_echo(event):  # noqa: ARG001 — C-ECHO (DICOM ping / "Verify")
    return 0x0000


def main():
    if not config.INGEST_API_KEY:
        log.warning("INGEST_API_KEY is not set — images will queue locally but never upload!")

    ae = AE(ae_title=config.AE_TITLE)
    # Accept every storage SOP class the machine might send (US Image Storage,
    # US Multi-frame Image Storage, Secondary Capture, ...), all transfer
    # syntaxes including JPEG-compressed (decoded by pylibjpeg on conversion).
    ae.supported_contexts = AllStoragePresentationContexts
    ae.add_supported_context(Verification)

    stop_event = threading.Event()
    uploader.start_uploader_thread(stop_event)

    handlers = [
        (evt.EVT_C_STORE, handle_store),
        (evt.EVT_C_ECHO, handle_echo),
    ]

    log.info("DICOM bridge listening on %s:%s (AE: %s) -> %s",
             config.BIND_ADDRESS, config.DICOM_PORT, config.AE_TITLE, config.HMIS_API_URL)
    try:
        ae.start_server((config.BIND_ADDRESS, config.DICOM_PORT), evt_handlers=handlers)
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        stop_event.set()


if __name__ == "__main__":
    main()
