#Requires -Version 5.1
# Builds the helper and the fixture, then exercises the JSONL protocol.
# Run from a Windows prompt: powershell -ExecutionPolicy Bypass -File tools\smoke.ps1
[CmdletBinding()]
param(
    [string]$BuildDir = "",
    [string]$Dotnet = "dotnet"
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrEmpty($BuildDir)) { $BuildDir = Join-Path $root "build" }
$helper = Join-Path $BuildDir "Release\adl-windows-uia-helper.exe"
$fixtureExe = Join-Path $BuildDir "fixture\FixtureApp.exe"
$controls = Join-Path $root "controls.example.json"
$script:failed = 0

function Step([string]$name, [bool]$ok, [string]$detail) {
    if ($ok) { Write-Host "PASS $name" }
    else { Write-Host "FAIL $name :: $detail"; $script:failed++ }
}

Write-Host "== build helper =="
& cmake -S $root -B $BuildDir -DCMAKE_BUILD_TYPE=Release
if ($LASTEXITCODE -ne 0) { throw "helper configure failed" }
& cmake --build $BuildDir --config Release
if ($LASTEXITCODE -ne 0) { throw "helper build failed" }
Step "helper builds" (Test-Path $helper) "no $helper"

Write-Host "== build fixture =="
& $Dotnet publish (Join-Path $root "tools\fixture\FixtureApp.csproj") -c Release -o (Join-Path $BuildDir "fixture")
if ($LASTEXITCODE -ne 0) { throw "fixture build failed" }
Step "fixture builds" (Test-Path $fixtureExe) "no $fixtureExe"

$fx = Start-Process -FilePath $fixtureExe -PassThru
Start-Sleep -Seconds 2

function New-Helper([string]$appPath) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $helper
    $psi.Arguments = "--app-id fixture --app-path `"$appPath`" --controls-file `"$controls`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    return $p
}

$script:id = 0
function Send($p, $obj) {
    $script:id++
    $req = @{} + $obj
    $req["request_id"] = [string]$script:id
    $p.StandardInput.WriteLine(($req | ConvertTo-Json -Compress -Depth 8))
    $p.StandardInput.Flush()
    $read = $p.StandardOutput.ReadLineAsync()
    if (-not $read.Wait(10000)) { $p.Kill(); throw 'helper response deadline exceeded' }
    $line = $read.Result
    if ($null -eq $line) { throw "helper closed the pipe" }
    return ($line | ConvertFrom-Json)
}
function Code($r) { if ($r.ok) { return "ok" } ; return $r.error.code }

Add-Type @"
using System;using System.Runtime.InteropServices;
public class Win { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p); }
"@
$fg0 = [Win]::GetForegroundWindow()
$cp0 = New-Object Win+P
[void][Win]::GetCursorPos([ref]$cp0)

$p = New-Helper $fixtureExe
try {
    $d = Send $p @{ op = "discover" }
    Step "discover" ($d.ok -and $d.result.targets[0].target_id -and $d.result.targets[0].application_id -and $d.result.targets.Count -eq 1) (Code $d)

    $bad = Send $p @{ op = "open"; mode = "strict_isolated"; target_id = $d.result.targets[0].target_id }
    Step "strict_isolated denied" ((Code $bad) -eq "E_INTERFERENCE_RISK") (Code $bad)
    $wrong = Send $p @{ op = "open"; mode = "background_semantic"; target_id = "nope" }
    Step "unknown target denied" ((Code $wrong) -eq "E_TARGET_NOT_FOUND") (Code $wrong)

    $o = Send $p @{ op = "open"; mode = "background_semantic"; target_id = $d.result.targets[0].target_id }
    Step "open" ($o.ok -and $o.result.session_id) (Code $o)
    $sid = $o.result.session_id

    $target = $d.result.targets[0].target_id
    $s1 = Send $p @{ op = "snapshot"; target_id = $target; session_id = $sid }
    Step "snapshot" ($s1.ok -and $s1.result.revision -ge 1 -and $s1.result.elements.Count -gt 0) (Code $s1)
    $ids = @{}
    foreach ($e in $s1.result.elements) { $ids[$e.name] = $e }
    Step "element shape" ($s1.result.elements[0].PSObject.Properties.Name -contains "enabled") "no enabled"
    $password = $s1.result.elements | Where-Object {$_.sensitive -eq $true} | Select-Object -First 1
    Step "password value redacted" ($password.sensitive -eq $true -and $password.value -ne "CANARY_NATIVE_PASSWORD") "password metadata not redacted"

    $s2 = Send $p @{ op = "snapshot"; target_id = $target; session_id = $sid }
    Step "revision stable when unchanged" ($s2.result.revision -eq $s1.result.revision) "$($s1.result.revision)/$($s2.result.revision)"

    $noEl = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = "e999"; action = "click"; expected_revision = $s2.result.revision }
    Step "missing element" ((Code $noEl) -eq "E_NO_ELEMENT") (Code $noEl)
    $stale = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $ids["Fixture text"].id; action = "fill"; value = "x"; expected_revision = 0 }
    Step "stale revision" ((Code $stale) -eq "E_STALE_REVISION") (Code $stale)

    $deny = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $ids["Unapproved control"].id; action = "fill"; value = "x"; expected_revision = $s2.result.revision }
    Step "per-action deny (unlisted control)" ((Code $deny) -eq "E_NOT_ALLOWED") (Code $deny)
    $deny2 = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $ids["Fixture text"].id; action = "click"; expected_revision = $s2.result.revision }
    Step "per-action deny (fill only)" ((Code $deny2) -eq "E_NOT_ALLOWED") (Code $deny2)
    $readOnly = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $ids["Read only"].id; action = "fill"; value = "x"; expected_revision = $s2.result.revision }
    Step "read-only value denied" ((Code $readOnly) -eq "E_READ_ONLY") (Code $readOnly)
    $passwordAct = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $password.id; action = "fill"; value = "x"; expected_revision = $s2.result.revision }
    Step "password action denied" ((Code $passwordAct) -eq "E_CONTROL_BLOCKED") (Code $passwordAct)
    $delete = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $ids["Delete record"].id; action = "click"; expected_revision = $s2.result.revision }
    Step "consequential action denied" ((Code $delete) -eq "E_CONTROL_BLOCKED") (Code $delete)

    $rev = $s2.result.revision
    $f = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $ids["Fixture text"].id; action = "fill"; value = "hello-adl"; expected_revision = $rev }
    Step "fill accepted" ($f.ok) (Code $f)
    $s3 = Send $p @{ op = "snapshot"; target_id = $target; session_id = $sid }
    $ids = @{}
    foreach ($e in $s3.result.elements) { $ids[$e.name] = $e }
    Step "fill readback" ($ids["Fixture text"].value -eq "hello-adl") "value=$($ids["Fixture text"].value)"

    $c = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $ids["Fixture button"].id; action = "click"; expected_revision = $s3.result.revision }
    Step "click accepted" ($c.ok) (Code $c)
    $s4 = Send $p @{ op = "snapshot"; target_id = $target; session_id = $sid }
    $ids = @{}
    foreach ($e in $s4.result.elements) { $ids[$e.name] = $e }
    Step "click readback" ($ids["Button clicks: 1"] -ne $null) "status label not updated"

    $k = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $ids["Fixture check"].id; action = "check"; checked = $true; expected_revision = $s4.result.revision }
    Step "check accepted" ($k.ok) (Code $k)
    $s5 = Send $p @{ op = "snapshot"; target_id = $target; session_id = $sid }
    $ids = @{}
    foreach ($e in $s5.result.elements) { $ids[$e.name] = $e }
    Step "check readback" ($ids["Fixture check"].checked -eq $true) "checked=$($ids["Fixture check"].checked)"

    $sel = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $ids["Select beta"].id; action = "select"; expected_revision = $s5.result.revision }
    Step "select accepted" ($sel.ok) (Code $sel)
    $s6 = Send $p @{ op = "snapshot"; target_id = $target; session_id = $sid }
    $ids = @{}
    foreach ($e in $s6.result.elements) { $ids[$e.name] = $e }
    Step "select readback" ($ids["Select beta"].selected -eq $true) "selected=$($ids["Select beta"].selected)"

    $sc = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $ids["Fixture scroll"].id; action = "scroll"; direction = "down"; expected_revision = $s6.result.revision }
    Step "scroll accepted" ($sc.ok) (Code $sc)
    $badDir = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $ids["Fixture scroll"].id; action = "scroll"; direction = "sideways"; expected_revision = $s6.result.revision }
    Step "scroll direction bounded" ((Code $badDir) -eq "E_BAD_REQUEST") (Code $badDir)

    $cp1 = New-Object Win+P
    [void][Win]::GetCursorPos([ref]$cp1)
    Step "cursor unmoved by semantic calls" ($cp0.X -eq $cp1.X -and $cp0.Y -eq $cp1.Y) "$($cp0.X),$($cp0.Y) -> $($cp1.X),$($cp1.Y)"
    Step "foreground unmoved by semantic calls" ([Win]::GetForegroundWindow() -eq $fg0) "foreground changed"

    $cl = Send $p @{ op = "close"; target_id = $target; session_id = $sid }
    Step "close" ($cl.ok -and $cl.result.closed) (Code $cl)
    if (-not $p.WaitForExit(5000)) { $p.Kill(); Step "helper exits after close" $false "still running" }
    else { Step "helper exits after close" $true "" }
}
finally {
    if ($p -ne $null -and -not $p.HasExited) { $p.Kill() }
    if ($fx -ne $null -and -not $fx.HasExited) { $fx.Kill() }
}

$ghost = New-Helper (Join-Path $env:WINDIR "system32\find.exe")
try {
    $gd = Send $ghost @{ op = "discover" }
    Step "missing target discover" ($gd.ok -and $gd.result.available -eq $false) (Code $gd)
    $go = Send $ghost @{ op = "open"; mode = "background_semantic"; target_id = $gd.result.target_id }
    Step "missing target open" ((Code $go) -eq "E_TARGET_NOT_FOUND") (Code $go)
}
finally { if ($ghost -ne $null -and -not $ghost.HasExited) { $ghost.Kill() } }

if ($script:failed -gt 0) { Write-Host "$($script:failed) check(s) failed"; exit 1 }
Write-Host "all smoke checks passed"
