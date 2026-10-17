/**
 * API 結合テスト (Node 標準 node:test。追加依存なし)
 *   実行: npm test
 * インメモリ SQLite で Express アプリを起動して HTTP で叩く。
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/create-app');
const { buildOrderBy, KNOWN_TABLES } = require('../server/tables');

let server;
let base;
let db;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* binary */ }
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  db = openDatabase(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

test('health / version', async () => {
  assert.equal((await call('GET', '/health')).json.status, 'ok');
  const v = await call('GET', '/api/version');
  assert.equal(v.status, 200);
  assert.ok(v.json.version);
});

test('CRUD: transactions', async () => {
  const c = await call('POST', '/tables/transactions', { date: '2026-08-01', type: 'expense', category: '食費', amount: '1200', memo: 'x' });
  assert.equal(c.status, 201);
  assert.equal(c.json.amount, 1200);
  assert.ok(c.json.id && c.json.created_at);

  const u = await call('PUT', `/tables/transactions/${c.json.id}`, { amount: 1500, created_at: 1 });
  assert.equal(u.json.amount, 1500);
  assert.equal(u.json.created_at, c.json.created_at, 'created_at は更新不可');

  const g = await call('GET', `/tables/transactions/${c.json.id}`);
  assert.equal(g.json.memo, 'x');

  const d = await call('DELETE', `/tables/transactions/${c.json.id}`);
  assert.equal(d.json.success, true);
  assert.equal((await call('GET', `/tables/transactions/${c.json.id}`)).status, 404);
});

test('一覧: フィルタ・ページング・total', async () => {
  for (let i = 0; i < 7; i++) {
    await call('POST', '/tables/transactions', { date: `2026-09-0${i + 1}`, type: 'income', category: '給与', amount: i });
  }
  const p1 = await call('GET', '/tables/transactions?type=income&limit=3&offset=0&sort=date ASC');
  assert.equal(p1.json.total, 7);
  assert.equal(p1.json.data.length, 3);
  assert.equal(p1.json.data[0].date, '2026-09-01');
  const p3 = await call('GET', '/tables/transactions?type=income&limit=3&offset=6&sort=-date');
  assert.equal(p3.json.data.length, 1);
  assert.equal(p3.json.data[0].date, '2026-09-01');
});

test('セキュリティ: 未定義テーブル・不正 sort は拒否', async () => {
  assert.equal((await call('GET', '/tables/sqlite_master')).status, 404);
  assert.equal((await call('GET', '/tables/transactions?sort=' + encodeURIComponent('(SELECT 1)'))).status, 400);
  assert.equal((await call('GET', '/tables/transactions?sort=' + encodeURIComponent('date; DROP TABLE budgets'))).status, 400);
  assert.equal((await call('GET', '/tables/budgets')).status, 200);
  assert.equal(buildOrderBy('amount desc, -date', KNOWN_TABLES.transactions), 'amount DESC, date DESC, id ASC');
  assert.equal(buildOrderBy('nope', KNOWN_TABLES.transactions), null);
});

test('未定義 API は JSON 404 (SPA に飲まれない)', async () => {
  const r = await call('GET', '/api/nothing');
  assert.equal(r.status, 404);
  assert.ok(r.json.error);
});

test('口座残高の再計算 (振込を含む)', async () => {
  const a = (await call('POST', '/tables/bank_accounts', { name: 'A', initial_balance: 10000, balance: 0 })).json;
  const b = (await call('POST', '/tables/bank_accounts', { name: 'B', initial_balance: 0, balance: 999 })).json;
  await call('POST', '/tables/account_transactions', { account_id: a.id, date: '2026-08-01', type: 'deposit', amount: 5000, created_at: 1 });
  await call('POST', '/tables/account_transactions', { account_id: a.id, date: '2026-08-02', type: 'withdrawal', amount: 2000, created_at: 2 });
  await call('POST', '/tables/account_transactions', { account_id: a.id, date: '2026-08-03', type: 'transfer_out', amount: 3000, related_account_id: b.id, created_at: 3 });
  await call('POST', '/tables/account_transactions', { account_id: b.id, date: '2026-08-03', type: 'transfer_in', amount: 3000, related_account_id: a.id, created_at: 4 });

  const r = await call('POST', '/api/accounts/recalculate');
  assert.equal(r.status, 200);
  const after = Object.fromEntries(r.json.accounts.map(x => [x.name, x.after]));
  assert.equal(after.A, 10000);
  assert.equal(after.B, 3000);

  const txs = (await call('GET', `/tables/account_transactions?account_id=${a.id}&sort=date ASC`)).json.data;
  assert.deepEqual(txs.map(t => t.balance_after), [15000, 13000, 10000]);
  assert.equal((await call('GET', `/tables/bank_accounts/${b.id}`)).json.balance, 3000);
});

test('Excel / JSON エクスポート', async () => {
  const x = await call('GET', '/api/export/excel?month=2026-09');
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-type'), /spreadsheetml/);
  const j = await call('GET', '/api/export');
  assert.equal(j.status, 200);
  assert.ok(Array.isArray(j.json.transactions));
  assert.ok(Array.isArray(j.json.app_settings));
});

test('マイグレーション: 旧 app_settings (id 無し) を移行', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kakeibo-')), 'k.db');
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER); INSERT INTO app_settings VALUES ('opening_cash_2026-08', '100', 1);");
  raw.close();

  const migrated = openDatabase(file);
  const rows = migrated.prepare('SELECT * FROM app_settings').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'opening_cash_2026-08');
  assert.ok(migrated.prepare("PRAGMA table_info(account_transactions)").all().some(c => c.name === 'paired_tx_id'));
  assert.equal(migrated.prepare("SELECT name FROM sqlite_master WHERE name='app_settings_new'").get(), undefined);
  migrated.close();
  // 2 回目の起動でも壊れない
  const again = openDatabase(file);
  assert.equal(again.prepare('SELECT COUNT(*) c FROM app_settings').get().c, 1);
  again.close();
});
