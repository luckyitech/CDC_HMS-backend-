"""HMIS V4 DICOM bridge — supervisor / control channel.

Runs on the MAIN thread (keeps the process alive) after the DICOM SCP has been
started non-blocking. Every cycle it:

  1. Self-checks the listener with a local DICOM C-ECHO and rebinds it if the
     socket is wedged. This is what recovers the bridge after the Mac sleeps and
     wakes — the failure that previously left a dead listener for days and
     needed a manual `launchctl kickstart`.
  2. Sends a heartbeat to the HMS API (listener state, queue depth, last-image
     time, host/IP/version) so the Radiology Suite can show a live status chip.
  3. Applies a restart requested from the Radiology Suite "Restart listener"
     button, returned in the heartbeat response, by rebinding.

The bridge is behind NAT with a changing IP, so control is inverted: HMS never
connects in; the bridge polls out and the response carries the command.
"""
import logging
import os
import socket

import requests
from pynetdicom import AE
from pynetdicom.sop_class import Verification

import config

log = logging.getLogger("bridge.control")

# The self-check opens and releases a local association each cycle. Quiet that
# pynetdicom chatter to WARNING, but keep the C-STORE handler logs
# (pynetdicom._handlers) visible so real image receipts still show.
logging.getLogger("pynetdicom.acse").setLevel(logging.WARNING)
logging.getLogger("pynetdicom.association").setLevel(logging.WARNING)

HEARTBEAT_URL = f"{config.HMIS_API_URL}/ultrasound/bridge/heartbeat"


def listener_alive(host: str, port: int, timeout: float = 5.0) -> bool:
    """True if the local DICOM SCP accepts an association and answers C-ECHO."""
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "", None) else host
    ae = AE()
    ae.add_requested_context(Verification)
    ae.acse_timeout = timeout
    ae.dimse_timeout = timeout
    ae.network_timeout = timeout
    try:
        assoc = ae.associate(probe_host, port, ae_title=config.AE_TITLE)
    except Exception:
        return False
    if not assoc.is_established:
        try:
            assoc.release()
        except Exception:
            pass
        return False
    try:
        status = assoc.send_c_echo()
        return status is not None and getattr(status, "Status", None) == 0x0000
    except Exception:
        return False
    finally:
        try:
            assoc.release()
        except Exception:
            pass


def _local_ip() -> str:
    """Best-effort primary LAN IP (no traffic actually sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return ""
    finally:
        s.close()


def _queue_depth() -> int:
    try:
        return len(list(config.QUEUE_DIR.glob("*.json")))
    except OSError:
        return 0


def _send_heartbeat(listener_ok: bool, last_image_iso) -> bool:
    """POST status to HMS; return True if a restart was commanded back."""
    payload = {
        "bridgeId": config.BRIDGE_ID,
        "aeTitle": config.AE_TITLE,
        "host": socket.gethostname(),
        "localIp": _local_ip(),
        "version": config.BRIDGE_VERSION,
        "listenerOk": listener_ok,
        "queueDepth": _queue_depth(),
    }
    if last_image_iso:
        payload["lastImageReceivedAt"] = last_image_iso
    resp = requests.post(
        HEARTBEAT_URL,
        headers={"x-ingest-key": config.INGEST_API_KEY},
        json=payload,
        timeout=config.HEARTBEAT_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    try:
        body = resp.json()
    except ValueError:
        return False
    return bool(body.get("data", {}).get("restart"))


def supervise(stop_event, rebind, get_last_image_iso) -> None:
    log.info("Supervisor started (heartbeat + self-heal every %ss)",
             config.HEARTBEAT_INTERVAL_SECONDS)
    while not stop_event.is_set():
        alive = True
        try:
            alive = listener_alive(config.BIND_ADDRESS, config.DICOM_PORT)
            if not alive:
                log.warning("Listener self-check FAILED — rebinding DICOM server")
                rebind()
                stop_event.wait(1)
                alive = listener_alive(config.BIND_ADDRESS, config.DICOM_PORT)
                if not alive:
                    log.error("Rebind did not restore the listener; exiting for a clean relaunch")
                    os._exit(3)  # launchd/NSSM KeepAlive starts a fresh process
        except Exception:
            log.exception("Self-check/rebind failed")
            alive = False

        try:
            if _send_heartbeat(alive, get_last_image_iso()):
                log.info("Restart command received from HMS — rebinding DICOM listener")
                rebind()
        except requests.RequestException as exc:
            log.warning("Heartbeat failed (will retry): %s", exc)
        except Exception:
            log.exception("Heartbeat processing failed")

        stop_event.wait(config.HEARTBEAT_INTERVAL_SECONDS)
