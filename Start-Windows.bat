@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer from https://nodejs.org and try again.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" goto setup
".venv\Scripts\python.exe" -c "from importlib.metadata import version; assert version('ytmusicapi') == '1.12.3' and version('yt-dlp') == '2026.8.19' and version('mutagen') == '1.48.1'" >nul 2>nul
if errorlevel 1 goto setup
goto run
:setup
call Setup-Windows.bat
if errorlevel 1 (
  echo Setup failed. Fix the message above and start again.
  pause
  exit /b 1
)
:run
start "" "http://localhost:3030"
node server.mjs
pause
