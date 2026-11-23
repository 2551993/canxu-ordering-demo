@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22.13 or later, then run this file again.
  pause
  exit /b 1
)
node -e "try { require('node:sqlite'); } catch { process.exit(1); }"
if errorlevel 1 (
  echo Node.js 22.13 or later with built-in SQLite is required.
  pause
  exit /b 1
)
if not exist "node_modules\qrcode\package.json" (
  call npm.cmd ci --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node "scripts\start-demo.mjs"
if errorlevel 1 pause
