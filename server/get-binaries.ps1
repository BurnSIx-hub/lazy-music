# Lazy Music — докачивает deno.exe и yt-dlp.exe в server\bin.
#
# В git бинарники не хранятся (см. .gitignore), поэтому в исходниках с GitHub
# папки bin\ нет и помощник запускаться не может. Релизный module.zip их уже
# содержит — этот скрипт нужен только тем, кто ставит модуль из исходников.
#
# Запуск:  powershell -ExecutionPolicy Bypass -File get-binaries.ps1

$ErrorActionPreference = 'Stop'
$bin = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Force $bin | Out-Null

$ytdlp = Join-Path $bin 'yt-dlp.exe'
$deno  = Join-Path $bin 'deno.exe'

try {
    if (-not (Test-Path $ytdlp)) {
        Write-Host 'Качаю yt-dlp.exe (~18 МБ)...'
        curl.exe -L -sS --fail -o $ytdlp 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        if ($LASTEXITCODE -ne 0) { throw 'не удалось скачать yt-dlp.exe' }
    }
    if (-not (Test-Path $deno)) {
        Write-Host 'Качаю deno (~100 МБ, это надолго)...'
        $zip = Join-Path $env:TEMP 'lazy-music-deno.zip'
        curl.exe -L -sS --fail -o $zip 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip'
        if ($LASTEXITCODE -ne 0) { throw 'не удалось скачать deno' }
        Expand-Archive $zip $bin -Force
        Remove-Item $zip -ErrorAction SilentlyContinue
    }
} catch {
    Write-Host ''
    Write-Host "Ошибка: $_" -ForegroundColor Red
    Write-Host 'Проще всего взять готовый module.zip со страницы релизов на GitHub —'
    Write-Host 'там бинарники уже внутри.'
    Start-Sleep -Seconds 20
    exit 1
}

if ((Test-Path $ytdlp) -and (Test-Path $deno)) {
    Write-Host 'Готово: bin\deno.exe и bin\yt-dlp.exe на месте.'
    Start-Sleep -Seconds 2
} else {
    Write-Host 'Что-то не докачалось — проверьте папку bin вручную.'
    Start-Sleep -Seconds 20
    exit 1
}
