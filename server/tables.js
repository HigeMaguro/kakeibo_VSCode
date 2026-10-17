/**
 * server/tables.js - 汎用 RESTful テーブル API (/tables/:table)
 *
 *   GET    /tables/:table             一覧 (?limit=&offset=&sort=col [ASC|DESC]&<col>=<値>)
 *   POST   /tables/:table             新規登録 (id/created_at/updated_at は自動付与)
 *   GET    /tables/:table/:id         単一取得
 *   PUT    /tables/:table/:id         更新 (PATCH も同じ。送ったカラムのみ更新)
 *   DELETE /tables/:table/:id         削除
 *
 * セキュリティ:
 *   - テーブル名は KNOWN_TABLES に定義されたもののみ許可 (それ以外は 404)
 *   - sort はカラム名 + ASC/DESC のみ許可 (SQL インジェクション対策)
 *   - フィルタ・値はすべてプレースホルダでバインド
 */

'use strict';

const express = require('express');
const crypto = require('crypto');

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

/**
 * テーブル定義メタデータ。
 * ここに無いテーブル/カラムは API から読み書きできない。
 */
const KNOWN_TABLES = {
  transactions: {
    columns: ['id', 'date', 'type', 'category', 'amount', 'memo', 'created_at', 'updated_at'],
    numeric: ['amount', 'created_at', 'updated_at'],
    defaultSort: 'created_at DESC',
  },
  budgets: {
    columns: ['id', 'month', 'category', 'budget', 'label', 'created_at', 'updated_at'],
    numeric: ['budget', 'created_at', 'updated_at'],
    defaultSort: 'created_at ASC',
  },
  bank_accounts: {
    columns: ['id', 'name', 'bank_name', 'account_type', 'balance', 'initial_balance', 'color', 'note', 'icon', 'created_at', 'updated_at'],
    numeric: ['balance', 'initial_balance', 'created_at', 'updated_at'],
    defaultSort: 'created_at ASC',
  },
  account_transactions: {
    columns: ['id', 'account_id', 'date', 'type', 'amount', 'category', 'description', 'related_account_id', 'link_mode', 'linked_income_tx_id', 'linked_expense_tx_id', 'linked_tx_id', 'paired_tx_id', 'balance_after', 'created_at', 'updated_at'],
    numeric: ['amount', 'balance_after', 'link_mode', 'created_at', 'updated_at'],
    defaultSort: 'created_at DESC',
  },
  app_settings: {
    columns: ['id', 'key', 'value', 'updated_at'],
    numeric: ['updated_at'],
    defaultSort: 'updated_at DESC',
  },
};

function getTableMeta(tableName) {
  return Object.prototype.hasOwnProperty.call(KNOWN_TABLES, tableName) ? KNOWN_TABLES[tableName] : null;
}

/**
 * ?sort= を検証して ORDER BY 句を返す。不正なら null。
 * 例: "date DESC" / "date DESC, created_at DESC" / "-date" (= date DESC)
 */
function buildOrderBy(sort, meta) {
  const raw = sort ? String(sort) : meta.defaultSort;
  const parts = [];
  for (const piece of raw.split(',')) {
    let token = piece.trim();
    if (!token) continue;
    let dir = 'ASC';
    if (token.startsWith('-')) { dir = 'DESC'; token = token.slice(1); }
    const m = /^([a-z_][a-z0-9_]*)(?:\s+(asc|desc))?$/i.exec(token);
    if (!m || !meta.columns.includes(m[1])) return null;
    if (m[2]) dir = m[2].toUpperCase();
    parts.push(`${m[1]} ${dir}`);
  }
  if (parts.length === 0) return null;
  // ページング時に順序が安定するよう id をタイブレーカーにする
  if (!parts.some(p => p.startsWith('id '))) parts.push('id ASC');
  return parts.join(', ');
}

function toDbValue(meta, key, val) {
  if (meta.numeric.includes(key) && val !== null && val !== undefined && val !== '') {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }
  if (val === undefined) return null;
  if (val !== null && typeof val === 'object') return JSON.stringify(val);
  if (typeof val === 'boolean') return val ? 1 : 0;
  return val;
}

function createTablesRouter(db) {
  const router = express.Router();

  // テーブル名の検証 (全ルート共通)
  router.param('table', (req, res, next, table) => {
    const meta = getTableMeta(table);
    if (!meta) return res.status(404).json({ error: `テーブル '${table}' が見つかりません` });
    req.tableMeta = meta;
    next();
  });

  // GET /tables/:table - 一覧取得
  router.get('/:table', (req, res) => {
    const { table } = req.params;
    const meta = req.tableMeta;
    try {
      const { limit, offset, sort, ...filters } = req.query;
      const conditions = [];
      const paramValues = [];

      for (const [k, v] of Object.entries(filters)) {
        if (meta.columns.includes(k) && v !== undefined && v !== '' && typeof v === 'string') {
          conditions.push(`${k} = ?`);
          paramValues.push(toDbValue(meta, k, v));
        }
      }

      const orderBy = buildOrderBy(sort, meta);
      if (!orderBy) return res.status(400).json({ error: `不正な sort 指定です: ${sort}` });

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

      const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM ${table} ${whereClause}`).get(...paramValues);
      const rows = db.prepare(`SELECT * FROM ${table} ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
        .all(...paramValues, limitNum, offsetNum);

      res.json({ data: rows, total: totalRow ? totalRow.total : 0, limit: limitNum, offset: offsetNum });
    } catch (err) {
      console.error(`[GET /tables/${table}] Error:`, err);
      res.status(500).json({ error: 'データ取得に失敗しました', details: err.message });
    }
  });

  // POST /tables/:table - 新規登録
  router.post('/:table', (req, res) => {
    const { table } = req.params;
    const meta = req.tableMeta;
    try {
      const record = { ...(req.body || {}) };
      const now = Date.now();
      if (!record.id) record.id = crypto.randomUUID();
      if (!record.created_at && meta.columns.includes('created_at')) record.created_at = now;
      record.updated_at = now;

      const validKeys = Object.keys(record).filter(k => meta.columns.includes(k));
      if (validKeys.length === 0) {
        return res.status(400).json({ error: '有効なデータフィールドがありません' });
      }

      const values = validKeys.map(k => toDbValue(meta, k, record[k]));
      db.prepare(`INSERT INTO ${table} (${validKeys.join(', ')}) VALUES (${validKeys.map(() => '?').join(', ')})`)
        .run(...values);

      res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(record.id));
    } catch (err) {
      console.error(`[POST /tables/${table}] Error:`, err);
      const status = /constraint/i.test(err.message) ? 400 : 500;
      res.status(status).json({ error: 'データ登録に失敗しました', details: err.message });
    }
  });

  // GET /tables/:table/:id - 単一取得
  router.get('/:table/:id', (req, res) => {
    const { table, id } = req.params;
    try {
      const item = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      if (!item) return res.status(404).json({ error: '指定されたレコードが見つかりません' });
      res.json(item);
    } catch (err) {
      console.error(`[GET /tables/${table}/${id}] Error:`, err);
      res.status(500).json({ error: 'データ取得に失敗しました', details: err.message });
    }
  });

  // PUT / PATCH /tables/:table/:id - 更新
  const updateHandler = (req, res) => {
    const { table, id } = req.params;
    const meta = req.tableMeta;
    try {
      const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      if (!existing) return res.status(404).json({ error: '更新対象のレコードが見つかりません' });

      const updates = { ...(req.body || {}) };
      delete updates.id;          // ID は不変
      delete updates.created_at;  // 作成日時も不変
      updates.updated_at = Date.now();

      const validKeys = Object.keys(updates).filter(k => meta.columns.includes(k));
      if (validKeys.length === 0) return res.json(existing);

      const values = validKeys.map(k => toDbValue(meta, k, updates[k]));
      db.prepare(`UPDATE ${table} SET ${validKeys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...values, id);

      res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
    } catch (err) {
      console.error(`[PUT /tables/${table}/${id}] Error:`, err);
      res.status(500).json({ error: 'データ更新に失敗しました', details: err.message });
    }
  };
  router.put('/:table/:id', updateHandler);
  router.patch('/:table/:id', updateHandler);

  // DELETE /tables/:table/:id - 削除
  router.delete('/:table/:id', (req, res) => {
    const { table, id } = req.params;
    try {
      const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      if (result.changes === 0) return res.status(404).json({ error: '削除対象のレコードが見つかりません' });
      res.status(200).json({ success: true, deletedId: id });
    } catch (err) {
      console.error(`[DELETE /tables/${table}/${id}] Error:`, err);
      res.status(500).json({ error: 'データ削除に失敗しました', details: err.message });
    }
  });

  return router;
}

module.exports = { createTablesRouter, KNOWN_TABLES, getTableMeta, buildOrderBy };
