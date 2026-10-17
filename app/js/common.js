/**
 * MyKakeibo - 画面共通ユーティリティ
 * js/common.js  (index.html / mobile-input.html の両方で最初に読み込む)
 *
 * グローバル `Kakeibo` 名前空間に公開する。新機能では各ファイルに
 * 同じ処理を複製せず、ここに追加して使うこと。
 */

'use strict';

(function (global) {
  const API_TABLES = 'tables';
  const PAGE_SIZE = 5000; // サーバー側 MAX_LIMIT と一致させる

  /** HTML 特殊文字をエスケープ (innerHTML へ埋め込むユーザー入力には必ず使う) */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** ローカル日付の 'YYYY-MM-DD' (toISOString は UTC になるので使わない) */
  function localDateString(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatYen(amount) {
    return '¥' + Math.round(Number(amount) || 0).toLocaleString('ja-JP');
  }

  /** 円単位に丸める (浮動小数の誤差対策) */
  function toYen(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }

  async function request(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let json = null;
    try { json = await res.json(); } catch { /* 204 等 */ }
    if (!res.ok) {
      const msg = (json && (json.details || json.error)) || res.statusText;
      const err = new Error(`API error ${res.status}: ${method} ${path} - ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /**
   * テーブルの全件を取得する (サーバーの上限件数ごとにページングして連結)。
   * @param {string} table
   * @param {Record<string,string|number>} [params] フィルタ・sort
   * @returns {Promise<object[]>}
   */
  async function fetchAllRows(table, params = {}) {
    const rows = [];
    let offset = 0;
    for (;;) {
      const qs = new URLSearchParams({ ...params, limit: PAGE_SIZE, offset }).toString();
      const res = await request('GET', `${API_TABLES}/${table}?${qs}`);
      const data = (res && res.data) || [];
      rows.push(...data);
      offset += data.length;
      if (data.length === 0 || offset >= (res.total || 0)) break;
    }
    return rows;
  }

  const api = {
    list: (table, params = {}) =>
      request('GET', `${API_TABLES}/${table}?${new URLSearchParams(params).toString()}`),
    all: fetchAllRows,
    get: (table, id) => request('GET', `${API_TABLES}/${table}/${encodeURIComponent(id)}`),
    create: (table, data) => request('POST', `${API_TABLES}/${table}`, data),
    update: (table, id, data) => request('PUT', `${API_TABLES}/${table}/${encodeURIComponent(id)}`, data),
    remove: (table, id) => request('DELETE', `${API_TABLES}/${table}/${encodeURIComponent(id)}`),
    post: (path, data) => request('POST', path, data || {}),
    request,
  };

  global.Kakeibo = Object.freeze({
    escapeHtml,
    localDateString,
    formatYen,
    toYen,
    fetchAllRows,
    api,
  });
})(window);
