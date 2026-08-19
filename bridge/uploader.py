"""HMIS V4 DICOM bridge — upload queue.

Each converted image becomes a job: a PNG plus a JSON sidecar in QUEUE_DIR.
An uploader thread POSTs jobs to the HMIS API; on failure (no internet — the
clinic connection is intermittent) jobs stay queued and are retried every
RETRY_INTERVAL_SECONDS. Successful (and duplicate) jobs are removed.

The API is idempotent on sopInstanceUid, so retrying a job that actually
landed is safe.
"""
import json
import logging
import threading
import time
import uuid
from pathlib import Path

import requests

import config

log = logging.getLogger("bridge.uploader")

INGEST_URL = f"{config.HMIS_API_URL}/ultrasound/ingest"


def enqueue(png_path: Path, metadata: dict) -> Path:
    """Add a job to the upload queue. Returns the sidecar path."""
    job_id = uuid.uuid4().hex
    queued_png = config.QUEUE_DIR / f"{job_id}.png"
    sidecar = config.QUEUE_DIR / f"{job_id}.json"

    # Copy the PNG into the queue dir (the incoming copy stays as archive)
    queued_png.write_bytes(Path(png_path).read_bytes())
    sidecar.write_text(json.dumps(metadata, indent=2))
    log.info("Queued %s (%s)", job_id, metadata.get("sopInstanceUid"))
    return sidecar


def _upload_job(sidecar: Path) -> bool:
    """Attempt one job. True = done (uploaded or duplicate), False = retry later."""
    png_path = sidecar.with_suffix(".png")
    if not png_path.exists():
        log.warning("Job %s has no PNG — dropping", sidecar.name)
        sidecar.unlink(missing_ok=True)
        return True

    try:
        metadata = json.loads(sidecar.read_text())
    except json.JSONDecodeError:
        log.error("Job %s sidecar unreadable — dropping", sidecar.name)
        sidecar.unlink(missing_ok=True)
        png_path.unlink(missing_ok=True)
        return True

    try:
        with open(png_path, "rb") as f:
            resp = requests.post(
                INGEST_URL,
                headers={"x-ingest-key": config.INGEST_API_KEY},
                files={"file": (metadata.get("fileName", "image.png"), f, "image/png")},
                data={
                    "sopInstanceUid": metadata["sopInstanceUid"],
                    "dicomPatientId": metadata["dicomPatientId"],
                    "patientName": metadata.get("patientName") or "",
                    "patientBirthDate": metadata.get("patientBirthDate") or "",
                    "studyInstanceUid": metadata.get("studyInstanceUid") or "",
                    "studyDate": metadata.get("studyDate") or "",
                    "studyDescription": metadata.get("studyDescription") or "",
                    "isMultiframe": "true" if metadata.get("isMultiframe") else "false",
                    "receivedAt": metadata.get("receivedAt") or "",
                },
                timeout=config.UPLOAD_TIMEOUT_SECONDS,
            )
    except requests.RequestException as exc:
        log.warning("Upload failed (will retry): %s", exc)
        return False

    if resp.status_code in (200, 201):
        body = {}
        try:
            body = resp.json()
        except ValueError:
            pass
        dup = body.get("data", {}).get("duplicate")
        log.info("Uploaded %s%s", metadata["sopInstanceUid"], " (duplicate)" if dup else "")
        sidecar.unlink(missing_ok=True)
        png_path.unlink(missing_ok=True)
        return True

    if resp.status_code in (400, 401, 503):
        # Bad job or server-side config problem — keep queued but log loudly:
        # 401 = key mismatch, 503 = INGEST_API_KEY unset on server.
        log.error("Server rejected %s: HTTP %s %s",
                  metadata["sopInstanceUid"], resp.status_code, resp.text[:200])
        return False

    log.warning("Unexpected HTTP %s for %s — will retry", resp.status_code, metadata["sopInstanceUid"])
    return False


def drain_queue() -> None:
    """Try every queued job once (oldest first)."""
    for sidecar in sorted(config.QUEUE_DIR.glob("*.json")):
        _upload_job(sidecar)


def start_uploader_thread(stop_event: threading.Event) -> threading.Thread:
    """Background thread: drain the queue, then poll for new/retry jobs."""
    def run():
        log.info("Uploader thread started (retry every %ss)", config.RETRY_INTERVAL_SECONDS)
        while not stop_event.is_set():
            try:
                drain_queue()
            except Exception:
                log.exception("Uploader pass failed")
            stop_event.wait(config.RETRY_INTERVAL_SECONDS)

    thread = threading.Thread(target=run, name="uploader", daemon=True)
    thread.start()
    return thread
