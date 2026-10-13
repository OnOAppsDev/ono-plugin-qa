#!/usr/bin/env node
// Zero-dependency OOXML .xlsx writer — no npm install is guaranteed on the
// machine this runs on, only Node (bundled with Claude Code itself).
'use strict';

import fs from 'node:fs';
import zlib from 'node:zlib';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node build-test-cases-xlsx.mjs <input.json> <output.xlsx>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const groups = Array.isArray(data.groups) ? data.groups : [];

const HEADERS = ['Test ID', 'Summary', 'Action', 'Expected Result', 'Test Data/Parameter', 'Comments'];
const WIDTHS = [11, 40, 58, 62, 42, 46];

// One soft color family, a lighter shade per header level. Text colors were picked
// for at least 4.5:1 contrast (WCAG AA); qa-ledger.test.mjs re-checks every pair from the built file.
const PALETTE = {
  header: { fill: '4A6FA5', text: 'FFFFFF' }, // column header row
  group: { fill: 'B4C7E7', text: '000000' }, // section rows
  subgroup: { fill: 'DCE6F2', text: '000000' }, // sub-section rows
};

const STYLE_HEADER = 1;
const STYLE_GROUP = 2;
const STYLE_SUBGROUP = 3;
const STYLE_DATA = 4;

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeSheetName(name) {
  const s = String(name || 'Test Cases').replace(/[\\/*?:[\]]/g, ' ').trim();
  return (s || 'Test Cases').slice(0, 31);
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cell(ref, value, styleIdx) {
  if (value === '' || value === undefined || value === null) {
    return `<c r="${ref}" s="${styleIdx}"/>`;
  }
  return `<c r="${ref}" s="${styleIdx}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

// Steps are numbered here ("1. …"); a number the author already wrote is dropped first.
function actionText(action) {
  const steps = Array.isArray(action) ? action : String(action || '').split('\n').filter(Boolean);
  return steps.map((step, i) => `${i + 1}. ${String(step).replace(/^\s*(?:שלב\s*)?\d+\s*[.:)]\s*/, '')}`).join('\n');
}

// ponytail: line count estimated from character count per column width; switch to real text metrics if rows get cut off
function rowHeight(values) {
  const lines = Math.max(...values.map((v, i) => String(v || '').split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / (WIDTHS[i] - 3))), 0)));
  return Math.min(409, lines * 16 + 16); // Excel's maximum row height
}

let rowsXml = '';
let rowNum = 1;
const merges = [];

function titleRow(title, style, height) {
  const cells = ['A', 'B', 'C', 'D', 'E', 'F'].map((col, i) => cell(`${col}${rowNum}`, i === 0 ? title || '' : '', style)).join('');
  rowsXml += `<row r="${rowNum}" ht="${height}" customHeight="1">${cells}</row>`;
  merges.push(`A${rowNum}:F${rowNum}`);
  rowNum++;
}

function dataRows(rows) {
  for (const row of rows || []) {
    const values = ['', row.summary || '', actionText(row.action), row.expected || '', row.testData || '', row.comments || ''];
    const cells = values.map((v, i) => cell(`${colLetter(i + 1)}${rowNum}`, v, STYLE_DATA)).join('');
    rowsXml += `<row r="${rowNum}" ht="${rowHeight(values)}" customHeight="1">${cells}</row>`;
    rowNum++;
  }
}

rowsXml += `<row r="${rowNum}" ht="32" customHeight="1">${HEADERS.map((h, i) => cell(`${colLetter(i + 1)}${rowNum}`, h, STYLE_HEADER)).join('')}</row>`;
rowNum++;

for (const group of groups) {
  titleRow(group.title, STYLE_GROUP, 30);
  dataRows(group.rows);
  for (const sub of group.subgroups || []) {
    titleRow(sub.title, STYLE_SUBGROUP, 26);
    dataRows(sub.rows);
  }
}

const lastRow = rowNum - 1;
const mergeCellsXml = merges.length
  ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
  : '';

const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:F${lastRow}"/>
<sheetViews><sheetView rightToLeft="1" showGridLines="0" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="16"/>
<cols>
${WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('\n')}
</cols>
<sheetData>${rowsXml}</sheetData>
${mergeCellsXml}
</worksheet>`;

const fill = (hex) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`;
const font = (bold, size, hex) => `<font>${bold ? '<b/>' : ''}<sz val="${size}"/><color rgb="FF${hex}"/><name val="Arial"/></font>`;
const titleAlign = '<alignment horizontal="right" vertical="center" wrapText="1" readingOrder="2" indent="1"/>';

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">${font(false, 11, '000000')}${font(true, 12, PALETTE.header.text)}${font(true, 12, PALETTE.group.text)}${font(true, 12, PALETTE.subgroup.text)}</fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fill(PALETTE.header.fill)}${fill(PALETTE.group.fill)}${fill(PALETTE.subgroup.fill)}</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${['left', 'right', 'top', 'bottom'].map((side) => `<${side} style="thin"><color rgb="FFD0D0D0"/></${side}>`).join('')}<diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1" readingOrder="2"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${titleAlign}</xf>
<xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${titleAlign}</xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top" wrapText="1" readingOrder="2" indent="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sanitizeSheetName(data.sheetName))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = file.data;
    const crc = crc32(raw);
    const compressed = zlib.deflateRawSync(raw);
    const useCompression = compressed.length < raw.length;
    const method = useCompression ? 8 : 0;
    const payload = useCompression ? compressed : raw;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localChunks.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirBuf, eocd]);
}

const files = [
  { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') },
  { name: '_rels/.rels', data: Buffer.from(rootRelsXml, 'utf8') },
  { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
  { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRelsXml, 'utf8') },
  { name: 'xl/styles.xml', data: Buffer.from(stylesXml, 'utf8') },
  { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
];

fs.writeFileSync(outputPath, buildZip(files));
console.log(`Wrote ${outputPath}`);
