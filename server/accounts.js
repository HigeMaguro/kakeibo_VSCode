/**
 * server/accounts.js - 預金口座の補助 API
 *
 *   POST /api/accounts/recalculate
 *     全口座の残高 (bank_accounts.balance) と各明細の取引後残高 (balance_after) を
 *     「初期残高 + 明細の積み上げ (日付順 → 登録順)」で再計算する。
 *     フロント側の差分更新で残高がずれた場合の復旧用。
 */

'use strict';

const express = require('express');
const { withTransaction } = require('./db');

const DEBIT_TYPES = new Set(['withdrawal', 'transfer_out']);

/**
 * 残高を再計算する。
 * @returns {{ accounts: Array<{id:string,name:string,before:number,after:number}>, updatedTx: number }}
 */
function recalculateBalances(db) {
  return withTransaction(db, () => {
    const accounts = db.prepare('SELECT * FROM bank_accounts').all();
    const txStmt = db.prepare('SELECT id, type, amount, balance_after FROM account_transactions WHERE account_id = ? ORDER BY date ASC, created_at ASC, id ASC');
    const updTx = db.prepare('UPDATE account_transactions SET balance_after = ? WHERE id = ?');
    const updAcct = db.prepare('UPDATE bank_accounts SET balance = ?, updated_at = ? WHERE id = ?');
    const now = Date.now();
    const result = [];
    let updatedTx = 0;

    for (const a of accounts) {
      let bal = Number(a.initial_balance) || 0;
      for (const t of txStmt.all(a.id)) {
        const amt = Number(t.amount) || 0;
        bal += DEBIT_TYPES.has(t.type) ? -amt : amt;
        if (Number(t.balance_after) !== bal) {
          updTx.run(bal, t.id);
          updatedTx++;
        }
      }
      if (Number(a.balance) !== bal) updAcct.run(bal, now, a.id);
      result.push({ id: a.id, name: a.name, before: Number(a.balance) || 0, after: bal });
    }
    return { accounts: result, updatedTx };
  });
}

function createAccountsRouter(db) {
  const router = express.Router();
  router.post('/accounts/recalculate', (req, res) => {
    try {
      res.json(recalculateBalances(db));
    } catch (err) {
      console.error('[POST /api/accounts/recalculate] Error:', err);
      res.status(500).json({ error: '残高の再計算に失敗しました', details: err.message });
    }
  });
  return router;
}

module.exports = { createAccountsRouter, recalculateBalances };
