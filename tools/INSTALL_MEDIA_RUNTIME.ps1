$ErrorActionPreference = 'Stop'
Write-Host 'Installing FFmpeg for OMNIA IQ...'
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'WinGet is unavailable. Put ffmpeg.exe and ffprobe.exe in tools\ffmpeg\bin.'
}
winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
Write-Host 'FFmpeg installed. Restart OMNIA IQ.'
