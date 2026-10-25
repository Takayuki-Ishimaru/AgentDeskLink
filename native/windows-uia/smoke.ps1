param([switch]$Help)
$ErrorActionPreference = 'Stop'
if ($Help) { Write-Output 'On Windows: run smoke.ps1 to build and exercise the fixture and helper.'; exit 0 }
if (-not $IsWindows) { throw 'This smoke test requires Windows; cross-build does not verify UI Automation runtime behavior.' }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$helperProject = Join-Path $here 'AgentDeskLink.WindowsUia.csproj'
$fixtureProject = Join-Path $here 'fixture/Fixture.csproj'
dotnet build $helperProject -c Release | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Helper build failed' }
dotnet build $fixtureProject -c Release | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Fixture build failed' }
$fixtureExe = Join-Path $here 'fixture/bin/Release/net8.0-windows/AgentDeskLink.TestFixture.exe'
$helperDll = Join-Path $here 'bin/Release/net8.0-windows/AgentDeskLink.WindowsUia.dll'
$fixture = Start-Process -FilePath $fixtureExe -PassThru
try {
    Start-Sleep -Seconds 2
    $psi = [System.Diagnostics.ProcessStartInfo]::new('dotnet')
    $psi.ArgumentList.Add($helperDll)
    $psi.ArgumentList.Add('--app-id'); $psi.ArgumentList.Add('adl-fixture')
    $psi.ArgumentList.Add('--app-path'); $psi.ArgumentList.Add($fixtureExe)
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
    $helper = [System.Diagnostics.Process]::Start($psi)
    function Call([string]$json) {
        $helper.StandardInput.WriteLine($json); $helper.StandardInput.Flush()
        $pending = $helper.StandardOutput.ReadLineAsync()
        if (-not $pending.Wait(5000)) { throw 'Helper response timed out' }
        return ($pending.Result | ConvertFrom-Json)
    }
    $d = Call '{"op":"discover","request_id":"1"}'
    if (-not $d.ok -or -not $d.result.available) { throw 'configured fixture was not discovered' }
    $strict = Call (@{op='open';request_id='2';target_id=$d.result.target_id;mode='strict_isolated'} | ConvertTo-Json -Compress)
    if ($strict.ok -or $strict.error.code -ne 'E_INTERFERENCE_RISK') { throw 'strict mode did not fail closed' }
    $opened = Call (@{op='open';request_id='3';target_id=$d.result.target_id;mode='background_semantic'} | ConvertTo-Json -Compress)
    if (-not $opened.ok -or $opened.result.mutations_enabled) { throw 'background observation did not open in gated mode' }
    $sid = $opened.result.session_id
    $snap = Call (@{op='snapshot';request_id='4';session_id=$sid} | ConvertTo-Json -Compress)
    if (-not $snap.ok -or $snap.result.elements.Count -lt 1) { throw 'snapshot returned no elements' }
    $eid = $snap.result.elements[0].id
    $act = Call (@{op='act';request_id='5';session_id=$sid;element_id=$eid;action='click'} | ConvertTo-Json -Compress)
    if ($act.ok -or $act.error.code -ne 'E_UNSUPPORTED_ACTION') { throw 'mutation gate did not reject action' }
    $staleElement = Call (@{op='act';request_id='6';session_id=$sid;element_id='missing';action='click'} | ConvertTo-Json -Compress)
    if ($staleElement.ok -or $staleElement.error.code -ne 'E_STALE_HANDLE') { throw 'stale element was not rejected' }
    $stale = Call '{"op":"snapshot","request_id":"7","session_id":"unknown"}'
    if ($stale.ok -or $stale.error.code -ne 'E_STALE_HANDLE') { throw 'stale session was not rejected' }
    $closed = Call (@{op='close';request_id='8';session_id=$sid} | ConvertTo-Json -Compress)
    if (-not $closed.ok) { throw 'close failed' }
    $helper.StandardInput.Close(); if (-not $helper.WaitForExit(5000)) { throw 'EOF cleanup timed out' }
    Write-Output 'PASS: discover, strict rejection, background snapshot, gated act, stale handle, close'
} finally {
    if ($helper -and -not $helper.HasExited) { $helper.Kill() }
    if (-not $fixture.HasExited) { $fixture.Kill() }
}
