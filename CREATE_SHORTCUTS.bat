@echo off
setlocal
cd /d "%~dp0"
set "SCRIPT=%CD%\START_OMNIA.bat"
set "DESKTOP=%USERPROFILE%\Desktop\OMNIA IQ.lnk"
set "STARTMENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\OMNIA IQ.lnk"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; foreach($p in @('%DESKTOP%','%STARTMENU%')){$s=$ws.CreateShortcut($p);$s.TargetPath='%SCRIPT%';$s.WorkingDirectory='%CD%';$s.Description='OMNIA IQ Local LLM Orchestrator';$s.IconLocation='%CD%\assets\omnia-iq.ico,0';$s.Save()}"
if /I not "%~1"=="/silent" pause
