@echo off
setlocal
cd /d "%~dp0"
python -I scout.py %*
echo.
echo exit code: %ERRORLEVEL%
pause
