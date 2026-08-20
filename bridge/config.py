"""HMIS V4 DICOM bridge — configuration (from .env)."""
import os
import sys
from pathlib import Path

# When frozen by PyInstaller (one-file build), __file__ lives in a temp folder
# that is wiped on exit. Anchor config + data to the folder that holds the
# executable instead, so the operator drops the single binary in a folder, puts
# .env beside it, and incoming/ queue/ bridge.log appear there and persist.
if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
else:
    APP_DIR = Path(__file__).resolve().parent

try:
    from dotenv import load_dotenv
    load_dotenv(APP_DIR / ".env")
except ImportError:
    pass  # python-dotenv optional; plain environment variables also work

BASE_DIR = APP_DIR

# --- HMIS API ---
HMIS_API_URL = os.environ.get("HMIS_API_URL", "https://api.cdiabetescentre.com/api").rstrip("/")
INGEST_API_KEY = os.environ.get("INGEST_API_KEY", "")

# --- DICOM listener ---
AE_TITLE = os.environ.get("AE_TITLE", "WARDPC")
DICOM_PORT = int(os.environ.get("DICOM_PORT", "11112"))
BIND_ADDRESS = os.environ.get("BIND_ADDRESS", "0.0.0.0")

# --- Local storage ---
INCOMING_DIR = Path(os.environ.get("INCOMING_DIR", BASE_DIR / "incoming"))
QUEUE_DIR = Path(os.environ.get("QUEUE_DIR", BASE_DIR / "queue"))
LOG_FILE = Path(os.environ.get("LOG_FILE", BASE_DIR / "bridge.log"))

# --- Upload retry ---
RETRY_INTERVAL_SECONDS = int(os.environ.get("RETRY_INTERVAL_SECONDS", "60"))
UPLOAD_TIMEOUT_SECONDS = int(os.environ.get("UPLOAD_TIMEOUT_SECONDS", "60"))

INCOMING_DIR.mkdir(parents=True, exist_ok=True)
QUEUE_DIR.mkdir(parents=True, exist_ok=True)
