@echo off
setlocal
cd /d "%~dp0"
echo Installing FFmpeg for OMNIA IQ...
where winget >nul 2>&1
if errorlevel 1 (
  echo WinGet is unavailable.
  echo Put ffmpeg.exe and ffprobe.exe in tools\ffmpeg\bin
  pause
  exit /b 1
)
winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo Installation failed. See the message above.
  pause
  exit /b 1
)
echo.
echo FFmpeg installed. Restart OMNIA IQ.
pause
