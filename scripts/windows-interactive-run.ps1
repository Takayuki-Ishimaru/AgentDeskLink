param([Parameter(Mandatory=$true)][string]$Script,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$context=@{time=(Get-Date).ToUniversalTime().ToString('o');user=[Security.Principal.WindowsIdentity]::GetCurrent().Name;session=(Get-Process -Id $PID).SessionId;explorerSessions=@(Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SessionId)}
$context | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $OutputDirectory 'context.json') -Encoding UTF8
try {
    if($context.session -eq 0){throw 'Interactive desktop tests cannot run in service session 0.'}
    & $Script *> (Join-Path $OutputDirectory 'output.txt')
    if($LASTEXITCODE -and $LASTEXITCODE -ne 0){throw "Test process exited $LASTEXITCODE"}
    @{ok=$true;finished=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $OutputDirectory 'result.json') -Encoding UTF8
} catch {
    @{ok=$false;error=$_.Exception.Message;finished=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $OutputDirectory 'result.json') -Encoding UTF8
    exit 1
}
