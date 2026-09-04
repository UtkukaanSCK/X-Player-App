; Custom installer pieces for X-Player.
;
; Two things happen here that electron-builder does not do on its own.
;
; First, a page asking whether video files should open with X-Player. Ticking it
; claims the file types; leaving it unticked still puts X-Player in the "Open
; with" menu, which is what someone who already has a player they like wants.
;
; Second, the app registers its Capabilities. Without that entry Windows does
; not list an application under Settings > Default apps at all, so there is no
; way for anyone to choose it later even if they want to.
;
; What is deliberately NOT attempted: forcing X-Player to be the default for a
; file type that already has one. Windows 8 and later protect that choice with a
; hashed UserChoice key, and applications that appear to override it are either
; failing silently or corrupting the association until Windows resets it. For
; already-claimed types the honest path is Settings, which the app can open with
; one click from its own window.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; The page functions and their variables live inside the macro on purpose.
;
;
; electron-builder includes this file before MUI2, so anything referring to
; MUI_HEADER_TEXT at include time fails to compile - the macro does not exist
; yet. Macro bodies are compiled where they are inserted, which is inside the
; page sequence, by which point it does.
; Declared here rather than at file scope because the uninstaller is compiled
; from the same script without this macro, and NSIS reports a variable nothing
; in that pass touches as unreferenced - which this build treats as an error.
!macro customPageAfterChangeDir
  Var XPAssocCheckbox
  Var XPAssocState

  Page custom xpAssociationPageCreate xpAssociationPageLeave

Function xpAssociationPageCreate
  !insertmacro MUI_HEADER_TEXT "Video files" "Choose how X-Player opens the files on your computer."

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 34u "X-Player can open MKV, MP4, AVI, MOV, WebM, TS, WMV, FLV and MPEG files.$\r$\n$\r$\nTicking this claims those file types for X-Player. Types that already have a player keep it - Windows only lets you change those from Settings."
  Pop $0

  ${NSD_CreateCheckbox} 0 40u 100% 12u "Open video files with X-Player"
  Pop $XPAssocCheckbox
  ${NSD_Check} $XPAssocCheckbox

  ${NSD_CreateLabel} 14u 54u 100% 20u "Leave this unticked and X-Player is still added to the 'Open with' menu, and can be chosen later from Settings > Default apps."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function xpAssociationPageLeave
  ${NSD_GetState} $XPAssocCheckbox $XPAssocState
FunctionEnd
!macroend

; Every extension the app declares, spelled out.
;
; A loop over a packed string would be shorter to write and worse to read, and
; it also has to live in a Function - which NSIS then reports as unreferenced
; while compiling the uninstaller, where customInstall is never inserted, and
; that warning is an error here.
!macro xpReleaseExtension EXT
  DeleteRegValue SHELL_CONTEXT "SoftwareClasses.${EXT}" ""
!macroend

!macro customInstall
  ; Capabilities: what makes the app appear in Settings > Default apps. Without
  ; it Windows does not list the application at all, so nobody can choose it
  ; later even if they want to.
  WriteRegStr SHELL_CONTEXT "SoftwareXPlayerCapabilities" "ApplicationName" "X-Player"
  WriteRegStr SHELL_CONTEXT "SoftwareXPlayerCapabilities" "ApplicationDescription" "Plays any video file, straight away."

  ${If} $XPAssocState != ${BST_CHECKED}
    ; The association macro has already claimed each extension by writing its
    ; default ProgID. Removing that leaves OpenWithProgids in place, so X-Player
    ; stays in the "Open with" menu without having taken anything over.
    !insertmacro xpReleaseExtension "mkv"
    !insertmacro xpReleaseExtension "mp4"
    !insertmacro xpReleaseExtension "avi"
    !insertmacro xpReleaseExtension "mov"
    !insertmacro xpReleaseExtension "webm"
    !insertmacro xpReleaseExtension "m4v"
    !insertmacro xpReleaseExtension "ts"
    !insertmacro xpReleaseExtension "m2ts"
    !insertmacro xpReleaseExtension "wmv"
    !insertmacro xpReleaseExtension "flv"
    !insertmacro xpReleaseExtension "mpg"
    !insertmacro xpReleaseExtension "mpeg"
  ${EndIf}

  ; Registered last, so the entry only exists once the capabilities behind it do.
  WriteRegStr SHELL_CONTEXT "SoftwareRegisteredApplications" "X-Player" "SoftwareXPlayerCapabilities"
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "SoftwareRegisteredApplications" "X-Player"
  DeleteRegKey SHELL_CONTEXT "SoftwareXPlayer"
!macroend
