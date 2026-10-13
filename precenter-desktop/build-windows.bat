@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
call npm install
if errorlevel 1 goto fail
call npm test
if errorlevel 1 goto fail
call npm run dist
if errorlevel 1 goto fail
echo.
echo Done. The installer and the portable program are in the "dist" folder.
start "" "%~dp0dist"
pause
exit /b 0
:fail
echo.
echo Something went wrong. Scroll up to read the error message.
pause
exit /b 1
