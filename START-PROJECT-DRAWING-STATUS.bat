@echo off
rem ===========================================================================
rem  PROJECT DRAWING STATUS
rem  Double-click this file to start the application.
rem
rem  This file is deliberately tiny. All of the real work is in
rem  scripts\launcher.mjs, which is written in Node.js because that can be
rem  tested; batch files cannot.
rem
rem  No path below is specific to one computer: %~dp0 is the folder this file
rem  is in, so the project can be moved or copied to another machine and this
rem  still works.
rem ===========================================================================

setlocal
title Project Drawing Status
cd /d "%~dp0"

if not exist "%~dp0scripts\launcher.mjs" goto NO_LAUNCHER

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

node "%~dp0scripts\launcher.mjs"
if errorlevel 1 goto FAILED

rem Normal exit: the user stopped the application.
endlocal
exit /b 0


:NO_NODE
echo.
echo ============================================
echo  PROJECT DRAWING STATUS
echo ============================================
echo.
echo  Node.js is required to run Project Drawing Status,
echo  and it was not found on this computer.
echo.
echo  Please contact IT and ask for the Node.js LTS runtime,
echo  version 20 or newer, to be installed.
echo.
echo  Nothing on this computer has been changed.
echo.
pause
endlocal
exit /b 1


:NO_LAUNCHER
echo.
echo ============================================
echo  PROJECT DRAWING STATUS
echo ============================================
echo.
echo  This launcher cannot find the application files.
echo.
echo  Expected to find:
echo      %~dp0scripts\launcher.mjs
echo.
echo  START-PROJECT-DRAWING-STATUS.bat must stay in the application
echo  folder. If it was copied to the Desktop, create a
echo  shortcut to it instead of copying the file.
echo.
pause
endlocal
exit /b 1


:FAILED
echo.
echo  The application did not start. The reason is shown above.
echo.
pause
endlocal
exit /b 1
