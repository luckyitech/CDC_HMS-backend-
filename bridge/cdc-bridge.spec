# -*- mode: python ; coding: utf-8 -*-
# One-file PyInstaller build for the CDC HMS DICOM bridge.
# Same spec on macOS and Windows — run the matching build script.
#
#   macOS:    ./build_macos.sh      -> dist/cdc-bridge        (Unix executable)
#   Windows:  build_windows.bat     -> dist\cdc-bridge.exe
#
# pydicom decodes JPEG-compressed ultrasound frames via pylibjpeg, whose
# decoders are registered as *entry points*. PyInstaller must therefore bundle
# each package's dist-info metadata (copy_metadata) or plugin discovery fails at
# runtime with "no decoders available". collect_all pulls in their data files,
# binaries and submodules.

from PyInstaller.utils.hooks import collect_all, copy_metadata

datas, binaries, hiddenimports = [], [], []

# Full collection for packages with data files / native libs / dynamic imports.
# NOTE: pip package `pylibjpeg-libjpeg` installs the importable module `libjpeg`
# (and `pylibjpeg-openjpeg` -> `openjpeg`) — collect by the MODULE names.
for pkg in (
    "pydicom",
    "pynetdicom",
    "pylibjpeg",
    "libjpeg",
    "openjpeg",
    "numpy",
    "PIL",
):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass  # package name may differ per platform wheel; skip if absent

# Entry-point metadata (by DISTRIBUTION name, with hyphens) so pylibjpeg can
# discover its JPEG / JPEG-2000 plugins at runtime inside the frozen app.
for dist in (
    "pylibjpeg",
    "pylibjpeg-libjpeg",
    "pylibjpeg-openjpeg",
    "pydicom",
):
    try:
        datas += copy_metadata(dist)
    except Exception:
        pass

hiddenimports += ["config", "convert", "uploader", "libjpeg", "openjpeg"]

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

# One-file: binaries + datas folded into a single EXE (no COLLECT step).
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="cdc-bridge",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
