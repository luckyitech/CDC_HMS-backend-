# CDC HMS DICOM Bridge — building the one-file installers

The bridge ships as a **single self-contained executable** per platform — the
clinic PC needs no Python, no pip, no virtualenv. You build one file for macOS
and one for Windows, then drop it on the clinic PC next to a `.env`.

> **PyInstaller cannot cross-compile.** Build the macOS binary on a Mac and the
> Windows binary on Windows (or a Windows CI runner / VM). The `.spec` is shared;
> only the build machine differs.

---

## Build

Prerequisite on the build machine: **Python 3.11+** on PATH.

### macOS  → `dist/cdc-bridge`
```bash
cd bridge
./build_macos.sh
```

### Windows  → `dist\cdc-bridge.exe`
```bat
cd bridge
build_windows.bat
```

Each script creates an isolated `build-venv`, installs `requirements.txt` +
PyInstaller, and runs `cdc-bridge.spec`. First build takes a few minutes; the
result is one file (~50 MB) that bundles Python, pydicom/pynetdicom, and the
pylibjpeg JPEG/JPEG-2000 decoders for compressed ultrasound frames.

---

## Deploy on a clinic PC

1. Copy the one file to a folder, e.g. `C:\cdc-bridge\` (Windows) or
   `/opt/cdc-bridge/` (macOS).
2. Put a **`.env`** in that same folder (copy `.env.example`) and set:
   ```
   HMIS_API_URL=https://api.<clinic-domain>/api
   INGEST_API_KEY=<the value from that clinic's server backend/.env>
   ```
   Config and data (`incoming/`, `queue/`, `bridge.log`) live next to the
   executable — that's why it must sit in a writable folder.
3. Run it once from a terminal to confirm it prints
   `DICOM bridge listening on 0.0.0.0:11112 (AE: WARDPC) -> https://...`.
4. Give the PC a **static LAN IP**, allow inbound **TCP 11112**, and point the
   ultrasound machine's DICOM Storage destination at that IP / port 11112 /
   AE `WARDPC` (see the main `README.md`).

### Run it as a background service (starts on boot, restarts on crash)

**Windows — via [NSSM](https://nssm.cc):**
```bat
nssm install CDCBridge "C:\cdc-bridge\cdc-bridge.exe"
nssm set CDCBridge AppDirectory "C:\cdc-bridge"
nssm start CDCBridge
```

**macOS — LaunchDaemon** `/Library/LaunchDaemons/com.cdc.bridge.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.cdc.bridge</string>
  <key>ProgramArguments</key><array><string>/opt/cdc-bridge/cdc-bridge</string></array>
  <key>WorkingDirectory</key><string>/opt/cdc-bridge</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/opt/cdc-bridge/bridge.err.log</string>
</dict></plist>
```
```bash
sudo launchctl load /Library/LaunchDaemons/com.cdc.bridge.plist
```

---

## Unsigned-binary warnings (first launch)

These builds are **not code-signed**. For a real product you'd sign them, but
to run as-is:

- **macOS Gatekeeper:** right-click → Open the first time, or
  `xattr -d com.apple.quarantine /opt/cdc-bridge/cdc-bridge`. To distribute
  without warnings, sign + notarize with an Apple Developer ID.
- **Windows SmartScreen:** "More info → Run anyway" the first time. To
  distribute without warnings, sign the `.exe` with an EV/OV code-signing cert.

---

## Verify end to end

1. **Hop 1 (machine → bridge):** run the ultrasound machine's DICOM Ping/Verify,
   or from the bridge PC: the C-ECHO snippet in `README.md`.
2. **Hop 2 (bridge → API):** send one image; watch `bridge.log` for the upload
   and `pm2 logs cdc-hms-api` on the server for the `POST /api/ultrasound/ingest`.
   The study then appears in the Radiology Suite worklist (matched if the machine
   Patient ID equals a UHID, else in the Unassigned queue).
