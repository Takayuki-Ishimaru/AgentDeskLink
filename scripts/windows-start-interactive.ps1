param(
    [Parameter(Mandatory=$true)][string]$TestScript,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$TaskName='AgentDeskLink-BetaQA'
)
$ErrorActionPreference='Stop'
if(-not(Test-Path -LiteralPath $TestScript)){throw 'Test script does not exist'}
$runner=Join-Path $PSScriptRoot 'windows-interactive-run.ps1'
$arguments='-NoLogo -NoProfile -File "'+$runner+'" -Script "'+$TestScript+'" -OutputDirectory "'+$OutputDirectory+'"'
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
@{task_name=$TaskName;logon_type='Interactive';output_directory=$OutputDirectory} | ConvertTo-Json -Compress
# After collecting results: Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
