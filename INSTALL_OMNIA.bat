@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title OMNIA IQ Installer

if not exist logs mkdir logs
set "STAMP=%RANDOM%_%RANDOM%"
set "LOG=%CD%\logs\install_%STAMP%.log"

echo OMNIA IQ installer log: %LOG%
echo.
echo Do not close this window while prerequisites are being installed.
echo Ollama may take several minutes to download and install.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\tools\INSTALL_OMNIA.ps1" -Root "%CD%" -LogPath "%LOG%"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo OMNIA IQ installation did not complete.
  echo Review this log:
  echo %LOG%
  pause
  exit /b %RC%
)

echo.
echo OMNIA IQ installation completed successfully.
echo Log: %LOG%
echo.
choice /C YN /M "Create Desktop and Start Menu shortcuts"
if errorlevel 2 goto skip_shortcuts
call "%CD%\CREATE_SHORTCUTS.bat" /silent
:skip_shortcuts

echo.
choice /C YN /M "Run the first-run model setup now"
if errorlevel 2 goto done
call "%CD%\FIRST_RUN_SETUP.bat"
:done
echo.
echo Run START_OMNIA.bat to launch OMNIA IQ.
pause
exit /b 0
