@echo off
cd /d "%~dp0"
echo.
echo  Starting CourtIQ...
start "" "http://localhost:3003"
"C:\Program Files\Git\usr\bin\perl.exe" server.pl
