@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title OMNIA IQ First-Run Setup
if not exist logs mkdir logs
for /f "tokens=1-4 delims=/ " %%a in ("%date%") do set D=%%d%%b%%c
for /f "tokens=1-3 delims=:., " %%a in ("%time%") do set T=%%a%%b%%c
set "T=%T: =0%"
set "LOG=%CD%\logs\first-run_%D%_%T%.log"
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\tools\FIRST_RUN_SETUP.ps1" -Root "%CD%" -LogPath "%LOG%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo First-run setup failed. Review:
  echo %LOG%
  pause
  exit /b %RC%
)
echo.
echo First-run setup completed.
echo Log: %LOG%
pause
exit /b 0
