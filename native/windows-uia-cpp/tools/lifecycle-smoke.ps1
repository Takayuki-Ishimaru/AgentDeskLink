param([Parameter(Mandatory=$true)][string]$HelperExe,[string]$ApplicationExe=(Join-Path $env:WINDIR 'System32/charmap.exe'),[string]$OutputDirectory)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
if(-not $OutputDirectory){$OutputDirectory=Join-Path $root ('artifacts/windows-lifecycle-'+[Guid]::NewGuid().ToString('N'))}
$out=[IO.Path]::GetFullPath($OutputDirectory);New-Item -ItemType Directory -Path $out -Force|Out-Null
$node=(Get-Command node -ErrorAction Stop).Source
 Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;Add-Type -AssemblyName WindowsBase
 $uia=[Windows.Automation.AutomationElement].Assembly.Location;$types=[Windows.Automation.AutomationProperty].Assembly.Location
 Add-Type -ReferencedAssemblies @($uia,$types,'System.dll') -TypeDefinition @'
using System;using System.Text;using System.Threading;using System.Runtime.InteropServices;using System.Windows.Automation;
public static class ADLWindowsCheck {
 [StructLayout(LayoutKind.Sequential)]struct Point{public int x,y;}
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int l,t,r,b;}
 [StructLayout(LayoutKind.Sequential)]struct Gui{public int size,flags;public IntPtr active,focus,capture,menuOwner,moveSize,caret;public Rect rect;}
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr pid);
 [DllImport("user32.dll")]static extern bool GetGUIThreadInfo(uint id,ref Gui g);
 [DllImport("user32.dll")]static extern bool GetCursorPos(out Point p);
 struct Sample{public IntPtr fg,focus;public int x,y;public string uia;public bool Same(Sample s){return fg==s.fg&&focus==s.focus&&x==s.x&&y==s.y&&uia==s.uia;}}
 static Sample Read(){var fg=GetForegroundWindow();var g=new Gui{size=Marshal.SizeOf(typeof(Gui))};Point p;if(fg==IntPtr.Zero||!GetGUIThreadInfo(GetWindowThreadProcessId(fg,IntPtr.Zero),ref g)||!GetCursorPos(out p))throw new Exception("Native focus probe failed");var e=AutomationElement.FocusedElement;var id=e==null?"<none>":string.Join(",",e.GetRuntimeId());return new Sample{fg=fg,focus=g.focus,x=p.x,y=p.y,uia=id};}
 static Sample baseline;static Thread thread;static volatile bool running;public static int Samples,Changes,ForegroundChanges,FocusChanges,CursorChanges,Errors;
 public static void Start(){baseline=Read();Samples=Changes=ForegroundChanges=FocusChanges=CursorChanges=Errors=0;running=true;thread=new Thread(()=>{while(running){try{var s=Read();Samples++;if(!s.Same(baseline))Changes++;if(s.fg!=baseline.fg)ForegroundChanges++;if(s.focus!=baseline.focus||s.uia!=baseline.uia)FocusChanges++;if(s.x!=baseline.x||s.y!=baseline.y)CursorChanges++;}catch{Errors++;}Thread.Sleep(10);}});thread.IsBackground=true;thread.Start();}
 public static bool Unchanged(){return baseline.Same(Read());}
 public static void Stop(){running=false;if(thread!=null&&!thread.Join(2000))throw new Exception("Monitor did not stop");}

}
'@
 function MonitorResult {return @{samples=[ADLWindowsCheck]::Samples;changed_samples=[ADLWindowsCheck]::Changes;foreground_changes=[ADLWindowsCheck]::ForegroundChanges;focus_changes=[ADLWindowsCheck]::FocusChanges;cursor_changes=[ADLWindowsCheck]::CursorChanges;probe_errors=[ADLWindowsCheck]::Errors;scope='Native foreground HWND, GUI thread focus, exact UIA focused runtime ID and cursor; read-only sampling'} }

$process=$null;$started=$false
try{
 Set-Location $root
 [ADLWindowsCheck]::Start();$started=$true
 $argsList=@((Join-Path $root 'scripts/windows-background-charmap.mjs'),[IO.Path]::GetFullPath($HelperExe),[IO.Path]::GetFullPath($ApplicationExe),$out)
 if($argsList|Where-Object {$_ -match '"|[\r\n]'}){throw 'Paths must not contain quotes or line breaks'}
 $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$node;$info.Arguments=($argsList|ForEach-Object {'"'+($_ -replace '(\\+)$','$1$1')+'"'}) -join ' '
 $info.WorkingDirectory=$root;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 $process=[Diagnostics.Process]::Start($info);$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
 if(-not $process.WaitForExit(180000)){throw 'Lifecycle MCP test exceeded 180 seconds'}
 [IO.File]::WriteAllText((Join-Path $out 'stdout.txt'),$stdout.Result,[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText((Join-Path $out 'stderr.txt'),$stderr.Result,[Text.UTF8Encoding]::new($false))
 if($process.ExitCode -ne 0){throw ('Lifecycle MCP test failed: '+$process.ExitCode)}
}finally{
 if($started){[ADLWindowsCheck]::Stop();$monitor=MonitorResult;[IO.File]::WriteAllText((Join-Path $out 'human-input-monitor.json'),($monitor|ConvertTo-Json),[Text.UTF8Encoding]::new($false))}
 if($process -and -not $process.HasExited){$process.Kill()}
}
if($monitor.changed_samples -ne 0 -or $monitor.probe_errors -ne 0){throw 'Human foreground/focus/cursor monitor changed or failed; inspect human-input-monitor.json'}
Write-Output ('Passed: Character Map lifecycle and UIA operations; '+$monitor.samples+' unchanged input samples. '+$out)
