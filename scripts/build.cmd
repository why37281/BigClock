@echo off
REM ============================================================
REM BigClock build entry.
REM
REM Picks PowerShell 7 (pwsh) when it is installed, otherwise falls
REM back to Windows PowerShell 5.1.
REM
REM Why: 5.1 decodes .ps1 as ANSI/GBK unless the file starts with a
REM UTF-8 BOM, so one editor pass that strips the BOM breaks the whole
REM build with a parse error. PowerShell 7 reads UTF-8 by default.
REM Keep build.ps1's BOM anyway: the 5.1 fallback path still needs it.
REM
REM ASCII only on purpose: cmd.exe reads batch files in the OEM code
REM page, and ASCII parses identically in all of them.
REM ============================================================
setlocal
set "HERE=%~dp0"

where pwsh >nul 2>nul
if errorlevel 1 goto ps51

pwsh -NoProfile -ExecutionPolicy Bypass -File "%HERE%build.ps1" %*
exit /b %ERRORLEVEL%

:ps51
echo.
echo   [!] pwsh 7 not found - falling back to Windows PowerShell 5.1
echo       (5.1 reads .ps1 as ANSI, so build.ps1 must keep its UTF-8 BOM:
echo        winget install --id Microsoft.PowerShell -e   removes this risk)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%build.ps1" %*
exit /b %ERRORLEVEL%