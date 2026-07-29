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

const HEADERS = ['Test ID', 'Summary', 'Action', 'Expected Result', 'Test Data / Parameter', 'Comments'];
const STYLE_HEADER = 1;
const STYLE_GROUP = 2;
const STYLE_DATA = 3;

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

let rowsXml = '';
let rowNum = 1;
const merges = [];

rowsXml += `<row r="${rowNum}">${HEADERS.map((h, i) => cell(`${colLetter(i + 1)}${rowNum}`, h, STYLE_HEADER)).join('')}</row>`;
rowNum++;

for (const group of groups) {
  const groupRow = rowNum;
  const groupCells = ['A', 'B', 'C', 'D', 'E', 'F']
    .map((col, i) => (i === 0 ? cell(`${col}${groupRow}`, group.title || '', STYLE_GROUP) : cell(`${col}${groupRow}`, '', STYLE_GROUP)))
    .join('');
  rowsXml += `<row r="${groupRow}">${groupCells}</row>`;
  merges.push(`A${groupRow}:F${groupRow}`);
  rowNum++;

  for (const row of group.rows || []) {
    const actionText = Array.isArray(row.action) ? row.action.join('\n') : String(row.action || '');
    const cells = [
      cell(`A${rowNum}`, '', STYLE_DATA),
      cell(`B${rowNum}`, row.summary || '', STYLE_DATA),
      cell(`C${rowNum}`, actionText, STYLE_DATA),
      cell(`D${rowNum}`, row.expected || '', STYLE_DATA),
      cell(`E${rowNum}`, row.testData || '', STYLE_DATA),
      cell(`F${rowNum}`, row.comments || '', STYLE_DATA),
    ].join('');
    rowsXml += `<row r="${rowNum}">${cells}</row>`;
    rowNum++;
  }
}

const lastRow = rowNum - 1;
const mergeCellsXml = merges.length
  ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
  : '';

const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:F${lastRow}"/>
<sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>
<col min="1" max="1" width="12" customWidth="1"/>
<col min="2" max="2" width="30" customWidth="1"/>
<col min="3" max="3" width="45" customWidth="1"/>
<col min="4" max="4" width="35" customWidth="1"/>
<col min="5" max="5" width="20" customWidth="1"/>
<col min="6" max="6" width="25" customWidth="1"/>
</cols>
<sheetData>${rowsXml}</sheetData>
${mergeCellsXml}
</worksheet>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="top" wrapText="1"/></xf>
</cellXfs>
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
