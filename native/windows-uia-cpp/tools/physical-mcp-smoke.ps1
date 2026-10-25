[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$NodeWorkspace,[Parameter(Mandatory=$true)][string]$BuildDir,[string]$DotnetRoot='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$root=[IO.Path]::GetFullPath($NodeWorkspace);$native=[IO.Path]::GetFullPath($BuildDir);$harness=Join-Path $root ('.adl-physical-smoke-'+[Guid]::NewGuid().ToString('N')+'.mjs');Copy-Item (Join-Path $PSScriptRoot 'physical-mcp-smoke.mjs') $harness
if($DotnetRoot){$env:DOTNET_ROOT=$DotnetRoot;$env:DOTNET_ROOT_X64=$DotnetRoot;$env:PATH=$DotnetRoot+';'+$env:PATH}
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class CursorRestore { [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; } [DllImport("user32.dll")]public static extern bool GetCursorPos(out Point p); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); }
'@
$cursor=New-Object CursorRestore+Point;[void][CursorRestore]::GetCursorPos([ref]$cursor);$p=$null
try {
 $start=New-Object System.Diagnostics.ProcessStartInfo;$start.FileName=(Get-Command node.exe).Source;$start.Arguments='"'+$harness+'" "'+$native+'"';$start.WorkingDirectory=$root;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $p=[Diagnostics.Process]::Start($start);$stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
 if(-not $p.WaitForExit(120000)){& taskkill.exe /PID $p.Id /T /F|Out-Null;throw 'MCP fixture exceeded120s'}
 $stdout.Result|Set-Content ($root+'\physical-mcp-stdout.txt') -Encoding UTF8;$stderr.Result|Set-Content ($root+'\physical-mcp-stderr.txt') -Encoding UTF8
 @{ok=($p.ExitCode -eq 0);exit_code=$p.ExitCode;session=(Get-Process -Id $PID).SessionId;finished=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json|Set-Content ($root+'\physical-mcp-runner.json') -Encoding UTF8
 if($p.ExitCode -ne 0){throw ('MCP exit'+$p.ExitCode)}
} finally {if($p -and -not $p.HasExited){& taskkill.exe /PID $p.Id /T /F|Out-Null};[void][CursorRestore]::SetCursorPos($cursor.x,$cursor.y);Remove-Item -LiteralPath $harness -Force -ErrorAction SilentlyContinue}
