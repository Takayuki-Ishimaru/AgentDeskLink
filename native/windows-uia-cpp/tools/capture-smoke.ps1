#Requires -Version 5.1
# Run in an interactive synthetic Windows test session, after building native targets.
param([Parameter(Mandatory=$true)][string]$BuildDir,
      [Parameter(Mandatory=$true)][string]$FixtureExe,
      [Parameter(Mandatory=$true)][string]$OutputDirectory,
      [string]$DotnetRoot='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$work=$OutputDirectory
New-Item -ItemType Directory -Force -Path $work | Out-Null
if($DotnetRoot){$env:DOTNET_ROOT=$DotnetRoot;$env:DOTNET_ROOT_X64=$DotnetRoot;$env:PATH=$DotnetRoot+';'+$env:PATH}
$checks=New-Object System.Collections.Generic.List[string]
$fx=$null;$p=$null;$test=$null
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class ADLVisualNativeProbe {
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [StructLayout(LayoutKind.Sequential)]public struct Point {public int x,y;}
 [DllImport("user32.dll")]public static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int cx,int cy,uint flags);
}
'@
function Check([bool]$ok,[string]$name){if(-not $ok){throw $name};$checks.Add($name)}
function StartHelper([string]$app,[bool]$enabled){
 $start=New-Object System.Diagnostics.ProcessStartInfo;$start.FileName=Join-Path $BuildDir 'Release\adl-windows-uia-helper.exe'
 $start.Arguments='--app-id capture-fixture --app-path "'+$app+'"'+$(if($enabled){' --visual-enabled'}else{''})
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 return [System.Diagnostics.Process]::Start($start)
}
$script:id=0
function Send($process,$request){$script:id++;$request.request_id=[string]$script:id;$process.StandardInput.WriteLine(($request|ConvertTo-Json -Compress));$process.StandardInput.Flush();$read=$process.StandardOutput.ReadLineAsync();if(-not $read.Wait(7000)){$process.Kill();throw 'Native response exceeded 7s'};if(-not $read.Result){throw 'Native IPC ended'};return $read.Result|ConvertFrom-Json}
try {
 Check ((Get-Process -Id $PID).SessionId -ne 0) 'interactive desktop session'
 $start=New-Object System.Diagnostics.ProcessStartInfo;$start.FileName=Join-Path $BuildDir 'Release\adl_window_capture_tests.exe';$start.Arguments='--interactive';$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $test=[System.Diagnostics.Process]::Start($start);$stdout=$test.StandardOutput.ReadToEndAsync();$stderr=$test.StandardError.ReadToEndAsync()
 if(-not $test.WaitForExit(30000)){$test.Kill();throw 'Native WGC test exceeded 30s'}
 $stdout.Result|Set-Content (Join-Path $work 'wgc-interactive-stdout.txt') -Encoding UTF8
 $stderr.Result|Set-Content (Join-Path $work 'wgc-interactive-stderr.txt') -Encoding UTF8
 Check ($test.ExitCode -eq 0) 'native WGC synthetic content, PNG, close, focus and cursor tests'
 $app=(Resolve-Path -LiteralPath $FixtureExe).Path
 $fx=Start-Process -FilePath $app -PassThru
 for($i=0;$i -lt 100;$i++){$fx.Refresh();if($fx.MainWindowHandle -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 50}
 Check ($fx.MainWindowHandle -ne [IntPtr]::Zero) 'fixture ready'
 Start-Sleep -Milliseconds 500
 $fg=[ADLVisualNativeProbe]::GetForegroundWindow();$cursor=New-Object ADLVisualNativeProbe+Point;Check ([ADLVisualNativeProbe]::GetCursorPos([ref]$cursor)) 'cursor preflight'
 $p=StartHelper $app $false;$d=Send $p @{op='discover'};Check ($d.ok -and $d.result.visual_capture -eq $false) 'visual capture default disabled'
 $target=$d.result.targets[0].target_id;$o=Send $p @{op='open';mode='background_semantic';target_id=$target};Check $o.ok 'exact fixture open'
 $disabled=Send $p @{op='capture';target_id=$target;session_id=$o.result.session_id};Check ($disabled.error.code -eq 'E_POLICY_DENIED') 'disabled capture denied'
 $p.StandardInput.Close();if(-not $p.WaitForExit(2000)){$p.Kill()};$p=$null
 $p=StartHelper $app $true;$d=Send $p @{op='discover'};Check ($d.ok -and $d.result.visual_capture -eq $true) 'visual opt-in advertised'
 Check ($d.result.targets.Count -eq 1) 'one exact synthetic fixture target'
 $target=$d.result.targets[0].target_id;$o=Send $p @{op='open';mode='background_semantic';target_id=$target};Check $o.ok 'visual exact fixture open';$sid=$o.result.session_id
 $snap=Send $p @{op='snapshot';target_id=$target;session_id=$sid};Check ($snap.ok -and @($snap.result.elements|Where-Object {$_.name -eq 'Fixture text' -and $_.role -eq 'edit'}).Count -eq 1) 'actual UIA fixture textbox present';$snap|ConvertTo-Json -Depth 10|Set-Content (Join-Path $work 'diagnostic-snapshot.json') -Encoding UTF8
 $r=Send $p @{op='capture';target_id=$target;session_id=$sid};if(-not $r.ok){throw ('capture failed '+$r.error.code)}
 Check ($r.result.coordinate_space -eq 'window_pixels' -and $r.result.source_to_desktop.coordinate_space -eq 'desktop_physical_pixels') 'native coordinate mappings'
 Check ($r.result.redacted -eq $true) 'native sensitive/edit redaction applied'
 $bytes=[Convert]::FromBase64String($r.result.png_base64);[IO.File]::WriteAllBytes((Join-Path $work 'masked-fixture.png'),$bytes)
 $stream=New-Object IO.MemoryStream(,$bytes);$bitmap=New-Object Drawing.Bitmap($stream)
 try {
  Check ($bitmap.Width -eq $r.result.viewport.width -and $bitmap.Height -eq $r.result.viewport.height) 'PNG dimensions match metadata'
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($fx.MainWindowHandle)
  $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)
  $edits=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition);$masked=0
  foreach($edit in $edits){$rect=$edit.Current.BoundingRectangle;$x=[int](($rect.Left+$rect.Right)/2)-$r.result.source_to_desktop.origin_x;$y=[int](($rect.Top+$rect.Bottom)/2)-$r.result.source_to_desktop.origin_y
   if($x -ge 0 -and $y -ge 0 -and $x -lt $bitmap.Width -and $y -lt $bitmap.Height){$pixel=$bitmap.GetPixel($x,$y);Check ($pixel.R -eq 0 -and $pixel.G -eq 0 -and $pixel.B -eq 0) 'native edit rectangle center black';$masked++}
  }
  Check ($masked -ge 3) 'editable, read-only and password fields masked'
 } finally {$bitmap.Dispose();$stream.Dispose()}
 $prior=$r.result.surface_epoch
 $x=[int]$r.result.source_to_desktop.origin_x+25;$y=[int]$r.result.source_to_desktop.origin_y+25
 Check ([ADLVisualNativeProbe]::SetWindowPos($fx.MainWindowHandle,[IntPtr]::Zero,$x,$y,0,0,0x15)) 'move only own fixture without activation'
 Start-Sleep -Milliseconds 100
 $moved=Send $p @{op='capture';target_id=$target;session_id=$sid};Check ($moved.ok -and $moved.result.surface_epoch -ne $prior) 'moving target changes visual epoch'
 $wrong=Send $p @{op='capture';target_id='t-forged';session_id=$sid};Check ($wrong.error.code -eq 'E_TARGET_MISMATCH') 'wrong capture target denied'
 $after=New-Object ADLVisualNativeProbe+Point;Check ([ADLVisualNativeProbe]::GetCursorPos([ref]$after)) 'cursor postflight'
 Check ($fg -eq [ADLVisualNativeProbe]::GetForegroundWindow() -and $cursor.x -eq $after.x -and $cursor.y -eq $after.y) 'all capture operations preserve foreground and cursor'
 $fx.Kill();$fx.WaitForExit(2000)|Out-Null;$fx=$null
 $closed=Send $p @{op='capture';target_id=$target;session_id=$sid};Check ($closed.ok -ne $true -and $closed.error.code -eq 'E_TARGET_NOT_FOUND') 'closed fixture capture denied'
 @{ok=$true;session=(Get-Process -Id $PID).SessionId;os=(Get-CimInstance Win32_OperatingSystem|Select-Object Caption,Version,BuildNumber,OSArchitecture);checks=$checks;finished=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Depth 10|Set-Content (Join-Path $work 'interactive-result.json') -Encoding UTF8
} catch {
 @{ok=$false;error=$_.Exception.Message;checks=$checks;finished=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Depth 10|Set-Content (Join-Path $work 'interactive-result.json') -Encoding UTF8
 throw
} finally {
 if($test -and -not $test.HasExited){$test.Kill()}
 if($p -and -not $p.HasExited){$p.StandardInput.Close();if(-not $p.WaitForExit(2000)){$p.Kill()}}
 if($fx -and -not $fx.HasExited){$fx.Kill()}
}
