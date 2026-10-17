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

UGREEN NAS に SSH でログインして実行 (UGOS の Docker GUI でも同等の操作が可能)。

```sh
# 配置先 (既存の kakeibo を使っていた場合は同じフォルダーを使うと data/ をそのまま引き継げる)
mkdir -p /volume1/docker/kakeibovs && cd /volume1/docker/kakeibovs

# 2 ファイルを取得
wget -O docker-compose.prod.yml https://raw.githubusercontent.com/HigeMaguro/kakeibo_VSCode/main/docker-compose.prod.yml
wget -O update-nas.sh          https://raw.githubusercontent.com/HigeMaguro/kakeibo_VSCode/main/scripts/update-nas.sh
chmod +x update-nas.sh

# 旧構成 (ローカルビルド版) から移行する場合は旧コンテナを停止
docker stop kakeibo 2>/dev/null; docker rm kakeibo 2>/dev/null

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
sh update-nas.sh
```

スクリプトの動作:
1. `data/kakeibo.db` を `backups/kakeibo_YYYYMMDD_HHMMSS.db` にコピー (30 世代保持)
2. `docker compose pull` で新イメージ取得
3. `docker compose up -d` で再作成 (`data/` はマウントなので DB は保持)
4. `/api/version` を表示して完了

## 5. ロールバック

```sh
sh update-nas.sh 1.2.0        # 旧バージョンのタグに固定して再作成
# DB も戻す必要がある場合 (通常は不要。スキーマは後方互換)
docker compose -f docker-compose.prod.yml stop
cp backups/kakeibo_YYYYMMDD_HHMMSS.db data/kakeibo.db && rm -f data/kakeibo.db-wal data/kakeibo.db-shm
docker compose -f docker-compose.prod.yml start
```

`:latest` に戻すには `sh update-nas.sh latest`。

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
