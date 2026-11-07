@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Установите Node.js LTS и запустите этот файл ещё раз.
  pause
  exit /b 1
)
node scripts/start.mjs
pause
