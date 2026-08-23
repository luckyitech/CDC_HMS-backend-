@echo off
REM Build the CDC HMS DICOM bridge into a single Windows executable.
REM Run this ON Windows (PyInstaller cannot cross-compile). Output: dist\cdc-bridge.exe
setlocal
cd /d "%~dp0"

echo ==^> Python:
python --version || (echo Python not found on PATH & exit /b 1)

python -m venv build-venv
call build-venv\Scripts\activate.bat

python -m pip install --upgrade pip
pip install -r requirements.txt
pip install "pyinstaller>=6.6"

if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
pyinstaller --clean --noconfirm cdc-bridge.spec

echo.
echo ==^> Built: %cd%\dist\cdc-bridge.exe
echo     Ship dist\cdc-bridge.exe together with a .env file (copy .env.example).
echo     Install as a service with NSSM — see BUILD.md.
endlocal
