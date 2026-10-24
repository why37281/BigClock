@echo off
chcp 65001 >nul
title 修复 Low 完整性标签（可拷到任意目录使用）
setlocal
set "PS1=%~dp0fix-integrity-label.ps1"

if not exist "%PS1%" (
  echo [错误] 找不到同目录下的 fix-integrity-label.ps1
  echo        请把 .cmd 和 .ps1 两个文件一起拷过去。
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
pause
