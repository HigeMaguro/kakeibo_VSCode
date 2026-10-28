#!/bin/sh
# MyKakeibo NAS 更新スクリプト v2
#
#   1. compose ファイルを自動検出 (GUI が作った docker-compose.yml でも動く)
#   2. 事前チェック (構文 / /app/data マウント / DB の存在)
#   3. DB を一貫スナップショットでバックアップ (VACUUM INTO / 失敗時は cp)
#   4. イメージタグを書き換えて pull → 再作成 → 起動確認
set -eu

IMAGE_CANONICAL="ghcr.io/higemaguro/kakeibo"
IMAGE_OVERRIDE=""
DEFAULT_PORT=9090
RETENTION=30

COMPOSE_ARG=""
TAG="latest"
DO_BACKUP=1
DO_EDIT=1
DRY_RUN=0
ROLLBACK=0

info() { printf '%s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOS'
使い方: sh update-nas.sh [オプション] [タグ]

  sh update-nas.sh                  latest へ更新
  sh update-nas.sh 1.2.6            指定タグへ固定 (ロールバックにも使う)
  sh update-nas.sh --dry-run 1.2.6  実行内容の確認だけ
  sh update-nas.sh --rollback       直近バックアップから DB を戻す

オプション:
  -f, --file FILE   compose ファイルを指定
      --tag TAG     イメージタグ (位置引数と同じ)
      --image REPO  image を丸ごと差し替え (例: ghcr.io/higemaguro/kakeibo)
      --no-backup   バックアップを省略
      --no-edit     compose のタグ書き換えをしない (GUI 管理を維持)
      --dry-run     実行内容の表示のみ
      --rollback    直近の DB バックアップを復元
  -h, --help        このヘルプ

環境変数: COMPOSE_FILE (compose のパス)
EOS
}

while [ $# -gt 0 ]; do
  case "$1" in
    -f|--file)      [ $# -ge 2 ] || die "--file には値が必要です"; COMPOSE_ARG="$2"; shift 2 ;;
    --file=*)       COMPOSE_ARG="${1#*=}"; shift ;;
    --tag)          [ $# -ge 2 ] || die "--tag には値が必要です"; TAG="$2"; shift 2 ;;
    --tag=*)        TAG="${1#*=}"; shift ;;
    --image)        [ $# -ge 2 ] || die "--image には値が必要です"; IMAGE_OVERRIDE="$2"; shift 2 ;;
    --image=*)      IMAGE_OVERRIDE="${1#*=}"; shift ;;
    --no-backup)    DO_BACKUP=0; shift ;;
    --no-edit)      DO_EDIT=0; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --rollback)     ROLLBACK=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    --*)            die "不明なオプション: $1 (--help を参照)" ;;
    *)              TAG="$1"; shift ;;
  esac
done

cd "$(dirname "$0")"

# ---------------------------------------------------------------
# compose の検出
# ---------------------------------------------------------------
detect_compose() {
  if [ -n "$COMPOSE_ARG" ]; then
    [ -f "$COMPOSE_ARG" ] || die "指定された compose が見つかりません: $COMPOSE_ARG"
    printf '%s' "$COMPOSE_ARG"; return 0
  fi
  if [ -n "${COMPOSE_FILE:-}" ]; then
    [ -f "$COMPOSE_FILE" ] || die "COMPOSE_FILE が見つかりません: $COMPOSE_FILE"
    printf '%s' "$COMPOSE_FILE"; return 0
  fi
  for f in docker-compose.prod.yml compose.yaml docker-compose.yml compose.yml; do
    if [ -f "$f" ]; then printf '%s' "$f"; return 0; fi
  done
  # GUI プロジェクトの実体を docker compose ls から拾う
  if command -v docker >/dev/null 2>&1; then
    cand=$(docker compose ls --all --format json 2>/dev/null \
      | grep -oE '"ConfigFiles":"[^"]+"' \
      | sed 's/.*:"//; s/"$//' | tr ',' '\n' \
      | grep -F "$PWD/" | head -1 || true)
    if [ -n "$cand" ] && [ -f "$cand" ]; then printf '%s' "$cand"; return 0; fi
  fi
  return 1
}

COMPOSE=$(detect_compose) || die "compose ファイルが見つかりません (カレント: $PWD / 候補: docker-compose.prod.yml, compose.yaml, docker-compose.yml)。-f で指定してください。"
[ -f "$COMPOSE" ] || die "compose が見つかりません: $COMPOSE"

compose() { docker compose -f "$COMPOSE" "$@"; }

# /app/data, /app/backups にマウントされているホスト側パスを推定
data_host_dir() {
  p=$(grep -oE '[^[:space:]]+:/app/data' "$COMPOSE" 2>/dev/null | head -1 | sed 's#:/app/data$##' || true)
  [ -n "$p" ] || p="./data"
  printf '%s' "$p"
}
backups_host_dir() {
  p=$(grep -oE '[^[:space:]]+:/app/backups' "$COMPOSE" 2>/dev/null | head -1 | sed 's#:/app/backups$##' || true)
  [ -n "$p" ] || p="./backups"
  printf '%s' "$p"
}
port_number() {
  p=$(grep -oE '[0-9]+:80' "$COMPOSE" 2>/dev/null | head -1 | cut -d: -f1 || true)
  [ -n "$p" ] || p="$DEFAULT_PORT"
  printf '%s' "$p"
}

DATA_DIR=$(data_host_dir)
BACKUP_DIR=$(backups_host_dir)
PORT=$(port_number)

info "=================================================="
info " MyKakeibo NAS 更新"
info "=================================================="
info "[1/5] compose: $COMPOSE"
[ "$DRY_RUN" = 1 ] && info "      (dry-run: 変更は行いません)"

if ! compose config -q 2>/dev/null; then
  die "compose の構文チェックに失敗しました。'docker compose -f $COMPOSE config' で確認してください。"
fi
info "      構文 OK / データ: $DATA_DIR / バックアップ: $BACKUP_DIR / ポート: $PORT"

if ! grep -q '/app/data' "$COMPOSE"; then
  die "compose に /app/data へのマウントが見つかりません。DB 消失を防ぐため中止しました。"
fi
# image 行を検出 (パッケージ名は固定しない)
IMAGE_LINE=$(grep -E '^[[:space:]]*image:' "$COMPOSE" | head -1 | sed -E 's/^[[:space:]]*image:[[:space:]]*//; s/[[:space:]]*$//' || true)
IMAGE_REPO_DETECTED=""
if [ -n "$IMAGE_LINE" ]; then
  IMAGE_REPO_DETECTED=$(printf '%s' "$IMAGE_LINE" | sed -E 's/:[^:\/]+$//')
  info "      image: $IMAGE_LINE"
else
  warn "compose に image 行が見つかりません"
fi
if [ -n "$IMAGE_OVERRIDE" ]; then
  info "      --image 指定により $IMAGE_OVERRIDE:$TAG に差し替えます"
elif [ -n "$IMAGE_REPO_DETECTED" ] && [ "$(printf '%s' "$IMAGE_REPO_DETECTED" | tr 'A-Z' 'a-z')" != "$IMAGE_CANONICAL" ]; then
  warn "image が公開イメージと異なります: $IMAGE_REPO_DETECTED"
  warn "  公開イメージは $IMAGE_CANONICAL です。切り替えるには: sh update-nas.sh --image $IMAGE_CANONICAL $TAG"
fi

SVC=$(compose config --services 2>/dev/null | head -1 || true)
[ -n "$SVC" ] || die "compose からサービス名を取得できませんでした"
info "      サービス: $SVC"

RUNNING=$(compose ps -q "$SVC" 2>/dev/null | head -1 || true)
if [ -n "$RUNNING" ]; then
  info "      稼働中のコンテナを検出"
else
  info "      コンテナ未起動 (初回セットアップとして続行)"
fi

# ---------------------------------------------------------------
# ロールバック
# ---------------------------------------------------------------
if [ "$ROLLBACK" = 1 ]; then
  mkdir -p "$BACKUP_DIR"
  LATEST=$(ls -1t "$BACKUP_DIR"/kakeibo_*.db 2>/dev/null | head -1 || true)
  [ -n "$LATEST" ] || die "$BACKUP_DIR にバックアップがありません"
  info "[rollback] 復元元: $LATEST"
  info "           現在の $DATA_DIR/kakeibo.db は上書きされます"
  if [ "$DRY_RUN" = 1 ]; then info "           (dry-run のため実行しません)"; exit 0; fi
  printf '実行しますか? [y/N]: '
  read -r ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) info "中止しました"; exit 1 ;;
  esac
  mkdir -p "$DATA_DIR"
  compose stop || true
  cp "$LATEST" "$DATA_DIR/kakeibo.db"
  rm -f "$DATA_DIR/kakeibo.db-wal" "$DATA_DIR/kakeibo.db-shm"
  compose start
  info "復元しました: $(basename "$LATEST")"
  exit 0
fi

# ---------------------------------------------------------------
# バックアップ
# ---------------------------------------------------------------
STAMP=$(date +%Y%m%d_%H%M%S)
BK_NAME="kakeibo_${STAMP}.db"
BK_OK=0

info "[2/5] DB バックアップ"
if [ "$DO_BACKUP" = 1 ] && [ -f "$DATA_DIR/kakeibo.db" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    info "      $BACKUP_DIR/$BK_NAME を作成予定 (VACUUM INTO / 失敗時は cp)"
  else
    mkdir -p "$BACKUP_DIR"
    # (a) 稼働中なら VACUUM INTO で一貫スナップショット
    if [ -n "$RUNNING" ]; then
      if compose exec -T "$SVC" node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/kakeibo.db');db.exec(\"VACUUM INTO '/app/backups/$BK_NAME'\");db.close();" >/dev/null 2>&1 \
         && [ -s "$BACKUP_DIR/$BK_NAME" ]; then
        BK_OK=1
        info "      $BACKUP_DIR/$BK_NAME (一貫スナップショット)"
      else
        warn "VACUUM INTO に失敗、またはホスト側にファイルが見えません (/app/backups マウント未設定の可能性)。cp 方式に切り替えます"
      fi
    fi
    # (b) フォールバック: 本体 + WAL をコピー
    if [ "$BK_OK" != 1 ]; then
      cp "$DATA_DIR/kakeibo.db" "$BACKUP_DIR/$BK_NAME"
      if [ -f "$DATA_DIR/kakeibo.db-wal" ]; then cp "$DATA_DIR/kakeibo.db-wal" "$BACKUP_DIR/$BK_NAME-wal"; fi
      BK_OK=1
      info "      $BACKUP_DIR/$BK_NAME (cp)"
    fi
    # (c) 検証
    [ -s "$BACKUP_DIR/$BK_NAME" ] || die "バックアップファイルが空です。更新を中止します。"
    if [ -n "$RUNNING" ]; then
      CHECK=$(compose exec -T "$SVC" node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/backups/$BK_NAME',{readOnly:true});const r=db.prepare('PRAGMA quick_check').get();console.log(Object.values(r)[0]);" 2>/dev/null | tr -d '\r' || true)
      case "$CHECK" in
        ok) info "      quick_check: ok" ;;
        "") warn "バックアップの検証をスキップ (コンテナ内から参照できません)" ;;
        *)  die "バックアップの検証に失敗しました (結果: $CHECK)。更新を中止します。" ;;
      esac
    fi
    # (d) 世代管理
    ls -1t "$BACKUP_DIR"/kakeibo_*.db 2>/dev/null | tail -n +$((RETENTION + 1)) | while read -r f; do
      rm -f "$f" "$f-wal"
    done
  fi
else
  info "      スキップ (DB 未作成または --no-backup)"
fi

# ---------------------------------------------------------------
# タグ書き換え
# ---------------------------------------------------------------
# image 行のタグだけ差し替える (repo 指定時は丸ごと置換)
rewrite_image() {
  awk -v tag="$1" -v repo="$2" '
    /^[[:space:]]*image:/ && !done {
      if (repo != "") {
        match($0, /^[[:space:]]*/)
        $0 = substr($0, 1, RLENGTH) "image: " repo ":" tag
      } else if ($0 ~ /:[^\/[:space:]]+[[:space:]]*$/) {
        sub(/:[^\/[:space:]]+[[:space:]]*$/, ":" tag)
      } else {
        sub(/[[:space:]]*$/, "")
        $0 = $0 ":" tag
      }
      done = 1
    }
    { print }
  ' "$COMPOSE" > "$COMPOSE.tmp"
  mv "$COMPOSE.tmp" "$COMPOSE"
}

info "[3/5] イメージタグ: $TAG"
if [ "$DO_EDIT" = 0 ]; then
  info "      --no-edit のため書き換えません (現在のタグのまま pull)"
elif [ "$DRY_RUN" = 1 ]; then
  if [ -n "$IMAGE_OVERRIDE" ]; then
    info "      image を $IMAGE_OVERRIDE:$TAG に差し替え予定"
  elif [ -n "$IMAGE_LINE" ]; then
    info "      $IMAGE_LINE のタグを $TAG に書き換え予定"
  else
    info "      (image 行が無いため書き換えません)"
  fi
else
  CURRENT_TAG=$(printf '%s' "$IMAGE_LINE" | sed -nE 's#^.*:([^:/]+)$#\1#p' || true)
  if [ -z "$IMAGE_LINE" ]; then
    warn "image 行が無いためタグを書き換えません"
  elif [ -z "$IMAGE_OVERRIDE" ] && [ "$CURRENT_TAG" = "$TAG" ]; then
    info "      既に $TAG のため変更なし"
  else
    cp "$COMPOSE" "$COMPOSE.bak"
    rewrite_image "$TAG" "$IMAGE_OVERRIDE"
    if compose config -q 2>/dev/null; then
      NEW_LINE=$(grep -E '^[[:space:]]*image:' "$COMPOSE" | head -1 | sed -E 's/^[[:space:]]*image:[[:space:]]*//; s/[[:space:]]*$//')
      info "      $IMAGE_LINE -> $NEW_LINE ($COMPOSE.bak を保存)"
    else
      mv "$COMPOSE.bak" "$COMPOSE"
      die "タグ書き換え後の構文チェックに失敗したため元に戻しました"
    fi
  fi
fi

# ---------------------------------------------------------------
# pull / 再作成
# ---------------------------------------------------------------
info "[4/5] pull & 再作成"
if [ "$DRY_RUN" = 1 ]; then
  info "      (dry-run のため実行しません)"
else
  PULL_LOG=$(mktemp 2>/dev/null || echo "/tmp/kakeibo_pull.$$")
  if ! compose pull 2>&1 | tee "$PULL_LOG"; then
    if grep -qiE 'unauthorized|denied|authentication required' "$PULL_LOG" 2>/dev/null; then
      warn "GHCR の認証が必要です:"
      warn "  echo <PAT> | docker login ghcr.io -u HigeMaguro --password-stdin"
    fi
    rm -f "$PULL_LOG"
    die "イメージの取得に失敗しました"
  fi
  rm -f "$PULL_LOG"
  compose up -d --remove-orphans
  docker image prune -f >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------
# 起動確認
# ---------------------------------------------------------------
info "[5/5] 起動確認 (http://localhost:$PORT/api/version)"
if [ "$DRY_RUN" = 1 ]; then
  info "      (dry-run のため実行しません)"
  info "完了 (dry-run)"
  exit 0
fi

i=0
while [ "$i" -lt 20 ]; do
  BODY=""
  if command -v curl >/dev/null 2>&1; then
    BODY=$(curl -fsS --max-time 2 "http://localhost:$PORT/api/version" 2>/dev/null || true)
  else
    BODY=$(wget -qO- "http://localhost:$PORT/api/version" 2>/dev/null || true)
  fi
  if [ -n "$BODY" ]; then
    info "      $BODY"
    info "更新完了"
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

warn "起動確認がタイムアウトしました。ログを確認してください:"
warn "  docker compose -f $COMPOSE logs --tail=50"
exit 1
