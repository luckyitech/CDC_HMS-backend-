#!/usr/bin/env bash
# Build a double-click .pkg installer for the CDC HMS DICOM bridge (macOS).
# The clinic's server URL + ingest key are baked in, so the installer is
# per-clinic and needs no configuration on the clinic's machine.
#
# Usage:
#   ./package_macos.sh --url https://api.<clinic>/api --key <INGEST_API_KEY> \
#                      [--clinic <slug>] [--version 1.0.0] [--sign "Developer ID Installer: NAME (TEAMID)"]
#
# Output: ../../dist/CDC-Bridge-<clinic>-<version>.pkg
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$(cd "$HERE/../.." && pwd)"          # backend/bridge
BIN="$BRIDGE/dist/cdc-bridge"

URL=""; KEY=""; CLINIC="clinic"; VERSION="1.0.0"; SIGN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --clinic) CLINIC="$2"; shift 2;;
    --version) VERSION="$2"; shift 2;;
    --sign) SIGN="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

[ -z "$URL" ] && read -r -p "Clinic API URL (e.g. https://api.clinic.com/api): " URL
[ -z "$KEY" ] && read -r -p "INGEST_API_KEY for this clinic: " KEY
if [ -z "$URL" ] || [ -z "$KEY" ]; then echo "URL and key are required."; exit 1; fi

# Build the one-file binary if it isn't there yet.
if [ ! -f "$BIN" ]; then
  echo "==> Bridge binary not found — building it first"
  (cd "$BRIDGE" && ./build_macos.sh)
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ROOT="$STAGE/root"
mkdir -p "$ROOT/usr/local/cdc-bridge" "$ROOT/Library/LaunchDaemons" "$STAGE/scripts"

cp "$BIN" "$ROOT/usr/local/cdc-bridge/cdc-bridge"
printf 'HMIS_API_URL=%s\nINGEST_API_KEY=%s\nAE_TITLE=WARDPC\nDICOM_PORT=11112\nBIND_ADDRESS=0.0.0.0\n' \
  "$URL" "$KEY" > "$ROOT/usr/local/cdc-bridge/.env"
cp "$HERE/com.cdc.bridge.plist" "$ROOT/Library/LaunchDaemons/com.cdc.bridge.plist"
cp "$HERE/scripts/postinstall" "$STAGE/scripts/postinstall"
chmod +x "$STAGE/scripts/postinstall"

mkdir -p "$BRIDGE/dist"
OUT="$BRIDGE/dist/CDC-Bridge-${CLINIC}-${VERSION}.pkg"

echo "==> Building installer for '$CLINIC' -> $URL"
if [ -n "$SIGN" ]; then
  pkgbuild --root "$ROOT" --scripts "$STAGE/scripts" \
    --identifier com.cdc.bridge --version "$VERSION" \
    --install-location / --sign "$SIGN" "$OUT"
else
  pkgbuild --root "$ROOT" --scripts "$STAGE/scripts" \
    --identifier com.cdc.bridge --version "$VERSION" \
    --install-location / "$OUT"
fi

echo
echo "==> Installer ready: $OUT"
echo "    Double-click to install. It installs to /usr/local/cdc-bridge and starts"
echo "    on boot as the 'com.cdc.bridge' LaunchDaemon."
[ -z "$SIGN" ] && echo "    (Unsigned — first open: right-click the .pkg → Open. See INSTALLER.md.)"
