@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist .env copy .env.example .env >nul
if not exist node_modules\ (
  echo 처음 실행: 필요한 모듈을 설치합니다 ^(npm install, 1~2분^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 echo [경고] 설치에 실패했어요. 팀 영상 합치기만 안 되고 나머지는 사용할 수 있어요.
)
start "" http://localhost:3000
node server.mjs
pause
