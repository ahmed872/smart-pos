# Smoke test of the real NSIS installer and the installed (fused, packaged) app on Windows.
# The packaged app deliberately refuses debugger/automation attachment, so this script checks
# it from the outside: install, launch, database, hardening probes, uninstall and reinstall.
#
#   -Phase FirstRun : clean machine state -> install -> first launch creates the database
#   -Phase Existing : run after scripts/ci/e2e-functional.js left a populated database
param([Parameter(Mandatory = $true)][ValidateSet('FirstRun', 'Existing')][string]$Phase)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$sysDir = Join-Path $env:APPDATA 'SystemDB'
$dbFile = Join-Path $sysDir 'smart-pos.db'
$failures = 0

function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Host "PASS  $name  $detail" } else { Write-Host "FAIL  $name  $detail"; $script:failures++ }
}

function Inspect-Db {
  $json = & node --no-warnings (Join-Path $root 'scripts\ci\db-inspect.js') $dbFile
  if ($LASTEXITCODE -ne 0 -or -not $json) { throw "database inspection failed for $dbFile" }
  $db = $json | Out-String | ConvertFrom-Json
  if ($null -eq $db -or $null -eq $db.integrity) { throw "database inspection returned no data for $dbFile" }
  return $db
}

function Get-Installer { Get-ChildItem (Join-Path $root 'dist') -Filter '*Setup*.exe' | Select-Object -First 1 }
function Get-InstalledExe { Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Recurse -Filter 'Cashier System.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 }

function Stop-App { Get-Process -Name 'Cashier System' -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 3 }

function Show-InstallState([string]$label, [string]$dir) {
  Write-Host "--- install state: $label"
  $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Un_*' -or $_.ProcessName -like 'Au_*' -or $_.ProcessName -like 'Cashier*' }
  Write-Host ("processes: " + (($procs | ForEach-Object { $_.ProcessName }) -join ', '))
  if ($dir) {
    Write-Host "install dir exists: $(Test-Path $dir)"
    if (Test-Path $dir) { Get-ChildItem $dir -Force | Select-Object -First 15 | ForEach-Object { Write-Host "  $($_.Name)" } }
  }
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Cashier*' } |
    ForEach-Object { Write-Host "registry: $($_.DisplayName) -> $($_.InstallLocation) | $($_.UninstallString)" }
}

function Install-App {
  $installer = Get-Installer
  $p = Start-Process $installer.FullName -ArgumentList '/S' -Wait -PassThru
  $exe = $null
  for ($i = 0; $i -lt 60 -and $null -eq $exe; $i++) { $exe = Get-InstalledExe; if ($null -eq $exe) { Start-Sleep -Seconds 1 } }
  if ($null -eq $exe) { Show-InstallState 'after install (exe not found)' (Join-Path $env:LOCALAPPDATA 'Programs\Cashier System') }
  Check 'NSIS installer runs silently (per-user, no admin rights)' ($p.ExitCode -eq 0 -and $null -ne $exe) "exit=$($p.ExitCode) $($installer.Name) -> $($exe.FullName)"
  return $exe
}

# Launch the installed app, give it time to open its database and window, then stop it.
function Launch-App($exe, [string[]]$appArgs = @(), [int]$seconds = 15) {
  $p = if ($appArgs.Count) { Start-Process $exe.FullName -ArgumentList $appArgs -PassThru } else { Start-Process $exe.FullName -PassThru }
  Start-Sleep -Seconds $seconds
  $p.Refresh()
  $state = [pscustomobject]@{ Alive = -not $p.HasExited; ExitCode = $(if ($p.HasExited) { $p.ExitCode } else { $null }); Title = $p.MainWindowTitle }
  Stop-App
  return $state
}

function Port-Open([int]$port) {
  try { Invoke-WebRequest "http://127.0.0.1:$port/json" -UseBasicParsing -TimeoutSec 3 | Out-Null; return $true } catch { return $false }
}

if ($Phase -eq 'FirstRun') {
  Stop-App
  Remove-Item $sysDir -Recurse -Force -ErrorAction SilentlyContinue
  $exe = Install-App
  $run = Launch-App $exe
  Check 'installed app starts and keeps running' $run.Alive "window title: '$($run.Title)'"
  Check 'database created on first launch' (Test-Path $dbFile) $dbFile
  $db = Inspect-Db
  Check 'fresh database has no default accounts (first-run setup required)' (@($db.users).Count -eq 0)
  Check 'fresh database has current schema (pin_hash column)' $db.hasPinHashColumn
  Check 'fresh database has no demo products or categories' ($db.products -eq 0 -and $db.categories -eq 0) "products=$($db.products) categories=$($db.categories)"
  Check 'fresh database has no store identity, logo or currency preset' ($db.settings.store_name -eq '' -and $db.settings.logo_data_url -eq '' -and $db.settings.currency -eq '')
  Check 'fresh database contains no organization name' (-not $db.containsOrganizationName)
  Check 'fresh database integrity ok' ($db.integrity -eq 'ok')
}

if ($Phase -eq 'Existing') {
  $exe = Get-InstalledExe
  $before = Inspect-Db
  Check 'database from the functional run is present' (@($before.users).Count -ge 2) "users=$(@($before.users).Count) products=$($before.products)"

  $run = Launch-App $exe
  $after = Inspect-Db
  Check 'installed app starts on an existing database' $run.Alive
  Check 'existing users and data intact after packaged launch' (($after.users | ConvertTo-Json -Compress) -eq ($before.users | ConvertTo-Json -Compress) -and $after.products -eq $before.products -and $after.integrity -eq 'ok')

  # --- hardening probes against the installed binary
  $dbg = Launch-App $exe @('--remote-debugging-port=9333') 8
  Check 'packaged app refuses --remote-debugging-port' ((-not $dbg.Alive) -and $dbg.ExitCode -eq 1 -and -not (Port-Open 9333)) "exit=$($dbg.ExitCode)"
  $insp = Launch-App $exe @('--inspect=9334') 8
  Check 'packaged app refuses --inspect' ((-not $insp.Alive) -and -not (Port-Open 9334)) "exit=$($insp.ExitCode)"

  $marker = Join-Path $env:RUNNER_TEMP 'pwned-run-as-node'
  $env:ELECTRON_RUN_AS_NODE = '1'
  try { Launch-App $exe @('-e', "require('fs').writeFileSync(String.raw``$marker``,'x')") 8 | Out-Null } finally { Remove-Item Env:ELECTRON_RUN_AS_NODE }
  Check 'ELECTRON_RUN_AS_NODE cannot run scripts (fuse)' (-not (Test-Path $marker))

  $evil = Join-Path $env:RUNNER_TEMP 'evil.js'
  $marker2 = Join-Path $env:RUNNER_TEMP 'pwned-node-options'
  Set-Content $evil "require('fs').writeFileSync(String.raw``$marker2``,'x')"
  $env:NODE_OPTIONS = "--require `"$evil`""
  try { Launch-App $exe @() 8 | Out-Null } finally { Remove-Item Env:NODE_OPTIONS }
  Check 'NODE_OPTIONS cannot inject code (fuse)' (-not (Test-Path $marker2))

  # --- uninstall keeps the customer's database; reinstall picks it up again
  $uninstaller = Get-ChildItem $exe.DirectoryName -Filter 'Uninstall*.exe' | Select-Object -First 1
  $installDir = $exe.DirectoryName
  Start-Process $uninstaller.FullName -ArgumentList '/S' -Wait | Out-Null
  # The NSIS uninstaller re-launches itself from %TEMP% (Un_*.exe) and keeps working after the
  # first process exits: wait until that copy is gone and no installed files remain.
  for ($i = 0; $i -lt 120; $i++) {
    $busy = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Un_*' -or $_.ProcessName -like 'Au_*' }
    # NSIS may leave the (empty) install folder behind; only real leftovers count.
    $leftovers = if (Test-Path $installDir) { @(Get-ChildItem $installDir -Force -Recurse -File) } else { @() }
    if (-not $busy -and $leftovers.Count -eq 0) { break }
    Start-Sleep -Seconds 1
  }
  Show-InstallState 'after uninstall' $installDir
  Check 'uninstaller removes the application' (-not (Test-Path $exe.FullName))
  $afterUninstall = Inspect-Db
  Check 'uninstall keeps the database (customer data not lost)' (($afterUninstall.users | ConvertTo-Json -Compress) -eq ($before.users | ConvertTo-Json -Compress) -and $afterUninstall.products -eq $before.products)

  $exe = Install-App
  $re = Launch-App $exe
  $afterReinstall = Inspect-Db
  Check 'reinstalled app starts' $re.Alive
  Check 'reinstall reuses the existing database' (($afterReinstall.users | ConvertTo-Json -Compress) -eq ($before.users | ConvertTo-Json -Compress) -and $afterReinstall.products -eq $before.products -and $afterReinstall.integrity -eq 'ok')
}

if ($failures -gt 0) { Write-Host "$failures check(s) failed"; exit 1 }
Write-Host 'all checks passed'
