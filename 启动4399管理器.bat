@echo off
chcp 936 >nul
cd /d "%~dp0"
title 4399 账号管理器

REM ---------- 已在运行就不重复启动 ----------
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8790" ^| findstr "LISTENING"') do set "FOUND=%%p"

if defined FOUND (
  echo.
  echo   4399 账号管理器已经在运行中^(PID %FOUND%^)
  echo   地址：http://127.0.0.1:8790
  echo.
  echo   正在为你打开浏览器...
  start "" "http://127.0.0.1:8790"
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

REM ---------- 环境检查 ----------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 node.exe
  echo   请先安装 Node.js 并确保加入 PATH 环境变量。
  echo.
  pause
  exit /b 1
)

echo.
echo   ================================================
echo      4399 账号管理器
echo.
echo      正在启动，稍候会自动打开浏览器...
echo      地址：http://127.0.0.1:8790
echo.
echo      关闭这个黑窗口 = 停止服务
echo   ================================================
echo.

REM ---------- 延迟 2 秒后自动开浏览器（后台小窗口） ----------
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:8790"

node server.js

echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul
