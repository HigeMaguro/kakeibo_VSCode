/**
 * make-report.js - Excel エクスポートデータに集計・グラフレポートを追加するCLI
 *
 * 使い方:
 *   node scripts/make-report.js              # exceldata/ 内の最新 xlsx を処理
 *   node scripts/make-report.js mykakeibo.xlsx # ファイル指定
 *
 * 出力:
 *   <入力名>_report.xlsx  (元ファイルと同じディレクトリ)
 *
 * チェックボックス化 (Excel 365):
 *   「設定」シートの集計対象列 (C2:C..) を選択 →
 *   挿入 → チェックボックス で TRUE/FALSE セルが本物のチェックボックスに変換される。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { addReportToWorkbook } = require('./lib/report-builder');

async function main() {
  const input = resolveInput(process.argv[2]);
  if (!input) {
    console.error('使い方: node scripts/make-report.js [xlsxファイル または exceldata内のファイル名]');
    console.error('  (exceldata/ 内の最新 xlsx を自動選択します)');
    process.exit(1);
  }
  console.log(`入力: ${input}`);
  const outPath = input.replace(/\.xlsx$/i, '') + '_report.xlsx';

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(input);

  const buf = await addReportToWorkbook(wb);

  await fs.promises.writeFile(outPath, buf);
  console.log(`出力: ${outPath} (${(buf.length / 1024).toFixed(1)} KB)`);
  console.log('');
  console.log('使い方:');
  console.log('  1. 「設定」シートの「集計対象」列 (TRUE/FALSE) を変更すると全グラフが自動更新');
  console.log('  2. Excel 365: 集計対象列を選択 → 挿入 → チェックボックス でチェックボックス化');
  console.log('  3. 大区分は「設定」シート B 列を自由に編集可 (集計・グラフへ反映)');
}

function resolveInput(arg) {
  if (arg) {
    const candidates = path.isAbsolute(arg) ? [arg] : [arg, path.join(process.cwd(), 'exceldata', arg)];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
  }
  const dirs = [
    path.join(process.cwd(), 'exceldata'),
    path.join(__dirname, '..', '..', '..', 'exceldata'),
    path.join(__dirname, '..', 'exceldata'),
  ];
  for (const d of dirs) {
    if (fs.existsSync(d)) {
      const files = fs.readdirSync(d)
        .filter((f) => /\.xlsx$/i.test(f) && !/_report\.xlsx$/i.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (files.length > 0) return path.join(d, files[0].f);
    }
  }
  return null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});