@echo off
rem Drag a .mvp session file onto this .bat to open it directly.
cd /d "%~dp0"
npm start -- "%~1"
