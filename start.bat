@echo off
cd /d "%~dp0"
title Agri Library
where node >nul 2>nul && goto :havenode
if exist "D:\node-v24.22.0-win-x64\node.exe" set "PATH=D:\node-v24.22.0-win-x64;%PATH%"
where node >nul 2>nul && goto :havenode
echo Node.js was not found.
echo Install it from nodejs.org, or edit this file and put your Node folder in the PATH line.
pause
exit /b 1
:havenode
if exist node_modules goto :run
echo Installing, please wait...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto :fail
:run
echo.
echo Library is starting. The browser will open http://localhost:3000
echo Keep this window open. Close it to stop the site.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node server.js
pause
exit /b 0
:fail
echo Install failed. Check your internet connection and try again.
pause
exit /b 1
