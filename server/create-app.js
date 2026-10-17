/**
 * server/create-app.js - Express アプリケーションの組み立て
 *
 * server.js (起動エントリ) とテスト (test/*.test.js) の両方から使う。
 * 新しい API を追加する場合は server/<機能>.js に Router を作り、ここで app.use() する。
 */

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { createTablesRouter } = require('./tables');
const { createExportRouter } = require('./export');
const { createAccountsRouter } = require('./accounts');

const ROOT_DIR = path.join(__dirname, '..');

function readAppVersion() {
  if (process.env.APP_VERSION && process.env.APP_VERSION !== 'dev') return process.env.APP_VERSION;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    return pkg.version || process.env.APP_VERSION || 'unknown';
  } catch {
    return process.env.APP_VERSION || 'unknown';
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ appDir?: string }} [options]
 */
function createApp(db, options = {}) {
  const appDir = options.appDir || path.join(ROOT_DIR, 'app');
  const appVersion = readAppVersion();
  const app = express();

  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ── ヘルスチェック ──
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
  });

  // ── バージョン情報 ──
  app.get('/api/version', (req, res) => {
    res.json({
      version: appVersion,
      build_date: process.env.BUILD_DATE || '',
      node: process.version,
      uptime: process.uptime(),
    });
  });

  // ── API ──
  app.use('/tables', createTablesRouter(db));
  app.use('/api', createExportRouter(db));
  app.use('/api', createAccountsRouter(db));

  // 未定義の API は JSON で 404 (SPA フォールバックに飲み込ませない)
  app.use(['/api', '/tables'], (req, res) => {
    res.status(404).json({ error: `API が見つかりません: ${req.method} ${req.originalUrl}` });
  });

  // ── 静的ファイル配信 (app ディレクトリ) ──
  // HTML/JS/CSS はキャッシュさせず、デプロイ直後から新版が反映されるようにする
  app.use(express.static(appDir, {
    setHeaders(res, filePath) {
      if (/\.(html?|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  // ── SPA / ルートフォールバック ──
  app.get('*', (req, res) => {
    const indexPath = path.join(appDir, 'index.html');
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send('Not Found');
  });

  // ── エラーハンドラ (JSON パースエラー等) ──
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[Unhandled]', err);
    res.status(status).json({ error: status >= 500 ? 'サーバーエラーが発生しました' : 'リクエストが不正です', details: err.message });
  });

  return app;
}

module.exports = { createApp };
