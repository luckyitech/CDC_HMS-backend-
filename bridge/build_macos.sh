#!/usr/bin/env bash
# Build the CDC HMS DICOM bridge into a single macOS executable.
# Run this ON a Mac (PyInstaller cannot cross-compile). Output: dist/cdc-bridge
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Python: $(python3 --version)"
python3 -m venv build-venv
# shellcheck disable=SC1091
source build-venv/bin/activate

python -m pip install --upgrade pip
pip install -r requirements.txt
pip install "pyinstaller>=6.6"

rm -rf build dist
pyinstaller --clean --noconfirm cdc-bridge.spec

echo
echo "==> Built: $(pwd)/dist/cdc-bridge"
echo "    Ship dist/cdc-bridge together with a .env file (copy .env.example)."
echo "    First run may be blocked by Gatekeeper — see BUILD.md."
