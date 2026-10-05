; Sync Retail — NSIS installer hooks (included by Tauri's installer template).
; Per-machine install runs elevated, so the firewall rule can be managed here.

!macro NSIS_HOOK_POSTINSTALL
  ; Let registers on the store's private network reach the Main Register API.
  ; Public networks (cafés, guest Wi-Fi) stay blocked.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Sync Retail Host"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Sync Retail Host" dir=in action=allow program="$INSTDIR\sr-host.exe" enable=yes profile=private,domain description="Sync Retail Main Register API (registers on this network connect here)"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Sync Retail Host"'
!macroend
