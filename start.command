#!/bin/bash
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
if [ ! -d node_modules ]; then
  echo "처음 실행: 필요한 모듈을 설치합니다 (npm install, 1~2분)..."
  npm install --no-audit --no-fund || echo "[경고] 설치에 실패했어요. 팀 영상 합치기만 안 되고 나머지는 사용할 수 있어요."
fi
(sleep 1; open http://localhost:3000) &
node server.mjs
