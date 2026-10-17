/**
 * MyKakeibo – スマホ専用伝票入力画面
 * js/mobile-input.js
 */

'use strict';

// ─────────────────────────────────────────
// 定数・設定
// ─────────────────────────────────────────
const TABLE_TX  = 'transactions';
const TABLE_ACCT = 'bank_accounts';
const TABLE_ACCT_TX = 'account_transactions';
const MAX_DIGITS = 10;

const EXPENSE_CATS_DEFAULT = ['食費','交通費','光熱費','通信費','日用品','医療費','娯楽','衣服','外食','教育','保険','住居','その他'];
const INCOME_CATS_DEFAULT  = ['給与','副業','ボーナス','投資','銀行ATM','その他収入'];

const ACCT_TX_CATS = ['ATM出金','ATM入金','振込','公共料金','カード引落','利息','その他','食費','交通費','光熱費','通信費','日用品','医療費','娯楽','衣服','外食','教育','保険','住居'];

const LINK_MODE_NONE = 0;
const LINK_MODE_INCOME = 1;
const LINK_MODE_INCOME_EXPENSE = 2;
const KAKEIBO_INCOME_FALLBACK = 'その他収入';
const KAKEIBO_EXPENSE_FALLBACK = 'その他';

const CAT_ICONS = {
  '食費':'🍚','交通費':'🚃','光熱費':'💡','通信費':'📱','日用品':'🧹',
  '医療費':'💊','娯楽':'🎮','衣服':'👕','外食':'🍜','教育':'📚',
  '保険':'🛡️','住居':'🏠','その他':'📦','給与':'💼','副業':'💻',
  'ボーナス':'🎁','投資':'📈','銀行ATM':'🏧','その他収入':'💰',
};

/** innerHTML に埋め込むユーザー入力は必ず esc() を通す (js/common.js) */
const esc = Kakeibo.escapeHtml;

const MEMO_SUGGESTIONS_EXPENSE = ['コンビニ','スーパー','ランチ','カフェ','薬局','電車代','ガソリン','外食','病院','書籍'];
const MEMO_SUGGESTIONS_INCOME  = ['給与','賞与','フリーランス','売上','配当'];

const STORAGE_KEY_EX_CATS = 'mkb_expense_cats';
const STORAGE_KEY_IN_CATS = 'mkb_income_cats';
const STORAGE_KEY_MEMOS   = 'mkb_recent_memos';

// ─────────────────────────────────────────
// アプリ状態
// ─────────────────────────────────────────
const s = {
  type:             'expense',        // 'expense' | 'income' | 'account'
  rawAmount:        '',               // テンキー入力文字列
  selectedCategory: '',
  selectedDate:     todayStr(),
  dateOffset:       0,                // -1=昨日, 0=今日, 1=明日
  expenseCats:      loadCats('expense'),
  incomeCats:       loadCats('income'),
  todayTxs:         [],               // 今日登録した取引（履歴パネル用）
  detailOpen:       false,
  historyOpen:      false,
  // 口座モード
  accounts:         [],
  selectedAccountId: '',
  acctTxType:       'withdrawal',     // 'withdrawal' | 'deposit'
  selectedAcctCat:  '',
  acctLinkMode:     LINK_MODE_NONE,
};

// ─────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────
function todayStr() {
  return Kakeibo.localDateString();
}
function pad(n) { return String(n).padStart(2, '0'); }

function offsetDateStr(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function formatYen(n) { return Kakeibo.formatYen(n); }

function formatDateJP(str) {
  if (!str) return '';
  const [y, m, d] = str.split('-');
  const days = ['日','月','火','水','木','金','土'];
  const dt = new Date(+y, +m - 1, +d);
  return `${+m}/${+d}(${days[dt.getDay()]})`;
}

// ─────────────────────────────────────────
// localStorage カテゴリ保存・読み込み
// ─────────────────────────────────────────
function loadCats(type) {
  try {
    const key  = type === 'expense' ? STORAGE_KEY_EX_CATS : STORAGE_KEY_IN_CATS;
    const defs = type === 'expense' ? EXPENSE_CATS_DEFAULT : INCOME_CATS_DEFAULT;
    const raw  = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      // デフォルトカテゴリが消えていたら先頭に補完
      const merged = [...new Set([...defs.filter(d => parsed.includes(d)), ...parsed])];
      return merged;
    }
  } catch {}
  return type === 'expense' ? [...EXPENSE_CATS_DEFAULT] : [...INCOME_CATS_DEFAULT];
}

function saveCats(type) {
  const key = type === 'expense' ? STORAGE_KEY_EX_CATS : STORAGE_KEY_IN_CATS;
  const arr = type === 'expense' ? s.expenseCats : s.incomeCats;
  localStorage.setItem(key, JSON.stringify(arr));
}

// ─────────────────────────────────────────
// localStorage メモ履歴
// ─────────────────────────────────────────
function loadRecentMemos() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_MEMOS) || '[]'); }
  catch { return []; }
}

function saveRecentMemo(memo) {
  if (!memo) return;
  let memos = loadRecentMemos().filter(m => m !== memo);
  memos.unshift(memo);
  memos = memos.slice(0, 10);
  localStorage.setItem(STORAGE_KEY_MEMOS, JSON.stringify(memos));
}

// ─────────────────────────────────────────
// API
// ─────────────────────────────────────────
// (js/common.js の Kakeibo.api を使用)
const apiPost = data => Kakeibo.api.create(TABLE_TX, data);

/** 今日の取引 (サーバー側で date フィルタ。件数上限による欠落なし) */
async function apiGetToday() {
  const rows = await Kakeibo.fetchAllRows(TABLE_TX, { date: todayStr() });
  return rows.sort((a, b) => b.created_at - a.created_at);
}

// ─── 口座API ───
async function apiGetAccounts() {
  const rows = await Kakeibo.fetchAllRows(TABLE_ACCT);
  return rows.sort((a, b) => a.created_at - b.created_at);
}

const apiPostAcctTx  = data => Kakeibo.api.create(TABLE_ACCT_TX, data);
const apiPostKakeibo = data => Kakeibo.api.create(TABLE_TX, data);

/** 全口座の残高をサーバー側で再計算し、最新の口座一覧を返す */
async function apiRecalculateAccounts() {
  await Kakeibo.api.post('api/accounts/recalculate');
  return apiGetAccounts();
}

// ─────────────────────────────────────────
// DOM 参照
// ─────────────────────────────────────────
const $ = id => document.getElementById(id);
const amountDisplay  = $('amount-display');
const amountValueEl  = $('amount-value');
const amountLabelEl  = $('amount-type-label');
const amountErrorEl  = $('amount-error');
const detailPanel    = $('detail-panel');
const detailBackdrop = $('detail-backdrop');
const historyPanel   = $('history-panel');
const histBackdrop   = $('history-backdrop');
const panelDate      = $('panel-date');
const categoryChips  = $('category-chips');
const panelMemo      = $('panel-memo');
const memoSugg       = $('memo-suggestions');
const submitBtn      = $('submit-btn');
const historyList    = $('history-list');
const historyEmpty   = $('history-empty');
const historyTotal   = $('history-total');
const successOverlay = $('success-overlay');
const successMsg     = $('success-msg');
const successSub     = $('success-sub');
const continuousMode = $('continuous-mode');
const accountFields  = $('account-fields');
const kakeiboFields  = $('kakeibo-fields');
const accountChips   = $('account-chips');
const acctCatChips   = $('acct-cat-chips');
const acctLinkGroup  = $('acct-link-group');
const acctLinkSelect = $('acct-link-mode');

// ─────────────────────────────────────────
// 金額入力（テンキー）
// ─────────────────────────────────────────
function updateAmountDisplay() {
  const num = parseInt(s.rawAmount || '0', 10);
  amountValueEl.textContent = num.toLocaleString('ja-JP');
  const typeClass = s.type === 'account' ? s.acctTxType : s.type;
  amountDisplay.className = 'amount-display' +
    (s.rawAmount ? ' has-value' : '') +
    ` ${typeClass}`;
}

function handleNumpad(val) {
  amountErrorEl.style.display = 'none';

  if (val === 'C') {
    s.rawAmount = '';
    updateAmountDisplay();
    return;
  }
  if (val === 'DEL') {
    s.rawAmount = s.rawAmount.slice(0, -1);
    updateAmountDisplay();
    return;
  }
  if (val === 'NEXT') {
    if (!s.rawAmount || parseInt(s.rawAmount, 10) === 0) {
      amountErrorEl.style.display = 'block';
      // 振動フィードバック
      if (navigator.vibrate) navigator.vibrate([30, 10, 30]);
      return;
    }
    openDetailPanel();
    return;
  }
  // 数字入力
  if (s.rawAmount.length >= MAX_DIGITS) return;
  if (s.rawAmount === '' && val === '0') return;    // 先頭ゼロ防止
  if (s.rawAmount === '' && val === '000') return;
  if (val === '000') {
    if (s.rawAmount.length + 3 > MAX_DIGITS) return;
    s.rawAmount += '000';
  } else if (val === '00') {
    if (s.rawAmount.length + 2 > MAX_DIGITS) return;
    s.rawAmount += '00';
  } else {
    s.rawAmount += val;
  }
  updateAmountDisplay();
}

// ─────────────────────────────────────────
// 収入／支出 切替
// ─────────────────────────────────────────
function setType(type) {
  s.type = type;
  s.selectedCategory = '';
  s.selectedAcctCat = '';

  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });

  const isAccount = type === 'account';
  amountLabelEl.textContent = isAccount
    ? (s.acctTxType === 'withdrawal' ? '出金金額' : '入金金額')
    : (type === 'expense' ? '支出金額' : '収入金額');

  // フィールド表示切替
  if (accountFields) accountFields.style.display = isAccount ? 'block' : 'none';
  if (kakeiboFields) kakeiboFields.style.display = isAccount ? 'none' : 'block';

  updateAmountDisplay();
  if (isAccount) {
    renderAccountChips();
    renderAcctCatChips();
    updateAcctLinkVisibility();
  } else {
    renderCategoryChips();
    renderMemoSuggestions();
  }
  updateSubmitBtnStyle();
}

// ─────────────────────────────────────────
// 口座モード: 入金/出金切替
// ─────────────────────────────────────────
function setAcctTxType(acctType) {
  s.acctTxType = acctType;
  document.querySelectorAll('.acct-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.acctType === acctType);
  });
  amountLabelEl.textContent = acctType === 'withdrawal' ? '出金金額' : '入金金額';
  updateAmountDisplay();
  updateAcctLinkVisibility();
  updateSubmitBtnStyle();
}

function updateAcctLinkVisibility() {
  // 出金時のみ家計簿連携を表示
  if (acctLinkGroup) {
    acctLinkGroup.style.display = (s.type === 'account' && s.acctTxType === 'withdrawal') ? 'block' : 'none';
  }
}

// ─────────────────────────────────────────
// 口座チップ描画
// ─────────────────────────────────────────
function renderAccountChips() {
  if (!accountChips) return;
  accountChips.innerHTML = s.accounts.map(a => {
    const isSel = a.id === s.selectedAccountId;
    return `<button class="cat-chip${isSel ? ' selected' : ''}" data-acct-id="${esc(a.id)}">
      🏦 ${esc(a.bank_name || '')} ${esc(a.name)}
    </button>`;
  }).join('');
  accountChips.querySelectorAll('.cat-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      s.selectedAccountId = btn.dataset.acctId;
      renderAccountChips();
      if (navigator.vibrate) navigator.vibrate(20);
    });
  });
}

// ─────────────────────────────────────────
// 口座種類チップ描画
// ─────────────────────────────────────────
function renderAcctCatChips() {
  if (!acctCatChips) return;
  acctCatChips.innerHTML = ACCT_TX_CATS.map(cat => {
    const isSel = cat === s.selectedAcctCat;
    return `<button class="cat-chip${isSel ? ' selected' : ''}" data-acct-cat="${esc(cat)}">
      ${esc(cat)}
    </button>`;
  }).join('');
  acctCatChips.querySelectorAll('.cat-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      s.selectedAcctCat = btn.dataset.acctCat;
      renderAcctCatChips();
      if (navigator.vibrate) navigator.vibrate(20);
    });
  });
}

// ─────────────────────────────────────────
// 詳細パネル
// ─────────────────────────────────────────
function openDetailPanel() {
  s.detailOpen = true;
  panelDate.value = s.selectedDate;
  if (s.type === 'account') {
    renderAccountChips();
    renderAcctCatChips();
    updateAcctLinkVisibility();
  } else {
    renderCategoryChips();
    renderMemoSuggestions();
  }
  updateSubmitBtnStyle();

  detailBackdrop.style.display = 'block';
  detailPanel.style.display    = 'flex';
  detailPanel.classList.remove('closing');
}

function closeDetailPanel() {
  if (!s.detailOpen) return;
  detailPanel.classList.add('closing');
  setTimeout(() => {
    detailPanel.style.display    = 'none';
    detailBackdrop.style.display = 'none';
    detailPanel.classList.remove('closing');
    s.detailOpen = false;
  }, 240);
}

function updateSubmitBtnStyle() {
  const isExpenseLike = s.type === 'expense' || (s.type === 'account' && s.acctTxType === 'withdrawal');
  submitBtn.className = 'submit-btn ' + (isExpenseLike ? 'expense-mode' : 'income-mode');
}

// ─────────────────────────────────────────
// 日付クイック選択
// ─────────────────────────────────────────
function setDateOffset(offset) {
  s.dateOffset = offset;
  s.selectedDate = offsetDateStr(offset);
  panelDate.value = s.selectedDate;

  document.querySelectorAll('.date-quick-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.offset) === offset);
  });
}

// ─────────────────────────────────────────
// カテゴリチップ描画
// ─────────────────────────────────────────
function renderCategoryChips() {
  const cats = s.type === 'expense' ? s.expenseCats : s.incomeCats;
  categoryChips.innerHTML = cats.map(cat => {
    const icon = CAT_ICONS[cat] || '🏷️';
    const isSel = cat === s.selectedCategory;
    const typeClass = s.type === 'income' ? 'income-chip' : '';
    return `<button class="cat-chip${isSel ? ' selected ' + typeClass : ''}" data-cat="${esc(cat)}">
      ${esc(icon)} ${esc(cat)}
    </button>`;
  }).join('');

  categoryChips.querySelectorAll('.cat-chip').forEach(btn => {
    btn.addEventListener('click', () => selectCategory(btn.dataset.cat));
  });
}

function selectCategory(cat) {
  s.selectedCategory = cat;
  renderCategoryChips();
  if (navigator.vibrate) navigator.vibrate(20);
}

// ─────────────────────────────────────────
// メモ候補描画
// ─────────────────────────────────────────
function renderMemoSuggestions() {
  const recentMemos   = loadRecentMemos();
  const defaultSuggs  = s.type === 'expense' ? MEMO_SUGGESTIONS_EXPENSE : MEMO_SUGGESTIONS_INCOME;
  // 直近メモを先頭に、デフォルト候補を続ける（重複除去）
  const merged = [...new Set([...recentMemos.slice(0, 4), ...defaultSuggs])].slice(0, 8);

  memoSugg.innerHTML = merged.map(m =>
    `<button class="memo-sug-btn" data-memo="${esc(m)}">${esc(m)}</button>`
  ).join('');

  memoSugg.querySelectorAll('.memo-sug-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      panelMemo.value = btn.dataset.memo;
      panelMemo.focus();
    });
  });
}

// ─────────────────────────────────────────
// 登録処理
// ─────────────────────────────────────────
async function handleSubmit() {
  const amount   = parseInt(s.rawAmount || '0', 10);
  const date     = panelDate.value || s.selectedDate;
  const memo     = panelMemo.value.trim();

  // バリデーション
  if (!amount || amount <= 0) {
    showToast('金額を入力してください', 'error'); return;
  }
  if (!date) {
    showToast('日付を選択してください', 'error'); return;
  }

  submitBtn.disabled = true;

  try {
    if (s.type === 'account') {
      await handleAccountSubmit(amount, date, memo);
    } else {
      await handleKakeiboSubmit(amount, date, memo);
    }
  } catch (err) {
    showToast('登録に失敗しました。通信状況をご確認ください。', 'error');
    submitBtn.disabled = false;
  }
}

async function handleKakeiboSubmit(amount, date, memo) {
  const category = s.selectedCategory;
  if (!category) {
    showToast('カテゴリを選択してください', 'error');
    categoryChips.scrollIntoView({ behavior: 'smooth', block: 'center' });
    submitBtn.disabled = false;
    return;
  }

  const created = await apiPost({ date, type: s.type, category, amount, memo });
  s.todayTxs.unshift(created);
  if (memo) saveRecentMemo(memo);

  showSuccessOverlay(s.type, category, amount);

  const continuous = continuousMode.checked;
  if (continuous) {
    setTimeout(() => { hideSuccessOverlay(); resetForm(); }, 900);
  } else {
    closeDetailPanel();
    setTimeout(hideSuccessOverlay, 1100);
    resetAmountOnly();
  }
  if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
}

async function handleAccountSubmit(amount, date, memo) {
  if (!s.selectedAccountId) {
    showToast('口座を選択してください', 'error');
    accountChips.scrollIntoView({ behavior: 'smooth', block: 'center' });
    submitBtn.disabled = false;
    return;
  }
  if (!s.selectedAcctCat) {
    showToast('種類を選択してください', 'error');
    acctCatChips.scrollIntoView({ behavior: 'smooth', block: 'center' });
    submitBtn.disabled = false;
    return;
  }

  const account = s.accounts.find(a => a.id === s.selectedAccountId);
  if (!account) { showToast('口座が見つかりません', 'error'); submitBtn.disabled = false; return; }

  const isDebit = s.acctTxType === 'withdrawal';

  // 家計簿連携（出金時のみ）
  let linkedIncomeTxId = '';
  let linkedExpenseTxId = '';
  const linkMode = isDebit ? (parseInt(acctLinkSelect.value, 10) || LINK_MODE_NONE) : LINK_MODE_NONE;
  const kakeiboMemo = `${account.name}より${memo ? ' / ' + memo : ''}`;

  if (linkMode >= LINK_MODE_INCOME) {
    const incomeCat = s.selectedAcctCat || KAKEIBO_INCOME_FALLBACK;
    const kakeiboCreated = await apiPostKakeibo({
      date, amount, type: 'income', category: incomeCat, memo: kakeiboMemo,
    });
    linkedIncomeTxId = kakeiboCreated.id;
    s.todayTxs.unshift(kakeiboCreated);
  }
  if (linkMode === LINK_MODE_INCOME_EXPENSE) {
    const expenseCat = s.selectedAcctCat || KAKEIBO_EXPENSE_FALLBACK;
    const kakeiboCreated = await apiPostKakeibo({
      date, amount, type: 'expense', category: expenseCat, memo: kakeiboMemo,
    });
    linkedExpenseTxId = kakeiboCreated.id;
    s.todayTxs.unshift(kakeiboCreated);
  }

  // 口座取引登録
  const txData = {
    account_id: s.selectedAccountId,
    date, type: s.acctTxType, amount,
    category: s.selectedAcctCat,
    description: memo,
    related_account_id: '',
    link_mode: linkMode,
    linked_income_tx_id: linkedIncomeTxId,
    linked_expense_tx_id: linkedExpenseTxId,
  };
  await apiPostAcctTx(txData);

  // 口座残高・取引後残高はサーバー側で再計算 (他端末との同時更新でもずれない)
  s.accounts = await apiRecalculateAccounts();

  if (memo) saveRecentMemo(memo);

  showSuccessOverlay('account', s.selectedAcctCat, amount, s.acctTxType);

  const continuous = continuousMode.checked;
  if (continuous) {
    setTimeout(() => { hideSuccessOverlay(); resetForm(); }, 900);
  } else {
    closeDetailPanel();
    setTimeout(hideSuccessOverlay, 1100);
    resetAmountOnly();
  }
  if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
}

function resetAmountOnly() {
  s.rawAmount = '';
  updateAmountDisplay();
  submitBtn.disabled = false;
}

function resetForm() {
  s.rawAmount = '';
  s.selectedCategory = '';
  s.selectedAcctCat = '';
  s.selectedDate = todayStr();
  s.dateOffset = 0;
  s.acctLinkMode = LINK_MODE_NONE;
  panelMemo.value = '';
  panelDate.value = s.selectedDate;
  if (acctLinkSelect) acctLinkSelect.value = String(LINK_MODE_NONE);
  updateAmountDisplay();
  if (s.type === 'account') {
    renderAcctCatChips();
  } else {
    renderCategoryChips();
    renderMemoSuggestions();
  }
  // 日付クイックボタンリセット
  document.querySelectorAll('.date-quick-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.offset) === 0);
  });
  submitBtn.disabled = false;
}

// ─────────────────────────────────────────
// 完了オーバーレイ
// ─────────────────────────────────────────
function showSuccessOverlay(type, category, amount, acctTxType) {
  const icon = successOverlay.querySelector('.success-icon');
  if (type === 'account') {
    icon.className = 'success-icon';
    const label = acctTxType === 'withdrawal' ? '出金' : '入金';
    successMsg.textContent = `口座${label}を登録しました！`;
    successSub.textContent = `${category}  ${formatYen(amount)}`;
  } else {
    icon.className = `success-icon${type === 'expense' ? ' expense' : ''}`;
    successMsg.textContent = type === 'expense' ? '支出を登録しました！' : '収入を登録しました！';
    successSub.textContent = `${CAT_ICONS[category] || '💴'} ${category}  ${formatYen(amount)}`;
  }
  successOverlay.style.display = 'flex';
}

function hideSuccessOverlay() {
  successOverlay.style.display = 'none';
}

// ─────────────────────────────────────────
// 履歴パネル
// ─────────────────────────────────────────
function openHistoryPanel() {
  s.historyOpen = true;
  histBackdrop.style.display  = 'block';
  historyPanel.style.display  = 'flex';
  historyPanel.classList.remove('closing');
  renderHistoryList();
}

function closeHistoryPanel() {
  if (!s.historyOpen) return;
  historyPanel.classList.add('closing');
  setTimeout(() => {
    historyPanel.style.display  = 'none';
    histBackdrop.style.display  = 'none';
    historyPanel.classList.remove('closing');
    s.historyOpen = false;
  }, 240);
}

function renderHistoryList() {
  if (s.todayTxs.length === 0) {
    historyList.innerHTML = '';
    historyEmpty.style.display = 'block';
    historyTotal.textContent   = '';
    return;
  }
  historyEmpty.style.display = 'none';

  const totalExpense = s.todayTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+Number(t.amount),0);
  const totalIncome  = s.todayTxs.filter(t=>t.type==='income' ).reduce((s,t)=>s+Number(t.amount),0);
  historyTotal.textContent = `支出 ${formatYen(totalExpense)} / 収入 ${formatYen(totalIncome)}`;

  historyList.innerHTML = s.todayTxs.map(tx => `
    <div class="history-item">
      <div class="hist-icon ${esc(tx.type)}">${esc(CAT_ICONS[tx.category] || '💴')}</div>
      <div class="hist-details">
        <div class="hist-cat">${esc(tx.category)}</div>
        <div class="hist-meta">${esc(formatDateJP(tx.date))}${tx.memo ? ' · ' + esc(tx.memo) : ''}</div>
      </div>
      <div class="hist-amount ${tx.type}">
        ${tx.type === 'income' ? '+' : '−'}${formatYen(tx.amount)}
      </div>
    </div>
  `).join('');
}

// ─────────────────────────────────────────
// カテゴリ追加モーダル
// ─────────────────────────────────────────
const catModalOverlay = $('cat-modal-overlay');
const newCatInput     = $('new-cat-input');

function openCatModal() {
  catModalOverlay.style.display = 'flex';
  newCatInput.value = '';
  setTimeout(() => newCatInput.focus(), 80);
}
function closeCatModal() { catModalOverlay.style.display = 'none'; }

function addCategory() {
  const name = newCatInput.value.trim();
  if (!name) { showToast('カテゴリ名を入力してください', 'error'); return; }
  if (name.length > 30) { showToast('カテゴリ名は30文字以内で入力してください', 'error'); return; }

  const arr = s.type === 'expense' ? s.expenseCats : s.incomeCats;
  if (arr.includes(name)) { showToast('同じカテゴリが既に存在します', 'info'); return; }

  arr.push(name);
  CAT_ICONS[name] = '🏷️';
  saveCats(s.type);

  closeCatModal();
  s.selectedCategory = name;
  renderCategoryChips();
  showToast(`「${name}」を追加しました`);
}

// ─────────────────────────────────────────
// トースト
// ─────────────────────────────────────────
function showToast(msg, type = 'success') {
  const container = $('mob-toast-container');
  const toast = document.createElement('div');
  toast.className = `mob-toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastFade 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ─────────────────────────────────────────
// キーボードショートカット（デスクトップ）
// ─────────────────────────────────────────
function handleKeyboard(e) {
  if (catModalOverlay.style.display === 'flex') {
    if (e.key === 'Enter')  { e.preventDefault(); addCategory(); }
    if (e.key === 'Escape') closeCatModal();
    return;
  }
  if (s.detailOpen) {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleSubmit(); }
    if (e.key === 'Escape') closeDetailPanel();
    return;
  }
  if (s.historyOpen) {
    if (e.key === 'Escape') closeHistoryPanel();
    return;
  }
  // テンキー操作
  if (/^[0-9]$/.test(e.key)) handleNumpad(e.key);
  if (e.key === 'Backspace') handleNumpad('DEL');
  if (e.key === 'Delete')    handleNumpad('C');
  if (e.key === 'Enter')     handleNumpad('NEXT');
}

// ─────────────────────────────────────────
// 初期化
// ─────────────────────────────────────────
async function init() {
  // 今日の既存取引を取得（履歴表示用）
  try {
    s.todayTxs = await apiGetToday();
  } catch {}
  // 口座一覧を取得
  try {
    s.accounts = await apiGetAccounts();
    if (s.accounts.length > 0) s.selectedAccountId = s.accounts[0].id;
  } catch {}

  // テンキーイベント
  document.querySelectorAll('.numpad-btn').forEach(btn => {
    btn.addEventListener('click', () => handleNumpad(btn.dataset.val));
  });

  // 収支タブ
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => setType(btn.dataset.type));
  });

  // 口座 入金/出金切替
  document.querySelectorAll('.acct-type-btn').forEach(btn => {
    btn.addEventListener('click', () => setAcctTxType(btn.dataset.acctType));
  });

  // 詳細パネル：バックドロップ
  detailBackdrop.addEventListener('click', closeDetailPanel);

  // 詳細パネル：日付
  document.querySelectorAll('.date-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => setDateOffset(Number(btn.dataset.offset)));
  });
  panelDate.addEventListener('change', e => {
    s.selectedDate = e.target.value;
    s.dateOffset   = null;
    document.querySelectorAll('.date-quick-btn').forEach(b => b.classList.remove('active'));
  });

  // 詳細パネル：カテゴリ追加
  $('add-cat-btn').addEventListener('click', openCatModal);
  $('cat-modal-cancel').addEventListener('click', closeCatModal);
  $('cat-modal-add').addEventListener('click', addCategory);
  newCatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); addCategory(); }
    if (e.key === 'Escape') closeCatModal();
  });

  // 詳細パネル：登録ボタン
  submitBtn.addEventListener('click', handleSubmit);

  // 履歴パネル
  $('history-toggle-btn').addEventListener('click', openHistoryPanel);
  histBackdrop.addEventListener('click', closeHistoryPanel);

  // キーボード
  document.addEventListener('keydown', handleKeyboard);

  // 完了オーバーレイタップ
  successOverlay.addEventListener('click', hideSuccessOverlay);

  // 初期表示
  updateAmountDisplay();
  panelDate.value = s.selectedDate;
  setDateOffset(0);
}

document.addEventListener('DOMContentLoaded', init);
