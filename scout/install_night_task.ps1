# Peakaboo Night: register the logon task that runs `night.py --daemon` (design 4.11).
# ASCII only: Windows PowerShell 5.1 misreads BOM-less UTF-8.
#
#   powershell -ExecutionPolicy Bypass -File scout\install_night_task.ps1             # install / update
#   powershell -ExecutionPolicy Bypass -File scout\install_night_task.ps1 -Uninstall  # remove
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'Peakaboo Night'

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed task '$TaskName'"
    exit 0
}

# The scheduler's PATH may differ from this shell, so bake the full path into the action.
# pythonw.exe: no console window at logon (closing one would stop the daemon).
$cmd = Get-Command pythonw -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cmd) {
    $python = $cmd.Source
} else {
    $console = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $python = Join-Path (Split-Path $console) 'pythonw.exe'
}
if (-not (Test-Path -LiteralPath $python)) { throw "pythonw.exe not found: $python" }
$scoutDir = $PSScriptRoot
$script = Join-Path $scoutDir 'night.py'
if (-not (Test-Path -LiteralPath $script)) { throw "night.py not found: $script" }

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $python -Argument "-I `"$script`" --daemon" -WorkingDirectory $scoutDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'Peakaboo night runner daemon (scout\night.py --daemon)' -Force | Out-Null

Write-Host "Registered task '$TaskName'"
Write-Host "  python : $python"
Write-Host "  script : $script"
Write-Host "  user   : $user (at logon)"
