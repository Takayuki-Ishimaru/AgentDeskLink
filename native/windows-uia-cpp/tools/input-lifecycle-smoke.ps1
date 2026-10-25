[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BuildDir,[string]$DotnetRoot='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$work=[IO.Path]::GetFullPath($BuildDir)
if($DotnetRoot){$env:DOTNET_ROOT=$DotnetRoot;$env:DOTNET_ROOT_X64=$DotnetRoot;$env:PATH=$DotnetRoot+';'+$env:PATH}
$checks=New-Object System.Collections.Generic.List[string];$fx=$null;$p=$null;$p2=$null;$holder=$null;$humanTestDown=$false;$recoveryTestStarted=$false
$log=Join-Path $work 'physical-extra-progress.txt';Set-Content $log 'start' -Encoding UTF8
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class ADLInputProbe {
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [StructLayout(LayoutKind.Sequential)]public struct Point {public int x,y;}
 [DllImport("user32.dll")]public static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")]public static extern short GetAsyncKeyState(int vk);
 [DllImport("user32.dll")]public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll")]public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
}
'@
$initialCursor=New-Object ADLInputProbe+Point;[void][ADLInputProbe]::GetCursorPos([ref]$initialCursor)
function Check([bool]$ok,[string]$name){if(-not $ok){throw $name};$checks.Add($name);Add-Content $log ('PASS '+$name) -Encoding UTF8}
function Describe($r){if($r.ok){return 'ok'};return ($r.error|ConvertTo-Json -Compress)}
function StartHelper([string]$app,[bool]$enabled=$true){
 $start=New-Object System.Diagnostics.ProcessStartInfo;$start.FileName=Join-Path $work 'Release\adl-windows-uia-helper.exe'
 $start.Arguments='--app-id physical-fixture --app-path "'+$app+'" --controls-file "'+(Join-Path $work 'controls.json')+'" --visual-enabled'+$(if($enabled){' --interactive-config "'+((Get-Content (Join-Path $work 'interactive.json') -Raw).Replace('"','\"'))+'"'}else{''})
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 return [System.Diagnostics.Process]::Start($start)
}
$script:id=0
function BeginSend($process,$request){$script:id++;$request.request_id=[string]$script:id;$wire=[Text.Encoding]::UTF8.GetBytes(($request|ConvertTo-Json -Depth 12 -Compress)+"`n");$process.StandardInput.BaseStream.Write($wire,0,$wire.Length);$process.StandardInput.BaseStream.Flush();return @{id=[string]$script:id;read=$process.StandardOutput.ReadLineAsync()}}
function ReadReply($process,$pending){if(-not $pending.read.Wait(12000)){$process.Kill();throw 'Native response exceeded 12s'};if(-not $pending.read.Result){throw 'Native IPC ended'};return $pending.read.Result|ConvertFrom-Json}
function Send($process,$request){$pending=BeginSend $process $request;return ReadReply $process $pending}
function RunEmergency(){
 $start=New-Object System.Diagnostics.ProcessStartInfo;$start.FileName=Join-Path $work 'Release\adl-windows-uia-helper.exe';$start.Arguments='--release-input';$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true
 $release=[Diagnostics.Process]::Start($start);$line=$release.StandardOutput.ReadLineAsync();if(-not $line.Wait(2000)-or -not $release.WaitForExit(2000)){$release.Kill();throw 'Emergency release timed out'};return @{code=$release.ExitCode;result=($line.Result|ConvertFrom-Json)}
}
function StopHelper($process){if($process -and -not $process.HasExited){$process.StandardInput.Close();if(-not $process.WaitForExit(2000)){$process.Kill()};$process.StandardError.ReadToEnd()|Add-Content (Join-Path $work 'physical-helper-stderr.txt');$process.Dispose()}}
$script:fid=0;$script:state=$null;$script:fixtureDir=Join-Path $work ('fixture-state-'+[Guid]::NewGuid().ToString('N'))
function Fixture([string]$op,$extra=@{}){
 $script:fid++;$req=@{id=$script:fid;op=$op};foreach($key in $extra.Keys){$req[$key]=$extra[$key]}
 $inputFile=Join-Path $script:fixtureDir 'input.json';$wire=($req|ConvertTo-Json -Compress);$written=$false;for($retry=0;$retry -lt 100;$retry++){try{[IO.File]::WriteAllText($inputFile,$wire);$written=$true;break}catch{Start-Sleep -Milliseconds 5}};if(-not $written){throw 'Fixture command file remained locked'}
 for($i=0;$i -lt 400;$i++){try{$r=Get-Content (Join-Path $script:fixtureDir 'output.json') -Raw|ConvertFrom-Json;if($r.id -eq $script:fid){$script:state=$r;return}}catch{};Start-Sleep -Milliseconds 10};throw ('Fixture command timed out '+$op)
}
function Req([string]$op){return @{op=$op;target_id=$script:target;session_id=$script:sid}}
function Capture(){Fixture 'state';$r=Send $p (Req 'capture');if(-not $r.ok){throw ('capture '+(Describe $r))};return $r.result}
function Point($rect,$capture){return @{x=[int]($rect.x+$rect.width/2-$capture.source_to_desktop.origin_x);y=[int]($rect.y+$rect.height/2-$capture.source_to_desktop.origin_y)}}
function Prepare([string]$which,[string]$action,[string]$role,[string]$name){$cap=Capture;$req=Req 'prepare_input';$req.input_token=$cap.input_token;$req.point=Point $script:state.$which $cap;$req.action=$action;$req.expected_target=@{role=$role;name=$name};return Send $p $req}
function Commit($prepared,$value=$null){$req=Req 'commit_input';$req.confirmation_id=$prepared.result.confirmation_id;if($null -ne $value){$req.value=$value};return Send $p $req}
function Gesture($cap,[string]$kind,[int]$duration=120){Fixture 'state';$rect=$script:state.canvas;$x=[int]($rect.x+60-$cap.source_to_desktop.origin_x);$y=[int]($rect.y+80-$cap.source_to_desktop.origin_y);$req=Req 'gesture';$req.input_token=$cap.input_token;$req.expected_revision=$script:revision;$req.surface_id='canvas';$req.kind=$kind;$req.points=@(@{x=$x;y=$y;t_ms=0},@{x=$x+80;y=$y+50;t_ms=$duration});if($kind -eq 'swipe'){$req.swipe_backend='scroll'};return $req}
function Snap(){ $r=Send $p (Req 'snapshot');if(-not $r.ok){throw ('snapshot '+(Describe $r))};$script:revision=$r.result.revision;return $r.result}
try {
 Check ((Get-Process -Id $PID).SessionId -ne 0) 'interactive desktop session'
 @{FixtureText=@{role='edit';allowed=@('fill')};FixtureButton=@{role='button';allowed=@('click')}}|ConvertTo-Json -Depth 10|Set-Content (Join-Path $work 'controls.json') -Encoding ASCII
 @{enabled=$true;surfaces=@(@{id='canvas';region=@{x=0;y=180;width=610;height=350};kinds=@('drag','swipe');swipe_backend='scroll'})}|ConvertTo-Json -Depth 10|Set-Content (Join-Path $work 'interactive.json') -Encoding ASCII
 $app=Join-Path $work 'interactive-fixture\InteractiveFixture.exe';$fx=Start-Process -FilePath $app -ArgumentList ('"'+($script:fixtureDir)+'"') -PassThru
 for($i=0;$i -lt 100;$i++){$fx.Refresh();if($fx.MainWindowHandle -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 50}
 Check ($fx.MainWindowHandle -ne [IntPtr]::Zero) 'synthetic fixture ready';Fixture 'foreground';Start-Sleep -Milliseconds 100
 $p=StartHelper $app;$d=Send $p @{op='discover'};$script:target=$d.result.targets[0].target_id;$o=Send $p @{op='open';mode='interactive_desktop';target_id=$script:target};Check $o.ok 'native extra fixture open';$script:sid=$o.result.session_id
 Fixture 'focus_canvas';$null=Snap;$cap=Capture;$req=Gesture $cap 'drag' 3000;$pending=BeginSend $p $req;for($heldWait=0;$heldWait -lt 100 -and (([ADLInputProbe]::GetAsyncKeyState(1)-band 0x8000)-eq 0);$heldWait++){Start-Sleep -Milliseconds 10};Check ((([ADLInputProbe]::GetAsyncKeyState(1)-band 0x8000)-ne 0)) 'EOF begins with an actual held native drag';$p.StandardInput.Close();$r=ReadReply $p $pending;Check ($r.error.code -eq 'E_CANCELLED' -and $r.error.may_have_executed) ('EOF cooperatively cancels active native drag '+(Describe $r));Check ($p.WaitForExit(2000)) 'EOF drains native helper before exit';$p.Dispose();$p=$null;Start-Sleep -Milliseconds 60;Fixture 'state';Check (-not $script:state.mouse_down -and (([ADLInputProbe]::GetAsyncKeyState(1)-band 0x8000)-eq 0)) 'EOF releases owned mouse before process exit'
 $p=StartHelper $app;$d=Send $p @{op='discover'};$script:target=$d.result.targets[0].target_id;$o=Send $p @{op='open';mode='interactive_desktop';target_id=$script:target};Check $o.ok 'fresh native helper for forced drag death';$script:sid=$o.result.session_id;Fixture 'focus_canvas';$null=Snap;$cap=Capture;$req=Gesture $cap 'drag' 3000;$pending=BeginSend $p $req;for($heldWait=0;$heldWait -lt 100 -and (([ADLInputProbe]::GetAsyncKeyState(1)-band 0x8000)-eq 0);$heldWait++){Start-Sleep -Milliseconds 10};Check ((([ADLInputProbe]::GetAsyncKeyState(1)-band 0x8000)-ne 0)) 'actual helper owns a held drag before forced death';$p.Kill();Check ($p.WaitForExit(2000)) 'actual killed helper releases input lease';$p.Dispose();$p=$null;$release=RunEmergency;Check ($release.code -eq 0 -and $release.result.released_input) 'actual native drag journal recovered after forced death';Start-Sleep -Milliseconds 60;Fixture 'state';Check (-not $script:state.mouse_down -and (([ADLInputProbe]::GetAsyncKeyState(1)-band 0x8000)-eq 0)) 'actual helper forced death leaves no stuck drag'
 @{ok=$true;session=(Get-Process -Id $PID).SessionId;checks=$checks;finished=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Depth 10|Set-Content (Join-Path $work 'physical-extra-result.json') -Encoding UTF8
} catch {
 @{ok=$false;error=$_.Exception.Message;stack=$_.ScriptStackTrace;checks=$checks}|ConvertTo-Json -Depth 10|Set-Content (Join-Path $work 'physical-extra-result.json') -Encoding UTF8;throw
} finally {
 StopHelper $p;try{$null=RunEmergency}catch{};if($fx -and -not $fx.HasExited){$fx.Kill();[void]$fx.WaitForExit(2000)};[void][ADLInputProbe]::SetCursorPos($initialCursor.x,$initialCursor.y)
}
