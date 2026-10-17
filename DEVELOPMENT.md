# MyKakeibo 開発者ガイド (機能拡張の手引き)

機能を追加・修正するときに最初に読むドキュメントです。
NAS への配置・バージョン更新は `DEPLOY.md` を参照してください。

---

## 1. 構成

```text
kakeibo_VSCode/
├── server.js              起動エントリ (DB を開いて createApp → listen。SIGTERM で DB を安全に閉じる)
├── server/
│   ├── db.js              スキーマ定義 (SCHEMA_SQL)・カラム追加マイグレーション (COLUMN_MIGRATIONS)
│   ├── tables.js          汎用 REST API /tables/:table と KNOWN_TABLES (テーブル/カラムのホワイトリスト)
│   ├── export.js          /api/export (JSON), /api/export/excel (xlsx)
│   ├── accounts.js        /api/accounts/recalculate (口座残高の再計算)
│   └── create-app.js      Express 組み立て (ルーター登録・静的配信・SPA フォールバック)
├── scripts/
│   ├── make-report.js     既存 xlsx に集計/グラフを追加する CLI (npm run report)
│   ├── update-nas.sh      NAS 上で実行する更新スクリプト (DB バックアップ → pull → 再起動)
│   └── lib/               report-builder.js (集計・グラフシート), xlsx-charts.js (チャート XML 埋込)
├── app/                   フロントエンド (ビルド不要の素の HTML/CSS/JS)
│   ├── index.html         PC 向け SPA (ダッシュボード/収支一覧/入力/予算/分析/口座/データ管理)
│   ├── mobile-input.html  スマホ向け伝票入力
│   └── js/
│       ├── common.js      共通ユーティリティ (window.Kakeibo)。最初に読み込む
│       ├── accounts.js    預金口座ページ
│       ├── app.js         SPA 本体 (state, ページ切替, 各ページ描画)
│       └── mobile-input.js
├── test/api.test.js       API 結合テスト (node:test, インメモリ SQLite)
├── eslint.config.js
├── .vscode/               launch.json (Node + Chrome デバッグ), tasks.json, 推奨拡張
├── Dockerfile / .dockerignore
├── docker-compose.yml       開発 PC 用 (ローカルビルド)
├── docker-compose.prod.yml  NAS 用 (GHCR から pull)
└── .github/workflows/       ci.yml (lint+test), docker-publish.yml (タグ push で GHCR へ)
```

### データモデル (SQLite)

| テーブル | 用途 | 主なカラム |
|---|---|---|
| `transactions` | 家計簿の収入/支出 | `date`(YYYY-MM-DD) `type`(income/expense) `category` `amount` `memo` |
| `budgets` | 月別カテゴリ予算 | `month`(YYYY-MM) `category` `budget` |
| `bank_accounts` | 預金口座 | `initial_balance` `balance`(※再計算で決まる派生値) `color` |
| `account_transactions` | 口座明細 | `account_id` `type`(deposit/withdrawal/transfer_in/transfer_out) `amount` `balance_after`(派生値) `related_account_id` `paired_tx_id` `link_mode` `linked_income_tx_id` `linked_expense_tx_id` |
| `app_settings` | 汎用 key/value | 現在は `opening_cash_YYYY-MM` (月初現金残高) のみ |

- 全テーブル共通: `id`(UUID), `created_at`/`updated_at`(epoch ms) はサーバーが自動付与。
- **口座残高は派生値**: `bank_accounts.balance` と `account_transactions.balance_after` は
  `POST /api/accounts/recalculate` が「初期残高 + 明細を 日付→登録順 に積み上げ」で再計算する。
  明細を変更したら必ず再計算を呼ぶ (accounts.js の `acctRecalculateAndReload()`)。クライアントで差分計算しないこと。
- **振込**: 自口座側と相手口座側の 2 明細を作り、`paired_tx_id` で双方向に紐づける。編集・削除は両方に反映される。
- **家計簿連携** (`link_mode`): 口座出金時に 1=収入として / 2=収入+支出として `transactions` に自動登録し、
  その ID を `linked_*_tx_id` に保持する。口座明細の削除時に連携先も削除される。

---

## 2. 開発環境での起動

前提: Node.js **22.5 以上** (`node:sqlite` を使用。Docker イメージは node:22-alpine)。

| 方法 | 手順 |
|---|---|
| VS Code (推奨) | F5 →「Full Stack (server + Chrome)」。サーバーとデバッグ用 Chrome が同時に起動し、`server/` と `app/js/` の両方でブレークポイントが使える |
| VS Code (個別) | 「Node: server.js」でサーバーだけ起動 → 「Chrome: localhost:9090」/「Chrome: スマホ入力画面」でブラウザを追加 |
| コマンドライン | `npm ci && APP_PORT=9090 npm run dev` → ブラウザで `http://localhost:9090` |
| Docker (本番と同じ構成) | `docker compose up -d --build` → `http://localhost:9090` |

- DB は既定で `data/kakeibo.db` (git 管理外)。環境変数 `DB_PATH` で変更可能。
  本番データで試すときは **NAS の data/kakeibo.db をコピーして** 使うこと (`*-wal` があれば一緒にコピー)。
- `node --watch` によりサーバー側の変更は自動再起動。フロント (app/) はブラウザ再読み込みで反映
  (HTML/JS/CSS は `Cache-Control: no-cache` で配信)。

### チェック

```bash
npm test        # API 結合テスト
npm run lint    # ESLint
npm run check   # lint + test (コミット/デプロイ前に実行。GitHub Actions の CI でも同じものが走る)
```

### リリース

`package.json` の version を上げて `git tag vX.Y.Z` を push すると GitHub Actions が GHCR にイメージを公開する。手順は `DEPLOY.md`。

---

## 3. よくある拡張の手順

### 3.1 既存テーブルにカラムを追加する

1. `server/db.js` の `SCHEMA_SQL` の CREATE TABLE にカラムを追加 (新規 DB 用)
2. 同 `COLUMN_MIGRATIONS` に `ALTER TABLE ... ADD COLUMN ...` を追加 (既存 DB 用。既存なら無視される)
3. `server/tables.js` の `KNOWN_TABLES.<table>.columns` に追加 (数値なら `numeric` にも)
   → **ここに無いカラムは API で保存されずに黙って捨てられる**ので注意
4. 必要なら `server/export.js` の Excel 出力に列を追加
5. `test/api.test.js` にテストを追加

### 3.2 新しいテーブルを追加する

上記 1・3 に加えて `KNOWN_TABLES` に `{ columns, numeric, defaultSort }` を定義すれば
`/tables/<新テーブル>` で CRUD が使える。フロントからは `Kakeibo.api.*` / `Kakeibo.fetchAllRows()` で操作する。

### 3.3 専用 API を追加する (集計・一括処理など)

1. `server/<機能>.js` に `express.Router()` を返す関数を作る (例: `server/accounts.js`)
2. `server/create-app.js` で `app.use('/api', createXxxRouter(db))`
3. 複数行を更新する処理は `withTransaction(db, () => { ... })` (server/db.js) で囲む

### 3.4 画面 (ページ) を追加する

1. `app/index.html`: サイドバーに `<a class="nav-link" data-page="xxx">`、本文に `<section id="page-xxx" class="page">`
2. `app/js/app.js`: `navigateTo()` の `titles` に追加、`refreshCurrentPage()` の switch に描画関数を追加
3. 大きい機能は `app/js/xxx.js` に分け、`index.html` で `common.js` の後に読み込む

### 3.5 フロントのルール

- **ユーザー入力を `innerHTML` に入れるときは必ずエスケープ**: `esc()` (app.js / mobile-input.js), `acctEsc()` (accounts.js),
  実体は `Kakeibo.escapeHtml`。トースト関数も内部でエスケープ済み。
- **一覧取得は `Kakeibo.fetchAllRows(table, filters)`** を使う。`?limit=` 単発取得は件数上限で古いデータが欠落する。
- 日付は `Kakeibo.localDateString()` (ローカル日付)。`toISOString()` は UTC になり JST で日付がずれるので使わない。
- 金額は `Kakeibo.toYen()` で円単位の整数に丸めて保存する。
- 共通処理は各ファイルに複製せず `app/js/common.js` に追加する。

---

## 4. 既知の課題・拡張候補

| 項目 | 内容 |
|---|---|
| カテゴリの永続化 | PC 画面は「デフォルト + 取引に使われたもの」をメモリ保持、スマホは localStorage。両者は同期しない。`app_settings` に `categories_expense` 等で保存する形に統一するのが次の候補 |
| カテゴリ定義の重複 | 既定カテゴリ・アイコンが app.js / mobile-input.js に別々に定義されている → common.js へ集約したい |
| 連携処理の原子性 | 口座明細 + 家計簿連携 + 振込の対明細はクライアントから複数 API 呼び出しで作成している。途中失敗時は再計算で残高は直るが、連携レコードが残る可能性あり。サーバー側に一括 API を作り `withTransaction` で処理するのが理想 |
| 認証 | なし (LAN 内利用前提)。外部公開する場合はリバースプロキシで Basic 認証等を付けること |
| 外部 CDN | Chart.js / Font Awesome / Google Fonts を CDN から読み込んでいる。インターネット非接続環境ではアイコン・グラフが表示されない |
| PWA | manifest / Service Worker は未実装 |

---

## 5. 変更履歴

### v1.2.0
- server.js を `server/` 以下にモジュール分割、API テスト・ESLint 追加
- セキュリティ: `/tables` のテーブル名をホワイトリスト化、`?sort=` を検証 (SQL インジェクション対策)、画面の XSS 対策
- 修正: 取引 500 件超で古いデータが集計から欠落する問題 (全件ページング取得に変更)
- 修正: 予算が月に関係なく全件表示され、別の月に同カテゴリの予算を作れなかった問題 (月別化 +「前月の予算をコピー」)
- 修正: 振込の編集で相手口座側の明細が重複作成・残高が二重計上される問題、振込削除・口座削除で相手側明細/連携取引が残る問題
  (`paired_tx_id` で紐づけ、残高はサーバー側で再計算。口座ページに「残高再計算」ボタン追加)
- 修正: 旧スキーマ移行処理で空の `app_settings_new` テーブルが毎回作られていた問題
- VS Code 専用プロジェクト `kakeibo_VSCode` へ移行 (C# ランチャー廃止、Chrome デバッグ構成、GitHub Actions → GHCR → NAS のデプロイ方式)
