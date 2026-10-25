#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$Root,[string]$FixtureExe,[string]$ControlsFile)
$ErrorActionPreference='Stop'
$r=Join-Path $Root 'repo'
$out=Join-Path $Root 'multiwindow-e2e'
New-Item -ItemType Directory -Force -Path $out | Out-Null
foreach($name in @('runner-error.json','negative-result.json','external-monitor.json','multiwindow-result.json','interference-stimulus.json')){Remove-Item (Join-Path $out $name) -ErrorAction SilentlyContinue}
$env:DOTNET_ROOT=Join-Path $Root '.dotnet';$env:DOTNET_ROOT_X64=$env:DOTNET_ROOT;$env:PATH="$env:DOTNET_ROOT;$env:PATH"
$control=Join-Path $Root 'multiwindow-control';New-Item -ItemType Directory -Force -Path $control | Out-Null;Remove-Item (Join-Path $control 'input.json'),(Join-Path $control 'output.json') -ErrorAction SilentlyContinue
$fx=$null;$human=$null;$node=$null
try{
 if((Get-Process -Id $PID).SessionId -eq 0){throw 'Interactive session required'}
 $fixture=if($FixtureExe){$FixtureExe}else{Join-Path $Root 'native-review\build\fixture\FixtureApp.exe'}
 $buddy=Join-Path $r 'native\windows-uia\fixture\bin\Release\net8.0-windows\AdlForegroundFixture.exe'
 $fx=Start-Process -FilePath $fixture -ArgumentList @('--multi-window','--control-dir',('"'+$control+'"')) -PassThru
 $human=Start-Process -FilePath $buddy -ArgumentList '--foreground' -PassThru
 for($i=0;$i -lt 300;$i++){$fx.Refresh();$human.Refresh();if($fx.HasExited -or $human.HasExited){throw 'Fixture application exited early'};if($fx.MainWindowHandle -ne [IntPtr]::Zero -and $human.MainWindowHandle -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 100}
 if($fx.MainWindowHandle -eq [IntPtr]::Zero -or $human.MainWindowHandle -eq [IntPtr]::Zero){throw 'Fixture window readiness timeout'}
 Add-Type @'
using System;using System.Threading;using System.Runtime.InteropServices;
public static class AdlExternalMonitor {
 [StructLayout(LayoutKind.Sequential)]struct Point{public int x,y;}
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int l,t,r,b;}
 [StructLayout(LayoutKind.Sequential)]struct Gui{public int size,flags;public IntPtr active,focus,capture,menuOwner,moveSize,caret;public Rect rect;}
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr p);
 [DllImport("user32.dll")]static extern bool GetGUIThreadInfo(uint id,ref Gui g);
 [DllImport("user32.dll")]static extern bool GetCursorPos(out Point p);
 public static int Samples,Changes,Errors;static volatile bool running;static Thread thread;
 struct Sample{public IntPtr fg,focus;public int x,y;}
 static Sample Read(){var fg=GetForegroundWindow();var g=new Gui{size=Marshal.SizeOf(typeof(Gui))};Point p;if(fg==IntPtr.Zero||!GetGUIThreadInfo(GetWindowThreadProcessId(fg,IntPtr.Zero),ref g)||!GetCursorPos(out p))throw new Exception();return new Sample{fg=fg,focus=g.focus,x=p.x,y=p.y};}
 public static void Start(){Samples=Changes=Errors=0;running=true;var first=Read();thread=new Thread(()=>{while(running){try{var s=Read();Samples++;if(s.fg!=first.fg||s.focus!=first.focus||s.x!=first.x||s.y!=first.y)Changes++;}catch{Errors++;}Thread.Sleep(10);}});thread.IsBackground=true;thread.Start();}
 public static void Stop(){running=false;if(thread!=null)thread.Join(1000);}
}
'@
 if(-not [AdlExternalMonitor]::SetForegroundWindow($human.MainWindowHandle)){throw 'Could not put independent human fixture in foreground'}
 Start-Sleep -Milliseconds 500
 [AdlExternalMonitor]::Start()
 $helper=Join-Path $Root 'native-review\build\Release\adl-windows-uia-helper.exe'
 $controls=if($ControlsFile){$ControlsFile}else{Join-Path $Root 'native-review\native\windows-uia-cpp\controls.example.json'}
 $start=New-Object System.Diagnostics.ProcessStartInfo
 $start.FileName='C:\Program Files\nodejs\node.exe'
 $start.Arguments='"'+(Join-Path $r 'scripts\windows-multiwindow-e2e.mjs')+'" "'+$helper+'" "'+$fixture+'" "'+$controls+'" "'+$out+'" "'+$control+'"'
 $start.WorkingDirectory=$r;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $node=[System.Diagnostics.Process]::Start($start)
 $stdout=$node.StandardOutput.ReadToEndAsync();$stderr=$node.StandardError.ReadToEndAsync()
 if(-not $node.WaitForExit(240000)){$node.Kill();throw 'Desktop end-to-end test exceeded 240s'}
 [AdlExternalMonitor]::Stop()
 $stdout.Result | Set-Content (Join-Path $out 'stdout.txt') -Encoding UTF8
 $stderr.Result | Set-Content (Join-Path $out 'stderr.txt') -Encoding UTF8
 @{ok=($node.ExitCode -eq 0 -and [AdlExternalMonitor]::Changes -eq 0 -and [AdlExternalMonitor]::Errors -eq 0);exit_code=$node.ExitCode;samples=[AdlExternalMonitor]::Samples;changed_samples=[AdlExternalMonitor]::Changes;probe_errors=[AdlExternalMonitor]::Errors;session=(Get-Process -Id $PID).SessionId;finished=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json|Set-Content (Join-Path $out 'external-monitor.json') -Encoding UTF8
 if($node.ExitCode -ne 0){throw 'MCP end-to-end assertions failed'}
 # Keep the independent foreground fixture while testing failure paths on a fresh single window.
 $fx.Kill();$fx.WaitForExit(2000) | Out-Null
 $fx=Start-Process -FilePath $fixture -ArgumentList @('--interference-log',('"'+(Join-Path $out 'interference-stimulus.json')+'"')) -PassThru
 for($i=0;$i -lt 100;$i++){$fx.Refresh();if($fx.MainWindowHandle -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 50}
 $start.Arguments=$start.Arguments.Replace('windows-multiwindow-e2e.mjs','windows-desktop-negative.mjs')
 $node=[System.Diagnostics.Process]::Start($start)
 $stdout=$node.StandardOutput.ReadToEndAsync();$stderr=$node.StandardError.ReadToEndAsync()
 if(-not $node.WaitForExit(60000)){$node.Kill();throw 'Negative test deadline exceeded'}
 $stdout.Result | Set-Content (Join-Path $out 'negative-stdout.txt') -Encoding UTF8
 $stderr.Result | Set-Content (Join-Path $out 'negative-stderr.txt') -Encoding UTF8
 if($node.ExitCode -ne 0){throw 'Negative MCP assertions failed'}
}catch{@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json|Set-Content (Join-Path $out 'runner-error.json') -Encoding UTF8;throw}
finally{if($node -and -not $node.HasExited){$node.Kill()};if($fx -and -not $fx.HasExited){$fx.Kill()};if($human -and -not $human.HasExited){$human.Kill()}}
