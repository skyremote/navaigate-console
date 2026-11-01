# Nightly backup on Windows (Docker Desktop path). Run once in PowerShell, from the kit folder.
# Needs Python on Windows (python.org, or: winget install Python.Python.3.12). It reads the brain over the network
# (--http) with the read-only token, so it works with the Docker volume too.
$kit = (Get-Location).Path
$py  = (Get-Command python).Source
$action  = New-ScheduledTaskAction -Execute $py -Argument "`"$kit\scripts\backup.py`" --http" -WorkingDirectory $kit
$trigger = New-ScheduledTaskTrigger -Daily -At 2:30am
Register-ScheduledTask -TaskName "BrainBackup" -Action $action -Trigger $trigger -Description "Nightly brain database backup"
