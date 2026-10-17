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
scripts/             Excel レポート生成, update-nas.sh (NAS 更新)
test/                API 結合テスト
Dockerfile
docker-compose.yml        開発 PC 用 (ローカルビルド)
docker-compose.prod.yml   NAS 用 (GHCR から pull)
.github/workflows/        CI (lint+test), Docker publish (タグ push で GHCR へ)
```

## リリースの流れ

1. `package.json` の `version` を上げてコミット
2. `git tag v1.3.0 && git push origin main --tags`
3. GitHub Actions が `ghcr.io/higemaguro/kakeibo:1.3.0` / `:latest` を公開
4. NAS で `sh update-nas.sh` (DB バックアップ → pull → 再起動)

詳細は [DEPLOY.md](DEPLOY.md)。
