@echo off
set "PATH=C:\Users\LG\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.16.0-win-x64\;%PATH%"
cd /d "%~dp0.."
call npm.cmd run dev
