@echo off
chcp 65001 >nul
title dsh-companion installer
echo.
echo  Installing dsh-companion (companion plugin)...
echo  It registers the plugin in the DSH profile and creates a folder link.
echo  No pnpm, no reinstalling other plugins' dependencies.
echo  DSH can stay running; restart DSH after installation.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" echo  [FAILED] exit code %RC%
echo  Done. Reopen DSH, then check: Settings -^> Plugins -^> Installed (dsh-companion)
echo  and the right sidebar (companion panel).
echo.
pause
exit /b %RC%
