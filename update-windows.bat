@echo off
rem A4YE Field Ops - update to the latest version. Double-click to run.
rem Backs up your data, downloads the new version, and starts the program.
setlocal
rem Git replaces this file while updating, so run from a temporary copy.
if not "%~1"=="--run" (
  copy /y "%~f0" "%TEMP%\a4ye-update.bat" >nul
  "%TEMP%\a4ye-update.bat" --run "%~dp0"
  exit /b
)
cd /d "%~2"
title A4YE Field Ops - updating
set "BRANCH=claude/electrical-contractor-platform-1ne6m0"
set "REPO=https://github.com/nathanc-ops/A4YE_Field_Ops.git"

where git >nul 2>&1
if errorlevel 1 (
  echo Git is not installed. Download it free from https://git-scm.com/download/win
  echo Install it with the default choices, then double-click this file again.
  pause & exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Download version 22 or newer from https://nodejs.org and run this again.
  pause & exit /b 1
)

echo Stopping Field Ops if it is running...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>&1
timeout /t 2 /nobreak >nul

if exist "data\fieldops.db" (
  echo Backing up your data...
  if not exist "data\backups" mkdir "data\backups"
  copy /y "data\fieldops.db" "data\backups\fieldops-before-update-%RANDOM%.db" >nul
  if errorlevel 1 ( echo Backup failed, so nothing was changed. & pause & exit /b 1 )
  echo   saved in data\backups
)

if not exist ".git" (
  echo Connecting this folder to GitHub for the first time...
  git init -q
  git remote add origin %REPO%
)
echo Downloading the latest version...
git fetch -q origin %BRANCH%
if errorlevel 1 (
  echo Could not download. Check the internet connection. If GitHub asks you to sign in, sign in and run this again.
  pause & exit /b 1
)
git checkout -q -f -B %BRANCH% FETCH_HEAD
if errorlevel 1 ( echo Could not apply the update. & pause & exit /b 1 )
for /f "delims=" %%v in ('git log -1 --format^="%%h %%s"') do echo Now on: %%v

echo Installing packages...
call npm.cmd ci --omit=dev --no-audit --no-fund --loglevel=error
if errorlevel 1 ( echo Package install failed. Your data is untouched. & pause & exit /b 1 )

echo.
echo Update finished. Starting Field Ops...
start "A4YE Field Ops" "%~2start-windows.bat"
timeout /t 3 /nobreak >nul
exit /b 0
