param([Parameter(Mandatory=$true)][string]$FixtureExe,[Parameter(Mandatory=$true)][string]$ProbeExe,[Parameter(Mandatory=$true)][string]$OutputDirectory,[string]$DotnetRoot)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
if($DotnetRoot){$env:DOTNET_ROOT=$DotnetRoot;$env:DOTNET_ROOT_X64=$DotnetRoot;$env:PATH="$DotnetRoot;$env:PATH"}
$fixture=$null;$human=$null
try{
 if((Get-Process -Id $PID).SessionId -eq 0){throw 'Session 0 is not interactive'}
 $buddy=Join-Path (Split-Path $FixtureExe) 'AdlForegroundFixture.exe'
 Copy-Item $FixtureExe $buddy -Force
 $fixture=Start-Process -FilePath $FixtureExe -PassThru
 Start-Sleep -Milliseconds 700
 $human=Start-Process -FilePath $buddy -ArgumentList '--foreground' -PassThru
 for($i=0;$i -lt 300;$i++){
   $fixture.Refresh();$human.Refresh()
   if($fixture.HasExited){throw "Fixture exited $($fixture.ExitCode) before creating its window"}
   if($human.HasExited){throw "Foreground application exited $($human.ExitCode) before creating its window"}
   if($human.MainWindowHandle -ne [IntPtr]::Zero -and $fixture.MainWindowHandle -ne [IntPtr]::Zero){break}
   Start-Sleep -Milliseconds 100
 }
 if($fixture.MainWindowHandle -eq [IntPtr]::Zero -or $human.MainWindowHandle -eq [IntPtr]::Zero){throw "Interactive fixture window did not become ready: fixture pid=$($fixture.Id) session=$($fixture.SessionId) hwnd=$($fixture.MainWindowHandle); human pid=$($human.Id) session=$($human.SessionId) hwnd=$($human.MainWindowHandle)"}
 Add-Type 'using System;using System.Runtime.InteropServices;public static class AdlProbeSetup{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);}'
 $activated=[AdlProbeSetup]::SetForegroundWindow($human.MainWindowHandle)
 & $ProbeExe $fixture.Id $human.Id *> (Join-Path $OutputDirectory 'patterns-output.txt')
 $code=$LASTEXITCODE
 @{ok=($code -eq 0);exit_code=$code;session=(Get-Process -Id $PID).SessionId;fixture_session=$fixture.SessionId;human_session=$human.SessionId;foreground_setup=$activated;finished=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress|Set-Content (Join-Path $OutputDirectory 'patterns-result.json') -Encoding UTF8
}catch{@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress|Set-Content (Join-Path $OutputDirectory 'patterns-result.json') -Encoding UTF8;throw}
finally{if($fixture -and -not $fixture.HasExited){$fixture.Kill()};if($human -and -not $human.HasExited){$human.Kill()}}
