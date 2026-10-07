@echo off
rem ===========================================================================
rem  PROJECT DRAWING STATUS - share a public test link from this laptop
rem
rem  Double-click to get an https link (Cloudflare Quick Tunnel, free, no
rem  account) that anyone can open. It asks for a Viewer password first,
rem  because the link is public. Close the window to stop sharing.
rem  All of the work is in scripts\public-link.ps1.
rem ===========================================================================

setlocal
title Project Drawing Status - public link
cd /d "%~dp0"

if not exist "%~dp0scripts\public-link.ps1" (
  echo.
  echo  scripts\public-link.ps1 is missing. Keep this file in the application folder.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\public-link.ps1"
endlocal
