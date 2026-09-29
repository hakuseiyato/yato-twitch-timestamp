# Yato Twitch Timestamp - Premiere Pro / After Effects dev install
# Links this dev folder into %APPDATA%\Adobe\CEP\extensions via a Directory Junction
# and enables PlayerDebugMode so the unsigned CEP extension loads.
# No admin rights required (HKCU / user area only).
# NOTE: ASCII-only on purpose so it runs under both Windows PowerShell 5.1 and pwsh 7.
$ErrorActionPreference = "Stop"
$source = $PSScriptRoot
$extId  = "com.yato.twitchtimestamp"
$target = Join-Path $env:APPDATA "Adobe\CEP\extensions\$extId"
$extDir = Split-Path $target -Parent

# CEP resolves relative URLs from the junction path, so the shared lib.js must live inside the panel.
# Re-run this script after editing extension\lib.js (tests/test_lib.js fails if the copy is stale).
$repoRoot = Split-Path $PSScriptRoot -Parent
$libSource = Join-Path $repoRoot "extension\lib.js"
$libTarget = Join-Path $PSScriptRoot "js\lib.js"
if (-not (Test-Path $libSource)) { Write-Error "Source lib.js was not found: $libSource" }
Copy-Item -Path $libSource -Destination $libTarget -Force
Write-Host "Copied lib.js: $libSource -> $libTarget" -ForegroundColor Green

if (-not (Test-Path $extDir)) { New-Item -ItemType Directory -Force -Path $extDir | Out-Null }
if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($item.LinkType -eq "Junction") { Remove-Item $target -Force }
    else { Write-Warning "A non-link item already exists: $target"; Write-Warning "Please check/remove it manually. Aborting."; exit 1 }
}
New-Item -ItemType Junction -Path $target -Target $source | Out-Null
Write-Host "Junction created: $target -> $source" -ForegroundColor Green
foreach ($v in 10, 11, 12) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -Type String
    Write-Host "PlayerDebugMode=1 set on CSXS.$v" -ForegroundColor Green
}
Write-Host "Done. Restart Premiere Pro / After Effects, then open Window > Extensions > Yato Twitch Timestamp." -ForegroundColor Cyan
