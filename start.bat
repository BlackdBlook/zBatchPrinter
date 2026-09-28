@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PDF 批量打印服务

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [错误] 未检测到 Node.js。
  echo  请先到 https://nodejs.org/ 下载安装 Node.js（LTS 版本），
  echo  安装完成后重新双击本脚本。
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次运行：正在安装依赖（需要联网，仅需一次）...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo  [错误] 依赖安装失败，请检查网络后重试。
    echo.
    pause
    exit /b 1
  )
)

echo 正在启动本地服务并打开页面...
echo 关闭本窗口或按 Ctrl+C 即可停止服务。
echo.
node server.js
if errorlevel 1 (
  echo.
  echo  [提示] 服务已退出。若为异常退出，请把上方错误信息反馈。
  pause
)
