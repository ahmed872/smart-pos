; Custom NSIS hooks for electron-builder (picked up via build.nsis.include).
;
; Works around an intermittent installer crash (0xC0000005 in the NSIS System plug-in) on fresh
; per-user installs. electron-builder 24's multiUser.nsh resolves the default install folder with
;   System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'
; which reads a fixed 2 KB from the short string returned by SHGetKnownFolderPath and faults when
; that allocation ends near a memory page boundary. That code only runs when no previous
; per-user InstallLocation exists, so we record the same default location the template uses
; ($LOCALAPPDATA\Programs\<app>) before it runs. Install location and behaviour are unchanged.
; (Fixed upstream in electron-builder 26.15 by switching to lstrcpynW.)
!macro preInit
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp $0 "" 0 +2
      WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  !endif
!macroend
