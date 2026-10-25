param([string]$Vsix)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if(-not $Vsix){$pkg=Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw|ConvertFrom-Json;$Vsix=Join-Path $PSScriptRoot ("../artifacts/agentdesklink-win32-x64-"+$pkg.version+".vsix")}
$Vsix=(Resolve-Path -LiteralPath $Vsix).Path
$code=(Get-Command code.cmd -ErrorAction Stop).Source
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('adl-vsix-install-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary|Out-Null
$oldPath=$env:PATH
try {
  $profile=Join-Path $temporary 'profile';$extensions=Join-Path $temporary 'extensions'
  & $code --user-data-dir $profile --extensions-dir $extensions --install-extension $Vsix
  if($LASTEXITCODE -ne 0){throw 'VSIX install failed'}
  $installed=@(Get-ChildItem $extensions -Directory|Where-Object {Test-Path (Join-Path $_.FullName 'runtime/node.exe')})
  if($installed.Count -ne 1){throw 'Expected exactly one installed runtime'}
  $folder=$installed[0].FullName
  $manifest=Get-Content (Join-Path $folder 'runtime/manifest.json') -Raw|ConvertFrom-Json
  if($manifest.target -ne 'win32-x64'){throw 'Wrong runtime target'}
  $entry=Join-Path $folder 'dist/extension/extension.cjs'
  $expected=(Get-FileHash -Algorithm SHA256 $entry).Hash
  [IO.File]::WriteAllText($entry,'old extension payload')
  & $code --user-data-dir $profile --extensions-dir $extensions --install-extension $Vsix
  if($LASTEXITCODE -ne 0 -or (Get-FileHash -Algorithm SHA256 $entry).Hash -ne $expected){throw 'Same-version VSIX reinstall failed'}
  $env:PATH=''
  $nodeVersion=& (Join-Path $folder 'runtime/node.exe') --version
  if($LASTEXITCODE -ne 0 -or $nodeVersion -ne $manifest.nodeVersion){throw 'Installed bundled Node did not start'}
  @{ok=$true;vsix=$Vsix;target=$manifest.target;node=$nodeVersion;systemPath='empty';isolatedInstall=$true;sameVersionReinstall=$true}|ConvertTo-Json -Compress
} finally {
  $env:PATH=$oldPath
  Remove-Item -LiteralPath $temporary -Recurse -Force
}
