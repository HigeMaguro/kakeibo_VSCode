/**
 * MyKakeibo - 家計簿アプリ メインスクリプト
 * 自宅サーバー向け静的ウェブアプリ
 */

'use strict';

// ===================================================
// 定数・設定
// ===================================================
const API_BASE = 'tables';
const TABLE_TX  = 'transactions';
const TABLE_BDG = 'budgets';
const ITEMS_PER_PAGE = 15;

const EXPENSE_CATEGORIES_DEFAULT = ['食費','交通費','光熱費','通信費','日用品','医療費','娯楽','衣服','外食','教育','保険','住居','その他'];
const INCOME_CATEGORIES_DEFAULT  = ['給与','副業','ボーナス','投資','銀行ATM','その他収入'];

const CATEGORY_ICONS = {
  '食費':'🍚','交通費':'🚃','光熱費':'💡','通信費':'📱','日用品':'🧹',
  '医療費':'💊','娯楽':'🎮','衣服':'👕','外食':'🍜','教育':'📚',
  '保険':'🛡️','住居':'🏠','その他':'📦','給与':'💼','副業':'💻',
  'ボーナス':'🎁','投資':'📈','銀行ATM':'🏧','その他収入':'💰'
};

// ===================================================
// アプリケーション状態
// ===================================================
const state = {
  currentPage: 'dashboard',
  currentYear: new Date().getFullYear(),
  currentMonth: new Date().getMonth() + 1,
  allTransactions: [],
  allBudgets: [],
  openingCashBalances: {}, // { 'YYYY-MM': amount }
  txPage: 1,
  txFilter: { type: '', category: '', search: '' },
  editingTxId: null,
  deletingTxId: null,
  editingBudgetId: null,
  expenseCategories: [...EXPENSE_CATEGORIES_DEFAULT],
  incomeCategories:  [...INCOME_CATEGORIES_DEFAULT],
  inputType: 'expense',
  expenseFilter: '', // 支出明細ページのカテゴリ絞り込み
  appVersion: null,  // /api/version の結果 (ヘッダー表示とデータ管理で共用)
  charts: {},
};

const TABLE_SETTINGS = 'app_settings';

// ===================================================
// ユーティリティ
// ===================================================
/** innerHTML に埋め込むユーザー入力は必ず esc() を通す (js/common.js) */
const esc = Kakeibo.escapeHtml;

function formatYen(amount) {
  return Kakeibo.formatYen(amount);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${y}/${m}/${d}`;
}

function getMonthKey(y, m) {
  return `${y}-${String(m).padStart(2,'0')}`;
}

function getMonthLabel(y, m) {
  return `${y}年${m}月`;
}

function getCategoryIcon(cat) {
  return CATEGORY_ICONS[cat] || '💴';
}

function todayString() {
  return Kakeibo.localDateString();
}

function showToast(message, type = 'success') {
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', info: 'fa-info-circle' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${esc(message)}`;
  document.getElementById('toast-container').appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

async function apiGet(table, params = {}) {
  const qs = new URLSearchParams({ limit: 500, ...params }).toString();
  const res = await fetch(`${API_BASE}/${table}?${qs}`);
  if (!res.ok) throw new Error('データ取得失敗');
  return await res.json();
}

async function apiPost(table, data) {
  const res = await fetch(`${API_BASE}/${table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('登録失敗');
  return await res.json();
}

async function apiPut(table, id, data) {
  const res = await fetch(`${API_BASE}/${table}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('更新失敗');
  return await res.json();
}

async function apiDelete(table, id) {
  const res = await fetch(`${API_BASE}/${table}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('削除失敗');
}

// ===================================================
// 開始時現金残高 (app_settings)
// ===================================================
const OPENING_CASH_KEY_PREFIX = 'opening_cash_';

function openingCashKey(y, m) {
  return OPENING_CASH_KEY_PREFIX + getMonthKey(y, m);
}

async function loadOpeningCashBalances() {
  try {
    const rows = await Kakeibo.fetchAllRows(TABLE_SETTINGS);
    rows.forEach(row => {
      if (row.key && row.key.startsWith(OPENING_CASH_KEY_PREFIX)) {
        state.openingCashBalances[row.key] = parseFloat(row.value) || 0;
      }
    });
  } catch (e) {
    // 読み込み失敗は無視
  }
}

function getOpeningCash(y, m) {
  return state.openingCashBalances[openingCashKey(y, m)] || 0;
}

function isOpeningCashSaved(y, m) {
  const key = openingCashKey(y, m);
  return Object.prototype.hasOwnProperty.call(state.openingCashBalances, key);
}

/** 前月の開始残高 + 前月収入 - 前月支出 を計算して繰越額を返す */
function computeCarriedOverCash(y, m) {
  let pm = m - 1, py = y;
  if (pm < 1) { pm = 12; py--; }
  const prevOpening = getOpeningCash(py, pm) || 0;
  const txs = getMonthTransactions(py, pm);
  const income  = txs.filter(t => t.type === 'income').reduce((s,t) => s + Number(t.amount), 0);
  const expense = txs.filter(t => t.type === 'expense').reduce((s,t) => s + Number(t.amount), 0);
  return prevOpening + income - expense;
}

async function saveOpeningCash(y, m, amount) {
  const key = openingCashKey(y, m);
  const value = String(amount);
  try {
    // 既存レコード検索
    const res = await apiGet(TABLE_SETTINGS, { key, limit: 10 });
    const existing = (res.data || []).find(r => r.key === key);
    if (existing) {
      await apiPut(TABLE_SETTINGS, existing.id, { key, value, updated_at: Date.now() });
    } else {
      await apiPost(TABLE_SETTINGS, { key, value });
    }
    state.openingCashBalances[key] = amount;
    return true;
  } catch (e) {
    return false;
  }
}

// ===================================================
// データ読み込み
// ===================================================
async function loadAllData() {
  try {
    // 全件取得 (旧実装は limit=500 で古いデータが集計から欠落していた)
    const [txRows, bdgRows] = await Promise.all([
      Kakeibo.fetchAllRows(TABLE_TX),
      Kakeibo.fetchAllRows(TABLE_BDG),
    ]);
    state.allTransactions = txRows;
    state.allBudgets      = bdgRows;
    // ユーザー追加カテゴリをマージ
    state.allTransactions.forEach(tx => {
      if (tx.type === 'expense' && !state.expenseCategories.includes(tx.category)) {
        state.expenseCategories.push(tx.category);
      }
      if (tx.type === 'income' && !state.incomeCategories.includes(tx.category)) {
        state.incomeCategories.push(tx.category);
      }
    });
    await loadOpeningCashBalances();
  } catch (e) {
    showToast('データの読み込みに失敗しました', 'error');
  }
}

// ===================================================
// ページナビゲーション
// ===================================================
function navigateTo(pageName, skipHistory = false) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

  const target = document.getElementById(`page-${pageName}`);
  if (target) target.classList.add('active');

  const navLink = document.querySelector(`.nav-link[data-page="${pageName}"]`);
  if (navLink) navLink.classList.add('active');

  const titles = {
    dashboard:    'ダッシュボード',
    transactions: '収支一覧',
    input:        '収支を入力',
    budget:       '予算管理',
    analysis:     '分析',
    expenses:     '支出明細',
    accounts:     '預金口座管理',
    datamanage:   'データ管理',
  };
  document.getElementById('page-title').textContent = titles[pageName] || '';
  state.currentPage = pageName;

  // モバイルサイドバー閉じる
  closeMobileSidebar();

  // ページ固有の初期化
  refreshCurrentPage();
}

function refreshCurrentPage() {
  // 共通月次サマリーバーを毎回更新（全ページ表示）
  renderMonthlySummaryBar();
  switch (state.currentPage) {
    case 'dashboard':    renderDashboard(); break;
    case 'transactions': renderTransactions(); break;
    case 'input':        renderInputForm(); break;
    case 'budget':       renderBudget(); break;
    case 'analysis':     renderAnalysis(); break;
    case 'expenses':     renderExpensesPage(); break;
    case 'accounts':
      if (typeof renderAccountsPage === 'function') {
        renderAccountsPage().catch(err => {
          console.error(err);
          showToast('口座データの読み込みに失敗しました', 'error');
        });
      }
      break;
    case 'datamanage':   if (typeof renderDataManagePage === 'function') renderDataManagePage(); break;
  }
}

// ===================================================
// 共通月次サマリーバー
// ===================================================
function renderMonthlySummaryBar() {
  const y = state.currentYear, m = state.currentMonth;
  const saved = isOpeningCashSaved(y, m);
  const opening = saved ? getOpeningCash(y, m) : computeCarriedOverCash(y, m);
  const txs = getMonthTransactions(y, m);
  const income  = txs.filter(t => t.type === 'income').reduce((s,t) => s + Number(t.amount), 0);
  const expense = txs.filter(t => t.type === 'expense').reduce((s,t) => s + Number(t.amount), 0);
  const balance = opening + income - expense;

  const elOpening = document.getElementById('msb-opening');
  const elIncome  = document.getElementById('msb-income');
  const elExpense = document.getElementById('msb-expense');
  const elBalance = document.getElementById('msb-balance');
  if (elOpening) elOpening.textContent = formatYen(opening);
  if (elIncome)  elIncome.textContent  = '+' + formatYen(income);
  if (elExpense) elExpense.textContent = '-' + formatYen(expense);
  if (elBalance) {
    elBalance.textContent = formatYen(balance);
    elBalance.className = 'msb-value ' + (balance >= 0 ? 'income' : 'expense');
  }
}

// ===================================================
// 月選択
// ===================================================
function updateMonthLabel() {
  document.getElementById('current-month-label').textContent =
    getMonthLabel(state.currentYear, state.currentMonth);
}

function changeMonth(delta) {
  let m = state.currentMonth + delta;
  let y = state.currentYear;
  if (m > 12) { m = 1; y++; }
  if (m < 1)  { m = 12; y--; }
  state.currentMonth = m;
  state.currentYear  = y;
  updateMonthLabel();
  refreshCurrentPage();
}

// ===================================================
// ダッシュボード
// ===================================================
function getMonthTransactions(year, month) {
  const key = getMonthKey(year, month);
  return state.allTransactions.filter(tx => tx.date && tx.date.startsWith(key));
}

function renderDashboard() {
  const txs = getMonthTransactions(state.currentYear, state.currentMonth);
  renderCategoryChart(txs);
  renderTrendChart();
  renderRecentTransactions(txs);
}

function renderRecentTransactions(txs) {
  const sorted = [...txs].sort((a,b) => b.date.localeCompare(a.date)).slice(0, 7);
  const container = document.getElementById('recent-transactions');
  const noMsg = document.getElementById('no-recent-msg');

  if (sorted.length === 0) {
    container.innerHTML = '';
    noMsg.style.display = 'block';
    return;
  }
  noMsg.style.display = 'none';

  container.innerHTML = sorted.map(tx => `
    <div class="transaction-item">
      <div class="tx-icon ${tx.type}">${esc(getCategoryIcon(tx.category))}</div>
      <div class="tx-details">
        <div class="tx-category">${esc(tx.category)}</div>
        <div class="tx-meta">
          <span>${esc(formatDate(tx.date))}</span>
          ${tx.memo ? `<span>・${esc(tx.memo)}</span>` : ''}
        </div>
      </div>
      <div class="tx-amount ${tx.type}">
        ${tx.type === 'income' ? '+' : '-'}${formatYen(tx.amount)}
      </div>
    </div>
  `).join('');
}

function renderCategoryChart(txs) {
  const expenses = txs.filter(t => t.type === 'expense');
  const catMap = {};
  expenses.forEach(t => { catMap[t.category] = (catMap[t.category] || 0) + Number(t.amount); });

  const labels = Object.keys(catMap);
  const data   = Object.values(catMap);
  const noDataMsg = document.getElementById('no-category-data');

  if (labels.length === 0) {
    noDataMsg.style.display = 'block';
    if (state.charts.category) { state.charts.category.destroy(); state.charts.category = null; }
    return;
  }
  noDataMsg.style.display = 'none';

  const colors = generateColors(labels.length);
  const ctx = document.getElementById('categoryChart').getContext('2d');

  if (state.charts.category) state.charts.category.destroy();
  state.charts.category = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { font: { family: 'Noto Sans JP', size: 12 }, padding: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${formatYen(ctx.raw)} (${Math.round(ctx.parsed / data.reduce((a,b)=>a+b,0) * 100)}%)`
          }
        }
      }
    }
  });
}

function renderTrendChart() {
  const months = [];
  const incomeData = [];
  const expenseData = [];

  for (let i = 5; i >= 0; i--) {
    let m = state.currentMonth - i;
    let y = state.currentYear;
    while (m < 1) { m += 12; y--; }
    const txs = getMonthTransactions(y, m);
    months.push(`${m}月`);
    incomeData.push(txs.filter(t => t.type === 'income').reduce((s,t) => s+Number(t.amount), 0));
    expenseData.push(txs.filter(t => t.type === 'expense').reduce((s,t) => s+Number(t.amount), 0));
  }

  const ctx = document.getElementById('trendChart').getContext('2d');
  if (state.charts.trend) state.charts.trend.destroy();
  state.charts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: months,
      datasets: [
        { label: '収入', data: incomeData, borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', borderWidth: 2, pointRadius: 4, fill: true, tension: 0.4 },
        { label: '支出', data: expenseData, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', borderWidth: 2, pointRadius: 4, fill: true, tension: 0.4 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { family: 'Noto Sans JP', size: 12 } } } },
      scales: {
        y: { ticks: { callback: v => `¥${(v/10000).toFixed(0)}万`, font: { family: 'Noto Sans JP', size: 11 } } },
        x: { ticks: { font: { family: 'Noto Sans JP', size: 11 } } }
      }
    }
  });
}

// ===================================================
// 収支一覧
// ===================================================
function getFilteredTransactions() {
  let txs = getMonthTransactions(state.currentYear, state.currentMonth);
  if (state.txFilter.type)     txs = txs.filter(t => t.type === state.txFilter.type);
  if (state.txFilter.category) txs = txs.filter(t => t.category === state.txFilter.category);
  if (state.txFilter.search) {
    const q = state.txFilter.search.toLowerCase();
    txs = txs.filter(t =>
      (t.category || '').toLowerCase().includes(q) ||
      (t.memo || '').toLowerCase().includes(q)
    );
  }
  return txs.sort((a,b) => b.date.localeCompare(a.date));
}

function renderOpeningCashCard() {
  const y = state.currentYear, m = state.currentMonth;
  const saved = isOpeningCashSaved(y, m);
  const savedAmount = getOpeningCash(y, m);
  const carriedOver = computeCarriedOverCash(y, m);

  const monthLabel = document.getElementById('opening-cash-month-label');
  const input = document.getElementById('opening-cash-input');
  const note = document.getElementById('opening-cash-note');
  const saveBtn = document.getElementById('opening-cash-save-btn');
  const editBtn = document.getElementById('opening-cash-edit-btn');

  if (monthLabel) monthLabel.textContent = getMonthLabel(y, m);

  if (saved) {
    // 保存済み: 読み取り専用、保存ボタン非活性、修正ボタン表示
    if (input) { input.value = savedAmount; input.readOnly = true; }
    if (saveBtn) saveBtn.disabled = true;
    if (editBtn) editBtn.style.display = 'inline-flex';
    if (note) note.innerHTML = '<i class="fas fa-check-circle" style="color:var(--income)"></i> 保存済み（確定）';
  } else {
    // 未保存: 前月繰越を自動セット、保存ボタン活性、修正ボタン非表示
    if (input) { input.value = carriedOver; input.readOnly = false; }
    if (saveBtn) saveBtn.disabled = false;
    if (editBtn) editBtn.style.display = 'none';
    if (note) note.innerHTML = `<i class="fas fa-info-circle" style="color:var(--text-muted)"></i> 前月繰越: <strong>${formatYen(carriedOver)}</strong>（未保存・編集可）`;
  }
}

function renderTransactions() {
  // 開始残高編集カード表示（収支一覧専用）
  renderOpeningCashCard();

  // フィルターカテゴリ更新
  const txs = getMonthTransactions(state.currentYear, state.currentMonth);
  const cats = [...new Set(txs.map(t => t.category))];
  const catSel = document.getElementById('filter-category');
  const current = catSel.value;
  catSel.innerHTML = '<option value="">カテゴリ：すべて</option>' +
    cats.map(c => `<option value="${esc(c)}"${c===current?' selected':''}>${esc(c)}</option>`).join('');

  const filtered = getFilteredTransactions();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  if (state.txPage > totalPages) state.txPage = totalPages;

  const start = (state.txPage - 1) * ITEMS_PER_PAGE;
  const paged = filtered.slice(start, start + ITEMS_PER_PAGE);

  const tbody = document.getElementById('transaction-tbody');
  const noMsg = document.getElementById('no-transaction-msg');

  if (paged.length === 0) {
    tbody.innerHTML = '';
    noMsg.style.display = 'block';
  } else {
    noMsg.style.display = 'none';
    tbody.innerHTML = paged.map(tx => `
      <tr>
        <td data-label="日付">${formatDate(tx.date)}</td>
        <td data-label="種別"><span class="badge ${tx.type}">${tx.type === 'income' ? '<i class="fas fa-arrow-up"></i> 収入' : '<i class="fas fa-arrow-down"></i> 支出'}</span></td>
        <td data-label="カテゴリ">${esc(getCategoryIcon(tx.category))} ${esc(tx.category)}</td>
        <td data-label="メモ" style="color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(tx.memo || '-')}</td>
        <td class="text-right amount-cell ${tx.type}" data-label="金額">${tx.type==='income'?'+':'−'}${formatYen(tx.amount)}</td>
        <td class="text-center action-cell" data-label="操作">
          <div class="action-buttons">
            <button class="btn-icon edit" onclick="startEdit('${tx.id}')" title="編集"><i class="fas fa-pen"></i></button>
            <button class="btn-icon delete" onclick="confirmDelete('${tx.id}')" title="削除"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const pg = document.getElementById('pagination');
  if (totalPages <= 1) { pg.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="goToPage(${state.txPage-1})" ${state.txPage===1?'disabled':''}><i class="fas fa-chevron-left"></i></button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - state.txPage) <= 2) {
      html += `<button class="page-btn${i===state.txPage?' active':''}" onclick="goToPage(${i})">${i}</button>`;
    } else if (Math.abs(i - state.txPage) === 3) {
      html += `<span class="page-btn" style="pointer-events:none">…</span>`;
    }
  }
  html += `<button class="page-btn" onclick="goToPage(${state.txPage+1})" ${state.txPage===totalPages?'disabled':''}><i class="fas fa-chevron-right"></i></button>`;
  pg.innerHTML = html;
}

function goToPage(p) {
  state.txPage = p;
  renderTransactions();
}

// ===================================================
// 収支入力フォーム
// ===================================================
function renderInputForm() {
  updateCategorySelect();
  if (!document.getElementById('input-date').value) {
    document.getElementById('input-date').value = todayString();
  }
}

function updateCategorySelect() {
  const cats = state.inputType === 'expense' ? state.expenseCategories : state.incomeCategories;
  const sel = document.getElementById('input-category');
  const cur = sel.value;
  sel.innerHTML = cats.map(c => `<option value="${esc(c)}"${c===cur?' selected':''}>${esc(c)}</option>`).join('');
}

function setInputType(type) {
  state.inputType = type;
  document.querySelectorAll('.type-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.type === type);
  });
  updateCategorySelect();
}

function resetForm() {
  state.editingTxId = null;
  document.getElementById('transaction-form').reset();
  document.getElementById('edit-id').value = '';
  document.getElementById('input-date').value = todayString();
  document.getElementById('form-cancel-btn').style.display = 'none';
  document.getElementById('form-submit-btn').innerHTML = '<i class="fas fa-check"></i> 登録する';
  setInputType('expense');
}

function startEdit(id) {
  const tx = state.allTransactions.find(t => t.id === id);
  if (!tx) return;

  navigateTo('input');
  state.editingTxId = id;

  setInputType(tx.type);
  document.getElementById('edit-id').value = id;
  document.getElementById('input-date').value = tx.date;
  document.getElementById('input-amount').value = tx.amount;
  document.getElementById('input-memo').value = tx.memo || '';

  // カテゴリセット（少し遅延）
  setTimeout(() => {
    const sel = document.getElementById('input-category');
    if ([...sel.options].some(o => o.value === tx.category)) {
      sel.value = tx.category;
    }
  }, 50);

  document.getElementById('form-cancel-btn').style.display = 'inline-flex';
  document.getElementById('form-submit-btn').innerHTML = '<i class="fas fa-pen"></i> 更新する';

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function handleTransactionSubmit(e) {
  e.preventDefault();
  const date     = document.getElementById('input-date').value;
  const amount   = Kakeibo.toYen(document.getElementById('input-amount').value);
  const category = document.getElementById('input-category').value;
  const memo     = document.getElementById('input-memo').value.trim();
  const type     = state.inputType;

  if (!date || !amount || !category) {
    showToast('日付・金額・カテゴリは必須です', 'error'); return;
  }
  if (amount <= 0) {
    showToast('金額は0より大きい値を入力してください', 'error'); return;
  }

  const data = { date, amount, category, memo, type };
  const btn = document.getElementById('form-submit-btn');
  btn.disabled = true;

  try {
    if (state.editingTxId) {
      const updated = await apiPut(TABLE_TX, state.editingTxId, data);
      // stateを更新
      const idx = state.allTransactions.findIndex(t => t.id === state.editingTxId);
      if (idx >= 0) state.allTransactions[idx] = { ...state.allTransactions[idx], ...data, ...(updated || {}) };
      showToast('取引を更新しました ✏️');
    } else {
      const created = await apiPost(TABLE_TX, data);
      state.allTransactions.push(created);
      showToast('取引を登録しました ✅');
    }
    resetForm();
    renderMonthlySummaryBar();
  } catch (err) {
    showToast('保存に失敗しました', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ===================================================
// 削除
// ===================================================
function confirmDelete(id) {
  state.deletingTxId = id;
  document.getElementById('delete-modal').style.display = 'flex';
}

async function executeDelete() {
  if (!state.deletingTxId) return;
  try {
    await apiDelete(TABLE_TX, state.deletingTxId);
    state.allTransactions = state.allTransactions.filter(t => t.id !== state.deletingTxId);
    showToast('取引を削除しました 🗑️');
    refreshCurrentPage();
  } catch (err) {
    showToast('削除に失敗しました', 'error');
  } finally {
    state.deletingTxId = null;
    document.getElementById('delete-modal').style.display = 'none';
  }
}

// ===================================================
// 予算管理
// ===================================================
/** 表示中の月の予算 (budgets.month = 'YYYY-MM') */
function getMonthBudgets(year, month) {
  const key = getMonthKey(year, month);
  return state.allBudgets.filter(b => b.month === key);
}

/** 直近の過去月で予算が設定されている月キー (無ければ null) */
function findPreviousBudgetMonth(year, month) {
  const key = getMonthKey(year, month);
  const months = [...new Set(state.allBudgets.map(b => b.month).filter(m => m && m < key))].sort();
  return months.length ? months[months.length - 1] : null;
}

function renderBudget() {
  // カテゴリセレクト更新 (支出カテゴリのみ)
  const budgetCatSel = document.getElementById('budget-category');
  const curVal = budgetCatSel.value;
  budgetCatSel.innerHTML = state.expenseCategories
    .map(c => `<option value="${esc(c)}"${c===curVal?' selected':''}>${esc(c)}</option>`).join('');

  const titleEl = document.getElementById('budget-list-title');
  if (titleEl) titleEl.textContent = `${getMonthLabel(state.currentYear, state.currentMonth)}の予算状況`;

  const txs = getMonthTransactions(state.currentYear, state.currentMonth);
  const expByCategory = {};
  txs.filter(t => t.type === 'expense').forEach(t => {
    expByCategory[t.category] = (expByCategory[t.category] || 0) + Number(t.amount);
  });

  const container = document.getElementById('budget-list');
  const noMsg = document.getElementById('no-budget-msg');
  const copyBtn = document.getElementById('budget-copy-prev-btn');
  const budgets = getMonthBudgets(state.currentYear, state.currentMonth);

  if (copyBtn) {
    const prev = findPreviousBudgetMonth(state.currentYear, state.currentMonth);
    copyBtn.style.display = budgets.length === 0 && prev ? 'inline-flex' : 'none';
    copyBtn.dataset.fromMonth = prev || '';
    copyBtn.title = prev ? `${prev} の予算をコピーします` : '';
  }

  if (budgets.length === 0) {
    container.innerHTML = '';
    noMsg.style.display = 'block';
    return;
  }
  noMsg.style.display = 'none';

  container.innerHTML = budgets.map(b => {
    const spent   = expByCategory[b.category] || 0;
    const ratio   = b.budget > 0 ? Math.min(spent / b.budget, 1) : 0;
    const pct     = Math.round(ratio * 100);
    const isOver  = spent > b.budget;
    const isWarn  = !isOver && pct >= 80;
    const fillClass = isOver ? 'over' : (isWarn ? 'warning' : '');
    const remaining = b.budget - spent;

    return `
      <div class="budget-item">
        <div class="budget-header">
          <span class="budget-category">${esc(getCategoryIcon(b.category))} ${esc(b.category)}</span>
          <div class="budget-actions">
            <button class="btn-icon edit" onclick="startEditBudget('${b.id}')" title="編集"><i class="fas fa-pen"></i></button>
            <button class="btn-icon delete" onclick="deleteBudget('${b.id}')" title="削除"><i class="fas fa-trash"></i></button>
          </div>
        </div>
        <div class="budget-amounts">
          <span>使用: <strong>${formatYen(spent)}</strong></span>
          <span>予算: <strong>${formatYen(b.budget)}</strong></span>
          <span style="margin-left:auto">${pct}%</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill ${fillClass}" style="width:${pct}%"></div>
        </div>
        <div class="budget-note${isOver?' over':''}">
          ${isOver
            ? `⚠️ 予算を ${formatYen(Math.abs(remaining))} オーバーしています`
            : isWarn
              ? `⚡ 残り ${formatYen(remaining)} (${100-pct}%)`
              : `残り ${formatYen(remaining)}`
          }
        </div>
      </div>
    `;
  }).join('');
}

function startEditBudget(id) {
  const b = state.allBudgets.find(b => b.id === id);
  if (!b) return;
  state.editingBudgetId = id;
  document.getElementById('budget-edit-id').value = id;
  document.getElementById('budget-category').value = b.category;
  document.getElementById('budget-amount').value = b.budget;
  document.getElementById('budget-cancel-btn').style.display = 'inline-flex';
  document.getElementById('budget-submit-btn').innerHTML = '<i class="fas fa-pen"></i> 更新する';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetBudgetForm() {
  state.editingBudgetId = null;
  document.getElementById('budget-form').reset();
  document.getElementById('budget-edit-id').value = '';
  document.getElementById('budget-cancel-btn').style.display = 'none';
  document.getElementById('budget-submit-btn').innerHTML = '<i class="fas fa-check"></i> 設定する';
}

async function handleBudgetSubmit(e) {
  e.preventDefault();
  const category = document.getElementById('budget-category').value;
  const budget   = Kakeibo.toYen(document.getElementById('budget-amount').value);
  if (!category || !budget || budget <= 0) {
    showToast('カテゴリと予算額を正しく入力してください', 'error'); return;
  }

  const month = getMonthKey(state.currentYear, state.currentMonth);
  const btn = document.getElementById('budget-submit-btn');

  // 同月・同カテゴリの重複チェック (編集中の自分自身は除外)
  const dup = state.allBudgets.find(b => b.month === month && b.category === category && b.id !== state.editingBudgetId);
  if (dup) {
    showToast('この月のこのカテゴリの予算は既に設定済みです。編集してください。', 'info');
    return;
  }

  btn.disabled = true;

  try {
    if (state.editingBudgetId) {
      // 編集時は対象予算の月を維持する (別の月を表示中に編集しても月が書き換わらないように)
      const target = state.allBudgets.find(b => b.id === state.editingBudgetId);
      const data = { category, budget, month: (target && target.month) || month, label: (target && target.label) || '' };
      await apiPut(TABLE_BDG, state.editingBudgetId, data);
      const idx = state.allBudgets.findIndex(b => b.id === state.editingBudgetId);
      if (idx >= 0) state.allBudgets[idx] = { ...state.allBudgets[idx], ...data };
      showToast('予算を更新しました ✏️');
    } else {
      const data = { category, budget, month, label: '' };
      const created = await apiPost(TABLE_BDG, data);
      state.allBudgets.push(created);
      showToast('予算を設定しました 🎯');
    }
    resetBudgetForm();
    renderBudget();
  } catch (err) {
    showToast('保存に失敗しました', 'error');
  } finally {
    btn.disabled = false;
  }
}

/** 直近の過去月の予算を表示中の月へコピー */
async function copyBudgetsFromPreviousMonth() {
  const btn = document.getElementById('budget-copy-prev-btn');
  const from = btn && btn.dataset.fromMonth;
  if (!from) return;
  const to = getMonthKey(state.currentYear, state.currentMonth);
  const source = state.allBudgets.filter(b => b.month === from);
  const existing = new Set(state.allBudgets.filter(b => b.month === to).map(b => b.category));
  const targets = source.filter(b => !existing.has(b.category));
  if (targets.length === 0) return;
  if (!confirm(`${from} の予算 ${targets.length} 件を ${to} にコピーしますか？`)) return;

  btn.disabled = true;
  try {
    for (const b of targets) {
      const created = await apiPost(TABLE_BDG, { month: to, category: b.category, budget: b.budget, label: b.label || '' });
      state.allBudgets.push(created);
    }
    showToast(`${targets.length} 件の予算をコピーしました 🎯`);
  } catch (err) {
    console.error(err);
    showToast('予算のコピーに失敗しました', 'error');
  } finally {
    btn.disabled = false;
    renderBudget();
  }
}

async function deleteBudget(id) {
  if (!confirm('この予算設定を削除しますか？')) return;
  try {
    await apiDelete(TABLE_BDG, id);
    state.allBudgets = state.allBudgets.filter(b => b.id !== id);
    showToast('予算を削除しました 🗑️');
    renderBudget();
  } catch {
    showToast('削除に失敗しました', 'error');
  }
}

// ===================================================
// 分析ページ
// ===================================================
function renderAnalysis() {
  renderMonthlyBarChart();
  renderIncomePieChart();
  renderDailyLineChart();
  renderDailyStackChart();
  renderExpenseHeatmap();
}

function renderMonthlyBarChart() {
  const labels = [], incomes = [], expenses = [];
  for (let i = 11; i >= 0; i--) {
    let m = state.currentMonth - i;
    let y = state.currentYear;
    while (m < 1) { m += 12; y--; }
    const txs = getMonthTransactions(y, m);
    labels.push(`${m}月`);
    incomes.push(txs.filter(t=>t.type==='income').reduce((s,t)=>s+Number(t.amount),0));
    expenses.push(txs.filter(t=>t.type==='expense').reduce((s,t)=>s+Number(t.amount),0));
  }

  const ctx = document.getElementById('monthlyBarChart').getContext('2d');
  if (state.charts.monthlyBar) state.charts.monthlyBar.destroy();
  state.charts.monthlyBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: '収入', data: incomes, backgroundColor: 'rgba(34,197,94,0.7)', borderRadius: 4 },
        { label: '支出', data: expenses, backgroundColor: 'rgba(239,68,68,0.7)', borderRadius: 4 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { family: 'Noto Sans JP', size: 12 } } } },
      scales: {
        y: { ticks: { callback: v => `¥${(v/10000).toFixed(0)}万`, font: { family: 'Noto Sans JP', size: 11 } } },
        x: { ticks: { font: { family: 'Noto Sans JP', size: 11 } } }
      }
    }
  });
}

function renderIncomePieChart() {
  const txs = getMonthTransactions(state.currentYear, state.currentMonth);
  const incomes = txs.filter(t => t.type === 'income');
  const catMap = {};
  incomes.forEach(t => { catMap[t.category] = (catMap[t.category] || 0) + Number(t.amount); });
  const labels = Object.keys(catMap);
  const data   = Object.values(catMap);
  const noMsg  = document.getElementById('no-income-pie-msg');

  if (labels.length === 0) {
    noMsg.style.display = 'block';
    if (state.charts.incomePie) { state.charts.incomePie.destroy(); state.charts.incomePie = null; }
    return;
  }
  noMsg.style.display = 'none';

  const ctx = document.getElementById('incomePieChart').getContext('2d');
  if (state.charts.incomePie) state.charts.incomePie.destroy();
  state.charts.incomePie = new Chart(ctx, {
    type: 'pie',
    data: { labels, datasets: [{ data, backgroundColor: generateColors(labels.length), borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { font: { family: 'Noto Sans JP', size: 12 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${formatYen(ctx.raw)}` } }
      }
    }
  });
}

function renderDailyLineChart() {
  const txs = getMonthTransactions(state.currentYear, state.currentMonth);
  const daysInMonth = new Date(state.currentYear, state.currentMonth, 0).getDate();
  const labels = [], data = [];
  let cumulative = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${getMonthKey(state.currentYear, state.currentMonth)}-${String(d).padStart(2,'0')}`;
    const dayExp = txs.filter(t => t.type === 'expense' && t.date === dateStr)
                      .reduce((s,t) => s+Number(t.amount), 0);
    cumulative += dayExp;
    labels.push(`${d}日`);
    data.push(cumulative);
  }

  const ctx = document.getElementById('dailyLineChart').getContext('2d');
  if (state.charts.dailyLine) state.charts.dailyLine.destroy();
  state.charts.dailyLine = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '累計支出', data, borderColor: '#ef4444',
        backgroundColor: 'rgba(239,68,68,0.1)',
        borderWidth: 2, pointRadius: 2, fill: true, tension: 0.3
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { family: 'Noto Sans JP', size: 12 } } } },
      scales: {
        y: { ticks: { callback: v => `¥${(v/10000).toFixed(1)}万`, font: { family: 'Noto Sans JP', size: 11 } } },
        x: {
          ticks: {
            maxTicksLimit: 10,
            font: { family: 'Noto Sans JP', size: 10 }
          }
        }
      }
    }
  });
}

// ===================================================
// 分析: 日別×カテゴリ積み上げ / 支出カレンダー / 支出明細ページ
// ===================================================
function getMonthExpenseTx(year, month) {
  return getMonthTransactions(year, month).filter(t => t.type === 'expense');
}

function dayOfMonth(dateStr) {
  return Number(String(dateStr).slice(8, 10));
}

function sumByCategory(txs) {
  const map = {};
  txs.forEach(t => { map[t.category] = (map[t.category] || 0) + Number(t.amount); });
  return map;
}

/** 日別×カテゴリの積み上げ棒グラフ */
function renderDailyStackChart() {
  const y = state.currentYear, m = state.currentMonth;
  const txs = getMonthExpenseTx(y, m);
  const days = new Date(y, m, 0).getDate();
  const summaryEl = document.getElementById('daily-stack-summary');
  const noMsg = document.getElementById('no-daily-stack-msg');
  const existing = state.charts.dailyStack;

  const catTotals = sumByCategory(txs);
  const cats = Object.keys(catTotals).sort((a, b) => catTotals[b] - catTotals[a]);

  if (cats.length === 0) {
    if (summaryEl) summaryEl.innerHTML = '';
    if (noMsg) noMsg.style.display = 'block';
    if (existing) { existing.destroy(); state.charts.dailyStack = null; }
    return;
  }
  if (noMsg) noMsg.style.display = 'none';

  const total = Object.values(catTotals).reduce((a, b) => a + b, 0);
  const usedDays = new Set(txs.map(t => t.date)).size;
  if (summaryEl) {
    summaryEl.innerHTML =
      `<span class="hm-chip">合計 <b>${formatYen(total)}</b></span>` +
      `<span class="hm-chip">カテゴリ <b>${cats.length}</b></span>` +
      `<span class="hm-chip">支出日 <b>${usedDays}日</b></span>`;
  }

  const matrix = {};
  cats.forEach(c => { matrix[c] = new Array(days).fill(0); });
  txs.forEach(t => {
    const d = dayOfMonth(t.date);
    if (d >= 1 && d <= days && matrix[t.category]) matrix[t.category][d - 1] += Number(t.amount);
  });

  const labels = Array.from({ length: days }, (_, i) => `${i + 1}日`);
  const colors = generateColors(cats.length);
  const datasets = cats.map((cat, i) => ({
    label: cat,
    data: matrix[cat],
    backgroundColor: colors[i],
    stack: 'expense',
    borderRadius: 3,
    borderSkipped: false,
  }));

  const ctx = document.getElementById('dailyStackChart').getContext('2d');
  if (existing) existing.destroy();
  state.charts.dailyStack = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { family: 'Noto Sans JP', size: 11 }, boxWidth: 10, padding: 10 } },
        tooltip: {
          callbacks: {
            label: c => ` ${c.dataset.label}: ${formatYen(c.raw)}`,
            footer: items => {
              if (!items.length) return '';
              const d = items[0].dataIndex;
              const dayTotal = txs.filter(t => dayOfMonth(t.date) === d + 1)
                .reduce((s, t) => s + Number(t.amount), 0);
              return `合計: ${formatYen(dayTotal)}`;
            }
          }
        }
      },
      scales: {
        x: { stacked: true, ticks: { font: { family: 'Noto Sans JP', size: 10 } } },
        y: {
          stacked: true,
          ticks: { callback: v => `¥${Math.round(v / 10000)}万`, font: { family: 'Noto Sans JP', size: 10 } }
        }
      }
    }
  });
}

/** 日×カテゴリのヒートマップ表。セルクリックで支出明細ページへ */
function renderExpenseHeatmap() {
  const y = state.currentYear, m = state.currentMonth;
  const txs = getMonthExpenseTx(y, m);
  const days = new Date(y, m, 0).getDate();
  const table = document.getElementById('expense-heatmap');
  const scale = document.getElementById('heatmap-scale');
  if (!table) return;

  const catTotals = sumByCategory(txs);
  const cats = Object.keys(catTotals).sort((a, b) => catTotals[b] - catTotals[a]);
  const colors = generateColors(cats.length);

  if (cats.length === 0) {
    table.innerHTML = '<tbody><tr><td class="hm-empty">この月の支出はありません</td></tr></tbody>';
    if (scale) scale.innerHTML = '';
    return;
  }

  const cell = {};
  let maxCell = 0;
  txs.forEach(t => {
    const key = `${t.category}|${dayOfMonth(t.date)}`;
    const amount = Number(t.amount);
    cell[key] = (cell[key] || 0) + amount;
    if (cell[key] > maxCell) maxCell = cell[key];
  });

  let html = '<thead><tr><th class="hm-cat">カテゴリ</th>';
  for (let d = 1; d <= days; d++) html += `<th>${d}</th>`;
  html += '<th class="hm-total">合計</th></tr></thead><tbody>';

  cats.forEach((cat, i) => {
    html += `<tr><td class="hm-cat"><span class="hm-dot" style="background:${colors[i]}"></span>${esc(cat)}</td>`;
    for (let d = 1; d <= days; d++) {
      const amount = cell[`${cat}|${d}`] || 0;
      if (!amount) { html += '<td class="hm-zero">·</td>'; continue; }
      const alpha = 0.12 + 0.78 * Math.sqrt(amount / maxCell);
      const dark = alpha > 0.55;
      html += `<td class="hm-cell${dark ? ' dark' : ''}" data-cat="${esc(cat)}" style="background:rgba(79,125,243,${alpha.toFixed(2)})" title="${esc(cat)} ${d}日 ${formatYen(amount)}">${amount.toLocaleString('ja-JP')}</td>`;
    }
    html += `<td class="hm-total">${catTotals[cat].toLocaleString('ja-JP')}</td></tr>`;
  });

  html += '</tbody><tfoot><tr><td class="hm-cat">日合計</td>';
  for (let d = 1; d <= days; d++) {
    const dayTotal = txs.filter(t => dayOfMonth(t.date) === d).reduce((s, t) => s + Number(t.amount), 0);
    html += `<td>${dayTotal ? dayTotal.toLocaleString('ja-JP') : '·'}</td>`;
  }
  const grand = Object.values(catTotals).reduce((a, b) => a + b, 0);
  html += `<td class="hm-total">${grand.toLocaleString('ja-JP')}</td></tr></tfoot>`;
  table.innerHTML = html;

  if (scale) {
    scale.innerHTML = [0.12, 0.3, 0.45, 0.6, 0.75, 0.9]
      .map(a => `<i style="background:rgba(79,125,243,${a})"></i>`).join('');
  }

  table.querySelectorAll('.hm-cell').forEach(td => {
    td.addEventListener('click', () => {
      state.expenseFilter = td.dataset.cat;
      navigateTo('expenses');
    });
  });
}

/** 支出明細ページ（日別リスト + カテゴリ別合計） */
function renderExpensesPage() {
  const y = state.currentYear, m = state.currentMonth;
  const txs = getMonthExpenseTx(y, m);
  const listEl = document.getElementById('expense-day-list');
  const chipsEl = document.getElementById('expense-filter-chips');
  const sumEl = document.getElementById('expense-category-sum');
  const totalEl = document.getElementById('expenses-total');
  const noMsg = document.getElementById('no-expense-msg');
  if (!listEl) return;

  const catTotals = sumByCategory(txs);
  const cats = Object.keys(catTotals).sort((a, b) => catTotals[b] - catTotals[a]);
  if (state.expenseFilter && !cats.includes(state.expenseFilter)) state.expenseFilter = '';

  const total = Object.values(catTotals).reduce((a, b) => a + b, 0);
  if (totalEl) totalEl.textContent = `${txs.length}件 / ${formatYen(total)}`;

  if (txs.length === 0) {
    listEl.innerHTML = '';
    chipsEl.innerHTML = '';
    sumEl.innerHTML = '';
    if (noMsg) noMsg.style.display = 'block';
    return;
  }
  if (noMsg) noMsg.style.display = 'none';

  // カテゴリ絞り込みチップ
  chipsEl.innerHTML = `<button type="button" class="exp-chip${state.expenseFilter === '' ? ' active' : ''}" data-cat="">すべて</button>` +
    cats.map(c => `<button type="button" class="exp-chip${state.expenseFilter === c ? ' active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  chipsEl.querySelectorAll('.exp-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      state.expenseFilter = btn.dataset.cat;
      renderExpensesPage();
    });
  });

  // 日別リスト（新しい日付順）
  const filtered = state.expenseFilter ? txs.filter(t => t.category === state.expenseFilter) : txs;
  const byDay = {};
  filtered.forEach(t => { (byDay[t.date] = byDay[t.date] || []).push(t); });
  const dates = Object.keys(byDay).sort((a, b) => b.localeCompare(a));
  const wdays = ['日', '月', '火', '水', '木', '金', '土'];

  listEl.innerHTML = dates.map(date => {
    const items = [...byDay[date]].sort((a, b) => Number(b.amount) - Number(a.amount));
    const dayTotal = items.reduce((s, t) => s + Number(t.amount), 0);
    const dt = new Date(`${date}T00:00:00`);
    const [, mm, dd] = date.split('-');
    return `<div class="exp-day">
      <div class="exp-day-head">
        <div class="exp-date">${mm}/${dd}<span class="exp-wday">(${wdays[dt.getDay()]})</span></div>
        <div class="exp-day-total">${formatYen(dayTotal)}</div>
      </div>
      ${items.map(t => `<div class="exp-item">
        <div class="exp-item-left">
          <span class="exp-icon">${getCategoryIcon(t.category)}</span>
          <span class="exp-cat">${esc(t.category)}</span>
          <span class="exp-memo">${esc(t.memo || '')}</span>
        </div>
        <span class="exp-amount">${formatYen(t.amount)}</span>
      </div>`).join('')}
    </div>`;
  }).join('');

  // カテゴリ別合計
  const maxCat = cats.length ? catTotals[cats[0]] : 0;
  sumEl.innerHTML = cats.map(c => `
    <div class="exp-cat-row">
      <div class="exp-cat-name">${getCategoryIcon(c)} ${esc(c)}</div>
      <div class="exp-cat-bar"><i style="width:${maxCat ? Math.max(2, catTotals[c] / maxCat * 100) : 0}%;background:${colorsForCategory(c, cats)}"></i></div>
      <div class="exp-cat-value">${formatYen(catTotals[c])}</div>
    </div>`).join('') +
    `<div class="exp-cat-row total"><div class="exp-cat-name">合計</div><div></div><div class="exp-cat-value">${formatYen(total)}</div></div>`;
}

/** カテゴリの固定色（積み上げ棒と同じ並び順を再現） */
function colorsForCategory(cat, cats) {
  const colors = generateColors(cats.length);
  const i = cats.indexOf(cat);
  return colors[i >= 0 ? i : 0];
}

// ===================================================
// カラーパレット生成
// ===================================================
function generateColors(n) {
  const palette = [
    '#4f7df3','#22c55e','#f59e0b','#ef4444','#8b5cf6',
    '#06b6d4','#ec4899','#10b981','#f97316','#6366f1',
    '#84cc16','#14b8a6','#e11d48','#7c3aed','#0ea5e9',
  ];
  return Array.from({ length: n }, (_, i) => palette[i % palette.length]);
}

// ===================================================
// サイドバー制御
// ===================================================
let sidebarOverlay = null;

function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  if (sidebarOverlay) sidebarOverlay.classList.remove('active');
}

function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const main    = document.getElementById('main-content');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebarLogo   = document.querySelector('.sidebar-logo');
  const sidebarHeader = document.querySelector('.sidebar-header');

  const toggleCollapse = () => {
    sidebar.classList.toggle('collapsed');
    main.classList.toggle('sidebar-collapsed');
  };

  const openSidebar = () => {
    if (sidebar.classList.contains('collapsed')) {
      sidebar.classList.remove('collapsed');
      main.classList.remove('sidebar-collapsed');
    }
  };

  // デスクトップ折りたたみボタン
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapse();
    });
  }

  // サイドバーが閉じている時にロゴクリックで開く
  if (sidebarLogo) {
    sidebarLogo.addEventListener('click', (e) => {
      if (sidebar.classList.contains('collapsed')) {
        e.stopPropagation();
        openSidebar();
      }
    });
  }

  // サイドバーが閉じている時にヘッダー領域クリックでも開く
  if (sidebarHeader) {
    sidebarHeader.addEventListener('click', (e) => {
      if (e.target.closest('#sidebar-toggle')) return;
      if (sidebar.classList.contains('collapsed')) {
        openSidebar();
      }
    });
  }

  // モバイルハンバーガー
  sidebarOverlay = document.createElement('div');
  sidebarOverlay.id = 'sidebar-overlay';
  document.body.appendChild(sidebarOverlay);

  const hamburgerBtn = document.getElementById('hamburger-btn');
  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', () => {
      sidebar.classList.add('mobile-open');
      sidebarOverlay.classList.add('active');
    });
  }

  sidebarOverlay.addEventListener('click', closeMobileSidebar);
}

// ===================================================
// ヘッダーのバージョン表示 (全ページ共通)
// ===================================================
async function loadAppVersion() {
  const el = document.getElementById('app-version');
  try {
    const res = await fetch('api/version');
    if (!res.ok) throw new Error('version fetch failed');
    const info = await res.json();
    state.appVersion = info;
    if (el) {
      el.textContent = `Ver：${info.version || '—'}`;
      el.title = `ビルド: ${info.build_date || '-'} / Node ${info.node || '-'}（クリックでデータ管理）`;
    }
  } catch {
    if (el) {
      el.textContent = 'Ver：—';
      el.title = 'バージョンを取得できませんでした';
    }
  }
}

function initVersionBadge() {
  const el = document.getElementById('app-version');
  if (!el) return;
  el.addEventListener('click', () => navigateTo('datamanage'));
}

// ===================================================
// データ管理ページ
// ===================================================
async function renderDataManagePage() {
  // 選択月に応じてエクスポートの説明文を更新
  const desc = document.getElementById('excel-export-desc');
  if (desc) {
    desc.innerHTML = `${getMonthLabel(state.currentYear, state.currentMonth)}のデータを Excel (.xlsx) ファイルに出力します。<br>月別サマリー・収支データ・予算・預金口座・口座明細・集計・グラフが含まれます。`;
  }

  let info = state.appVersion;
  if (!info) {
    try {
      const res = await fetch('api/version');
      if (!res.ok) throw new Error();
      info = await res.json();
      state.appVersion = info;
    } catch {
      info = null;
    }
  }
  const elV = document.getElementById('version-value');
  const elB = document.getElementById('version-build-date');
  const elN = document.getElementById('version-node');
  if (info) {
    if (elV) elV.textContent = info.version || '-';
    if (elB) elB.textContent = info.build_date || '-';
    if (elN) elN.textContent = info.node || '-';
  } else if (elV) {
    elV.textContent = '取得できませんでした';
  }
}

function downloadExport(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ===================================================
// カテゴリ追加モーダル
// ===================================================
function openCategoryModal() {
  document.getElementById('category-modal').style.display = 'flex';
  document.getElementById('new-category-input').value = '';
  setTimeout(() => document.getElementById('new-category-input').focus(), 50);
}

function closeCategoryModal() {
  document.getElementById('category-modal').style.display = 'none';
}

function addNewCategory() {
  const name = document.getElementById('new-category-input').value.trim();
  if (!name) { showToast('カテゴリ名を入力してください', 'error'); return; }

  if (name.length > 30) { showToast('カテゴリ名は30文字以内で入力してください', 'error'); return; }

  const arr = state.inputType === 'expense' ? state.expenseCategories : state.incomeCategories;
  if (arr.includes(name)) { showToast('すでに存在するカテゴリです', 'info'); return; }
  arr.push(name);
  CATEGORY_ICONS[name] = '📌';

  closeCategoryModal();
  updateCategorySelect();
  document.getElementById('input-category').value = name;
  showToast(`カテゴリ「${name}」を追加しました`);
}

// ===================================================
// イベント登録
// ===================================================
function bindEvents() {
  // ナビゲーション
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', e => {
      // 外部リンク（target="_blank"）はブラウザデフォルト動作に任せる
      if (link.target === '_blank') return;
      e.preventDefault();
      if (link.dataset.page) navigateTo(link.dataset.page);
    });
  });

  // 一覧ページからの追加ボタン
  document.getElementById('add-from-list-btn').addEventListener('click', () => navigateTo('input'));

  // 最近取引の「すべて見る」
  document.querySelector('.link-more')?.addEventListener('click', e => {
    e.preventDefault();
    navigateTo(e.target.dataset.page || 'transactions');
  });

  // 月切替
  document.getElementById('prev-month').addEventListener('click', () => changeMonth(-1));
  document.getElementById('next-month').addEventListener('click', () => changeMonth(1));

  // 開始残高保存（収支一覧専用）
  document.getElementById('opening-cash-save-btn').addEventListener('click', async () => {
    const val = parseFloat(document.getElementById('opening-cash-input').value || '0');
    const ok = await saveOpeningCash(state.currentYear, state.currentMonth, val);
    showToast(ok ? '開始残高を保存しました 💰' : '保存に失敗しました', ok ? 'success' : 'error');
    if (ok) {
      renderOpeningCashCard();
      renderMonthlySummaryBar();
    }
  });

  // 開始残高 修正ボタン（収支一覧専用）
  document.getElementById('opening-cash-edit-btn').addEventListener('click', () => {
    const input = document.getElementById('opening-cash-input');
    const saveBtn = document.getElementById('opening-cash-save-btn');
    const editBtn = document.getElementById('opening-cash-edit-btn');
    const note = document.getElementById('opening-cash-note');
    input.readOnly = false;
    input.focus();
    input.select();
    saveBtn.disabled = false;
    editBtn.style.display = 'none';
    note.innerHTML = '<i class="fas fa-pen" style="color:var(--expense)"></i> 編集中（保存で確定）';
  });

  // 取引フォーム
  document.getElementById('transaction-form').addEventListener('submit', handleTransactionSubmit);
  document.getElementById('form-cancel-btn').addEventListener('click', resetForm);

  document.querySelectorAll('.type-tab').forEach(tab => {
    tab.addEventListener('click', () => setInputType(tab.dataset.type));
  });

  // カテゴリ追加
  document.getElementById('add-category-btn').addEventListener('click', openCategoryModal);
  document.getElementById('category-modal-cancel').addEventListener('click', closeCategoryModal);
  document.getElementById('category-modal-add').addEventListener('click', addNewCategory);
  document.getElementById('new-category-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addNewCategory(); }
    if (e.key === 'Escape') closeCategoryModal();
  });

  // 削除モーダル
  document.getElementById('delete-confirm-btn').addEventListener('click', executeDelete);
  document.getElementById('delete-cancel-btn').addEventListener('click', () => {
    state.deletingTxId = null;
    document.getElementById('delete-modal').style.display = 'none';
  });

  // フィルター
  document.getElementById('filter-type').addEventListener('change', e => {
    state.txFilter.type = e.target.value;
    state.txPage = 1;
    renderTransactions();
  });
  document.getElementById('filter-category').addEventListener('change', e => {
    state.txFilter.category = e.target.value;
    state.txPage = 1;
    renderTransactions();
  });
  let searchTimer;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.txFilter.search = e.target.value;
      state.txPage = 1;
      renderTransactions();
    }, 300);
  });

  // 予算フォーム
  document.getElementById('budget-form').addEventListener('submit', handleBudgetSubmit);
  document.getElementById('budget-cancel-btn').addEventListener('click', resetBudgetForm);
  document.getElementById('budget-copy-prev-btn')?.addEventListener('click', copyBudgetsFromPreviousMonth);

  // データ管理ページ: エクスポートボタン
  const excelBtn = document.getElementById('excel-export-btn');
  if (excelBtn) {
    excelBtn.addEventListener('click', () => {
      const allToggle = document.getElementById('export-all-period');
      const useAll = !!(allToggle && allToggle.checked);
      const url = useAll
        ? 'api/export/excel'
        : `api/export/excel?month=${getMonthKey(state.currentYear, state.currentMonth)}`;
      showToast(useAll ? '全期間の Excel ファイルを生成中です...' : `${getMonthLabel(state.currentYear, state.currentMonth)}の Excel ファイルを生成中です...`);
      downloadExport(url);
    });
  }
  const jsonBtn = document.getElementById('json-export-btn');
  if (jsonBtn) {
    jsonBtn.addEventListener('click', () => {
      downloadExport('api/export');
    });
  }
}

// ===================================================
// 現在日時表示
// ===================================================
function updateCurrentDateDisplay() {
  const now = new Date();
  const days = ['日','月','火','水','木','金','土'];
  const str = `${now.getFullYear()}/${now.getMonth()+1}/${now.getDate()}(${days[now.getDay()]})`;
  document.getElementById('current-date-display').textContent = str;
}

// ===================================================
// アプリ初期化
// ===================================================
async function init() {
  updateCurrentDateDisplay();
  updateMonthLabel();
  initSidebar();
  bindEvents();
  initVersionBadge();

  // データとバージョン情報を並行取得 (バージョンは取れなくても致命的ではない)
  await Promise.all([loadAllData(), loadAppVersion()]);
  // 月次サマリーバー (開始残高〜現金残高) とダッシュボードを両方描画する。
  // renderDashboard() だけだとサマリーバーが月を切り替えるまで ¥0 のままになる。
  refreshCurrentPage();
}

document.addEventListener('DOMContentLoaded', init);
