# MyKakeibo (kakeibo_VSCode)

自宅 NAS の Docker で動かす家計簿 Web アプリ。Node.js + Express + 組み込み SQLite (`node:sqlite`)、フロントはビルド不要の素の HTML/JS。
VS Code 専用プロジェクト (C# ランチャー無し)。

| 用途 | ドキュメント |
|---|---|
| 開発・デバッグ・機能拡張 | [DEVELOPMENT.md](DEVELOPMENT.md) |
| NAS への配置・バージョン更新 | [DEPLOY.md](DEPLOY.md) |

## クイックスタート (開発 PC)

前提: Node.js 22.5 以上、VS Code

```bash
git clone https://github.com/HigeMaguro/kakeibo_VSCode.git
cd kakeibo_VSCode
npm ci
```

VS Code で開き **F5 →「Full Stack (server + Chrome)」** を選ぶと、サーバー (`http://localhost:9090`) とデバッグ用 Chrome が起動します。
サーバー側 (`server/`) とフロント側 (`app/js/`) の両方にブレークポイントを張れます。

```bash
npm run dev     # VS Code を使わない場合 (node --watch)
npm run check   # lint + テスト
```

DB は `data/kakeibo.db` に作られます (git 管理外)。

## 構成

```text
server.js            起動エントリ
server/              API 実装 (db / tables / export / accounts / create-app)
app/                 フロントエンド (index.html, mobile-input.html, js/, css/)
scripts/             Excel レポート生成, update-nas.sh (NAS 更新), migrate-nas.sh (旧方式からの移行)
test/                API 結合テスト
Dockerfile
docker-compose.yml        開発 PC 用 (ローカルビルド)
docker-compose.prod.yml   NAS 用 (GHCR から pull)
.github/workflows/        CI (lint+test), Docker publish (タグ push で GHCR へ)
```

## DB を保持したまま NAS をアップデートする

```text
開発 PC ──git tag v1.3.0 を push──▶ GitHub Actions ──イメージ build/push──▶ ghcr.io/higemaguro/kakeibo
                                                                                  │
NAS:  sh update-nas.sh   (DB バックアップ → docker compose pull → up -d)  ◀────────┘
```

### DB が消えない理由

| | 保存場所 | 更新時 |
|---|---|---|
| アプリ本体 (server.js, app/) | Docker **イメージ**の中 | pull で新しいものに**置き換わる** |
| 家計簿 DB (`kakeibo.db`) | NAS の**フォルダー** `/volume1/docker/kakeibovs/data/` を `/app/data` にマウント | コンテナを作り直しても**触られない** |

- `docker-compose.prod.yml` の `volumes: ./data:/app/data` がこの分離を担う。イメージにも git にも DB は含まれない (`.gitignore` / `.dockerignore` で除外)。
- DB のスキーマ変更は**起動時にカラム追加のみ**行う (`server/db.js` の `COLUMN_MIGRATIONS`)。既存の行は変更しないので、新版で起動した DB を旧版に戻しても動く。
- 更新前に `update-nas.sh` が `backups/kakeibo_<日時>.db` を自動で取る (30 世代保持)。

### 手順

**開発 PC** — バージョンを上げてタグを push

```bash
npm run check                                    # lint + テスト
npm version 1.3.0 --no-git-tag-version           # package.json の version を更新
git add -A && git commit -m "v1.3.0: 変更内容"
git tag v1.3.0
git push origin main --tags                      # → Actions「Docker publish」が数分でイメージを公開
```

> git tag と `package.json` の version が一致しないと Actions が失敗する (安全装置)。

**NAS** — SSH で 2 行 (GitHub Actions が緑になってから)

```sh
cd /volume1/docker/kakeibovs
sh update-nas.sh --dry-run    # 事前確認 (任意)
sh update-nas.sh
```

`update-nas.sh` は compose ファイルを自動検出する (`docker-compose.prod.yml` / `compose.yaml` / `docker-compose.yml`)。DBは `VACUUM INTO` で一貫バックアップしてから更新し、30世代保持。GUI の「再デプロイ」だけでも更新できるが、その場合は自動バックアップが無いので `data/kakeibo.db` を手動でコピーする。

ブラウザで `http://<NAS の IP>:9090` →「データ管理」ページのバージョン表示が新しくなっていれば完了。
取引データが表示されていれば DB は引き継がれている。

### 旧バージョンに戻す

```sh
sh update-nas.sh 1.2.0        # バージョン番号を指定して再作成 (DB はそのまま)
sh update-nas.sh latest       # 最新に戻す
```

DB も戻したいとき (通常は不要):

```sh
docker compose -f docker-compose.prod.yml stop
cp backups/kakeibo_<日時>.db data/kakeibo.db && rm -f data/kakeibo.db-wal data/kakeibo.db-shm
docker compose -f docker-compose.prod.yml start
```

### 初回だけ必要なこと

- **旧 kakeibovs (NAS 上で build する方式) から移行する場合**: `scripts/migrate-nas.sh` を NAS で 1 回実行する。既存の `data/` を引き継いで新方式に切り替える → [DEPLOY.md §2-A](DEPLOY.md#2-a-旧-kakeibovs-nas-上で-docker-build-する方式-が既に動いている場合--通常はこちら)
- **GHCR パッケージの公開範囲**: Public にすれば NAS で `docker login` 不要。Private のままなら PAT でログイン → [DEPLOY.md §1](DEPLOY.md#1-初回-github-側の設定)

その他 (新規 NAS へのインストール、GUI 操作、運用メモ) は [DEPLOY.md](DEPLOY.md)。
