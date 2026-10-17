/**
 * xlsx-charts.js - ExcelJS 生成ファイルへ OOXML チャートを埋め込むヘルパー
 *
 * ExcelJS はチャート生成をサポートしないため、xlsx (zip) 構造に
 * DrawingML チャート XML を直接注入する。
 *
 * 使い方:
 *   const { embedCharts } = require('./lib/xlsx-charts');
 *   const buf = await wb.xlsx.writeBuffer();
 *   const charts = [
 *     {
 *       type: 'bar' | 'line' | 'pie' | 'doughnut',   // bar は stacked/horizontal オプション可
 *       title: 'チャートタイトル',
 *       sheetName: 'グラフ',                          // チャートを配置するシート名
 *       anchor: { fromCol: 0, fromRow: 0, toCol: 10, toRow: 20 },
 *       series: [
 *         {
 *           name: '系列名',
 *           nameRef: "シート!$A$1",                  // 系列名セル参照 (任意)
 *           catRef: "シート!$A$2:$A$10",            // 分類参照 (bar/line/pie)
 *           valRef: "シート!$B$2:$B$10",            // 値参照
 *           cats: ['8月', '9月'],                    // 分類キャッシュ (任意、表示安定化)
 *           vals: [100, 200],                        // 値キャッシュ (任意)
 *           color: '4472C4',                        // 系列色 (bar/line)
 *           colors: ['4472C4', ...],                 // データポイント色 (pie/doughnut)
 *           formatCode: '#,##0',                     // 値の表示書式 (任意)
 *         },
 *       ],
 *     },
 *   ];
 *   const outBuf = await embedCharts(buf, charts);
 */

'use strict';

const JSZip = require('jszip');

// ─────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────
function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// シート名を数式参照用に引用 ('グラフ' などの空白・非ASCII対策は常に引用)
function quoteSheet(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

// セル参照文字列を絶対参照に正規化: A2:A100 → $A$2:$A$100
function absRange(ref) {
  const norm = (s) => s.replace(/\$?([A-Z]{1,3})\$?(\d+)/, '$$$1$$$2');
  const m = String(ref).match(/^(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?$/);
  if (!m) return String(ref);
  return m[2] ? `${norm(m[1])}:${norm(m[2])}` : norm(m[1]);
}

// シート名 + 範囲 → 数式参照 '設定'!$A$2:$A$20
function absRef(sheetName, ref) {
  return `${quoteSheet(sheetName)}!${absRange(ref)}`;
}

// ─────────────────────────────────────────
// 系列 XML 生成
// ─────────────────────────────────────────
function serXml(ser, idx, chartType) {
  const isPie = chartType === 'pie' || chartType === 'doughnut';
  const isLine = chartType === 'line';
  const color = ser.color || '4472C4';

  // pie/doughnut: spPr を ser に付けない (dPt 側で色指定)
  let spPr = '';
  if (!isPie) {
    spPr = isLine
      ? `<c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>`
      : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr>`;
  }

  // pie/doughnut は各データポイントに色
  let dPtXml = '';
  if (isPie && ser.colors) {
    dPtXml = ser.colors.map((c, i) =>
      `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${c}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`
    ).join('');
  }

  const markerXml = isLine
    ? `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr></c:marker>`
    : `<c:marker><c:symbol val="none"/></c:marker>`;

  // キャッシュ (Excel 表示の安定化。数式セルの場合は vals に初期値を渡す)
  const catCache = ser.cats != null
    ? `<c:strCache><c:ptCount val="${ser.cats.length}"/>${ser.cats.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strCache>`
    : '';
  const valCache = ser.vals != null
    ? `<c:numCache><c:formatCode>${esc(ser.formatCode || 'General')}</c:formatCode><c:ptCount val="${ser.vals.length}"/>${ser.vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v == null ? 0 : v}</c:v></c:pt>`).join('')}</c:numCache>`
    : '';

  const catRef = ser.catRef ? `<c:cat><c:strRef><c:f>${esc(ser.catRef)}</c:f>${catCache}</c:strRef></c:cat>` : '';
  const valRef = ser.valRef ? `<c:val><c:numRef><c:f>${esc(ser.valRef)}</c:f>${valCache}</c:numRef></c:val>` : '';
  const nameRef = ser.nameRef
    ? `<c:tx><c:strRef><c:f>${esc(ser.nameRef)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(ser.name || '')}</c:v></c:pt></c:strCache></c:strRef></c:tx>`
    : `<c:tx><c:v>${esc(ser.name || `系列${idx + 1}`)}</c:v></c:tx>`;

  // pie はラベルに割合表示。それ以外はラベルなし
  // ※ スキーマ順 (CT_BarSer): idx, order, tx, spPr, invertIfNegative, dPt, dLbls, cat, val
  const dLbls = isPie
    ? `<c:dLbls><c:numFmt formatCode="0.0%" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:endParaRPr lang="ja-JP"/></a:p></c:txPr><c:dLblPos val="bestFit"/><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/></c:dLbls>`
    : `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`;

  const invertIfNegative = (chartType === 'bar') ? '<c:invertIfNegative val="0"/>' : '';

  return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/>${nameRef}${spPr}${invertIfNegative}${dPtXml}${markerXml}${dLbls}${catRef}${valRef}</c:ser>`;
}

// ─────────────────────────────────────────
// 軸 XML (bar/line 用)
// ─────────────────────────────────────────
function axesXml(axIdCat, axIdVal, valNumFmt) {
  return `<c:catAx><c:axId val="${axIdCat}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="ja-JP"/></a:p></c:txPr><c:crossAx val="${axIdVal}"/></c:catAx>` +
    `<c:valAx><c:axId val="${axIdVal}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="${esc(valNumFmt || '#,##0')}" sourceLinked="0"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="ja-JP"/></a:p></c:txPr><c:crossAx val="${axIdCat}"/></c:valAx>`;
}

// ─────────────────────────────────────────
// チャート本体 XML
// ─────────────────────────────────────────
function chartXml(chart) {
  const axIdCat = 100000000 + Math.floor(Math.random() * 80000000);
  const axIdVal = axIdCat + 1;
  const seriesXml = chart.series.map((s, i) => serXml(s, i, chart.type)).join('');

  let plotXml = '';
  if (chart.type === 'bar') {
    const stacked = chart.stacked ? 'stacked' : 'clustered';
    const barDir = chart.horizontal ? 'bar' : 'col';
    plotXml = `<c:barChart><c:barDir val="${barDir}"/><c:grouping val="${stacked}"/><c:varyColors val="0"/>${seriesXml}<c:gapWidth val="${chart.stacked ? '150' : '119'}"/><c:overlap val="${chart.stacked ? '100' : '-27'}"/><c:axId val="${axIdCat}"/><c:axId val="${axIdVal}"/></c:barChart>`;
  } else if (chart.type === 'line') {
    plotXml = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${seriesXml}<c:marker val="1"/><c:axId val="${axIdCat}"/><c:axId val="${axIdVal}"/></c:lineChart>`;
  } else if (chart.type === 'pie' || chart.type === 'doughnut') {
    const hole = chart.type === 'doughnut' ? '<c:holeSize val="50"/>' : '';
    const tag = chart.type === 'doughnut' ? 'doughnutChart' : 'pieChart';
    plotXml = `<c:${tag}><c:varyColors val="1"/>${seriesXml}<c:firstSliceAng val="0"/>${hole}</c:${tag}>`;
  } else {
    throw new Error(`Unsupported chart type: ${chart.type}`);
  }

  const axes = (chart.type === 'bar' || chart.type === 'line') ? axesXml(axIdCat, axIdVal, chart.valNumFmt) : '';

  const legendPos = chart.legendPos || 'b';
  const legendXml = chart.hideLegend
    ? ''
    : `<c:legend><c:legendPos val="${legendPos}"/><c:overlay val="0"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="ja-JP"/></a:p></c:txPr></c:legend>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:lang val="ja-JP"/><c:roundedCorners val="0"/>
<c:chart>
<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:rPr lang="ja-JP"/><a:t>${esc(chart.title || '')}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
<c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/>${plotXml}${axes}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>
<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>${legendXml}
</c:chart>
</c:chartSpace>`;
}

// ─────────────────────────────────────────
// Drawing XML (シート上のチャート配置)
// ─────────────────────────────────────────
function drawingXml(entries) {
  const anchors = entries.map((e, i) => {
    const a = e.anchor;
    return `<xdr:twoCellAnchor><xdr:from><xdr:col>${a.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${a.toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
      `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
      `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${e.rid}"/></a:graphicData></a:graphic>` +
      `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`;
}

// ─────────────────────────────────────────
// パス操作
// ─────────────────────────────────────────
function pathBase(p) { return p.split('/').pop(); }
function pathDir(p) { const a = p.split('/'); a.pop(); return a.join('/'); }

// fromFile から見た toFile への相対パス (zip 内パス表記)
// 例: xl/worksheets/sheet1.xml → xl/drawings/drawing1.xml : ../drawings/drawing1.xml
function relPath(fromFile, toFile) {
  const fa = pathDir(fromFile).split('/');
  const ta = pathDir(toFile).split('/');
  const fileName = pathBase(toFile);
  let i = 0;
  while (i < fa.length && i < ta.length && fa[i] === ta[i]) i++;
  const ups = fa.length - i;
  return '../'.repeat(ups) + ta.slice(i).concat(fileName).join('/');
}

// ─────────────────────────────────────────
// メイン: バッファへチャートを注入
// ─────────────────────────────────────────
async function embedCharts(xlsxBuffer, charts) {
  if (!charts || charts.length === 0) return xlsxBuffer;

  const zip = await JSZip.loadAsync(xlsxBuffer);

  // 1. シート名 → sheetN.xml パスを解決
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const wbRelsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');

  const nameToRid = {};
  const sheetTagRe = /<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/g;
  let m;
  while ((m = sheetTagRe.exec(workbookXml)) !== null) {
    nameToRid[decodeXml(m[1])] = m[2];
  }
  const ridToTarget = {};
  const relRe = /<Relationship[^>]*Id="(rId\d+)"[^>]*Target="([^"]+)"/g;
  while ((m = relRe.exec(wbRelsXml)) !== null) {
    ridToTarget[m[1]] = m[2];
  }
  const sheetNameToFile = {};
  for (const [name, rid] of Object.entries(nameToRid)) {
    const target = ridToTarget[rid];
    if (target) {
      sheetNameToFile[name] = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    }
  }

  // 2. シートごとに drawing をまとめる
  const bySheet = {};
  charts.forEach((c) => {
    if (!bySheet[c.sheetName]) bySheet[c.sheetName] = [];
    bySheet[c.sheetName].push(c);
  });

  const contentTypesAdds = [];
  const sheetOrder = Object.keys(bySheet);

  for (let sIdx = 0; sIdx < sheetOrder.length; sIdx++) {
    const sName = sheetOrder[sIdx];
    const sheetCharts = bySheet[sName];
    const sheetFile = sheetNameToFile[sName];
    if (!sheetFile) throw new Error(`シート '${sName}' が見つかりません`);

    const drawingNum = sIdx + 1;
    const drawingFile = `xl/drawings/drawing${drawingNum}.xml`;

    // 既存の chart ファイル数を把握して番号の衝突を避ける
    const existingCharts = Object.keys(zip.files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f)).length;

    // このシートの全チャートを生成
    const drawingEntries = [];
    sheetCharts.forEach((chart, i) => {
      const chartNum = existingCharts + drawingEntries.length + 1;
      const chartFile = `xl/charts/chart${chartNum}.xml`;
      zip.file(chartFile, chartXml(chart));
      contentTypesAdds.push(`<Override PartName="/${chartFile}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
      drawingEntries.push({ rid: `rId${i + 1}`, anchor: chart.anchor, chartFile });
    });

    // drawing XML + rels
    zip.file(drawingFile, drawingXml(drawingEntries));
    zip.file(`xl/drawings/_rels/drawing${drawingNum}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingEntries.map((e) => `<Relationship Id="${e.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/${pathBase(e.chartFile)}"/>`).join('')}</Relationships>`);
    contentTypesAdds.push(`<Override PartName="/${drawingFile}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);

    // sheet rels: 既存があれば追記、なければ新規
    const sheetRelsFile = `${pathDir(sheetFile)}/_rels/${pathBase(sheetFile)}.rels`;
    const sheetRelsPath = sheetRelsFile.replace('/_rels/', '/_rels/'); // そのまま
    let sheetRelsXml = null;
    const existingRels = zip.file(sheetRelsPath);
    if (existingRels) {
      sheetRelsXml = await existingRels.async('string');
    }
    let maxRid = 0;
    if (sheetRelsXml) {
      const re = /Id="rId(\d+)"/g;
      let rm;
      while ((rm = re.exec(sheetRelsXml)) !== null) maxRid = Math.max(maxRid, parseInt(rm[1], 10));
    }
    const drawingRid = `rId${maxRid + 1}`;
    const drawingRelEntry = `<Relationship Id="${drawingRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="${relPath(sheetFile, drawingFile)}"/>`;
    if (sheetRelsXml) {
      sheetRelsXml = sheetRelsXml.replace('</Relationships>', drawingRelEntry + '</Relationships>');
    } else {
      sheetRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRelEntry}</Relationships>`;
    }
    zip.file(sheetRelsPath, sheetRelsXml);

    // sheet XML に <drawing r:id> を挿入
    let sheetXml = await zip.file(sheetFile).async('string');
    if (!/<drawing /i.test(sheetXml)) {
      sheetXml = sheetXml.replace('</worksheet>', `<drawing r:id="${drawingRid}"/></worksheet>`);
      zip.file(sheetFile, sheetXml);
    }
  }

  // 3. [Content_Types].xml 更新
  let ct = await zip.file('[Content_Types].xml').async('string');
  ct = ct.replace('</Types>', contentTypesAdds.join('') + '</Types>');
  zip.file('[Content_Types].xml', ct);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function decodeXml(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

module.exports = { embedCharts, absRef, quoteSheet };