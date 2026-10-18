; CDC Scanner Relay — Windows installer (NSIS 3).
; Built by build-installer.js, which puts node.exe and the relay files in
; build/payload/ and passes /DVERSION=…. Installs to Program Files, writes
; config.json to ProgramData\CDC Scanner Relay, and registers a scheduled
; task that runs the relay as SYSTEM from startup and restarts it if it stops.
;
; Silent install (for scripted setups and tests):
;   CDC-Scanner-Relay-Setup.exe /S /KEY=<relay key> [/SERIAL=…] [/IP=…] [/API=…]

Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!define NAME "CDC Scanner Relay"
!define TASK "CDC Scanner Relay"
!define DATA_DIR "$COMMONPROGRAMDATA\${NAME}"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CDCScannerRelay"

Name "${NAME}"
OutFile "..\dist\CDC-Scanner-Relay-Setup.exe"
InstallDir "$PROGRAMFILES64\${NAME}"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "Comprehensive Diabetes Centre — HMS"

Var KEY
Var SERIAL
Var IP
Var API
Var hKey
Var hSerial
Var hIP
Var hAPI

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "CDC Scanner Relay ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This installs the small program that sends punches from the clinic's fingerprint scanner to the CDC HMS.$\r$\n$\r$\nIt runs in the background, starts with Windows, and needs no one to be signed in.$\r$\n$\r$\nHave ready: the relay key from HR Settings → Attendance → Fingerprint scanner, and the scanner's IP address."
!insertmacro MUI_PAGE_WELCOME
Page custom SettingsPage SettingsLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "Installed"
!define MUI_FINISHPAGE_TEXT "The relay is running. Within a minute, HR Settings → Attendance → Fingerprint scanner should show Online.$\r$\n$\r$\nStart menu → CDC Scanner Relay → Check scanner connection shows what the relay sees."
!define MUI_FINISHPAGE_RUN ""
!define MUI_FINISHPAGE_RUN_FUNCTION RunCheck
!define MUI_FINISHPAGE_RUN_TEXT "Check the scanner connection now"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function RunCheck
  Exec '"$WINDIR\System32\cmd.exe" /k ""$INSTDIR\node.exe" "$INSTDIR\relay.js" --check"'
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This program needs 64-bit Windows."
    Abort
  ${EndIf}
  StrCpy $SERIAL "A8N5203760092"
  StrCpy $IP "192.168.0.132"
  StrCpy $API "https://api.cdiabetescentre.com/api"
  ${GetParameters} $R0
  ${GetOptions} $R0 "/KEY=" $R1
  ${IfNot} ${Errors}
    StrCpy $KEY $R1
  ${EndIf}
  ${GetOptions} $R0 "/SERIAL=" $R1
  ${IfNot} ${Errors}
    StrCpy $SERIAL $R1
  ${EndIf}
  ${GetOptions} $R0 "/IP=" $R1
  ${IfNot} ${Errors}
    StrCpy $IP $R1
  ${EndIf}
  ${GetOptions} $R0 "/API=" $R1
  ${IfNot} ${Errors}
    StrCpy $API $R1
  ${EndIf}
  ; Keep an existing config's values when upgrading.
  IfFileExists "${DATA_DIR}\config.json" 0 +2
    StrCpy $KEY "(keep the current key)"
FunctionEnd

Function SettingsPage
  !insertmacro MUI_HEADER_TEXT "Scanner and HMS settings" "These go into the relay's settings file. You can change them later from the Start menu."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 12u "Relay key (from HR Settings → Attendance → Fingerprint scanner):"
  Pop $0
  ${NSD_CreateText} 0 14u 100% 12u $KEY
  Pop $hKey
  ${NSD_CreateLabel} 0 34u 100% 12u "Scanner serial number (System Info → Device Info on the scanner):"
  Pop $0
  ${NSD_CreateText} 0 48u 100% 12u $SERIAL
  Pop $hSerial
  ${NSD_CreateLabel} 0 68u 100% 12u "Scanner IP address on the clinic network (Comm. → Ethernet on the scanner):"
  Pop $0
  ${NSD_CreateText} 0 82u 100% 12u $IP
  Pop $hIP
  ${NSD_CreateLabel} 0 102u 100% 12u "HMS API address:"
  Pop $0
  ${NSD_CreateText} 0 116u 100% 12u $API
  Pop $hAPI
  nsDialogs::Show
FunctionEnd

Function SettingsLeave
  ${NSD_GetText} $hKey $KEY
  ${NSD_GetText} $hSerial $SERIAL
  ${NSD_GetText} $hIP $IP
  ${NSD_GetText} $hAPI $API
  ${If} $KEY == ""
    MessageBox MB_ICONEXCLAMATION "The relay key is needed. HR Settings → Attendance → Fingerprint scanner shows it when the scanner is registered (or Replace relay key)."
    Abort
  ${EndIf}
  ${If} $SERIAL == ""
  ${OrIf} $IP == ""
  ${OrIf} $API == ""
    MessageBox MB_ICONEXCLAMATION "Please fill in every field."
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  ; Stop a running relay before replacing its files (an upgrade).
  nsExec::ExecToLog 'schtasks /End /TN "${TASK}"'
  Sleep 1500
  File "..\build\payload\node.exe"
  File "..\build\payload\relay.js"
  File "..\build\payload\k40.js"
  File "..\build\payload\README.md"
  File "..\build\payload\LICENSE-node.txt"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Settings, state and log in ProgramData; staff may read the log and edit settings.
  CreateDirectory "${DATA_DIR}"
  nsExec::ExecToLog 'icacls "${DATA_DIR}" /grant *S-1-5-32-545:(OI)(CI)M'
  ${If} $KEY != "(keep the current key)"
    FileOpen $0 "${DATA_DIR}\config.json" w
    FileWrite $0 '{$\r$\n  "HMIS_API_URL": "$API",$\r$\n  "SCANNER_KEY": "$KEY",$\r$\n  "SCANNER_SERIAL": "$SERIAL",$\r$\n  "SCANNER_IP": "$IP",$\r$\n  "SCANNER_PORT": 4370,$\r$\n  "SCANNER_PASSWORD": 0,$\r$\n  "POLL_SECONDS": 60,$\r$\n  "USERS_EVERY_MINUTES": 30$\r$\n}$\r$\n'
    FileClose $0
  ${EndIf}

  ; Runs as SYSTEM from startup, whether or not anyone signs in; restarts a
  ; minute after any crash; never stopped by a time limit or battery saving.
  FileOpen $0 "$INSTDIR\register-task.ps1" w
  FileWrite $0 "$$a = New-ScheduledTaskAction -Execute '$INSTDIR\node.exe' -Argument '$\"$INSTDIR\relay.js$\"' -WorkingDirectory '$INSTDIR'$\r$\n"
  FileWrite $0 "$$t = New-ScheduledTaskTrigger -AtStartup$\r$\n"
  FileWrite $0 "$$s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew$\r$\n"
  FileWrite $0 "Register-ScheduledTask -TaskName '${TASK}' -Action $$a -Trigger $$t -Settings $$s -User 'SYSTEM' -RunLevel Highest -Force | Out-Null$\r$\n"
  FileWrite $0 "Start-ScheduledTask -TaskName '${TASK}'$\r$\n"
  FileClose $0
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\register-task.ps1"'

  ; Start menu
  CreateDirectory "$SMPROGRAMS\${NAME}"
  CreateShortcut "$SMPROGRAMS\${NAME}\Check scanner connection.lnk" "$WINDIR\System32\cmd.exe" '/k ""$INSTDIR\node.exe" "$INSTDIR\relay.js" --check"' "$INSTDIR\node.exe" 0
  CreateShortcut "$SMPROGRAMS\${NAME}\Relay log.lnk" "$WINDIR\System32\notepad.exe" '"${DATA_DIR}\scanner-relay.log"'
  CreateShortcut "$SMPROGRAMS\${NAME}\Relay settings.lnk" "$WINDIR\System32\notepad.exe" '"${DATA_DIR}\config.json"'
  CreateShortcut "$SMPROGRAMS\${NAME}\Restart relay (after changing settings).lnk" "$WINDIR\System32\cmd.exe" '/c schtasks /End /TN "${TASK}" & timeout /t 2 >nul & schtasks /Run /TN "${TASK}" & echo Relay restarted. & pause'
  CreateShortcut "$SMPROGRAMS\${NAME}\Uninstall.lnk" "$INSTDIR\Uninstall.exe"

  ; Settings → Apps entry
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${NAME}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "Comprehensive Diabetes Centre"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog 'schtasks /End /TN "${TASK}"'
  nsExec::ExecToLog 'schtasks /Delete /TN "${TASK}" /F'
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\relay.js"
  Delete "$INSTDIR\k40.js"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\LICENSE-node.txt"
  Delete "$INSTDIR\register-task.ps1"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  RMDir /r "$SMPROGRAMS\${NAME}"
  ; The settings file holds the relay key; the log and bookmark are not needed once the relay is gone.
  RMDir /r "${DATA_DIR}"
  DeleteRegKey HKLM "${UNINST_KEY}"
SectionEnd
