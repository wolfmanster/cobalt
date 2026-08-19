$ErrorActionPreference = 'Stop'

$androidRoot = $PSScriptRoot
$projectRoot = Split-Path -Parent $androidRoot

$env:JAVA_HOME = Join-Path $androidRoot 'toolchain\jdk-17'
$env:ANDROID_SDK_ROOT = Join-Path $androidRoot 'sdk'
$env:ANDROID_HOME = $env:ANDROID_SDK_ROOT
$env:ANDROID_USER_HOME = Join-Path $androidRoot '.android'
$env:ANDROID_NDK_HOME = Join-Path $env:ANDROID_SDK_ROOT 'ndk\28.2.13676358'
$env:CMAKE_HOME = Join-Path $env:ANDROID_SDK_ROOT 'cmake\3.31.6'
$env:GRADLE_USER_HOME = Join-Path $androidRoot 'gradle-cache'
$env:TEMP = Join-Path $androidRoot 'tmp'
$env:TMP = $env:TEMP
$env:XDG_CACHE_HOME = Join-Path $projectRoot '.cache'
$env:npm_config_cache = Join-Path $projectRoot '.npm-cache'
$env:npm_config_devdir = Join-Path $projectRoot '.cache\node-gyp'

$localPaths = @(
    (Join-Path $projectRoot '.runtime\node-v24.19.0-win-x64'),
    (Join-Path $projectRoot '.runtime\pnpm\node_modules\.bin'),
    (Join-Path $env:JAVA_HOME 'bin'),
    (Join-Path $env:ANDROID_SDK_ROOT 'platform-tools'),
    (Join-Path $env:ANDROID_SDK_ROOT 'cmdline-tools\latest\bin'),
    (Join-Path $env:ANDROID_SDK_ROOT 'build-tools\36.1.0'),
    (Join-Path $env:CMAKE_HOME 'bin'),
    (Join-Path $androidRoot 'gradle\current\bin')
)
$env:Path = (($localPaths + $env:Path) -join [IO.Path]::PathSeparator)

New-Item -ItemType Directory -Force -Path @(
    $env:ANDROID_USER_HOME,
    $env:GRADLE_USER_HOME,
    $env:TEMP,
    (Join-Path $androidRoot 'artifacts')
) | Out-Null

Write-Host "项目 Android 工具链已启用：$androidRoot"
Write-Host "JAVA_HOME=$env:JAVA_HOME"
Write-Host "ANDROID_SDK_ROOT=$env:ANDROID_SDK_ROOT"
Write-Host "GRADLE_USER_HOME=$env:GRADLE_USER_HOME"
