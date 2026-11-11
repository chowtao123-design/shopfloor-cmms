@echo off
rem Starts the Shopfloor CMMS team server from this folder.
rem Double-click it, or point Windows Task Scheduler at it to start on boot.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 24 LTS:  winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
echo Starting Shopfloor CMMS (default http://localhost:8080). Close this window to stop it.
node server\server.js
if errorlevel 1 pause
