@echo off
chcp 65001 >nul
echo This optional installer creates a Python environment and downloads dependencies.
echo Model weights are NOT included. Read the voice download guide afterwards.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装RVC语音.ps1" %*
set RC=%ERRORLEVEL%
echo Exit code: %RC%
pause
exit /b %RC%
