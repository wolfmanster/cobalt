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

$cobalt = Start-Process -FilePath $nodeExe `
    -ArgumentList 'src/cobalt.js' `
    -WorkingDirectory (Join-Path $projectRoot 'api') `
    -WindowStyle Hidden `
    -PassThru

try {
    Write-Host 'Cobalt 正在启动：http://127.0.0.1:9000'
    Write-Host '产品服务正在启动：http://127.0.0.1:4100'
    Push-Location (Join-Path $projectRoot 'apps\server')
    & $nodeExe 'dist/index.js'
} finally {
    Pop-Location
    if (!$cobalt.HasExited) {
        Stop-Process -Id $cobalt.Id
    }
}
