# Build the Microsoft Store package (MSIX) from electron-builder's dist\win-unpacked.
#
#   pwsh packaging/msix/build-msix.ps1 -Version 1.0.0 `
#        -IdentityName NULLGRID.NullScribe -Publisher "CN=..." -PublisherDisplayName NULLGRID
#
# Uses MakePri and MakeAppx from the Windows SDK (present on GitHub's windows runners).
# The package is unsigned on purpose: the Store signs it. For a local sideload test,
# sign it with your own certificate (signtool sign /fd SHA256 /f cert.pfx ...).
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$IdentityName = 'NULLGRID.NullScribe',
  [string]$Publisher = 'CN=8685350B-5C4C-4422-9CDF-8AEB87F50B2F',
  [string]$PublisherDisplayName = 'NULLGRID',
  [string]$Unpacked = 'dist\win-unpacked',
  [string]$OutDir = 'dist'
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

# MSIX needs a four-part version: 1.0.0 -> 1.0.0.0
$v = ($Version -replace '^v', '').Split('-')[0]
$parts = $v.Split('.')
while ($parts.Count -lt 4) { $parts += '0' }
$msixVersion = ($parts[0..3] -join '.')

if (-not (Test-Path (Join-Path $Unpacked 'NullScribe.exe'))) { throw "No NullScribe.exe in $Unpacked. Run electron-builder --win first." }

# Windows SDK tools (newest SDK first)
$sdk = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'x64\makeappx.exe') } |
  Sort-Object { [version]($_.Name) } -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK (makeappx.exe) not found' }
$makeappx = Join-Path $sdk.FullName 'x64\makeappx.exe'
$makepri = Join-Path $sdk.FullName 'x64\makepri.exe'
Write-Host "Windows SDK $($sdk.Name)"

# Stage: app files + Assets + manifest
$stage = Join-Path $OutDir 'msix-stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item (Join-Path $Unpacked '*') $stage -Recurse
Copy-Item 'packaging\msix\Assets' (Join-Path $stage 'Assets') -Recurse

$manifest = Get-Content 'packaging\msix\AppxManifest.xml' -Raw
$manifest = $manifest.Replace('{{IDENTITY_NAME}}', $IdentityName).Replace('{{PUBLISHER}}', $Publisher).
  Replace('{{PUBLISHER_DISPLAY_NAME}}', $PublisherDisplayName).Replace('{{VERSION}}', $msixVersion)
if ($manifest -match '\{\{') { throw 'Unfilled placeholder left in AppxManifest.xml' }
Set-Content -Path (Join-Path $stage 'AppxManifest.xml') -Value $manifest -Encoding UTF8

# resources.pri, so Windows picks the right scale / size of each logo
$priConfig = Join-Path $OutDir 'priconfig.xml'
& $makepri createconfig /cf $priConfig /dq en-US /pv 10.0.0 /o
if ($LASTEXITCODE) { throw "makepri createconfig failed ($LASTEXITCODE)" }
& $makepri new /pr $stage /cf $priConfig /mn (Join-Path $stage 'AppxManifest.xml') /of (Join-Path $stage 'resources.pri') /o
if ($LASTEXITCODE) { throw "makepri new failed ($LASTEXITCODE)" }

# Pack (MakeAppx validates the manifest against the schema while packing)
$out = Join-Path $OutDir "NullScribe_${msixVersion}_x64.msix"
& $makeappx pack /d $stage /p $out /o
if ($LASTEXITCODE) { throw "makeappx pack failed ($LASTEXITCODE)" }

Remove-Item $stage -Recurse -Force
Write-Host "Built $out  (identity $IdentityName, version $msixVersion, publisher $Publisher)"
