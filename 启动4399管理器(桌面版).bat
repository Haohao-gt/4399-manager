@echo off
chcp 936 >nul
cd /d "%~dp0desktop"
title 4399 账号管理器 · 桌面版

echo.
echo   ================================================
echo      4399 账号管理器 · 桌面版
echo.
echo      首次启动会自动安装桌面运行时（约 100MB，只装一次）
echo      装好后双击这个文件即可直接打开窗口
echo   ================================================
echo.

REM 某些环境（如开发机）会带这个变量，会让 Electron 变成纯 Node，先清掉
set "ELECTRON_RUN_AS_NODE="

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Node.js
  echo   请先安装 Node.js 18+ ： https://nodejs.org/zh-cn
  echo.
  pause
  exit /b 1
)

if exist "node_modules\electron\dist\electron.exe" goto RUN

echo   正在安装桌面运行时，请耐心等待（国内镜像已自动配置）...
echo.
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo   [错误] 安装失败，请检查网络后重试。
  echo   也可以手动执行：cd desktop ^&^& npm install
  echo.
  pause
  exit /b 1
)

:RUN
echo   正在启动...
echo.
call "node_modules\.bin\electron.cmd" .
if errorlevel 1 (
  echo.
  echo   程序已退出（错误码 %errorlevel%）
  pause
)
