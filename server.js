/**
 * MyKakeibo - 自宅サーバー / NAS 向けバックエンドサーバー (起動エントリ)
 * Node.js + Express + 標準組み込み SQLite (node:sqlite)
 *
 * 実装本体は server/ 以下に分割:
 *   server/db.js          DB 初期化・スキーマ・マイグレーション
 *   server/tables.js      汎用 REST API (/tables/:table)
 *   server/export.js      JSON / Excel エクスポート (/api/export, /api/export/excel)
 *   server/accounts.js    口座残高再計算 (/api/accounts/recalculate)
 *   server/create-app.js  Express アプリ組み立て (テストからも利用)
 */

'use strict';

const path = require('path');
const { openDatabase } = require('./server/db');
const { createApp } = require('./server/create-app');

const PORT = process.env.APP_PORT || process.env.PORT || 80;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'kakeibo.db');

const db = openDatabase(DB_PATH);
console.log(`[DB] SQLite initialized at: ${DB_PATH}`);

const app = createApp(db);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('=========================================');
  console.log(`🏠 MyKakeibo Server running on port ${PORT}`);
  console.log(`📊 Storage: SQLite (${DB_PATH})`);
  console.log(`🌐 Local Access: http://localhost:${PORT}`);
  console.log('=========================================');
});

// docker stop / Ctrl+C で DB を安全に閉じる (WAL のチェックポイントを確実に行う)
function shutdown(signal) {
  console.log(`[${signal}] shutting down...`);
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
