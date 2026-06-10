# Lazy Music — сборка релиза для GitHub.
# Создаёт release\module.zip (модуль целиком, с yt-dlp.exe и deno.exe)
# и release\module.json (манифест для установки по ссылке в Foundry).
#
# Запуск:  powershell -ExecutionPolicy Bypass -File tools\pack-release.ps1

$ErrorActionPreference = 'Stop'
$root    = Split-Path $PSScriptRoot
$bin     = Join-Path $root 'server\bin'
$release = Join-Path $root 'release'

# 1. Бинарники: докачиваем, если их нет (в git они не хранятся)
New-Item -ItemType Directory -Force $bin | Out-Null
$ytdlp = Join-Path $bin 'yt-dlp.exe'
$deno  = Join-Path $bin 'deno.exe'
if (-not (Test-Path $ytdlp)) {
    Write-Host 'Качаю yt-dlp.exe...'
    curl.exe -L -sS -o $ytdlp 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
}
if (-not (Test-Path $deno)) {
    Write-Host 'Качаю deno...'
    $zip = Join-Path $env:TEMP 'deno.zip'
    curl.exe -L -sS -o $zip 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip'
    Expand-Archive $zip $bin -Force
    Remove-Item $zip
}

# 2. Собираем содержимое во временную папку (без локальных данных)
$stage = Join-Path $env:TEMP 'lazy-music-release'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
$exclude = @('.git', 'cache', 'release', 'tools')
Get-ChildItem $root | Where-Object { $exclude -notcontains $_.Name } |
    Copy-Item -Destination $stage -Recurse
Remove-Item (Join-Path $stage 'server\helper.log') -ErrorAction SilentlyContinue
Get-ChildItem $stage -Recurse -Filter '*cookies*' | Remove-Item -Force

# 3. Архив + манифест
New-Item -ItemType Directory -Force $release | Out-Null
$zipPath = Join-Path $release 'module.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath }
Compress-Archive -Path "$stage\*" -DestinationPath $zipPath
Copy-Item (Join-Path $root 'module.json') (Join-Path $release 'module.json') -Force
Remove-Item $stage -Recurse -Force

$ver = (Get-Content (Join-Path $root 'module.json') -Raw | ConvertFrom-Json).version
Write-Host "Готово: $zipPath (версия $ver, $([math]::Round((Get-Item $zipPath).Length / 1MB)) МБ)"
Write-Host 'Дальше: создать релиз на GitHub и приложить module.zip и module.json.'
