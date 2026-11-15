@echo off
chcp 65001 > nul
cd /d %~dp0..
title Piano video effect maker
node app\piano-make.js "%~1"
