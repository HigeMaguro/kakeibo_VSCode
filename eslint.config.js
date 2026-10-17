/**
 * ESLint 設定 (flat config)。実行: npm run lint
 * サーバー (CommonJS / Node) とブラウザ (app/js, スクリプトタグで読み込む) を分けて定義。
 */

'use strict';

const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable', __dirname: 'readonly', __filename: 'readonly',
  process: 'readonly', console: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
};

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', localStorage: 'readonly', console: 'readonly',
  fetch: 'readonly', URLSearchParams: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  confirm: 'readonly', alert: 'readonly', Chart: 'readonly',
  // js/common.js が公開
  Kakeibo: 'readonly',
};

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  eqeqeq: ['warn', 'smart'],
};

module.exports = [
  { ignores: ['node_modules/**', 'bin/**', 'obj/**', 'data/**', 'backups/**'] },
  {
    files: ['server.js', 'server/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: nodeGlobals },
    rules,
  },
  {
    files: ['app/js/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: browserGlobals },
    // onclick="..." から呼ばれる関数は未使用扱いになるため警告を緩める
    rules: { ...rules, 'no-unused-vars': 'off' },
  },
  // index.html で accounts.js と app.js が相互参照するグローバル (typeof で存在確認して使う)
  {
    files: ['app/js/accounts.js'],
    languageOptions: { globals: { state: 'readonly', renderMonthlySummaryBar: 'readonly' } },
  },
  {
    files: ['app/js/app.js'],
    languageOptions: { globals: { renderAccountsPage: 'readonly' } },
  },
];
