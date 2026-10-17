#!/bin/sh
# NAS 上で実行する更新スクリプト
#   1. 家計簿 DB を backups/ にコピー
#   2. GHCR から最新イメージを pull
#   3. コンテナを再作成 (data/ はマウントなので保持される)
#   4. 稼働バージョンを表示
#
# 使い方: docker-compose.prod.yml と同じディレクトリで  sh update-nas.sh [バージョン]
#   例:   sh update-nas.sh          -> :latest に更新
#         sh update-nas.sh 1.2.0    -> :1.2.0 に固定 (ロールバックにも使う)
set -eu

cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.prod.yml"
TAG="${1:-latest}"
PORT="$(grep -oE '"[0-9]+:80"' docker-compose.prod.yml | tr -d '"' | cut -d: -f1)"
PORT="${PORT:-9090}"

echo "[1/4] DB バックアップ"
mkdir -p backups
if [ -f data/kakeibo.db ]; then
  STAMP="$(date +%Y%m%d_%H%M%S)"
  cp data/kakeibo.db "backups/kakeibo_${STAMP}.db"
  [ -f data/kakeibo.db-wal ] && cp data/kakeibo.db-wal "backups/kakeibo_${STAMP}.db-wal" || true
  echo "      backups/kakeibo_${STAMP}.db"
  # 30 世代より古いバックアップを削除
  ls -1t backups/kakeibo_*.db 2>/dev/null | tail -n +31 | while read -r f; do rm -f "$f" "$f-wal"; done
else
  echo "      data/kakeibo.db が無いためスキップ (初回起動)"
fi

if [ "$TAG" != "latest" ]; then
  echo "[2/4] イメージタグを :$TAG に設定"
  sed -i -E "s#(ghcr.io/higemaguro/kakeibo):[^[:space:]]+#\1:${TAG}#" docker-compose.prod.yml
else
  echo "[2/4] イメージタグ: latest"
fi

echo "[3/4] pull & 再作成"
$COMPOSE pull
$COMPOSE up -d --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

echo "[4/4] 起動確認"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if wget -qO- "http://localhost:${PORT}/api/version" 2>/dev/null; then echo; echo "更新完了"; exit 0; fi
  sleep 2
done
echo "起動確認がタイムアウトしました。ログ: $COMPOSE logs --tail=50" >&2
exit 1
