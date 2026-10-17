/**
 * report-builder.js - 家計簿データ (ExcelJS Workbook) に集計・グラフレポートを追加
 *
 * server.js (/api/export/excel) と scripts/make-report.js の共通実装。
 * ExcelJS ワークブック (収支データ含む) に以下を追加する:
 *   - 収支データの作業列 (F:年月 G:大区分 H:集計フラグ)
 *   - 「設定」シート (科目→大区分マッピング + 集計対象 TRUE/FALSE)
 *   - 「集計」シート (SUMIFS 数式 = チェック連動)
 *   - 「グラフ」シート (チャート4種。xlsx-charts.js で XML 埋込)
 *
 * 使い方:
 *   const { addReportToWorkbook } = require('./report-builder');
 *   const wb = new ExcelJS.Workbook();  // 「収支データ」シート必須
 *   ...シート構築...
 *   const buf = await addReportToWorkbook(wb);  // チャート埋込済みバッファを返す
 */

'use strict';

const { embedCharts, quoteSheet } = require('./xlsx-charts');

// ─────────────────────────────────────────
// 大区分の初期マッピング (未定義科目は「その他」)
// ─────────────────────────────────────────
const MAJOR_CATEGORY_MAP = {
  '食費': '食料品',
  '菓子': '食料品',
  '飲料': '食料品',
  '惣菜・弁当': '食料品',
  '惣菜': '食料品',
  '調味料': '食料品',
  '外食': '食料品',
  '食材': '食料品',
  '日用品': '生活用品',
  '乾燥機': '生活用品',
  '洗剤': '生活用品',
  '衣類': '生活用品',
  '猫': 'ペット',
  'ペット': 'ペット',
  'ペットフード': 'ペット',
  '通信費': '通信・情報',
  'NHK': '通信・情報',
  '新聞': '通信・情報',
  '書籍': '通信・情報',
  '光熱費': '公共・住居',
  '電気代': '公共・住居',
  'ガス代': '公共・住居',
  '水道代': '公共・住居',
  '公共料金': '公共・住居',
  '住居': '公共・住居',
  '家賃': '公共・住居',
  '医療費': '医療・保険',
  '薬代': '医療・保険',
  '保険': '医療・保険',
  '娯楽': '娯楽・交際',
  '交際費': '娯楽・交際',
  '趣味': '娯楽・交際',
  '旅行': '娯楽・交際',
  'スポーツ': '娯楽・交際',
  'カード引落': '金融',
  '税金': '金融',
  'その他': 'その他',
};

const MAJOR_ORDER = ['食料品', '生活用品', 'ペット', '通信・情報', '公共・住居', '医療・保険', '娯楽・交際', '金融', 'その他'];
const PALETTE = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '264478', '9E480E', '636363', '997300', 'E8B4B8', '7B68A6'];

// ─────────────────────────────────────────
// メイン: ワークブックにレポートを追加し、チャート埋込済みバッファを返す
// ─────────────────────────────────────────
async function addReportToWorkbook(wb) {
  const txSheet = wb.getWorksheet('収支データ');
  if (!txSheet) throw new Error('「収支データ」シートが見つかりません');

  const { months, expenseCats, txLastRow } = parseTransactions(txSheet);
  if (months.length === 0 || expenseCats.length === 0) {
    // レポート対象なし: そのままバッファ返却
    return wb.xlsx.writeBuffer();
  }

  addHelperColumns(txSheet, txLastRow);

  const catToMajor = {};
  expenseCats.forEach((c) => { catToMajor[c] = MAJOR_CATEGORY_MAP[c] || 'その他'; });
  const majors = [...MAJOR_ORDER];
  Object.values(catToMajor).forEach((mj) => { if (!majors.includes(mj)) majors.push(mj); });

  const cfgSheet = wb.addWorksheet('設定');
  buildConfigSheet(cfgSheet, expenseCats, catToMajor, majors);

  const aggSheet = wb.addWorksheet('集計');
  const pos = buildAggSheet(aggSheet, months, expenseCats, majors, txLastRow);

  const graphSheet = wb.addWorksheet('グラフ');
  buildGraphSheet(graphSheet);

  const chartDefs = buildChartDefs(pos, months, expenseCats, majors);
  const buf = await wb.xlsx.writeBuffer();
  return embedCharts(buf, chartDefs);
}

// ─────────────────────────────────────────
// 収支データ解析
// ─────────────────────────────────────────
function parseTransactions(txSheet) {
  const months = [];
  const expenseCats = [];
  const monthSet = new Set();
  const catSet = new Set();
  let txLastRow = 1;

  for (let r = 2; r <= txSheet.rowCount; r++) {
    const v = txSheet.getRow(r).values;
    const dateCell = v[1];
    const type = v[2];
    const cat = v[3];
    if (dateCell == null || dateCell === '') continue;
    txLastRow = r;

    const month = extractMonth(dateCell);
    if (!month) continue;

    if (type === '支出' && cat) {
      if (!catSet.has(cat)) { catSet.add(cat); expenseCats.push(cat); }
      monthSet.add(month);
    } else if (type === '収入') {
      monthSet.add(month);
    }
  }
  months.push(...[...monthSet].sort());
  return { months, expenseCats, txLastRow };
}

function extractMonth(dateCell) {
  if (dateCell instanceof Date) {
    return `${dateCell.getFullYear()}-${String(dateCell.getMonth() + 1).padStart(2, '0')}`;
  }
  if (typeof dateCell === 'object' && dateCell !== null) {
    if (dateCell.result instanceof Date) {
      const d = dateCell.result;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    if (typeof dateCell.text === 'string') return dateCell.text.slice(0, 7);
    if (typeof dateCell.result === 'string') return dateCell.result.slice(0, 7);
  }
  const s = String(dateCell);
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null;
}

// ─────────────────────────────────────────
// 収支データに作業列追加
//   F: 年月 =TEXT(A,"yyyy-mm")
//   G: 大区分 =IF(B="支出", VLOOKUP(C, 設定!A:B, 2, FALSE), "")
//   H: 集計フラグ =IF(B="支出", VLOOKUP(C, 設定!A:C, 3, FALSE), FALSE)
// ─────────────────────────────────────────
function addHelperColumns(txSheet, txLastRow) {
  const header = txSheet.getRow(1);
  header.getCell(6).value = '年月';
  header.getCell(7).value = '大区分';
  header.getCell(8).value = '集計フラグ';
  [6, 7, 8].forEach((c) => {
    const cell = header.getCell(c);
    cell.font = { bold: true, color: { argb: 'FF7F7F7F' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
  });

  for (let r = 2; r <= txLastRow; r++) {
    txSheet.getCell(r, 6).value = { formula: `TEXT(A${r},"yyyy-mm")` };
    txSheet.getCell(r, 7).value = { formula: `IF(B${r}="支出",IFERROR(VLOOKUP(C${r},設定!$A$2:$B$200,2,FALSE),"その他"),"")` };
    txSheet.getCell(r, 8).value = { formula: `IF(B${r}="支出",IFERROR(VLOOKUP(C${r},設定!$A$2:$C$200,3,FALSE),FALSE),FALSE)` };
  }
}

// ─────────────────────────────────────────
// 「設定」シート
// ─────────────────────────────────────────
function buildConfigSheet(cfg, expenseCats, catToMajor, majors) {
  cfg.columns = [
    { header: '科目', key: 'cat', width: 16 },
    { header: '大区分', key: 'major', width: 14 },
    { header: '集計対象', key: 'flag', width: 12 },
  ];
  const header = cfg.getRow(1);
  header.font = { bold: true, color: { argb: 'FF1F3864' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };

  expenseCats.forEach((cat, i) => {
    const row = cfg.getRow(i + 2);
    row.getCell(1).value = cat;
    row.getCell(2).value = catToMajor[cat];
    const flagCell = row.getCell(3);
    flagCell.value = true;
    flagCell.alignment = { horizontal: 'center' };
  });
  const lastRow = expenseCats.length + 1;

  const noteRow = lastRow + 2;
  cfg.getCell(noteRow, 1).value = '大区分リスト (参考):';
  cfg.getCell(noteRow, 1).font = { bold: true };
  majors.forEach((mj, i) => {
    cfg.getCell(noteRow, 2 + i).value = mj;
  });

  cfg.views = [{ state: 'frozen', ySplit: 1 }];
  cfg.autoFilter = { from: 'A1', to: { row: 1, column: 3 } };
}

// ─────────────────────────────────────────
// 「集計」シート (SUMIFS 数式)
//   収支データ: D=金額 F=年月 G=大区分 H=集計フラグ C=科目
// ─────────────────────────────────────────
function buildAggSheet(agg, months, expenseCats, majors, txLastRow) {
  const txQ = quoteSheet('収支データ');
  const D = `${txQ}!$D$2:$D$${txLastRow}`;
  const F = `${txQ}!$F$2:$F$${txLastRow}`;
  const G = `${txQ}!$G$2:$G$${txLastRow}`;
  const H = `${txQ}!$H$2:$H$${txLastRow}`;
  const C2 = `${txQ}!$C$2:$C$${txLastRow}`;

  // === A. 月別×大区分 ===
  agg.getCell(1, 1).value = 'A. 月別×大区分 支出額';
  agg.getCell(1, 1).font = { bold: true, size: 12 };
  const A_HEAD = 2;
  agg.getCell(A_HEAD, 1).value = '年月';
  majors.forEach((mj, i) => { agg.getCell(A_HEAD, 2 + i).value = mj; });
  styleAggHeader(agg, A_HEAD, 1 + majors.length);

  months.forEach((month, mi) => {
    const row = A_HEAD + 1 + mi;
    agg.getCell(row, 1).value = month;
    majors.forEach((mj, ci) => {
      const cell = agg.getCell(row, 2 + ci);
      cell.value = { formula: `SUMIFS(${D},${F},$A${row},${G},${colLetter(2 + ci)}$${A_HEAD},${H},TRUE)` };
      cell.numFmt = '#,##0';
    });
  });
  const A_LAST = A_HEAD + months.length;

  // === B. 月別×科目 ===
  const B_TITLE_ROW = A_LAST + 2;
  const B_HEAD = B_TITLE_ROW + 1;
  agg.getCell(B_TITLE_ROW, 1).value = 'B. 月別×科目 支出額';
  agg.getCell(B_TITLE_ROW, 1).font = { bold: true, size: 12 };
  agg.getCell(B_HEAD, 1).value = '年月';
  expenseCats.forEach((cat, i) => { agg.getCell(B_HEAD, 2 + i).value = cat; });
  styleAggHeader(agg, B_HEAD, 1 + expenseCats.length);

  months.forEach((month, mi) => {
    const row = B_HEAD + 1 + mi;
    agg.getCell(row, 1).value = month;
    expenseCats.forEach((cat, ci) => {
      const cell = agg.getCell(row, 2 + ci);
      cell.value = { formula: `SUMIFS(${D},${F},$A${row},${C2},${colLetter(2 + ci)}$${B_HEAD},${H},TRUE)` };
      cell.numFmt = '#,##0';
    });
  });
  const B_LAST = B_HEAD + months.length;

  // === C. 期間合計 ===
  const C_TITLE_ROW = B_LAST + 2;
  const C_HEAD = C_TITLE_ROW + 1;
  agg.getCell(C_TITLE_ROW, 1).value = 'C. 期間合計';
  agg.getCell(C_TITLE_ROW, 1).font = { bold: true, size: 12 };
  agg.getCell(C_HEAD, 1).value = '大区分';
  agg.getCell(C_HEAD, 2).value = '合計支出';
  agg.getCell(C_HEAD, 4).value = '科目';
  agg.getCell(C_HEAD, 5).value = '合計支出';
  styleAggHeader(agg, C_HEAD, 5);

  majors.forEach((mj, ci) => {
    const row = C_HEAD + 1 + ci;
    const col = colLetter(2 + ci);
    agg.getCell(row, 1).value = mj;
    const cell = agg.getCell(row, 2);
    cell.value = { formula: `SUM(${col}${A_HEAD + 1}:${col}${A_LAST})` };
    cell.numFmt = '"¥"#,##0';
  });
  expenseCats.forEach((cat, ci) => {
    const row = C_HEAD + 1 + ci;
    const col = colLetter(2 + ci);
    agg.getCell(row, 4).value = cat;
    const cell = agg.getCell(row, 5);
    cell.value = { formula: `SUM(${col}${B_HEAD + 1}:${col}${B_LAST})` };
    cell.numFmt = '"¥"#,##0';
  });

  return {
    aHead: A_HEAD, aFirst: A_HEAD + 1, aLast: A_LAST,
    bHead: B_HEAD, bFirst: B_HEAD + 1, bLast: B_LAST,
    cHead: C_HEAD, cFirst: C_HEAD + 1,
  };
}

function styleAggHeader(sheet, row, colCount) {
  for (let c = 1; c <= colCount; c++) {
    const cell = sheet.getCell(row, c);
    cell.font = { bold: true, color: { argb: 'FF1F3864' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
  }
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ─────────────────────────────────────────
// 「グラフ」シート (見出しのみ。チャートは XML 配置)
// ─────────────────────────────────────────
function buildGraphSheet(gs) {
  gs.getCell(1, 1).value = '家計簿レポート';
  gs.getCell(1, 1).font = { bold: true, size: 14 };
  gs.getCell(2, 1).value = '※ グラフは「設定」シートの集計対象 (TRUE/FALSE) に連動します';
  gs.getCell(2, 1).font = { color: { argb: 'FF666666' } };
}

// ─────────────────────────────────────────
// チャート定義
// ─────────────────────────────────────────
function buildChartDefs(pos, months, expenseCats, majors) {
  const q = quoteSheet('集計');
  const charts = [];

  const majorSeries = () => majors.map((mj, ci) => ({
    name: mj,
    nameRef: `${q}!$${colLetter(2 + ci)}$${pos.aHead}`,
    catRef: `${q}!$A$${pos.aFirst}:$A$${pos.aLast}`,
    valRef: `${q}!$${colLetter(2 + ci)}$${pos.aFirst}:$${colLetter(2 + ci)}$${pos.aLast}`,
    cats: months.slice(),
    vals: months.map(() => 0),
    color: PALETTE[ci % PALETTE.length],
    formatCode: '#,##0',
  }));

  charts.push({
    type: 'bar',
    stacked: true,
    title: '月別支出 大区分別 (積み上げ)',
    sheetName: 'グラフ',
    anchor: { fromCol: 0, fromRow: 3, toCol: 9, toRow: 23 },
    series: majorSeries(),
    valNumFmt: '#,##0',
  });

  charts.push({
    type: 'bar',
    title: '月別支出 大区分別 (比較)',
    sheetName: 'グラフ',
    anchor: { fromCol: 0, fromRow: 25, toCol: 9, toRow: 45 },
    series: majorSeries(),
    valNumFmt: '#,##0',
  });

  charts.push({
    type: 'bar',
    horizontal: true,
    title: '大区分別 合計支出',
    sheetName: 'グラフ',
    anchor: { fromCol: 11, fromRow: 3, toCol: 20, toRow: 23 },
    series: [{
      name: '合計支出',
      catRef: `${q}!$A$${pos.cFirst}:$A$${pos.cFirst + majors.length - 1}`,
      valRef: `${q}!$B$${pos.cFirst}:$B$${pos.cFirst + majors.length - 1}`,
      cats: majors.slice(),
      vals: majors.map(() => 0),
      color: '4472C4',
      formatCode: '#,##0',
    }],
    valNumFmt: '#,##0',
  });

  charts.push({
    type: 'pie',
    title: '科目別 合計支出 (割合)',
    sheetName: 'グラフ',
    anchor: { fromCol: 11, fromRow: 25, toCol: 20, toRow: 45 },
    series: [{
      name: '合計支出',
      catRef: `${q}!$D$${pos.cFirst}:$D$${pos.cFirst + expenseCats.length - 1}`,
      valRef: `${q}!$E$${pos.cFirst}:$E$${pos.cFirst + expenseCats.length - 1}`,
      cats: expenseCats.slice(),
      vals: expenseCats.map(() => 0),
      colors: expenseCats.map((_, i) => PALETTE[i % PALETTE.length]),
      formatCode: '#,##0',
    }],
  });

  return charts;
}

module.exports = { addReportToWorkbook, MAJOR_CATEGORY_MAP };