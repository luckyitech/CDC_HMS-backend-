# CDC HMS DICOM Bridge — macOS click-to-install (.pkg)

Produces a **double-click installer** per clinic. The clinic's server URL and
ingest key are baked in, so there's nothing to configure on their machine — they
double-click, approve, done. The bridge installs to `/usr/local/cdc-bridge` and
runs as a background service (`com.cdc.bridge`) that starts on every boot and
restarts if it crashes.

## Build an installer (you, per clinic)

On a Mac, from `backend/bridge/installer/macos`:

```bash
chmod +x package_macos.sh scripts/postinstall
./package_macos.sh \
  --url https://api.<clinic-domain>/api \
  --key <that clinic's INGEST_API_KEY> \
  --clinic <short-name> --version 1.0.0
```

If `dist/cdc-bridge` doesn't exist yet, the script builds it first (needs
Python 3.11+). Output: `backend/bridge/dist/CDC-Bridge-<clinic>-1.0.0.pkg`.

## Install it (the clinic)

Double-click the `.pkg` → Continue → Install → admin password. That's it — the
bridge is running and listening on port 11112.

Then, once per site: give the Mac a **static LAN IP**, allow inbound **TCP
11112**, and point the ultrasound machine's DICOM Storage destination at that
IP / port `11112` / AE `WARDPC`.

## Manage / verify

```bash
sudo launchctl print system/com.cdc.bridge     # is it running?
tail -f /usr/local/cdc-bridge/bridge.err.log    # live log
sudo launchctl bootout system /Library/LaunchDaemons/com.cdc.bridge.plist   # stop
sudo launchctl bootstrap system /Library/LaunchDaemons/com.cdc.bridge.plist # start
```

## Signing (for real distribution)

The `.pkg` above is **unsigned**, so the first open shows a Gatekeeper warning —
right-click the `.pkg` → **Open** (once). To ship without any warning, pass a
Developer ID Installer certificate and notarize:

```bash
./package_macos.sh --url ... --key ... --sign "Developer ID Installer: YOUR ORG (TEAMID)"
xcrun notarytool submit dist/CDC-Bridge-*.pkg --keychain-profile <profile> --wait
xcrun stapler staple dist/CDC-Bridge-*.pkg
```

## Note on architecture

The binary matches the Mac it's built on (Apple Silicon → arm64). If a clinic
runs an Intel Mac, build on an Intel Mac (or add a universal2 build). Most
clinic bridges will be the Windows `.exe` — packaged separately later.
