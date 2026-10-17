/**
 * server/export.js - バックアップ / エクスポート API
 *
 *   GET /api/export                 全テーブルを JSON でダウンロード
 *   GET /api/export/excel[?month=]  Excel (.xlsx) 出力 (month=YYYY-MM で月指定)
 */

'use strict';

const express = require('express');
const ExcelJS = require('exceljs');
const { addReportToWorkbook } = require('../scripts/lib/report-builder');

const HEADER_FILL = 'FFE8F0FE';   // ヘッダー行の背景色 (薄い青)
const HEADER_FONT_COLOR = 'FF1F3864';
const YEN_FORMAT = '"¥"#,##0';
const DATE_FORMAT = 'yyyy/mm/dd';

const ACCT_TYPE_LABELS = { deposit: '入金', withdrawal: '出金', transfer_in: '振込入金', transfer_out: '振込出金' };
const TX_TYPE_LABELS = { income: '収入', expense: '支出' };

function styleHeaderRow(sheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: HEADER_FONT_COLOR } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 22;
}

function autoWidth(sheet, minWidth = 8) {
  sheet.columns.forEach(col => {
    let max = minWidth;
    col.eachCell({ includeEmpty: false }, cell => {
      const len = String(cell.value != null ? cell.value : '').length;
      if (len > max) max = len;
    });
    // 日本語は全角を考慮して幅を少し広げる
    col.width = Math.min(max * 1.6 + 4, 60);
  });
}

function finishSheet(ws, filterCols) {
  styleHeaderRow(ws);
  autoWidth(ws);
  if (filterCols) ws.autoFilter = { from: 'A1', to: { row: 1, column: filterCols } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/** 'YYYY-MM-DD' をローカル日付の Date に (Excel 日付セル用) */
function toLocalDate(s) {
  return s ? new Date(s + 'T00:00:00') : '';
}

function timestamp(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * Excel ワークブックを構築して xlsx バッファを返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|null} month 'YYYY-MM' または null (全期間)
 */
async function buildExcelWorkbook(db, month) {
  const transactions = month
    ? db.prepare("SELECT * FROM transactions WHERE date LIKE ? || '%' ORDER BY date DESC, created_at DESC").all(month)
    : db.prepare('SELECT * FROM transactions ORDER BY date DESC, created_at DESC').all();
  const budgets = month
    ? db.prepare('SELECT * FROM budgets WHERE month = ? ORDER BY month ASC').all(month)
    : db.prepare('SELECT * FROM budgets ORDER BY month ASC').all();
  const accounts = db.prepare('SELECT * FROM bank_accounts ORDER BY created_at ASC').all();
  const acctTx = month
    ? db.prepare("SELECT * FROM account_transactions WHERE date LIKE ? || '%' ORDER BY date DESC, created_at DESC").all(month)
    : db.prepare('SELECT * FROM account_transactions ORDER BY date DESC, created_at DESC').all();
  const accountNames = Object.fromEntries(accounts.map(a => [a.id, a.name]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MyKakeibo';
  wb.created = new Date();

  // ── シート1: 月別サマリー ──
  const ws1 = wb.addWorksheet('月別サマリー');
  ws1.columns = [
    { header: '年月', key: 'month', width: 12 },
    { header: '収入合計', key: 'income', width: 16 },
    { header: '支出合計', key: 'expense', width: 16 },
    { header: '収支', key: 'balance', width: 16 },
  ];
  const monthly = {};
  for (const t of transactions) {
    const m = String(t.date || '').slice(0, 7);
    if (!m) continue;
    if (!monthly[m]) monthly[m] = { income: 0, expense: 0 };
    if (t.type === 'income') monthly[m].income += Number(t.amount) || 0;
    if (t.type === 'expense') monthly[m].expense += Number(t.amount) || 0;
  }
  for (const m of Object.keys(monthly).sort()) {
    const v = monthly[m];
    const row = ws1.addRow({ month: m, income: v.income, expense: v.expense, balance: v.income - v.expense });
    ['income', 'expense', 'balance'].forEach(k => { row.getCell(k).numFmt = YEN_FORMAT; });
    row.getCell('balance').font = { color: { argb: v.income - v.expense >= 0 ? 'FF2E7D32' : 'FFC0392B' } };
  }
  finishSheet(ws1);

  // ── シート2: 収支データ (report-builder がこのシート名・列順 A:日付 B:種別 C:カテゴリ D:金額 を前提にする) ──
  const ws2 = wb.addWorksheet('収支データ');
  ws2.columns = [
    { header: '日付', key: 'date', width: 12 },
    { header: '種別', key: 'type', width: 8 },
    { header: 'カテゴリ', key: 'category', width: 14 },
    { header: '金額', key: 'amount', width: 14 },
    { header: 'メモ', key: 'memo', width: 30 },
  ];
  for (const t of transactions) {
    const row = ws2.addRow({
      date: toLocalDate(t.date),
      type: TX_TYPE_LABELS[t.type] || t.type,
      category: t.category,
      amount: Number(t.amount) || 0,
      memo: t.memo || '',
    });
    row.getCell('date').numFmt = DATE_FORMAT;
    row.getCell('amount').numFmt = YEN_FORMAT;
  }
  finishSheet(ws2, 5);

  // ── シート3: 予算 ──
  const ws3 = wb.addWorksheet('予算');
  ws3.columns = [
    { header: '年月', key: 'month', width: 12 },
    { header: 'カテゴリ', key: 'category', width: 14 },
    { header: '予算額', key: 'budget', width: 14 },
    { header: 'ラベル', key: 'label', width: 20 },
  ];
  for (const b of budgets) {
    const row = ws3.addRow({ month: b.month, category: b.category, budget: Number(b.budget) || 0, label: b.label || '' });
    row.getCell('budget').numFmt = YEN_FORMAT;
  }
  finishSheet(ws3, 4);

  // ── シート4: 預金口座 ──
  const ws4 = wb.addWorksheet('預金口座');
  ws4.columns = [
    { header: '口座名', key: 'name', width: 18 },
    { header: '銀行名', key: 'bank_name', width: 18 },
    { header: '口座種別', key: 'account_type', width: 10 },
    { header: '現在残高', key: 'balance', width: 14 },
    { header: '初期残高', key: 'initial_balance', width: 14 },
    { header: 'メモ', key: 'note', width: 24 },
  ];
  for (const a of accounts) {
    const row = ws4.addRow({
      name: a.name,
      bank_name: a.bank_name || '',
      account_type: a.account_type || '',
      balance: Number(a.balance) || 0,
      initial_balance: Number(a.initial_balance) || 0,
      note: a.note || '',
    });
    row.getCell('balance').numFmt = YEN_FORMAT;
    row.getCell('initial_balance').numFmt = YEN_FORMAT;
  }
  finishSheet(ws4);

  // ── シート5: 口座明細 ──
  const ws5 = wb.addWorksheet('口座明細');
  ws5.columns = [
    { header: '日付', key: 'date', width: 12 },
    { header: '口座名', key: 'account', width: 16 },
    { header: '種別', key: 'type', width: 10 },
    { header: 'カテゴリ', key: 'category', width: 12 },
    { header: '出金', key: 'withdraw', width: 14 },
    { header: '入金', key: 'deposit', width: 14 },
    { header: '残高', key: 'balance_after', width: 14 },
    { header: '摘要', key: 'description', width: 24 },
    { header: '相手口座', key: 'related', width: 16 },
  ];
  for (const t of acctTx) {
    const amt = Number(t.amount) || 0;
    const isWithdraw = t.type === 'withdrawal' || t.type === 'transfer_out';
    const row = ws5.addRow({
      date: toLocalDate(t.date),
      account: accountNames[t.account_id] || '',
      type: ACCT_TYPE_LABELS[t.type] || t.type,
      category: t.category || '',
      withdraw: isWithdraw ? amt : null,
      deposit: isWithdraw ? null : amt,
      balance_after: t.balance_after != null && t.balance_after !== '' ? Number(t.balance_after) : null,
      description: t.description || '',
      related: t.related_account_id ? (accountNames[t.related_account_id] || '') : '',
    });
    row.getCell('date').numFmt = DATE_FORMAT;
    ['withdraw', 'deposit', 'balance_after'].forEach(k => { row.getCell(k).numFmt = YEN_FORMAT; });
  }
  finishSheet(ws5, 9);

  // ── 集計・グラフレポート追加 (設定/集計/グラフシート + チャート埋込) ──
  return addReportToWorkbook(wb);
}

function createExportRouter(db) {
  const router = express.Router();

  router.get('/export', (req, res) => {
    try {
      const data = {
        exported_at: new Date().toISOString(),
        transactions: db.prepare('SELECT * FROM transactions ORDER BY date DESC').all(),
        budgets: db.prepare('SELECT * FROM budgets').all(),
        bank_accounts: db.prepare('SELECT * FROM bank_accounts').all(),
        account_transactions: db.prepare('SELECT * FROM account_transactions ORDER BY date DESC').all(),
        app_settings: db.prepare('SELECT * FROM app_settings').all(),
      };
      res.setHeader('Content-Disposition', `attachment; filename="mykakeibo_backup_${timestamp()}.json"`);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'エクスポートに失敗しました', details: err.message });
    }
  });

  router.get('/export/excel', async (req, res) => {
    try {
      const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month)
        ? req.query.month : null;
      const buf = await buildExcelWorkbook(db, month);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="mykakeibo_${month ? month + '_' : ''}${timestamp()}.xlsx"`);
      res.setHeader('Content-Length', buf.length);
      res.send(Buffer.from(buf));
    } catch (err) {
      console.error('[GET /api/export/excel] Error:', err);
      res.status(500).json({ error: 'Excel エクスポートに失敗しました', details: err.message });
    }
  });

  return router;
}

module.exports = { createExportRouter, buildExcelWorkbook };
