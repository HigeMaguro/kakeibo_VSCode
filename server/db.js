/**
 * server/db.js - SQLite (node:sqlite) の初期化・スキーマ定義・マイグレーション
 *
 * 新しいテーブル/カラムを追加する手順は DEVELOPMENT.md の
 * 「テーブル・カラムを追加する」を参照。
 *   1. SCHEMA_SQL に CREATE TABLE IF NOT EXISTS を追加 (新規 DB 用)
 *   2. COLUMN_MIGRATIONS に ADD COLUMN を追加 (既存 DB 用)
 *   3. server/tables.js の KNOWN_TABLES にカラムを追加 (REST API で読み書き可能にする)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_SQL = `
  -- 収支テーブル
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    memo TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
  CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at DESC);

  -- 予算テーブル
  CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    month TEXT NOT NULL,
    category TEXT NOT NULL,
    budget REAL NOT NULL,
    label TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_budgets_month ON budgets(month);

  -- 銀行口座テーブル
  CREATE TABLE IF NOT EXISTS bank_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bank_name TEXT DEFAULT '',
    account_type TEXT DEFAULT '普通',
    balance REAL DEFAULT 0,
    initial_balance REAL DEFAULT 0,
    color TEXT DEFAULT 'acct-color-1',
    note TEXT DEFAULT '',
    icon TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bank_accounts_created ON bank_accounts(created_at);

  -- 口座取引明細テーブル
  CREATE TABLE IF NOT EXISTS account_transactions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT DEFAULT '',
    description TEXT DEFAULT '',
    related_account_id TEXT DEFAULT '',
    link_mode INTEGER DEFAULT 0,
    linked_income_tx_id TEXT DEFAULT '',
    linked_expense_tx_id TEXT DEFAULT '',
    paired_tx_id TEXT DEFAULT '',
    balance_after REAL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_acct_tx_account ON account_transactions(account_id);
  CREATE INDEX IF NOT EXISTS idx_acct_tx_date ON account_transactions(date);
  CREATE INDEX IF NOT EXISTS idx_acct_tx_created ON account_transactions(created_at DESC);
`;

const APP_SETTINGS_SQL = `
  CREATE TABLE IF NOT EXISTS app_settings (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_app_settings_key ON app_settings(key);
`;

// 既存 DB 向けのカラム追加。既に存在する場合はエラーになるので無視する。
const COLUMN_MIGRATIONS = [
  "ALTER TABLE account_transactions ADD COLUMN linked_tx_id TEXT DEFAULT ''",
  'ALTER TABLE account_transactions ADD COLUMN link_mode INTEGER DEFAULT 0',
  "ALTER TABLE account_transactions ADD COLUMN linked_income_tx_id TEXT DEFAULT ''",
  "ALTER TABLE account_transactions ADD COLUMN linked_expense_tx_id TEXT DEFAULT ''",
  // v1.2.0: 振込(transfer_in/out)の対になる相手口座側の取引 ID
  "ALTER TABLE account_transactions ADD COLUMN paired_tx_id TEXT DEFAULT ''",
];

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function tableColumns(db, name) {
  // name は内部定数のみ (外部入力は渡さない)
  return db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
}

/**
 * app_settings の旧スキーマ (id カラムなし) を新スキーマへ移行する。
 * 旧実装が毎回作っていた空の app_settings_new テーブルも掃除する。
 */
function migrateAppSettings(db) {
  if (hasTable(db, 'app_settings') && !tableColumns(db, 'app_settings').includes('id')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings_migrating (
        id TEXT PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO app_settings_migrating(id, key, value, updated_at)
        SELECT key, key, value, updated_at FROM app_settings;
      DROP TABLE app_settings;
      ALTER TABLE app_settings_migrating RENAME TO app_settings;
    `);
  }
  if (hasTable(db, 'app_settings_new')) {
    if (!hasTable(db, 'app_settings')) {
      db.exec('ALTER TABLE app_settings_new RENAME TO app_settings');
    } else {
      const { c } = db.prepare('SELECT COUNT(*) AS c FROM app_settings_new').get();
      if (c === 0) db.exec('DROP TABLE app_settings_new');
    }
  }
  db.exec(APP_SETTINGS_SQL);
}

/**
 * DB を開いてスキーマを最新化する。
 * @param {string} dbPath SQLite ファイルパス (':memory:' 可)
 * @returns {DatabaseSync}
 */
function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);
  migrateAppSettings(db);
  for (const sql of COLUMN_MIGRATIONS) {
    try { db.exec(sql); } catch { /* 既存カラムは無視 */ }
  }
  return db;
}

/**
 * fn をトランザクション内で実行する (例外時はロールバック)。
 */
function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

module.exports = { openDatabase, withTransaction };
