# Upgrade test on Windows: the released v1.1.0 app is installed and has real data (created by the
# v1.1.0 code, see windows-verify.yml); this installs the new build over it, starts the new packaged
# app on that data and verifies that every piece of customer data is intact.
param([Parameter(Mandatory = $true)][string]$Snapshot)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Cashier System'
$exe = Join-Path $installDir 'Cashier System.exe'
$failures = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Host "PASS  $name  $detail" } else { Write-Host "FAIL  $name  $detail"; $script:failures++ }
}
function Stop-App { Get-Process -Name 'Cashier System' -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 3 }
function Run-App([int]$seconds = 15) {
  $p = Start-Process $exe -PassThru
  Start-Sleep -Seconds $seconds
  $p.Refresh()
  $alive = -not $p.HasExited
  Stop-App
  return $alive
}

Check 'released v1.1.0 app is installed' (Test-Path $exe) $exe
Check 'released v1.1.0 app starts on its data' (Run-App)

$installer = Get-ChildItem (Join-Path $root 'dist') -Filter '*Setup*.exe' | Select-Object -First 1
$p = Start-Process $installer.FullName -ArgumentList '/S' -Wait -PassThru
Check 'new installer upgrades the existing installation silently' ($p.ExitCode -eq 0 -and (Test-Path $exe)) "exit=$($p.ExitCode)"
$installedAsar = (Get-FileHash (Join-Path $installDir 'resources\app.asar')).Hash
$builtAsar = (Get-FileHash (Join-Path $root 'dist\win-unpacked\resources\app.asar')).Hash
Check 'installed files are the new build' ($installedAsar -eq $builtAsar)
$fuses = npx @electron/fuses read --app $exe | Out-String
Check 'fuses active on the upgraded executable' ($fuses -match 'RunAsNode is Disabled' -and $fuses -match 'EnableNodeCliInspectArguments is Disabled')
Check 'new packaged app starts on the upgraded data (migrations run)' (Run-App)

$env:PLAYWRIGHT_CORE = "$env:RUNNER_TEMP\pw\node_modules\playwright-core"
node (Join-Path $root 'scripts\ci\upgrade-check.js') $Snapshot
Check 'customer data verified after upgrade (upgrade-check.js)' ($LASTEXITCODE -eq 0)

if ($failures -gt 0) { Write-Host "$failures check(s) failed"; exit 1 }
Write-Host 'all upgrade checks passed'
