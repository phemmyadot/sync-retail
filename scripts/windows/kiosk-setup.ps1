<#
  Sync Retail — Windows Pro hardening for a dedicated till account.
  See docs/KIOSK_DEPLOYMENT.md §3. Run as administrator.

    kiosk-setup.ps1 -TillUser Till          apply
    kiosk-setup.ps1 -TillUser Till -Undo    remove

  Only the till account's policies are changed (through its registry hive);
  administrator accounts are untouched.
#>
param(
  [Parameter(Mandatory = $true)][string]$TillUser,
  [switch]$Undo
)
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script as administrator.'
}

$account = Get-LocalUser -Name $TillUser -ErrorAction SilentlyContinue
if (-not $account) { throw "No local account named '$TillUser'." }
if ((Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue).Name -match "\\$TillUser$") {
  throw "'$TillUser' is an administrator. Use a standard account for the till."
}
$sid = $account.SID.Value

# Load the till user's registry hive if they aren't signed in.
$hive = "Registry::HKEY_USERS\$sid"
$loaded = $false
if (-not (Test-Path $hive)) {
  $profilePath = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }).LocalPath
  if (-not $profilePath) { throw "Sign in as '$TillUser' once before running this script." }
  reg load "HKU\$sid" "$profilePath\NTUSER.DAT" | Out-Null
  $loaded = $true
}

$policies = @{
  "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\System"   = @{ DisableTaskMgr = 1; DisableLockWorkstation = 1; DisableChangePassword = 1 }
  "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" = @{ NoWinKeys = 1 }
}

try {
  foreach ($key in $policies.Keys) {
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    foreach ($name in $policies[$key].Keys) {
      if ($Undo) {
        Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue
      } else {
        New-ItemProperty -Path $key -Name $name -Value $policies[$key][$name] -PropertyType DWord -Force | Out-Null
      }
    }
  }
  # "Switch user" is machine-wide; only hidden while a till is set up.
  $sys = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\System'
  if ($Undo) { Remove-ItemProperty -Path $sys -Name HideFastUserSwitching -ErrorAction SilentlyContinue }
  else { New-ItemProperty -Path $sys -Name HideFastUserSwitching -Value 1 -PropertyType DWord -Force | Out-Null }
} finally {
  if ($loaded) {
    [gc]::Collect()
    reg unload "HKU\$sid" | Out-Null
  }
}

if ($Undo) { "Removed till restrictions for '$TillUser'. Sign out and back in to apply." }
else { "Applied till restrictions for '$TillUser'. Sign out and back in to apply. Ctrl+Alt+Del still works." }
