@echo off
setlocal
cd /d "%~dp0"
python -I night.py %*
echo.
echo exit code: %ERRORLEVEL%
pause
