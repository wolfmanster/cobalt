$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$localNode = Join-Path $projectRoot '.runtime\node-v24.19.0-win-x64'
$localCache = Join-Path $projectRoot '.cache'
$localTemp = Join-Path $localCache 'temp'

New-Item -ItemType Directory -Force -Path $localTemp | Out-Null

if (Test-Path (Join-Path $localNode 'node.exe')) {
    $env:Path = "$localNode;$env:Path"
    $nodeExe = Join-Path $localNode 'node.exe'
} else {
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
}

$env:TEMP = $localTemp
$env:TMP = $localTemp
$env:XDG_CACHE_HOME = $localCache
$env:npm_config_cache = Join-Path $projectRoot '.npm-cache'
$env:npm_config_devdir = Join-Path $localCache 'node-gyp'

Push-Location (Join-Path $projectRoot 'api')
try {
    & $nodeExe 'src/cobalt.js'
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
