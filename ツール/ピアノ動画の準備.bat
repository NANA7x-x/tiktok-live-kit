@echo off
chcp 65001 > nul
cd /d %~dp0..
title Piano video setup
node app\piano-make.js --setup
