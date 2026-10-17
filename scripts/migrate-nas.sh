#!/bin/sh
# 旧方式 (NAS 上で docker build する kakeibovs) から新方式 (GHCR から pull) へ切り替える。
# 既存の data/ (SQLite DB) はそのまま引き継ぐ。一度だけ実行すればよい。
#
#   使い方 (NAS 上で):
#     cd /volume1/docker/kakeibovs
#     wget -O migrate-nas.sh https://raw.githubusercontent.com/HigeMaguro/kakeibo_VSCode/main/scripts/migrate-nas.sh
#     sh migrate-nas.sh
#
#   やること:
#     1. 旧コンテナが使っている DB の場所を確認し、data/ に DB があることを検証
#     2. data/ を backups/ に丸ごとコピー (切り戻し用)
#     3. 旧ソース一式を old_src_YYYYMMDD/ へ退避 (削除はしない)
#     4. docker-compose.prod.yml / update-nas.sh を GitHub から取得
#     5. 旧コンテナ停止 → 新イメージ pull → 起動
#     6. /api/version で新バージョンを確認
set -eu

REPO_RAW="https://raw.githubusercontent.com/HigeMaguro/kakeibo_VSCode/main"
IMAGE="ghcr.io/higemaguro/kakeibo"
TAG="${1:-latest}"
STAMP="$(date +%Y%m%d_%H%M%S)"

cd "$(dirname "$0")"
echo "作業ディレクトリ: $(pwd)"

# ---------------------------------------------------------------
echo ""
echo "[1/6] 既存 DB の確認"
if docker ps -a --format '{{.Names}}' | grep -qx kakeibo; then
  MOUNT="$(docker inspect kakeibo --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
  echo "      旧コンテナの /app/data マウント元: ${MOUNT:-(不明)}"
  case "$MOUNT" in
    "$(pwd)/data"|"$(pwd)/data/") ;;
    "")   echo "      警告: マウント情報を取得できませんでした。data/ の存在で判断します。" ;;
    /volume*|/mnt*|/home*|/share*)
      if [ "$(readlink -f "$MOUNT")" != "$(readlink -f "$(pwd)/data")" ]; then
        echo "      注意: 旧コンテナは別の場所 ($MOUNT) の DB を使っています。"
        echo "            そこから data/ へコピーして引き継ぎます。"
        mkdir -p data
        cp -a "$MOUNT"/. data/
      fi ;;
    *)
      echo "      旧コンテナは名前付きボリューム ($MOUNT) を使っています。data/ へ取り出します。"
      mkdir -p data
      docker cp kakeibo:/app/data/. data/ ;;
  esac
fi

if [ ! -f data/kakeibo.db ]; then
  echo "エラー: data/kakeibo.db が見つかりません。移行を中止します。" >&2
  echo "       旧 DB の場所を確認してください: docker inspect kakeibo | grep -A3 Mounts" >&2
  exit 1
fi
echo "      data/kakeibo.db: $(du -h data/kakeibo.db | cut -f1)"

# ---------------------------------------------------------------
echo ""
echo "[2/6] DB バックアップ → backups/pre-migrate_${STAMP}/"
mkdir -p "backups/pre-migrate_${STAMP}"
cp -a data/. "backups/pre-migrate_${STAMP}/"
echo "      完了"

# ---------------------------------------------------------------
echo ""
echo "[3/6] 旧ソースを退避 → old_src_${STAMP}/"
mkdir -p "old_src_${STAMP}"
for f in app server scripts server.js package.json package-lock.json Dockerfile docker-compose.yml docker-compose.yaml .dockerignore; do
  [ -e "$f" ] && mv "$f" "old_src_${STAMP}/" || true
done
echo "      (問題なければ後で rm -rf old_src_${STAMP} で削除可)"

# ---------------------------------------------------------------
echo ""
echo "[4/6] 新しい compose ファイルを取得"
wget -qO docker-compose.prod.yml "$REPO_RAW/docker-compose.prod.yml"
wget -qO update-nas.sh "$REPO_RAW/scripts/update-nas.sh"
chmod +x update-nas.sh
if [ "$TAG" != "latest" ]; then
  sed -i -E "s#(${IMAGE}):[^[:space:]]+#\1:${TAG}#" docker-compose.prod.yml
fi
# 旧 compose と同じプロジェクト名 (ディレクトリ名) で動くよう、同じディレクトリで実行する
echo "      image: $(grep -oE "${IMAGE}:[^[:space:]]+" docker-compose.prod.yml)"

# ---------------------------------------------------------------
echo ""
echo "[5/6] 旧コンテナ停止 → 新イメージで起動"
docker stop kakeibo >/dev/null 2>&1 || true
docker rm kakeibo >/dev/null 2>&1 || true
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --remove-orphans

# ---------------------------------------------------------------
echo ""
echo "[6/6] 起動確認"
PORT="$(grep -oE '"[0-9]+:80"' docker-compose.prod.yml | tr -d '"' | cut -d: -f1)"
PORT="${PORT:-9090}"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if OUT="$(wget -qO- "http://localhost:${PORT}/api/version" 2>/dev/null)"; then
    echo "      $OUT"
    echo ""
    echo "移行完了。ブラウザで http://<NAS の IP>:${PORT} を開き、取引データが表示されることを確認してください。"
    echo "以降の更新:  sh update-nas.sh"
    echo "切り戻し:    docker compose -f docker-compose.prod.yml down && cd old_src_${STAMP} && docker compose up -d"
    exit 0
  fi
  sleep 2
done
echo "起動確認がタイムアウトしました。ログを確認してください:" >&2
echo "  docker compose -f docker-compose.prod.yml logs --tail=50" >&2
exit 1
