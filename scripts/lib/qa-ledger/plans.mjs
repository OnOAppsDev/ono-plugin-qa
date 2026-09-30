// Read-only parsing of QA-authored markdown: test plans and smoke suites.
// Internal module of scripts/qa-ledger.mjs. Nothing here writes — plans and
// suites are referenced by row, never rewritten.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { PLAN_ROW_ID_RE, fail, sha } from './core.mjs';
import { resolveQaFile } from './store.mjs';

export const SMOKE_DIR = 'smoke';
export const SMOKE_FILE = 'smoke-suite.md';
export const QA_AUTHORED = 'QA-authored';
const SMOKE_ID_RE = /^S[1-9][0-9]*$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\s+/g, ' '));
}

// Every markdown table row (outside code fences) whose first cell is a plan id.
function parseTableRows(text) {
  const rows = [];
  let inFence = false;
  let section = null;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      section = heading[1];
      return;
    }
    if (!line.trim().startsWith('|')) return;
    const cells = splitRow(line);
    const id = cells[0];
    if (!PLAN_ROW_ID_RE.test(id) || !/\d/.test(id)) return;
    rows.push({ id, section, line: i + 1, cells, row_hash: sha(cells.join('\u001f')) });
  });
  return rows;
}

// Rows of every markdown table whose first cell is a plan id (TC1, EC-U1, I18N1, …).
// The row hash covers the normalized cells, so a whitespace-only reflow does not
// count as a change but any wording change does.
export function parsePlanRows(text) {
  const rows = parseTableRows(text).map(({ cells, ...r }) => r);
  const seen = new Map();
  for (const r of rows) seen.set(r.id, (seen.get(r.id) || 0) + 1);
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  return { rows, duplicates };
}

// A `key: value` line from the document's first fenced YAML block — the frontmatter
// style every QA template in this plugin uses. Trailing `# comments` are dropped.
export function frontmatterValue(text, key) {
  const block = /```ya?ml\s*\n([\s\S]*?)```/.exec(text);
  if (!block) return null;
  const m = new RegExp(`^${key}:[ \\t]*([^#\\n]*)`, 'm').exec(block[1]);
  const v = m ? m[1].trim() : '';
  return v || null;
}

export function readPlan(root, rel) {
  const { abs, rel: norm } = resolveQaFile(root, rel);
  const bytes = fs.readFileSync(abs);
  const text = bytes.toString('utf8');
  const parsed = parsePlanRows(text);
  const dir = path.posix.dirname(norm);
  return {
    plan: norm,
    fingerprint: sha(bytes),
    status: frontmatterValue(text, 'status'),
    duplicates: parsed.duplicates,
    rows: parsed.rows.map((r) => ({ ...r, case_key: `${dir}/${r.id}` })),
  };
}

export const smokeSuitePath = (surface) => `${SMOKE_DIR}/${surface}/${SMOKE_FILE}`;
export const isSmokePath = (rel) => rel.startsWith(`${SMOKE_DIR}/`);

// Parses and checks a QA-authored smoke suite. `structural` errors make the suite
// unusable for a smoke run; `source` errors only break traceability to a plan case.
export function readSmokeSuite(root, rel) {
  const { abs, rel: norm } = resolveQaFile(root, rel);
  const parts = norm.split('/');
  if (parts.length !== 3 || parts[0] !== SMOKE_DIR || parts[2] !== SMOKE_FILE) {
    fail('INVALID_SMOKE_SUITE', `${norm} is not a smoke suite — suites live at ${SMOKE_DIR}/<surface>/${SMOKE_FILE}`);
  }
  const folderSurface = parts[1];
  const bytes = fs.readFileSync(abs);
  const text = bytes.toString('utf8');
  const structural = [];
  const source = [];
  const declared = frontmatterValue(text, 'surface');
  if (declared !== folderSurface) structural.push({ code: 'SURFACE_MISMATCH', message: `frontmatter surface "${declared}" does not match the folder "${folderSurface}"` });

  const retired = [];
  let inRetired = false;
  for (const line of text.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (h) inRetired = /^retired ids$/i.test(h[1]);
    else if (inRetired) {
      const m = /^\s*-\s+(S[1-9][0-9]*)\b/.exec(line);
      if (m) retired.push(m[1]);
    }
  }

  const rows = parseTableRows(text).map((r) => {
    const src = r.cells[1] ?? '';
    const row = { id: r.id, section: r.section, line: r.line, case_key: `${SMOKE_DIR}/${folderSurface}/${r.id}`, row_hash: r.row_hash, source: src, source_status: null };
    if (!SMOKE_ID_RE.test(r.id)) structural.push({ code: 'INVALID_CASE_ID', message: `smoke case id "${r.id}" must be S<n>` });
    if (src === QA_AUTHORED) row.source_status = 'qa-authored';
    else if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Z][A-Z0-9-]*$/.test(src)) {
      const [folder, id] = src.split('/');
      let plan = null;
      try {
        plan = readPlan(root, `${folder}/test-plan.md`);
      } catch {
        /* reported below */
      }
      const found = plan?.rows.find((x) => x.id === id);
      if (!found) {
        row.source_status = 'unknown';
        source.push({ code: 'UNKNOWN_SOURCE', message: `${r.id}: ${src} is not a case in ${folder}/test-plan.md` });
      } else {
        row.source_status = plan.status;
        if (plan.status !== 'approved') source.push({ code: 'SOURCE_NOT_APPROVED', message: `${r.id}: ${folder}/test-plan.md is ${plan.status ?? 'unstamped'}, not approved` });
      }
    } else {
      row.source_status = 'invalid';
      source.push({ code: 'INVALID_SOURCE', message: `${r.id}: source must be "${QA_AUTHORED}" or <plan-folder>/<case-id>` });
    }
    return row;
  });
  if (!rows.length) structural.push({ code: 'NO_CASES', message: 'the suite has no smoke cases' });
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id)) structural.push({ code: 'DUPLICATE_CASE_ID', message: `${r.id} is used more than once` });
    seen.add(r.id);
    if (retired.includes(r.id)) structural.push({ code: 'RETIRED_ID_REUSED', message: `${r.id} was retired and may never be reused` });
  }
  return { suite: norm, surface: folderSurface, fingerprint: sha(bytes), rows, retired, structural, source };
}
