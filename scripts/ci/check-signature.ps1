# Reports the Authenticode status of the built installer and application executable.
#   -Require : fail unless every file has a valid signature (a certificate is configured, or the
#              repository requires signed releases).
param([switch]$Require)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$files = @(Get-ChildItem (Join-Path $root 'dist') -Filter '*Setup*.exe') + @(Get-Item (Join-Path $root 'dist\win-unpacked\Cashier System.exe'))
if ($files.Count -lt 2) { throw 'installer or application executable not found in dist' }
$unsigned = 0
foreach ($f in $files) {
  $sig = Get-AuthenticodeSignature $f.FullName
  Write-Host "$($f.Name): $($sig.Status) $($sig.SignerCertificate.Subject)"
  if ($sig.Status -ne 'Valid') { $unsigned++ }
}
if ($unsigned -and $Require) { throw "$unsigned file(s) without a valid signature" }
if ($unsigned) { Write-Host '::warning::Build is not code-signed (no certificate configured, see docs/CODE_SIGNING.md).' }
