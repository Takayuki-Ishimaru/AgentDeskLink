#Requires -Version 5.1
# Exercises the real helper's --operation-mode standard|ask tiers against the WinForms fixture over the JSONL protocol.
# Semantic background mode only: no pointer, keyboard or focus is touched. Build first (tools\smoke.ps1 or the README
# cmake commands plus `dotnet publish tools\fixture`), then run from an interactive desktop session:
#   powershell -ExecutionPolicy Bypass -File tools\standard-tier-smoke.ps1 -BuildDir <build> [-FixtureExe <FixtureApp.exe>]
[CmdletBinding()]
param(
    [string]$BuildDir = "",
    [string]$FixtureExe = ""
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrEmpty($BuildDir)) { $BuildDir = Join-Path $root "build" }
$helper = Join-Path $BuildDir "Release\adl-windows-uia-helper.exe"
if ([string]::IsNullOrEmpty($FixtureExe)) { $FixtureExe = Join-Path $BuildDir "fixture\FixtureApp.exe" }
if (-not (Test-Path $helper)) { throw "helper not built: $helper" }
if (-not (Test-Path $FixtureExe)) { throw "fixture not built: $FixtureExe" }
$script:failed = 0
function Step([string]$name, [bool]$ok, [string]$detail) {
    if ($ok) { Write-Host "PASS $name" } else { Write-Host "FAIL $name :: $detail"; $script:failed++ }
}
function New-Helper([string[]]$flags) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $helper
    $psi.Arguments = "--app-id fixture --app-path `"$FixtureExe`" " + ($flags -join " ")
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    return [System.Diagnostics.Process]::Start($psi)
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
function Snapshot($p, $target, $sid) {
    $s = Send $p @{ op = "snapshot"; target_id = $target; session_id = $sid }
    $ids = @{}
    foreach ($e in $s.result.elements) { $ids[$e.name] = $e }
    return @{ revision = $s.result.revision; ids = $ids }
}
Add-Type @"
using System;using System.Runtime.InteropServices;
public class Win { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p); }
"@
$fg0 = [Win]::GetForegroundWindow()
$cp0 = New-Object Win+P
[void][Win]::GetCursorPos([ref]$cp0)

$fx = Start-Process -FilePath $FixtureExe -PassThru
Start-Sleep -Seconds 2
# The fixture may still be starting (first run, JIT); discovery is polled read-only until its window appears.
function Discover-Until($p) {
    $deadline = (Get-Date).AddSeconds(20)
    do {
        $d = Send $p @{ op = "discover" }
        if ($d.ok -and $d.result.targets.Count -ge 1) { return $d }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $d
}
try {
    # --- standard tier -----------------------------------------------------------------------
    $p = New-Helper @("--operation-mode", "standard")
    try {
        $d = Discover-Until $p
        Step "standard: discover reports mutations_enabled" ($d.ok -and $d.result.mutations_enabled -eq $true -and $d.result.targets.Count -eq 1) (Code $d)
        $target = $d.result.targets[0].target_id
        $o = Send $p @{ op = "open"; mode = "background_semantic"; target_id = $target }
        Step "standard: open" ($o.ok) (Code $o)
        $sid = $o.result.session_id
        $snap = Snapshot $p $target $sid
        $password = $snap.ids["Password"]
        if ($null -eq $password) { $password = $snap.ids.Values | Where-Object { $_.sensitive -eq $true } | Select-Object -First 1 }
        $delete = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $snap.ids["Delete record"].id; action = "click"; expected_revision = $snap.revision }
        Step "standard: consequential click refused" ((Code $delete) -eq "E_APPROVAL_REQUIRED" -and -not $delete.error.may_have_executed) (Code $delete)
        $secret = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $password.id; action = "fill"; value = "x"; expected_revision = $snap.revision }
        Step "standard: sensitive fill refused" ((Code $secret) -eq "E_PRIVACY_BLOCKED") (Code $secret)
        $forged = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $snap.ids["Delete record"].id; action = "click"; expected_revision = $snap.revision; approved = $true }
        Step "standard: approved field rejected" ((Code $forged) -eq "E_BAD_REQUEST") (Code $forged)
        $f = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $snap.ids["Fixture text"].id; action = "fill"; value = "tier-standard"; expected_revision = $snap.revision }
        Step "standard: ordinary fill accepted" ($f.ok) (Code $f)
        $snap = Snapshot $p $target $sid
        Step "standard: fill readback" ($snap.ids["Fixture text"].value -eq "tier-standard") "value=$($snap.ids["Fixture text"].value)"
        $c = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $snap.ids["Fixture button"].id; action = "click"; expected_revision = $snap.revision }
        Step "standard: ordinary click accepted" ($c.ok) (Code $c)
        $snap = Snapshot $p $target $sid
        Step "standard: click readback" ($null -ne $snap.ids["Button clicks: 1"]) "status label not updated"
        $k = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $snap.ids["Fixture check"].id; action = "check"; checked = $true; expected_revision = $snap.revision }
        Step "standard: check accepted" ($k.ok) (Code $k)
        $snap = Snapshot $p $target $sid
        $sc = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $snap.ids["Fixture scroll"].id; action = "scroll"; direction = "down"; expected_revision = $snap.revision }
        Step "standard: scroll accepted" ($sc.ok) (Code $sc)
        $snap = Snapshot $p $target $sid
        Step "standard: delete status untouched" ($null -eq $snap.ids["Interference fixture invoked"] -and $null -ne $snap.ids["Delete record"]) "unexpected fixture state"
        $cl = Send $p @{ op = "close"; target_id = $target; session_id = $sid }
        Step "standard: close" ($cl.ok) (Code $cl)
    }
    finally { if ($p -ne $null -and -not $p.HasExited) { $p.Kill() } }

    # --- ask tier ----------------------------------------------------------------------------
    $p = New-Helper @("--operation-mode", "ask")
    try {
        $d = Discover-Until $p
        Step "ask: discover reports mutations_enabled" ($d.ok -and $d.result.mutations_enabled -eq $true) (Code $d)
        $target = $d.result.targets[0].target_id
        $o = Send $p @{ op = "open"; mode = "background_semantic"; target_id = $target }
        $sid = $o.result.session_id
        $snap = Snapshot $p $target $sid
        $password = $snap.ids["Password"]
        if ($null -eq $password) { $password = $snap.ids.Values | Where-Object { $_.sensitive -eq $true } | Select-Object -First 1 }
        $delete = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $snap.ids["Delete record"].id; action = "click"; expected_revision = $snap.revision }
        Step "ask: consequential click refused without approval" ((Code $delete) -eq "E_APPROVAL_REQUIRED") (Code $delete)
        $bad = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $snap.ids["Delete record"].id; action = "click"; expected_revision = $snap.revision; approved = $false }
        Step "ask: approved:false rejected" ((Code $bad) -eq "E_BAD_REQUEST") (Code $bad)
        $secret = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $password.id; action = "fill"; value = "x"; expected_revision = $snap.revision; approved = $true }
        Step "ask: sensitive refused even with approved:true" ((Code $secret) -eq "E_PRIVACY_BLOCKED") (Code $secret)
        $ok = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $snap.ids["Delete record"].id; action = "click"; expected_revision = $snap.revision; approved = $true }
        Step "ask: approved consequential click accepted" ($ok.ok) (Code $ok)
        $f = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $snap.ids["Fixture text"].id; action = "fill"; value = "tier-ask"; expected_revision = $snap.revision }
        $snap2 = Snapshot $p $target $sid
        Step "ask: ordinary fill accepted without approval" ($f.ok -and $snap2.ids["Fixture text"].value -eq "tier-ask") (Code $f)
        $again = Send $p @{ op = "act"; target_id = $target; session_id = $sid; element_id = $snap2.ids["Delete record"].id; action = "click"; expected_revision = $snap2.revision }
        Step "ask: the next consequential click asks again" ((Code $again) -eq "E_APPROVAL_REQUIRED") (Code $again)
        $cl = Send $p @{ op = "close"; target_id = $target; session_id = $sid }
        Step "ask: close" ($cl.ok) (Code $cl)
    }
    finally { if ($p -ne $null -and -not $p.HasExited) { $p.Kill() } }

    # --- launch-time guards ------------------------------------------------------------------
    foreach ($flags in @(@("--operation-mode", "all"), @("--operation-mode", "standard", "--allow-all"), @("--operation-mode", "ask", "--controls-file", "`"$(Join-Path $root 'controls.example.json')`""))) {
        $g = New-Helper $flags
        $line = $g.StandardOutput.ReadLine()
        $g.WaitForExit(5000) | Out-Null
        $parsed = $null; try { $parsed = $line | ConvertFrom-Json } catch {}
        Step "launch guard: $($flags -join ' ')" ($g.ExitCode -eq 2 -and $null -ne $parsed -and $parsed.error.code -eq "E_CONFIG") "exit=$($g.ExitCode) line=$line"
        if (-not $g.HasExited) { $g.Kill() }
    }

    $cp1 = New-Object Win+P
    [void][Win]::GetCursorPos([ref]$cp1)
    Step "cursor unmoved by semantic calls" ($cp0.X -eq $cp1.X -and $cp0.Y -eq $cp1.Y) "$($cp0.X),$($cp0.Y) -> $($cp1.X),$($cp1.Y)"
    Step "foreground unmoved by semantic calls" ([Win]::GetForegroundWindow() -eq $fg0) "foreground changed"
}
finally {
    if ($fx -ne $null -and -not $fx.HasExited) { $fx.Kill() }
}
if ($script:failed -gt 0) { Write-Host "$($script:failed) check(s) failed"; exit 1 }
Write-Host "all standard-tier smoke checks passed"
