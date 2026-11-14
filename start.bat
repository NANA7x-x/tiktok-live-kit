@echo off
chcp 65001 > nul
cd /d %~dp0
title TikTok LIVE bridge server
where node > nul 2>&1
if errorlevel 1 (
  echo Node.js ga mitsukarimasen. https://nodejs.org kara irete kudasai.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Shokai setup chuu... shibaraku omachi kudasai.
  call npm install
)
echo Server wo kidou shimasu. Kono gamen wa tojinaide kudasai.
echo Remote: http://localhost:21213/remote.html
node start.js
pause
