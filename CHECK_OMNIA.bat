@echo off
setlocal
cd /d "%~dp0"
title OMNIA IQ System Check
if not exist logs mkdir logs
set "LOG=%CD%\logs\system-check.log"
(
 echo ==================================================
 echo OMNIA IQ SYSTEM CHECK %DATE% %TIME%
 echo ==================================================
 where python
 python --version
 where ollama
 ollama --version
 if exist venv\Scripts\python.exe venv\Scripts\python.exe -c "import fastapi,uvicorn,httpx,dotenv,multipart; print('Python dependencies: OK')"
 echo.
 echo Installed Ollama models:
 ollama list
 echo.
 echo .env present:
 if exist .env (echo YES) else (echo NO)
) > "%LOG%" 2>&1
type "%LOG%"
echo.
echo Report saved to %LOG%
pause
