; BTR Sub Array Designer for Windows - the installer.
;
; Per-user, no administrator rights (like the VS Code user installer):
;   %LOCALAPPDATA%\Programs\BTR Sub Array Designer\
;       BTRSubArrayDesigner.exe, WebView2Loader.dll, web\ (the app build)
;   Start menu + desktop shortcut, Apps & features entry (HKCU).
; The program's own data (presets, settings) lives in
; %LOCALAPPDATA%\BTR Sub Array Designer and survives an uninstall unless the
; box on the uninstaller's page is ticked.
;
; Built on the Mac by desktop/build-windows.sh:
;   makensis -DVERSION=1.0.0 -DOUTFILE=<setup.exe> -DSTAGE=<staged dir> -DICON=<app.ico> installer.nsi
; Silent: BTR-Sub-Array-Designer-<version>-Setup.exe /S

!ifndef VERSION | OUTFILE | STAGE | ICON
    !error "Pass -DVERSION, -DOUTFILE, -DSTAGE and -DICON (see the top of this file)"
!endif

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include MUI2.nsh
!include LogicLib.nsh
!include x64.nsh
!include nsDialogs.nsh

!define PRODUCT    "BTR Sub Array Designer"
!define PUBLISHER  "BTR Solutions"
!define EXE        "BTRSubArrayDesigner.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\BTRSubArrayDesigner"
; .btrsub is the project file: double-click opens it here. Projects written
; from older versions are .json; the app is offered in "Open with" for those but
; does not take .json over from other programs.
!define PROGID     "BTRSubArrayDesigner.Project"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
BrandingText "${PRODUCT} ${VERSION}"
Icon "${ICON}"
UninstallIcon "${ICON}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=1033 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=1033 "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Author: Karol Bernacki, ${PUBLISHER}"

Var PurgeData
Var PurgeCheckbox

!define MUI_ICON   "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${PRODUCT} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Subwoofer array design and prediction.$\r$\n$\r$\nThis installs ${PRODUCT} for your user account only; no administrator rights are needed.$\r$\n$\r$\nIt uses Microsoft Edge WebView2, which Windows 11 includes."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.PurgePage un.PurgeLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Polish"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${PRODUCT} needs 64-bit Windows."
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  ; an open copy holds the exe; ask for it to be closed rather than half-replace it
  retry:
  ClearErrors
  FileOpen $0 "$INSTDIR\${EXE}" a
  ${If} ${Errors}
    ${If} ${FileExists} "$INSTDIR\${EXE}"
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT} is running. Close it and press Retry." IDRETRY retry
      Abort
    ${EndIf}
  ${Else}
    FileClose $0
  ${EndIf}

  ; the web build is replaced whole: old hashed assets must not pile up
  RMDir /r "$INSTDIR\web"
  SetOutPath "$INSTDIR"
  File "${STAGE}/${EXE}"
  File "${STAGE}/WebView2Loader.dll"
  File /r "${STAGE}/web"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\${EXE}"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  WriteRegStr HKCU "Software\Classes\.btrsub" "" "${PROGID}"
  WriteRegStr HKCU "Software\Classes\.btrsub" "Content Type" "application/vnd.btr.subarray+json"
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "BTR Sub Array project"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" '"$INSTDIR\${EXE}",0'
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKCU "Software\Classes\.json\OpenWithProgids" "${PROGID}" ""
  ; tell Explorer the association changed, so the icon and the double-click work at once
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd

Function un.PurgePage
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "Your presets and settings are kept in $LOCALAPPDATA\${PRODUCT}. Leave them for a later reinstall, or remove them too."
  ${NSD_CreateCheckbox} 0 44u 100% 12u "Also remove my presets and settings"
  Pop $PurgeCheckbox
  nsDialogs::Show
FunctionEnd

Function un.PurgeLeave
  ${NSD_GetState} $PurgeCheckbox $PurgeData
FunctionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  RMDir /r "$INSTDIR\web"
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ${If} $PurgeData == ${BST_CHECKED}
    RMDir /r "$LOCALAPPDATA\${PRODUCT}"
  ${EndIf}
  DeleteRegKey HKCU "${UNINST_KEY}"
  ReadRegStr $0 HKCU "Software\Classes\.btrsub" ""
  ${If} $0 == "${PROGID}"
    DeleteRegKey HKCU "Software\Classes\.btrsub"
  ${EndIf}
  DeleteRegKey HKCU "Software\Classes\${PROGID}"
  DeleteRegValue HKCU "Software\Classes\.json\OpenWithProgids" "${PROGID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd
