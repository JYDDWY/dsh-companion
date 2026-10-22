@echo off
chcp 65001 >nul
title dsh-companion uninstaller
echo.
echo  Removing dsh-companion from your DSH profile...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" echo  [FAILED] exit code %RC%
echo  Done. Reopen DSH; the plugin entry and sidebar panel will be gone.
echo.
pause
exit /b %RC%
