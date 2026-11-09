@echo off
rem A4YE Field Ops - start the program and open it in the browser. Double-click to run.
rem Keep this window open while you use it; closing it stops the program.
cd /d "%~dp0"
title A4YE Field Ops
where node >nul 2>&1
if errorlevel 1 ( echo Node.js is not installed. Download version 22 or newer from https://nodejs.org & pause & exit /b 1 )
if not exist "node_modules\express" (
  echo First run: installing packages...
  call npm.cmd ci --omit=dev --no-audit --no-fund --loglevel=error
  if errorlevel 1 ( pause & exit /b 1 )
)
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
node --no-warnings server\index.js
echo.
echo Field Ops stopped.
pause
