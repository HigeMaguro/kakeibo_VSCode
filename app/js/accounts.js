/**
 * MyKakeibo – 預金口座管理モジュール
 * js/accounts.js  (app.js より先に読み込まれる)
 */

'use strict';

/* ─────────────────────────────────────────
   定数・設定
───────────────────────────────────────── */
const ACCT_TABLE = 'bank_accounts';
const ACCT_TX_TABLE = 'account_transactions';
const ACCT_TX_PER_PAGE = 20;

const ACCT_COLORS = [
  { cls: 'acct-color-1', hex: '#4f7df3' },
  { cls: 'acct-color-2', hex: '#22c55e' },
  { cls: 'acct-color-3', hex: '#f59e0b' },
  { cls: 'acct-color-4', hex: '#ef4444' },
  { cls: 'acct-color-5', hex: '#8b5cf6' },
  { cls: 'acct-color-6', hex: '#06b6d4' },
  { cls: 'acct-color-7', hex: '#ec4899' },
  { cls: 'acct-color-8', hex: '#10b981' },
];

const TX_TYPE_LABELS = {
  deposit:      { label: '入金',      icon: 'fa-arrow-down',         cls: 'deposit' },
  withdrawal:   { label: '出金',      icon: 'fa-arrow-up',           cls: 'withdrawal' },
  transfer_in:  { label: '振込（入）', icon: 'fa-right-to-bracket',  cls: 'transfer_in' },
  transfer_out: { label: '振込（出）', icon: 'fa-right-from-bracket', cls: 'transfer_out' },
};

/* 家計簿連携モード: 0=連携なし, 1=収入へ連携, 2=収入と支出へ連携 */
const LINK_MODE_NONE = 0;
const LINK_MODE_INCOME = 1;
const LINK_MODE_INCOME_EXPENSE = 2;
const KAKEIBO_INCOME_CATEGORY_FALLBACK = 'その他収入';
const KAKEIBO_EXPENSE_CATEGORY_FALLBACK = 'その他';

function getLinkMode(type) {
  if (type !== 'withdrawal') return LINK_MODE_NONE;
  const sel = document.getElementById('acct-tx-link-mode');
  if (!sel) return LINK_MODE_NONE;
  return parseInt(sel.value, 10) || LINK_MODE_NONE;
}

/* ─────────────────────────────────────────
   状態
───────────────────────────────────────── */
const acctState = {
  accounts:         [],
  transactions:     [],
  activeAccountId:  null,
  selectedColor:    ACCT_COLORS[0].cls,
  txPage:           1,
  txTypeFilter:     '',
  editingAcctId:    null,
  editingTxId:      null,
};

/* ─────────────────────────────────────────
   ユーティリティ
───────────────────────────────────────── */
/** innerHTML に埋め込むユーザー入力は必ず acctEsc() を通す (js/common.js) */
const acctEsc = Kakeibo.escapeHtml;

function acctFormatYen(n) {
  return Kakeibo.formatYen(n);
}

function isTransferType(type) {
  return type === 'transfer_in' || type === 'transfer_out';
}
function acctFormatDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${+m}/${+d}`;
}
function acctToday() {
  return Kakeibo.localDateString();
}

/** 口座に色クラス→hex 逆引き */
function colorHexFromCls(cls) {
  return (ACCT_COLORS.find(c => c.cls === cls) || ACCT_COLORS[0]).hex;
}

/* ─────────────────────────────────────────
   API ラッパー (js/common.js の Kakeibo.api を使用)
   path は 'テーブル名' または 'テーブル名/ID'
───────────────────────────────────────── */
const acctPost   = (path, body)  => Kakeibo.api.request('POST',   `tables/${path}`, body);
const acctPut    = (path, body)  => Kakeibo.api.request('PUT',    `tables/${path}`, body);
const acctDelete = (path)        => Kakeibo.api.request('DELETE', `tables/${path}`);

/** 削除 (既に存在しなければ成功扱い) */
async function acctDeleteIfExists(path) {
  try { await acctDelete(path); } catch (e) { if (e.status !== 404) throw e; }
}

/* ─── 家計簿(transactions)連携用 API ─── */
const kakeiboPost   = (body)      => Kakeibo.api.create('transactions', body);
const kakeiboPut    = (id, body)  => Kakeibo.api.update('transactions', id, body);
const kakeiboDelete = (id)        => Kakeibo.api.remove('transactions', id);

/**
 * 口座残高をサーバー側で再計算 (初期残高 + 明細の積み上げ) して再読み込みする。
 * 明細を変更したら必ずこれを呼ぶ。クライアントでの差分計算はしない。
 */
async function acctRecalculateAndReload() {
  await Kakeibo.api.post('api/accounts/recalculate');
  await loadAccountsData();
}

/* ─── app.js state.allTransactions への即時反映ヘルパー ─── */
function pushKakeiboState(created) {
  if (typeof state !== 'undefined' && state.allTransactions) {
    state.allTransactions.push(created);
  }
}
function syncKakeiboState(id, updated) {
  if (typeof state !== 'undefined' && state.allTransactions) {
    const kIdx = state.allTransactions.findIndex(t => t.id === id);
    if (kIdx >= 0) state.allTransactions[kIdx] = { ...state.allTransactions[kIdx], ...updated };
  }
}
function removeKakeiboState(id) {
  if (typeof state !== 'undefined' && state.allTransactions) {
    state.allTransactions = state.allTransactions.filter(t => t.id !== id);
  }
}

/* ─────────────────────────────────────────
   データ読み込み
───────────────────────────────────────── */
async function loadAccountsData() {
  const [accounts, txs] = await Promise.all([
    Kakeibo.fetchAllRows(ACCT_TABLE),
    Kakeibo.fetchAllRows(ACCT_TX_TABLE),
  ]);
  acctState.accounts     = accounts.sort((a,b) => a.created_at - b.created_at);
  acctState.transactions = txs.sort((a,b) => {
    if (a.date < b.date) return 1;
    if (a.date > b.date) return -1;
    return b.created_at - a.created_at;
  });
}

/* ─────────────────────────────────────────
   ページ全体描画
───────────────────────────────────────── */
async function renderAccountsPage() {
  await loadAccountsData();
  renderSummaryCards();
  renderAccountCardsList();
  // デフォルト選択
  if (!acctState.activeAccountId && acctState.accounts.length > 0) {
    acctState.activeAccountId = acctState.accounts[0].id;
  }
  renderAccountTxArea();
}

/* ─────────────────────────────────────────
   合計残高サマリーカード
───────────────────────────────────────── */
function renderSummaryCards() {
  const container = document.getElementById('accounts-summary-cards');
  const accounts  = acctState.accounts;

  const totalBalance = accounts.reduce((s, a) => s + Number(a.balance || 0), 0);

  let html = `
    <div class="acct-summary-card total-card">
      <div class="acct-summary-label">💰 全口座合計残高</div>
      <div class="acct-summary-value">${acctFormatYen(totalBalance)}</div>
    </div>
  `;

  accounts.forEach(a => {
    const colorHex = colorHexFromCls(a.color || ACCT_COLORS[0].cls);
    html += `
      <div class="acct-summary-card" style="--acct-color:${colorHex}">
        <div class="acct-summary-label">${acctEsc(a.bank_name || '')} ${acctEsc(a.name)}</div>
        <div class="acct-summary-value">${acctFormatYen(a.balance)}</div>
      </div>
    `;
  });

  container.innerHTML = html;
}

/* ─────────────────────────────────────────
   口座カードリスト
───────────────────────────────────────── */
function renderAccountCardsList() {
  const list    = document.getElementById('account-cards-list');
  const noMsg   = document.getElementById('no-accounts-msg');
  const accounts = acctState.accounts;
  const addBtn  = document.getElementById('add-acct-tx-btn');

  if (accounts.length === 0) {
    list.innerHTML = '';
    noMsg.style.display = 'block';
    if (addBtn) addBtn.disabled = true;
    return;
  }
  noMsg.style.display = 'none';
  if (addBtn) addBtn.disabled = false;

  list.innerHTML = accounts.map(a => {
    const colorHex = colorHexFromCls(a.color || ACCT_COLORS[0].cls);
    const isActive = a.id === acctState.activeAccountId;
    const bal      = Number(a.balance || 0);
    return `
      <div class="account-card${isActive ? ' active-acct' : ''}"
           style="--acct-color:${colorHex}"
           onclick="acctSelectAccount('${acctEsc(a.id)}')">
        <div class="account-card-bar"></div>
        <div class="account-card-info">
          <div class="account-card-bank">
            <i class="fas fa-building-columns"></i>${acctEsc(a.bank_name || '')}
          </div>
          <div class="account-card-name">${acctEsc(a.name)}</div>
          <span class="account-card-type">${acctEsc(a.account_type || '普通')}</span>
        </div>
        <div class="account-card-balance-col">
          <div class="account-card-balance-label">残高</div>
          <div class="account-card-balance${bal < 0 ? ' negative' : ''}">${acctFormatYen(bal)}</div>
        </div>
        <div class="account-card-actions">
          <button class="btn-icon edit" onclick="event.stopPropagation(); acctStartEditAccount('${acctEsc(a.id)}')" title="編集">
            <i class="fas fa-pen"></i>
          </button>
          <button class="btn-icon delete" onclick="event.stopPropagation(); acctConfirmDeleteAccount('${acctEsc(a.id)}')" title="削除">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/* ─────────────────────────────────────────
   口座選択
───────────────────────────────────────── */
function acctSelectAccount(id) {
  acctState.activeAccountId = id;
  acctState.txPage          = 1;
  acctState.txTypeFilter    = '';
  document.getElementById('acct-tx-filter-type').value = '';
  renderAccountCardsList();
  renderAccountTxArea();
}

/* ─────────────────────────────────────────
   取引エリア（テーブル＋サマリー）
───────────────────────────────────────── */
function renderAccountTxArea() {
  const account = acctState.accounts.find(a => a.id === acctState.activeAccountId);

  const titleEl = document.getElementById('acct-tx-title');
  if (account) {
    const colorHex = colorHexFromCls(account.color || ACCT_COLORS[0].cls);
    titleEl.innerHTML = `<i class="fas fa-list-ul" style="color:${colorHex}"></i> ${acctEsc(account.name)}　の取引明細`;
  } else {
    titleEl.innerHTML = '<i class="fas fa-list-ul"></i> 取引明細';
  }

  // 取引追加ボタンの有効化
  const addBtn = document.getElementById('add-acct-tx-btn');
  if (addBtn) addBtn.disabled = !account;

  // 相手口座セレクト更新
  updateRelatedAccountSelect();

  if (!account) {
    document.getElementById('acct-tx-tbody').innerHTML = '';
    document.getElementById('no-acct-tx-msg').style.display = 'block';
    document.getElementById('acct-tx-pagination').innerHTML = '';
    return;
  }

  // 対象口座の取引を絞り込み
  let txs = acctState.transactions.filter(t => t.account_id === acctState.activeAccountId);
  if (acctState.txTypeFilter) {
    txs = txs.filter(t => t.type === acctState.txTypeFilter);
  }

  // サマリーバー
  renderTxSummaryBar(txs);

  // ページング
  const total      = txs.length;
  const totalPages = Math.max(1, Math.ceil(total / ACCT_TX_PER_PAGE));
  if (acctState.txPage > totalPages) acctState.txPage = totalPages;
  const start  = (acctState.txPage - 1) * ACCT_TX_PER_PAGE;
  const paged  = txs.slice(start, start + ACCT_TX_PER_PAGE);

  const tbody = document.getElementById('acct-tx-tbody');
  const noMsg = document.getElementById('no-acct-tx-msg');

  if (paged.length === 0) {
    tbody.innerHTML = '';
    noMsg.style.display = 'block';
  } else {
    noMsg.style.display = 'none';
    tbody.innerHTML = paged.map(tx => {
      const info      = TX_TYPE_LABELS[tx.type] || TX_TYPE_LABELS.deposit;
      const isDebit   = tx.type === 'withdrawal' || tx.type === 'transfer_out';
      const debitCell = isDebit
        ? `<td class="text-right acct-tx-debit" data-label="出金">−${acctFormatYen(tx.amount)}</td><td class="text-right" data-label="入金">—</td>`
        : `<td class="text-right" data-label="出金">—</td><td class="text-right acct-tx-credit" data-label="入金">+${acctFormatYen(tx.amount)}</td>`;
      const relatedAcct = tx.related_account_id
        ? (acctState.accounts.find(a => a.id === tx.related_account_id) || {}).name || ''
        : '';
      const hasIncomeLink  = !!tx.linked_income_tx_id || !!tx.linked_tx_id;
      const hasExpenseLink  = !!tx.linked_expense_tx_id;
      const linkedBadge = (hasIncomeLink || hasExpenseLink)
        ? `<span class="acct-tx-linked-badge" title="家計簿へ自動連携済み"><i class="fas fa-link"></i>家計簿${(hasIncomeLink && hasExpenseLink) ? '入出金' : (hasIncomeLink ? '収入' : '支出')}</span>`
        : '';
      const descText = [tx.description, relatedAcct ? `(${relatedAcct})` : ''].filter(Boolean).join(' ');

      return `
        <tr>
          <td data-label="日付">${acctFormatDate(tx.date)}</td>
          <td data-label="種別">
            <span class="tx-type-badge ${info.cls}">
              <i class="fas ${info.icon}"></i> ${info.label}
            </span>
          </td>
          <td data-label="種類" style="color:var(--text-muted);font-size:13px;">${acctEsc(tx.category || '—')}</td>
          <td data-label="摘要" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;" title="${acctEsc(descText)}">${acctEsc(descText || '—')} ${linkedBadge}</td>
          ${debitCell}
          <td class="text-right acct-tx-balance" data-label="残高">${tx.balance_after != null ? acctFormatYen(tx.balance_after) : '—'}</td>
          <td class="text-center action-cell" data-label="操作">
            <div class="action-buttons">
              <button class="btn-icon edit" onclick="acctStartEditTx('${acctEsc(tx.id)}')" title="編集"><i class="fas fa-pen"></i></button>
              <button class="btn-icon delete" onclick="acctConfirmDeleteTx('${acctEsc(tx.id)}')" title="削除"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  renderAcTxPagination(totalPages);
}

/* ─── 取引合計サマリーバー ─── */
function renderTxSummaryBar(txs) {
  const totalIn  = txs.filter(t => t.type === 'deposit'    || t.type === 'transfer_in' ).reduce((s,t) => s + Number(t.amount), 0);
  const totalOut = txs.filter(t => t.type === 'withdrawal' || t.type === 'transfer_out').reduce((s,t) => s + Number(t.amount), 0);
  const txArea = document.getElementById('acct-tx-area');

  let bar = document.getElementById('acct-tx-summary-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'acct-tx-summary-bar';
    bar.className = 'acct-tx-summary-bar';
    const tableWrap = txArea.querySelector('.acct-tx-table-wrap');
    txArea.insertBefore(bar, tableWrap);
  }
  bar.innerHTML = `
    <span>取引件数：<strong>${txs.length}件</strong></span>
    <span style="color:var(--income)">入金合計：<strong>${acctFormatYen(totalIn)}</strong></span>
    <span style="color:var(--expense)">出金合計：<strong>${acctFormatYen(totalOut)}</strong></span>
    <span>差引：<strong style="color:${(totalIn-totalOut)>=0?'var(--income)':'var(--expense)'}">${acctFormatYen(totalIn-totalOut)}</strong></span>
  `;
}

/* ─── 取引ページネーション ─── */
function renderAcTxPagination(totalPages) {
  const pg = document.getElementById('acct-tx-pagination');
  if (totalPages <= 1) { pg.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="acctGoToTxPage(${acctState.txPage-1})" ${acctState.txPage===1?'disabled':''}><i class="fas fa-chevron-left"></i></button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - acctState.txPage) <= 2) {
      html += `<button class="page-btn${i===acctState.txPage?' active':''}" onclick="acctGoToTxPage(${i})">${i}</button>`;
    } else if (Math.abs(i - acctState.txPage) === 3) {
      html += `<span class="page-btn" style="pointer-events:none">…</span>`;
    }
  }
  html += `<button class="page-btn" onclick="acctGoToTxPage(${acctState.txPage+1})" ${acctState.txPage===totalPages?'disabled':''}><i class="fas fa-chevron-right"></i></button>`;
  pg.innerHTML = html;
}

function acctGoToTxPage(p) {
  acctState.txPage = p;
  renderAccountTxArea();
}

/* ─────────────────────────────────────────
   口座追加フォーム
───────────────────────────────────────── */
function renderColorPicker() {
  const row = document.getElementById('color-picker-row');
  row.innerHTML = ACCT_COLORS.map(c => `
    <div class="color-dot${c.cls === acctState.selectedColor ? ' selected' : ''}"
         style="background:${c.hex}"
         data-cls="${c.cls}"
         onclick="acctSelectColor('${c.cls}')">
    </div>
  `).join('');
}

function acctSelectColor(cls) {
  acctState.selectedColor = cls;
  renderColorPicker();
}

function showAccountForm(show = true) {
  const card = document.getElementById('acct-form-card');
  card.style.display = show ? 'block' : 'none';
  if (show) {
    renderColorPicker();
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function resetAccountForm() {
  acctState.editingAcctId = null;
  acctState.selectedColor = ACCT_COLORS[0].cls;
  document.getElementById('account-form').reset();
  document.getElementById('acct-edit-id').value = '';
  document.getElementById('acct-form-title').innerHTML = '<i class="fas fa-plus-circle"></i> 口座を追加';
  document.getElementById('acct-submit-btn').innerHTML = '<i class="fas fa-check"></i> 登録する';
  const hint = document.getElementById('acct-initial-hint');
  if (hint) hint.style.display = 'none';
  renderColorPicker();
}

function acctStartEditAccount(id) {
  const a = acctState.accounts.find(a => a.id === id);
  if (!a) return;

  acctState.editingAcctId = id;
  acctState.selectedColor = a.color || ACCT_COLORS[0].cls;

  document.getElementById('acct-edit-id').value    = id;
  document.getElementById('acct-bank').value       = a.bank_name || '';
  document.getElementById('acct-name').value       = a.name || '';
  document.getElementById('acct-type').value       = a.account_type || '普通';
  document.getElementById('acct-initial').value    = Number(a.initial_balance) || 0;
  document.getElementById('acct-note').value       = a.note || '';
  document.getElementById('acct-form-title').innerHTML = '<i class="fas fa-pen"></i> 口座を編集';
  document.getElementById('acct-submit-btn').innerHTML = '<i class="fas fa-pen"></i> 更新する';

  updateInitialBalanceHint();
  showAccountForm(true);
}

/** 口座明細の合計 (入金 − 出金) */
function sumAccountTxs(accountId) {
  return acctState.transactions
    .filter(t => t.account_id === accountId)
    .reduce((s, t) => s + ((t.type === 'withdrawal' || t.type === 'transfer_out') ? -Number(t.amount || 0) : Number(t.amount || 0)), 0);
}

/**
 * 初期残高欄の下に「保存後の残高 = 初期残高 + 明細合計」を表示する。
 * 現在の残高と変わる場合は警告色で差額を示す (旧データで初期残高が未設定のまま編集して残高が消える事故を防ぐ)。
 */
function updateInitialBalanceHint() {
  const hint = document.getElementById('acct-initial-hint');
  if (!hint) return;
  const account = acctState.editingAcctId ? acctState.accounts.find(a => a.id === acctState.editingAcctId) : null;
  if (!account) { hint.style.display = 'none'; return; }

  const initial = Kakeibo.toYen(document.getElementById('acct-initial').value || '0');
  const txSum   = sumAccountTxs(account.id);
  const after   = initial + txSum;
  const current = Number(account.balance) || 0;
  const diff    = after - current;

  let html = `保存後の残高: <strong>${acctFormatYen(after)}</strong>（初期残高 ${acctFormatYen(initial)} + 明細合計 ${txSum < 0 ? '−' : '+'}${acctFormatYen(Math.abs(txSum))}）`;
  if (diff !== 0) {
    html += `<br>現在の残高 ${acctFormatYen(current)} から <strong>${diff > 0 ? '+' : '−'}${acctFormatYen(Math.abs(diff))}</strong> 変わります。`
         + ` 現在の残高を維持するには初期残高を <strong>${acctFormatYen(current - txSum)}</strong> にしてください。`;
    hint.className = 'form-hint warn';
  } else {
    hint.className = 'form-hint';
  }
  hint.innerHTML = html;
  hint.style.display = 'block';
}

async function handleAccountFormSubmit(e) {
  e.preventDefault();
  const bankName      = document.getElementById('acct-bank').value.trim();
  const name          = document.getElementById('acct-name').value.trim();
  const accountType   = document.getElementById('acct-type').value;
  const initialBalance = Kakeibo.toYen(document.getElementById('acct-initial').value || '0');
  const note          = document.getElementById('acct-note').value.trim();
  const color         = acctState.selectedColor;

  if (!bankName || !name) {
    acctShowToast('銀行名と口座名称を入力してください', 'error'); return;
  }

  // 編集で残高が変わる場合は確認する (初期残高の変更は残高の再計算に直結するため)
  if (acctState.editingAcctId) {
    const account = acctState.accounts.find(a => a.id === acctState.editingAcctId);
    if (account) {
      const current = Number(account.balance) || 0;
      const after   = initialBalance + sumAccountTxs(account.id);
      if (after !== current) {
        const ok = confirm(
          `初期残高を ${acctFormatYen(initialBalance)} にすると、口座残高が\n` +
          `  ${acctFormatYen(current)} → ${acctFormatYen(after)}\n` +
          `に変わります（初期残高 + 取引明細の合計で再計算されます）。\n\n` +
          `よろしいですか？\n（現在の残高を維持する場合はキャンセルし、初期残高を ${acctFormatYen(current - sumAccountTxs(account.id))} にしてください）`
        );
        if (!ok) return;
      }
    }
  }

  const btn = document.getElementById('acct-submit-btn');
  btn.disabled = true;

  try {
    if (acctState.editingAcctId) {
      // balance はサーバー側の再計算で決まるので送らない (初期残高の変更も明細に反映される)
      const data = { name, bank_name: bankName, account_type: accountType,
                     initial_balance: initialBalance, color, note };
      await acctPut(`${ACCT_TABLE}/${acctState.editingAcctId}`, data);
      acctShowToast('口座情報を更新しました ✏️');
    } else {
      const data = { name, bank_name: bankName, account_type: accountType,
                     balance: initialBalance, initial_balance: initialBalance, color, note };
      const created = await acctPost(ACCT_TABLE, data);
      acctState.activeAccountId = created.id;
      acctShowToast('口座を登録しました 🏦');
    }
    await acctRecalculateAndReload();

    resetAccountForm();
    showAccountForm(false);
    renderSummaryCards();
    renderAccountCardsList();
    renderAccountTxArea();

  } catch (err) {
    console.error(err);
    acctShowToast('保存に失敗しました', 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ─── 口座削除 ─── */
function acctConfirmDeleteAccount(id) {
  const a = acctState.accounts.find(a => a.id === id);
  if (!a) return;
  if (!confirm(`「${a.name}」を削除しますか？\n関連する取引明細・家計簿への連携データ・相手口座側の振込明細も削除されます。`)) return;
  acctDeleteAccount(id);
}

async function acctDeleteAccount(id) {
  try {
    const own = acctState.transactions.filter(t => t.account_id === id);
    // この口座を相手とする振込明細 (相手口座側) も削除しないと孤立して残高がずれる
    const ownIds = new Set(own.map(t => t.id));
    const mirrored = acctState.transactions.filter(t =>
      t.account_id !== id && (t.related_account_id === id || ownIds.has(t.paired_tx_id)));

    for (const t of own) {
      await deleteLinkedKakeibo(t);
      await acctDeleteIfExists(`${ACCT_TX_TABLE}/${t.id}`);
    }
    for (const t of mirrored) {
      await acctDeleteIfExists(`${ACCT_TX_TABLE}/${t.id}`);
    }
    await acctDelete(`${ACCT_TABLE}/${id}`);

    if (acctState.activeAccountId === id) acctState.activeAccountId = null;
    await acctRecalculateAndReload();
    if (!acctState.activeAccountId) acctState.activeAccountId = acctState.accounts[0]?.id || null;

    acctShowToast('口座を削除しました 🗑️');
    renderAfterAccountChange();
  } catch (err) {
    console.error(err);
    acctShowToast('削除に失敗しました', 'error');
    // 途中まで削除された可能性があるので最新状態を表示
    try { await acctRecalculateAndReload(); renderAfterAccountChange(); } catch { /* ignore */ }
  }
}

/** 口座・明細変更後の再描画 (家計簿側の表示も更新) */
function renderAfterAccountChange() {
  renderSummaryCards();
  renderAccountCardsList();
  renderAccountTxArea();
  if (typeof renderMonthlySummaryBar === 'function') renderMonthlySummaryBar();
}

/** 口座明細に連携している家計簿 (transactions) を削除 */
async function deleteLinkedKakeibo(tx) {
  const linkedIds = [tx.linked_income_tx_id, tx.linked_expense_tx_id, tx.linked_tx_id].filter(Boolean);
  for (const lid of linkedIds) {
    try { await kakeiboDelete(lid); } catch (e) { if (e.status !== 404) throw e; }
    removeKakeiboState(lid);
  }
}

/**
 * 振込明細の相手口座側の対取引を探す。
 * v1.2.0 以降は paired_tx_id で双方向に紐づく。旧データは日付・金額・相手口座で推定する。
 */
function findPairedTx(tx) {
  if (!tx || !isTransferType(tx.type) || !tx.related_account_id) return null;
  if (tx.paired_tx_id) {
    const p = acctState.transactions.find(t => t.id === tx.paired_tx_id);
    if (p) return p;
  }
  const mirrorType = tx.type === 'transfer_out' ? 'transfer_in' : 'transfer_out';
  return acctState.transactions.find(t =>
    t.account_id === tx.related_account_id &&
    t.related_account_id === tx.account_id &&
    t.type === mirrorType &&
    t.date === tx.date &&
    Number(t.amount) === Number(tx.amount) &&
    (!t.paired_tx_id || t.paired_tx_id === tx.id)) || null;
}

/* ─────────────────────────────────────────
   取引追加フォーム
───────────────────────────────────────── */
function showTxForm(show = true) {
  document.getElementById('acct-tx-form-wrap').style.display = show ? 'block' : 'none';
  if (show) {
    document.getElementById('acct-tx-form-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function resetTxForm() {
  acctState.editingTxId = null;
  document.getElementById('acct-tx-form').reset();
  document.getElementById('acct-tx-edit-id').value = '';
  document.getElementById('acct-tx-date').value = acctToday();
  document.getElementById('acct-tx-link-mode').value = String(LINK_MODE_NONE);
  document.getElementById('acct-tx-submit-btn').innerHTML = '<i class="fas fa-check"></i> 登録する';
  toggleRelatedAccountField('withdrawal');
  toggleLinkSelectField('withdrawal');
}

function updateRelatedAccountSelect() {
  const sel     = document.getElementById('acct-tx-related');
  const others  = acctState.accounts.filter(a => a.id !== acctState.activeAccountId);
  sel.innerHTML = '<option value="">選択...</option>' +
    others.map(a => `<option value="${acctEsc(a.id)}">${acctEsc(a.bank_name || '')} ${acctEsc(a.name)}</option>`).join('');
}

function toggleRelatedAccountField(type) {
  const grp = document.getElementById('acct-tx-related-group');
  const show = type === 'transfer_in' || type === 'transfer_out';
  grp.style.display = show ? 'block' : 'none';
}

function toggleLinkSelectField(type) {
  const grp = document.getElementById('acct-tx-link-kakeibo-wrap');
  if (grp) grp.style.display = type === 'withdrawal' ? 'block' : 'none';
}

function acctStartEditTx(id) {
  const tx = acctState.transactions.find(t => t.id === id);
  if (!tx) return;

  acctState.editingTxId = id;
  document.getElementById('acct-tx-edit-id').value   = id;
  document.getElementById('acct-tx-date').value      = tx.date;
  document.getElementById('acct-tx-type').value      = tx.type;
  document.getElementById('acct-tx-amount').value    = tx.amount;
  document.getElementById('acct-tx-category').value  = tx.category || '';
  document.getElementById('acct-tx-desc').value      = tx.description || '';
  document.getElementById('acct-tx-related').value   = tx.related_account_id || '';
  document.getElementById('acct-tx-link-mode').value   = String(tx.link_mode || LINK_MODE_NONE);
  document.getElementById('acct-tx-submit-btn').innerHTML = '<i class="fas fa-pen"></i> 更新する';
  toggleRelatedAccountField(tx.type);
  toggleLinkSelectField(tx.type);
  showTxForm(true);
}

async function handleTxFormSubmit(e) {
  e.preventDefault();
  const account = acctState.accounts.find(a => a.id === acctState.activeAccountId);
  if (!account) { acctShowToast('口座が選択されていません', 'error'); return; }

  const date             = document.getElementById('acct-tx-date').value;
  const type             = document.getElementById('acct-tx-type').value;
  const amount           = Kakeibo.toYen(document.getElementById('acct-tx-amount').value || '0');
  const category         = document.getElementById('acct-tx-category').value.trim();
  const description      = document.getElementById('acct-tx-desc').value.trim();
  const relatedAccountId = document.getElementById('acct-tx-related').value || '';
  const linkMode         = getLinkMode(type);

  if (!date)   { acctShowToast('日付を入力してください', 'error'); return; }
  if (!amount || amount <= 0) { acctShowToast('金額を入力してください', 'error'); return; }
  const isTransfer = isTransferType(type);
  if (isTransfer && !relatedAccountId) { acctShowToast('振込の相手口座を選択してください', 'error'); return; }
  if (isTransfer && relatedAccountId === account.id) { acctShowToast('相手口座に同じ口座は指定できません', 'error'); return; }

  const isDebit    = type === 'withdrawal' || type === 'transfer_out';
  const oldTx      = acctState.editingTxId ? acctState.transactions.find(t => t.id === acctState.editingTxId) : null;
  const oldPaired  = oldTx ? findPairedTx(oldTx) : null;

  // 残高 (balance_after / bank_accounts.balance) は保存後にサーバーで再計算する
  const txData = {
    account_id: acctState.activeAccountId,
    date, type, amount, category, description,
    related_account_id: isTransfer ? relatedAccountId : '',
    link_mode: linkMode,
    linked_income_tx_id: '',
    linked_expense_tx_id: '',
  };

  // 家計簿連携: 種類名を収入カテゴリ(および支出カテゴリ)として使用
  const kakeiboIncomeCategory  = category || KAKEIBO_INCOME_CATEGORY_FALLBACK;
  const kakeiboExpenseCategory = category || KAKEIBO_EXPENSE_CATEGORY_FALLBACK;
  const kakeiboMemo = `${account.name}より${description ? ' / ' + description : ''}`;

  // 収入/支出カテゴリに未登録なら即時追加
  if (typeof state !== 'undefined') {
    if (linkMode >= LINK_MODE_INCOME && state.incomeCategories && !state.incomeCategories.includes(kakeiboIncomeCategory)) {
      state.incomeCategories.push(kakeiboIncomeCategory);
    }
    if (linkMode === LINK_MODE_INCOME_EXPENSE && state.expenseCategories && !state.expenseCategories.includes(kakeiboExpenseCategory)) {
      state.expenseCategories.push(kakeiboExpenseCategory);
    }
  }

  let linkedIncomeTxId = '';
  let linkedExpenseTxId = '';

  const btn = document.getElementById('acct-tx-submit-btn');
  btn.disabled = true;

  try {
    if (acctState.editingTxId) {
      // 編集: 旧連携取引を調整
      const oldIncomeId  = oldTx?.linked_income_tx_id || oldTx?.linked_tx_id || '';
      const oldExpenseId = oldTx?.linked_expense_tx_id || '';

      // 収入連携
      if (linkMode >= LINK_MODE_INCOME) {
        const kakeiboIncomeData = {
          date, amount, type: 'income',
          category: kakeiboIncomeCategory,
          memo: kakeiboMemo,
        };
        if (oldIncomeId) {
          const updated = await kakeiboPut(oldIncomeId, kakeiboIncomeData);
          linkedIncomeTxId = oldIncomeId;
          syncKakeiboState(oldIncomeId, updated);
        } else {
          const created = await kakeiboPost(kakeiboIncomeData);
          linkedIncomeTxId = created.id;
          pushKakeiboState(created);
        }
      } else if (oldIncomeId) {
        await kakeiboDelete(oldIncomeId);
        removeKakeiboState(oldIncomeId);
      }

      // 支出連携
      if (linkMode === LINK_MODE_INCOME_EXPENSE) {
        const kakeiboExpenseData = {
          date, amount, type: 'expense',
          category: kakeiboExpenseCategory,
          memo: kakeiboMemo,
        };
        if (oldExpenseId) {
          const updated = await kakeiboPut(oldExpenseId, kakeiboExpenseData);
          linkedExpenseTxId = oldExpenseId;
          syncKakeiboState(oldExpenseId, updated);
        } else {
          const created = await kakeiboPost(kakeiboExpenseData);
          linkedExpenseTxId = created.id;
          pushKakeiboState(created);
        }
      } else if (oldExpenseId) {
        await kakeiboDelete(oldExpenseId);
        removeKakeiboState(oldExpenseId);
      }

      txData.linked_income_tx_id  = linkedIncomeTxId;
      txData.linked_expense_tx_id = linkedExpenseTxId;

      const savedId = acctState.editingTxId;
      await acctPut(`${ACCT_TX_TABLE}/${savedId}`, txData);
      await syncTransferPair(savedId, txData, oldPaired);
      acctShowToast('取引を更新しました ✏️');
    } else {
      // 新規作成
      if (linkMode >= LINK_MODE_INCOME) {
        const kakeiboIncomeData = {
          date, amount, type: 'income',
          category: kakeiboIncomeCategory,
          memo: kakeiboMemo,
        };
        const created = await kakeiboPost(kakeiboIncomeData);
        linkedIncomeTxId = created.id;
        pushKakeiboState(created);
      }
      if (linkMode === LINK_MODE_INCOME_EXPENSE) {
        const kakeiboExpenseData = {
          date, amount, type: 'expense',
          category: kakeiboExpenseCategory,
          memo: kakeiboMemo,
        };
        const created = await kakeiboPost(kakeiboExpenseData);
        linkedExpenseTxId = created.id;
        pushKakeiboState(created);
      }

      txData.linked_income_tx_id  = linkedIncomeTxId;
      txData.linked_expense_tx_id = linkedExpenseTxId;

      const created = await acctPost(ACCT_TX_TABLE, txData);
      await syncTransferPair(created.id, txData, null);
      const linkLabel = linkMode === LINK_MODE_NONE ? '' : (linkMode === LINK_MODE_INCOME ? '（家計簿収入へ連携）' : '（家計簿入出金へ連携）');
      acctShowToast(`${isTransfer ? '振込' : (isDebit ? '出金' : '入金')}を登録しました${linkLabel}`);
    }

    // 全口座の残高・取引後残高をサーバーで再計算 (振込の相手口座も含む)
    await acctRecalculateAndReload();

    resetTxForm();
    showTxForm(false);
    renderAfterAccountChange();

  } catch (err) {
    acctShowToast('保存に失敗しました', 'error');
    console.error(err);
    try { await acctRecalculateAndReload(); renderAfterAccountChange(); } catch { /* ignore */ }
  } finally {
    btn.disabled = false;
  }
}

/**
 * 振込明細の相手口座側の対取引を作成/更新/削除して双方向に紐づける。
 * @param {string} txId     保存した自口座側の明細 ID
 * @param {object} txData   保存した内容
 * @param {object|null} oldPaired 編集前の対取引 (新規時は null)
 */
async function syncTransferPair(txId, txData, oldPaired) {
  const needPair = isTransferType(txData.type) && txData.related_account_id;
  if (!needPair) {
    if (oldPaired) await acctDeleteIfExists(`${ACCT_TX_TABLE}/${oldPaired.id}`);
    await acctPut(`${ACCT_TX_TABLE}/${txId}`, { paired_tx_id: '' });
    return;
  }
  const pairData = {
    account_id: txData.related_account_id,
    date: txData.date,
    type: txData.type === 'transfer_out' ? 'transfer_in' : 'transfer_out',
    amount: txData.amount,
    category: txData.category,
    description: txData.description,
    related_account_id: txData.account_id,
    link_mode: LINK_MODE_NONE,
    paired_tx_id: txId,
  };
  let pairId;
  if (oldPaired) {
    await acctPut(`${ACCT_TX_TABLE}/${oldPaired.id}`, pairData);
    pairId = oldPaired.id;
  } else {
    const created = await acctPost(ACCT_TX_TABLE, pairData);
    pairId = created.id;
  }
  await acctPut(`${ACCT_TX_TABLE}/${txId}`, { paired_tx_id: pairId });
}

/* ─── 取引削除 ─── */
function acctConfirmDeleteTx(id) {
  const tx = acctState.transactions.find(t => t.id === id);
  if (!tx) return;
  const paired = findPairedTx(tx);
  const msg = paired
    ? 'この振込を削除しますか？\n相手口座側の振込明細も削除され、両口座の残高が再計算されます。'
    : 'この取引を削除しますか？\n口座残高も再計算されます。';
  if (!confirm(msg)) return;
  acctDeleteTx(id);
}

async function acctDeleteTx(id) {
  const tx = acctState.transactions.find(t => t.id === id);
  if (!tx) return;

  try {
    const paired = findPairedTx(tx);
    // 家計簿連携取引があれば削除(収入・支出の2件)
    await deleteLinkedKakeibo(tx);
    await acctDeleteIfExists(`${ACCT_TX_TABLE}/${id}`);
    if (paired) await acctDeleteIfExists(`${ACCT_TX_TABLE}/${paired.id}`);

    await acctRecalculateAndReload();
    acctShowToast('取引を削除しました 🗑️');
    renderAfterAccountChange();
  } catch (err) {
    console.error(err);
    acctShowToast('削除に失敗しました', 'error');
    try { await acctRecalculateAndReload(); renderAfterAccountChange(); } catch { /* ignore */ }
  }
}

/** 残高再計算ボタン (データ不整合の復旧用) */
async function acctManualRecalculate() {
  if (!confirm('全口座の残高を「初期残高 + 取引明細」から再計算します。よろしいですか？')) return;
  try {
    const before = Object.fromEntries(acctState.accounts.map(a => [a.id, Number(a.balance) || 0]));
    await acctRecalculateAndReload();
    const changed = acctState.accounts.filter(a => before[a.id] !== (Number(a.balance) || 0)).length;
    acctShowToast(changed ? `${changed} 口座の残高を補正しました` : '残高に差異はありませんでした', changed ? 'info' : 'success');
    renderAfterAccountChange();
  } catch (err) {
    console.error(err);
    acctShowToast('再計算に失敗しました', 'error');
  }
}

/* ─────────────────────────────────────────
   トースト（app.js の showToast と共存）
───────────────────────────────────────── */
function acctShowToast(msg, type = 'success') {
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', info: 'fa-info-circle' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${acctEsc(msg)}`;
  const container = document.getElementById('toast-container');
  if (container) container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

/* ─────────────────────────────────────────
   イベントバインド（DOMContentLoaded後）
───────────────────────────────────────── */
function bindAccountEvents() {
  // 口座追加ボタン
  document.getElementById('show-add-acct-btn').addEventListener('click', () => {
    resetAccountForm();
    showAccountForm(true);
  });

  // フォームを閉じるボタン
  document.getElementById('acct-form-close-btn').addEventListener('click', () => {
    resetAccountForm();
    showAccountForm(false);
  });
  document.getElementById('acct-cancel-btn').addEventListener('click', () => {
    resetAccountForm();
    showAccountForm(false);
  });

  // 口座フォーム送信
  document.getElementById('account-form').addEventListener('submit', handleAccountFormSubmit);
  // 初期残高の入力に合わせて「保存後の残高」ヒントを更新
  document.getElementById('acct-initial').addEventListener('input', updateInitialBalanceHint);

  // 取引追加ボタン
  document.getElementById('add-acct-tx-btn').addEventListener('click', () => {
    if (!acctState.activeAccountId) return;
    resetTxForm();
    showTxForm(true);
  });

  // 取引フォームキャンセル
  document.getElementById('acct-tx-cancel-btn').addEventListener('click', () => {
    resetTxForm();
    showTxForm(false);
  });

  // 取引フォーム送信
  document.getElementById('acct-tx-form').addEventListener('submit', handleTxFormSubmit);

  // 取引種別変更 → 相手口座フィールド切替 + 連携セレクト切替
  document.getElementById('acct-tx-type').addEventListener('change', e => {
    toggleRelatedAccountField(e.target.value);
    toggleLinkSelectField(e.target.value);
  });

  // 残高再計算
  document.getElementById('acct-recalc-btn')?.addEventListener('click', acctManualRecalculate);

  // 取引フィルター
  document.getElementById('acct-tx-filter-type').addEventListener('change', e => {
    acctState.txTypeFilter = e.target.value;
    acctState.txPage = 1;
    renderAccountTxArea();
  });
}

/* ─────────────────────────────────────────
   初期化 (DOMContentLoaded)
───────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  bindAccountEvents();
});
