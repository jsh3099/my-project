@echo off
rem On the PC where node was installed via winget, node is not on PATH; prepend it there (skipped elsewhere).
set "WINGET_NODE=C:\Users\LG\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.16.0-win-x64"
if exist "%WINGET_NODE%\node.exe" set "PATH=%WINGET_NODE%;%PATH%"
cd /d "%~dp0.."
call npm.cmd run dev
