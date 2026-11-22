@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22 or later, then run this file again.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 22 or later is required.
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
if not defined PORT set "PORT=8787"
node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health',{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).then(v=>{if(v.paymentMode!=='simulation'||v.printMode!=='simulation')process.exit(1)}).catch(()=>process.exit(1))"
if not errorlevel 1 (
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)
set "ORDER_DEMO_OPEN_BROWSER=1"
call npm.cmd start
pause
