@echo off
REM ---------------------------------------------------------------
REM  Teonox Studio - local preview launcher
REM
REM  preview.bat            -> serve the SOURCE files (port 4173)
REM  preview.bat dist       -> serve the built dist/ folder (port 4173)
REM  preview.bat dist 4180  -> serve dist/ on a different port
REM
REM  Close the window to stop the server.
REM ---------------------------------------------------------------
cd /d "%~dp0"

set MODE=--source
if /i "%~1"=="dist" set MODE=--dist
if /i "%~1"=="source" set MODE=--source

set PORT=4173
if not "%~2"=="" set PORT=%~2

echo.
echo   Starting Teonox Studio preview  (mode: %MODE%, port: %PORT%)
echo   Close this window to stop it.
echo.

start "Teonox Preview" cmd /k "cd /d ""%~dp0"" && node serve.mjs %PORT% %MODE% && echo. && echo Server exited. && pause"
