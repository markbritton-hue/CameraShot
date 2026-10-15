@echo off
setlocal
cd /d "%~dp0"
title CameraShot server (close this window to stop CameraShot)

if "%PORT%"=="" set PORT=3001

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

rem Already running (this launcher, or "npm run dev")? Then just open it, never start a second copy.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  echo CameraShot is already running on port %PORT%.
  if not defined NO_BROWSER start "" http://localhost:%PORT%
  exit /b 0
)

if not exist node_modules (
  echo First run: installing packages, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo Install failed.
    pause
    exit /b 1
  )
)

if not exist client\.env.local echo Note: client\.env.local not found, so sign-in and cloud shows will be off.
if not exist tools\go2rtc\go2rtc.exe echo Note: tools\go2rtc\go2rtc.exe not found, so live video will be off.

echo Building CameraShot...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

rem Open the browser as soon as the server answers (runs in the background).
if not defined NO_BROWSER start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i=0; $i -lt 60; $i++) { try { Invoke-WebRequest http://localhost:%PORT% -UseBasicParsing -TimeoutSec 1 | Out-Null; Start-Process http://localhost:%PORT%; break } catch { Start-Sleep -Seconds 1 } }"

echo.
echo CameraShot is starting at http://localhost:%PORT%
echo Leave this window open while you use it. Close it to stop CameraShot.
echo.
call npm start

echo.
echo CameraShot stopped.
pause
