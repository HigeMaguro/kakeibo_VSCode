# デプロイ手順 (GitHub → GHCR → NAS Docker)

```text
開発 PC ──git push (tag)──▶ GitHub Actions ──build/push──▶ ghcr.io/higemaguro/kakeibo
                                                                   │
NAS: docker compose pull && up -d  ◀───────────────────────────────┘
     data/ (SQLite) はホスト側フォルダーなので更新しても保持される
```

NAS 側に git / Node / ソースコードは不要。置くのは `docker-compose.prod.yml` と `update-nas.sh` の 2 ファイルのみ。

---

## 1. 初回: GitHub 側の設定

1. リポジトリを push すると `.github/workflows/` の Actions が有効になる (追加設定不要)。
2. **イメージの公開範囲**: 初回のタグ push 後、GitHub の Packages (`kakeibo`) → Package settings → *Change visibility*。
   - **Public** にすると NAS 側で `docker login` 不要 (ソースが private でもイメージだけ public にできる)。
   - **Private** のままにする場合は、NAS 側で一度だけ次を実行:
     ```sh
     # GitHub → Settings → Developer settings → Personal access tokens (classic) で read:packages のみ付与
     echo <PAT> | docker login ghcr.io -u HigeMaguro --password-stdin
     ```

## 2. 初回: NAS 側のセットアップ

### 2-A. 旧 kakeibovs (NAS 上で docker build する方式) が既に動いている場合 ← 通常はこちら

既存の DB を引き継いだまま新方式へ切り替える。SSH でログインして 3 コマンド。

```sh
cd /volume1/docker/kakeibovs          # 旧 deploy-nas.ps1 の -NasDeployDir と同じ場所
wget -O migrate-nas.sh https://raw.githubusercontent.com/HigeMaguro/kakeibo_VSCode/main/scripts/migrate-nas.sh
sh migrate-nas.sh
```

`migrate-nas.sh` の動作:

| 手順 | 内容 |
|---|---|
| 1 | 旧コンテナ `kakeibo` の `/app/data` マウント元を確認し、`data/kakeibo.db` があることを検証 (別の場所にあれば `data/` へコピー) |
| 2 | `data/` を `backups/pre-migrate_<日時>/` に丸ごとコピー (切り戻し用) |
| 3 | 旧ソース (`app/ server/ server.js Dockerfile docker-compose.yml` 等) を `old_src_<日時>/` に退避。削除はしない |
| 4 | `docker-compose.prod.yml` と `update-nas.sh` を GitHub から取得 |
| 5 | 旧コンテナ停止・削除 → GHCR から pull → 起動。`data/` は同じフォルダーなので DB はそのまま |
| 6 | `/api/version` で新バージョンを表示 |

ブラウザで取引データが表示されることを確認したら、`old_src_*` は削除してよい。
**切り戻し**: `docker compose -f docker-compose.prod.yml down && cd old_src_<日時> && docker compose up -d`。
DB のスキーマ変更はカラム追加のみ (後方互換) なので、新版で起動した DB を旧版に戻しても動作する。念のため `backups/pre-migrate_*` も残る。

> GHCR のパッケージが Private の場合は、実行前に §1 の `docker login ghcr.io` を済ませておくこと。

### 2-B. まっさらな NAS に新規インストールする場合

UGREEN NAS に SSH でログインして実行 (UGOS の Docker GUI でも同等の操作が可能)。

```sh
# 配置先 (既存の kakeibo を使っていた場合は同じフォルダーを使うと data/ をそのまま引き継げる)
mkdir -p /volume1/docker/kakeibovs && cd /volume1/docker/kakeibovs

# 2 ファイルを取得
wget -O docker-compose.prod.yml https://raw.githubusercontent.com/HigeMaguro/kakeibo_VSCode/main/docker-compose.prod.yml
wget -O update-nas.sh          https://raw.githubusercontent.com/HigeMaguro/kakeibo_VSCode/main/scripts/update-nas.sh
chmod +x update-nas.sh

# 起動 (data/ が無ければ空の DB が作られる。既存 data/ があればそのまま使われる)
mkdir -p data backups
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f   # Ctrl+C で抜ける
```

ブラウザで `http://<NAS の IP>:9090` を開き、「データ管理」ページのバージョン表示を確認。

> **既存 DB の移行**: 旧環境の `data/kakeibo.db` (と `kakeibo.db-wal` があれば一緒に) を新しい `data/` へコピーするだけ。
> スキーマは起動時に自動で最新化される (カラム追加のみ。既存データは変更されない)。

### UGOS Docker GUI で行う場合

1. 「ファイル」で `docker/kakeibovs` フォルダーを作り、`docker-compose.prod.yml` をアップロード (ファイル名は `docker-compose.yml` に変えてよい)。
2. 「Docker」→「プロジェクト」→「作成」→ パスに上記フォルダーを指定 → 作成。
3. 更新時は「プロジェクト」→ 該当プロジェクト →「イメージを更新 (pull)」→「再作成」。更新前に `data/kakeibo.db` を手動でコピーしておくこと。
4. `update-nas.sh` は **GUI からは実行できない**ため、GUI 運用だけなら配置は不要。SSH が使えるなら同じフォルダーに置いて `sh update-nas.sh` を使うと、DB の自動バックアップと起動確認まで行える (推奨)。スクリプトは `docker-compose.prod.yml` / `compose.yaml` / `docker-compose.yml` を自動検出するので、GUI が作ったファイル名のままで動く。

---

## 3. バージョン更新 (開発 PC)

```bash
# 1. 変更を確認
npm run check

# 2. バージョンを上げてコミット (package.json の version と git tag を一致させる。不一致だと Actions が失敗する)
npm version 1.3.0 --no-git-tag-version
git add -A && git commit -m "v1.3.0: 〇〇を追加"

# 3. タグを push → Actions がイメージをビルド (数分)
git tag v1.3.0
git push origin main --tags
```

GitHub → Actions タブで「Docker publish」が緑になったら NAS 側へ。

## 4. バージョン更新 (NAS)

```sh
cd /volume1/docker/kakeibovs
sh update-nas.sh                 # latest へ
sh update-nas.sh 1.2.6          # 特定バージョンに固定
sh update-nas.sh --dry-run 1.2.6 # 実行内容の確認だけ (変更しない)
```

スクリプトの動作:
1. **compose を自動検出** (`docker-compose.prod.yml` → `compose.yaml` → `docker-compose.yml` → `docker compose ls` の順。`-f` で明示可)
2. **事前チェック**: 構文 / `/app/data` マウント / サービス名 / 稼働状態 (`/app/data` が無ければ DB 保護のため中止)
3. `data/kakeibo.db` を `backups/kakeibo_YYYYMMDD_HHMMSS.db` にバックアップ
   - 稼働中は `node:sqlite` の `VACUUM INTO` で**一貫スナップショット**を作成し `PRAGMA quick_check` で検証
   - 失敗時は従来の `cp` (本体 + `-wal`) にフォールバック
   - 30 世代保持
4. イメージタグを書き換え (`.bak` を保存し、構文検証に失敗したら自動で戻す) → `pull` → `up -d`
5. `/api/version` を最大 40 秒ポーリングして稼働バージョンを表示

オプション:

| オプション | 内容 |
|---|---|
| `-f, --file FILE` | compose を明示 |
| `--tag TAG` | タグ指定 (位置引数と同じ) |
| `--image REPO` | image を丸ごと差し替え (例: `ghcr.io/higemaguro/kakeibo`) |
| `--no-backup` | バックアップを省略 |
| `--no-edit` | compose のタグを書き換えない (GUI 管理を維持し、現在のタグのまま pull) |
| `--dry-run` | 表示のみ |
| `--rollback` | 直近バックアップから DB を復元 |

> GUI プロジェクトと同じ compose を編集するので、GUI の「再デプロイ」と併用できる。同時実行は避けること。
>
> 公開先パッケージは `ghcr.io/higemaguro/kakeibo` (`.github/workflows/docker-publish.yml` の `IMAGE`)。GUI が `kakeibo_VSCode` など別名を指している場合は、そのパッケージには新タグが存在しないため `--image ghcr.io/higemaguro/kakeibo` を付けて切り替える。スクリプトは別名でも止まらず、警告と切り替えコマンドを表示する。

## 5. ロールバック

```sh
sh update-nas.sh 1.2.0        # 旧バージョンのタグに固定して再作成 (DB はそのまま)
sh update-nas.sh latest       # 最新に戻す

# DB も戻す (直近バックアップから復元。確認プロンプトあり)
sh update-nas.sh --rollback
```

`--rollback` は `backups/` の最新 `kakeibo_*.db` を `data/kakeibo.db` に戻し、`-wal` / `-shm` を削除してから起動します。手動で行う場合:

```sh
docker compose -f docker-compose.prod.yml stop
cp backups/kakeibo_YYYYMMDD_HHMMSS.db data/kakeibo.db && rm -f data/kakeibo.db-wal data/kakeibo.db-shm
docker compose -f docker-compose.prod.yml start
```

---

## 6. 運用メモ

| 項目 | 内容 |
|---|---|
| DB の場所 | NAS: `/volume1/docker/kakeibovs/data/kakeibo.db` (SQLite WAL モード。`-wal` `-shm` も同じフォルダー) |
| 手動バックアップ | 「データ管理」ページの JSON / Excel エクスポート、または `data/` フォルダーごとコピー |
| ログ | `docker compose -f docker-compose.prod.yml logs --tail=100 -f` |
| 稼働バージョン | `http://<NAS>:9090/api/version` または「データ管理」ページ |
| ポート変更 | `docker-compose.prod.yml` の `"9090:80"` の左側を変更 |
| 認証 | 無し。LAN 内利用前提。外部公開する場合はリバースプロキシで認証を付けること |
| 自動更新 | 意図的に非対応 (家計簿 DB を扱うため、手動で pull → 動作確認を推奨) |
