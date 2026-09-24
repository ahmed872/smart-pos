# Installer reliability investigation: installs the SAME NSIS installer repeatedly on this machine,
# uninstalling between attempts, and records the outcome of every attempt. For any failure it
# collects Windows Error Reporting evidence (Application Error events, faulting module, crash dumps).
param(
  [int]$Attempts = 25,
  [string]$Label = 'run'
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$outDir = Join-Path $env:RUNNER_TEMP "installer-stress-$Label"
$dumpDir = Join-Path $outDir 'dumps'
New-Item -ItemType Directory -Force -Path $dumpDir | Out-Null

$installer = Get-ChildItem (Join-Path $root 'dist') -Filter '*Setup*.exe' | Select-Object -First 1
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs'

# ---- environment and installer metadata
$os = Get-CimInstance Win32_OperatingSystem
Write-Host "OS: $($os.Caption) $($os.Version) build $($os.BuildNumber) arch $($env:PROCESSOR_ARCHITECTURE)"
try { $mp = Get-MpComputerStatus; Write-Host "Defender: AMServiceEnabled=$($mp.AMServiceEnabled) RealTimeProtection=$($mp.RealTimeProtectionEnabled) BehaviorMonitor=$($mp.BehaviorMonitorEnabled)" } catch { Write-Host "Defender: status unavailable ($($_.Exception.Message))" }
Write-Host "Installer: $($installer.Name) size=$($installer.Length) sha256=$((Get-FileHash $installer.FullName).Hash)"
$bytes = [System.IO.File]::ReadAllBytes($installer.FullName)
$ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
$nsisMarks = [regex]::Matches($ascii, 'Nullsoft[^\x00]{0,60}') | ForEach-Object { $_.Value } | Select-Object -Unique -First 3
Write-Host "Installer NSIS markers: $($nsisMarks -join ' | ')"

# ---- capture crash dumps for the installer and anything it spawns (NSIS extracts plugins to %TEMP%)
$ld = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
New-Item -Path $ld -Force | Out-Null
Set-ItemProperty -Path $ld -Name DumpFolder -Value $dumpDir -Type ExpandString
Set-ItemProperty -Path $ld -Name DumpType -Value 1 -Type DWord   # minidump
Set-ItemProperty -Path $ld -Name DumpCount -Value 50 -Type DWord

function Get-InstalledExe { Get-ChildItem $installRoot -Recurse -Filter 'Cashier System.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 }

function Remove-Installation {
  $exe = Get-InstalledExe
  if ($exe) {
    $un = Get-ChildItem $exe.DirectoryName -Filter 'Uninstall*.exe' | Select-Object -First 1
    if ($un) { Start-Process $un.FullName -ArgumentList '/S' -Wait | Out-Null }
    for ($i = 0; $i -lt 120; $i++) {
      $busy = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Un_*' -or $_.ProcessName -like 'Au_*' }
      $left = if (Test-Path $exe.DirectoryName) { @(Get-ChildItem $exe.DirectoryName -Force -Recurse -File) } else { @() }
      if (-not $busy -and $left.Count -eq 0) { break }
      Start-Sleep -Milliseconds 500
    }
  }
  Remove-Item (Join-Path $installRoot 'Cashier System') -Recurse -Force -ErrorAction SilentlyContinue
}

function Get-CrashEvents([datetime]$since) {
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -ErrorAction SilentlyContinue |
    Where-Object { $_.ProviderName -in @('Application Error', 'Windows Error Reporting', 'Application Hang') } |
    ForEach-Object { "[$($_.ProviderName) $($_.Id)] " + ($_.Message -replace '\s+', ' ') }
}

Remove-Installation
$results = @()
for ($n = 1; $n -le $Attempts; $n++) {
  $start = Get-Date
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process $installer.FullName -ArgumentList '/S' -Wait -PassThru
  $sw.Stop()
  $exe = $null
  for ($i = 0; $i -lt 20 -and $null -eq $exe; $i++) { $exe = Get-InstalledExe; if (-not $exe) { Start-Sleep -Milliseconds 500 } }
  $ok = ($p.ExitCode -eq 0 -and $null -ne $exe)
  $code = '0x' + ([BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$p.ExitCode), 0)).ToString('X8')
  $entry = [ordered]@{ attempt = $n; ok = $ok; exitCode = $p.ExitCode; exitHex = $code; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); installed = [bool]$exe; events = @() }
  if (-not $ok) {
    Start-Sleep -Seconds 3   # give WER time to write its events/dumps
    $entry.events = @(Get-CrashEvents $start)
  }
  $results += [pscustomobject]$entry
  Write-Host ("attempt {0,2}: {1}  exit={2} ({3})  {4}s  installed={5}" -f $n, $(if ($ok) { 'OK  ' } else { 'FAIL' }), $p.ExitCode, $code, $entry.seconds, [bool]$exe)
  foreach ($e in $entry.events) { Write-Host "    $e" }
  if (-not $ok) {
    $newDumps = @(Get-ChildItem $dumpDir -Filter '*.dmp' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $start })
    foreach ($d in $newDumps) { Write-Host "    dump: $($d.Name) ($($d.Length) bytes)" }
  }
  Remove-Installation
}

$fail = @($results | Where-Object { -not $_.ok })
Write-Host ""
Write-Host "SUMMARY [$Label]: $($Attempts - $fail.Count)/$Attempts successful installations, $($fail.Count) failed"
$crashes = @($fail | Where-Object { $_.exitHex -eq '0xC0000005' })
Write-Host "0xC0000005 occurrences: $($crashes.Count)"

# Analyse dumps if the Windows debugger is available on the runner.
$cdb = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$dumps = @(Get-ChildItem $dumpDir -Filter '*.dmp' -ErrorAction SilentlyContinue)
Write-Host "crash dumps collected: $($dumps.Count)"
if ($cdb -and $dumps.Count) {
  foreach ($d in ($dumps | Select-Object -First 3)) {
    Write-Host "=== cdb analysis: $($d.Name)"
    $out = & $cdb.FullName -z $d.FullName -c '.ecxr; r; kn 25; lmv m ns*; lm; !analyze -v; q' 2>&1 | Out-String
    $out -split "`n" | Where-Object { $_ -match 'ExceptionCode|FAULTING_|MODULE_NAME|IMAGE_NAME|EXCEPTION_CODE|FAILURE_BUCKET|SYMBOL_NAME|PROCESS_NAME|READ_ADDRESS|WRITE_ADDRESS|ERROR_CODE|^\s*[0-9a-f]{2} [0-9a-f`]{8,}|^[0-9a-f`]{16} [0-9a-f`]{16} |Image path|Image name|Timestamp|^rip=|^rax=' } | Select-Object -First 90 | ForEach-Object { Write-Host "  $_" }
  }
}

$results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $outDir 'results.json')
Remove-Item -Path $ld -Recurse -Force -ErrorAction SilentlyContinue
if ($fail.Count -gt 0) { exit 1 }
