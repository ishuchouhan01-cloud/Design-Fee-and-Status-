@echo off
rem ===========================================================================
rem  PROJECT DRAWING STATUS - go back to an earlier version
rem
rem  Lists the versions of the application kept on this computer and puts the
rem  chosen one back. The version on disk now is kept too, so a rollback can
rem  itself be undone. Close the application window before running this.
rem  All of the work is in scripts\versions.mjs.
rem ===========================================================================

setlocal
title Project Drawing Status - roll back
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is required and was not found on this computer.
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\versions.mjs" rollback
echo.
pause
endlocal
