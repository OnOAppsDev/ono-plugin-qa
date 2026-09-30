// Stage 4 — Dev → QA handoff integration. Reads the Dev plugin's artifacts in the
// code repo (Task Breakdown → qa_handoff_link → QA handoff; Task Breakdown →
// feature_analysis_link → Feature Analysis) strictly read-only, checks them against
// the current producer contract (docs/dev-handoff-contract.md) and derives what the
// QA feature scope records: the canonical Dev identity, QA-owned debt, and the
// developer-owned context that must stay developer-owned.
// Internal module of scripts/qa-ledger.mjs. Nothing here writes — to either repo.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fail, sha, canonical } from './core.mjs';

// The producer's section contract, in order (ono-mobile-dev-plugin templates/qa-handoff-template.md).
export const HANDOFF_SECTIONS = ['Feature Summary', 'How to Test', 'Test Accounts & Environment', 'Edge Cases', 'Known Limitations', 'Screens & Flows Touched', 'Build / Install / Testing Instructions', 'i18n / RTL Check', 'Accessibility Check', 'Pending Verification (owed to QA)'];
export const READY_STATUS = 'ready-for-qa';
const A11Y_STATUSES = ['applicable', 'notApplicable', 'notRecorded'];
const SKIP_DIRS = new Set(['node_modules', 'Pods', 'build', 'dist', 'vendor', 'DerivedData', 'coverage']);
const SCAN_LIMIT = 20000;

// GitHub-style heading anchor, as the producer's links use.
export const anchor = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

// ---------- code repo boundary (read-only) ----------

export function resolveCodeRepo(arg, qaRoot) {
  if (!arg) fail('MISSING_ARGUMENT', '--code-repo <path> is required');
  let root;
  try {
    root = fs.realpathSync(path.resolve(arg));
  } catch {
    fail('NOT_A_CODE_REPO', `${arg} does not exist`);
  }
  if (!fs.statSync(root).isDirectory() || !fs.existsSync(path.join(root, '.git'))) fail('NOT_A_CODE_REPO', `${root} is not a git repository root`);
  if (root === qaRoot) fail('CODE_REPO_IS_QA_REPO', `${root} is the QA repo — the Dev handoff lives in the application repo`);
  return root;
}

function readCodeFile(root, rel, what) {
  if (typeof rel !== 'string' || !rel) fail('INVALID_VALUE', `${what} path is empty`);
  const abs = path.resolve(root, rel);
  if (path.isAbsolute(rel) || !abs.startsWith(root + path.sep)) fail('PATH_OUTSIDE_CODE_REPO', `${what} ${rel} is outside the code repo`);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  if (!fs.realpathSync(abs).startsWith(root + path.sep)) fail('PATH_OUTSIDE_CODE_REPO', `${what} ${rel} resolves outside the code repo`);
  return { rel: path.relative(root, abs).split(path.sep).join('/'), bytes: fs.readFileSync(abs) };
}

// ---------- frontmatter (docs/planning-doc-contract.md encodings) ----------

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

function parseYamlLines(lines) {
  const out = {};
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(line.trimEnd());
    if (!m) continue;
    let v = (m[2] ?? '').replace(/(^|\s)#.*$/, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v === '' || v === 'null' || v === '~' ? null : v;
  }
  return out;
}

// `delimited` (--- … ---) wins; otherwise the first ```yaml fence before the first
// level-2 heading outside an HTML comment (`fenced-yaml`).
export function parseFrontmatter(text) {
  const t = text.replace(/^﻿/, '');
  const lines = t.split(/\r?\n/);
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) return { encoding: 'delimited', fields: parseYamlLines(lines.slice(1, end)), body: lines.slice(end + 1).join('\n') };
  }
  const visible = stripComments(t).split(/\r?\n/);
  let open = -1;
  for (let i = 0; i < visible.length; i++) {
    if (/^## /.test(visible[i])) break;
    if (/^```ya?ml\s*$/.test(visible[i])) {
      open = i;
      break;
    }
  }
  if (open >= 0) {
    const close = visible.findIndex((l, i) => i > open && /^```\s*$/.test(l));
    if (close > open) return { encoding: 'fenced-yaml', fields: parseYamlLines(visible.slice(open + 1, close)), body: visible.slice(close + 1).join('\n') };
  }
  return { encoding: null, fields: {}, body: t };
}

// Level-2 sections of a document body, with HTML comments and code fences removed.
export function parseSections(body) {
  const sections = [];
  let cur = null;
  let inFence = false;
  for (const line of stripComments(body).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = !inFence && /^## (.+?)\s*$/.exec(line);
    if (h) {
      cur = { name: h[1], lines: [] };
      sections.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  return sections.map((s) => ({ name: s.name, text: s.lines.join('\n').trim() }));
}

// ---------- discovery ----------

// A Task Breakdown is recognized by its own frontmatter keys, never by a heading.
const isBreakdown = (f) => ['feature', 'feature_analysis_link', 'dd_link', 'dev_plan_link'].every((k) => k in f);
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

function findBreakdowns(root, qaRoot, feature) {
  const found = [];
  let seen = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (++seen > SCAN_LIMIT) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || p === qaRoot) continue;
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const fm = parseFrontmatter(fs.readFileSync(p, 'utf8')).fields;
        if (isBreakdown(fm) && fm.feature && (fm.feature === feature || slug(fm.feature) === slug(feature))) found.push(path.relative(root, p).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return found.sort();
}

// Pending Verification rows: a table (domain | rule ID | required verification | why | owner)
// or `·`-separated bullets in the same order. "None recorded" means none.
function parsePendingVerification(text) {
  const rows = [];
  const problems = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    let cells = null;
    if (line.startsWith('|')) {
      cells = line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c)) || cells[0].toLowerCase() === 'domain') continue;
    } else if (/^[-*]\s+/.test(line) && line.includes('·')) {
      cells = line.replace(/^[-*]\s+/, '').split('·').map((c) => c.trim());
    }
    if (!cells) continue;
    if (cells.length !== 5 || cells.slice(0, 3).some((c) => !c)) {
      problems.push({ code: 'MALFORMED_DEBT_ROW', message: `Pending Verification row does not have domain · rule ID · required verification · why · owner: ${line}` });
      continue;
    }
    const [domain, ruleId, required, why, owner] = cells;
    rows.push({ domain, rule_id: ruleId, required_verification: required, why_not_automatable: why || null, owner: owner.toLowerCase() });
  }
  if (!rows.length && !problems.length && text && !/none recorded/i.test(text)) problems.push({ code: 'MALFORMED_DEBT_ROW', message: 'Pending Verification has content but no recognizable entries, and does not say "None recorded"' });
  return { rows, problems };
}

function accessibilityOf(text) {
  const statuses = A11Y_STATUSES.filter((s) => new RegExp(`\\b${s}\\b`).test(text));
  return { statuses, attention: statuses.includes('notRecorded') || statuses.length === 0 };
}

// Resolves the Dev chain and interprets the handoff. `recorded` is the scope's
// previously bound dev_handoff, if any.
export function resolveHandoff(root, qaRoot, o, recorded) {
  const resolvedBy = {};
  let breakdownRel = o.breakdown ?? null;
  if (breakdownRel) resolvedBy.breakdown = 'explicit';
  else if (recorded?.task_breakdown_link) {
    breakdownRel = recorded.task_breakdown_link;
    resolvedBy.breakdown = 'scope';
  } else {
    if (!o.feature) fail('NEED_BREAKDOWN_PATH', 'no Task Breakdown is linked yet — give the feature name or the breakdown path', { candidates: [] });
    const candidates = findBreakdowns(root, qaRoot, o.feature);
    if (candidates.length !== 1) fail('NEED_BREAKDOWN_PATH', candidates.length ? `several Task Breakdowns declare feature "${o.feature}" — ask which one` : `no Task Breakdown declares feature "${o.feature}" — ask for its path`, { candidates }); // invariant:one-breakdown
    breakdownRel = candidates[0];
    resolvedBy.breakdown = 'feature-frontmatter';
  }
  const bFile = readCodeFile(root, breakdownRel, 'Task Breakdown');
  if (!bFile) fail('NEED_BREAKDOWN_PATH', `Task Breakdown ${breakdownRel} does not exist`, { candidates: [] });
  const breakdown = parseFrontmatter(bFile.bytes.toString('utf8'));
  if (!isBreakdown(breakdown.fields)) fail('NOT_A_TASK_BREAKDOWN', `${bFile.rel} has no Task Breakdown frontmatter (feature, feature_analysis_link, dd_link, dev_plan_link)`);
  const b = breakdown.fields;

  let handoffRel = o.handoff ?? null;
  if (handoffRel) resolvedBy.handoff = 'explicit';
  else if (b.qa_handoff_link) {
    handoffRel = b.qa_handoff_link;
    resolvedBy.handoff = 'qa_handoff_link';
  } else fail('NEED_HANDOFF_PATH', `${bFile.rel} has no qa_handoff_link yet — dev has not run /create-dev-qa-notes, or the link was not recorded; ask for the handoff path`);
  const hFile = readCodeFile(root, handoffRel, 'QA handoff');
  if (!hFile) fail('NEED_HANDOFF_PATH', `QA handoff ${handoffRel} does not exist — ask for its path`);
  const handoff = parseFrontmatter(hFile.bytes.toString('utf8'));
  const h = handoff.fields;

  let analysis = null;
  const problems = [];
  if (b.feature_analysis_link) {
    const aFile = readCodeFile(root, b.feature_analysis_link, 'Feature Analysis');
    if (aFile) {
      analysis = { path: aFile.rel, ...parseFrontmatter(aFile.bytes.toString('utf8')) };
      resolvedBy.analysis = 'feature_analysis_link';
    } else problems.push({ code: 'ANALYSIS_MISSING', message: `${b.feature_analysis_link} (feature_analysis_link) does not exist — surface and capability are unknown` });
  }
  const a = analysis?.fields ?? {};

  // Sections, against the one documented contract.
  const sections = parseSections(handoff.body);
  const names = sections.map((s) => s.name);
  const text = (n) => sections.find((s) => s.name === n)?.text ?? '';
  const missing = HANDOFF_SECTIONS.filter((s) => !names.includes(s));
  for (const s of missing) problems.push({ code: 'MISSING_SECTION', section: s, message: `the handoff has no "## ${s}" section` });
  if (handoff.encoding === null) problems.push({ code: 'MISSING_FRONTMATTER', message: 'the handoff has no frontmatter' });

  // Identity: the handoff must describe the same feature as its breakdown.
  const identityErrors = [];
  if (h.feature !== b.feature) identityErrors.push(`handoff feature "${h.feature}" ≠ breakdown feature "${b.feature}"`);
  for (const k of ['platform', 'device_type']) if (h[k] && b[k] && h[k] !== b[k]) identityErrors.push(`handoff ${k} "${h[k]}" ≠ breakdown ${k} "${b[k]}"`);
  if (h.task_breakdown_link && h.task_breakdown_link !== bFile.rel) identityErrors.push(`handoff task_breakdown_link "${h.task_breakdown_link}" ≠ ${bFile.rel}`);
  if (a.feature && a.feature !== b.feature && slug(a.feature) !== slug(b.feature)) problems.push({ code: 'ANALYSIS_FEATURE_DIFFERS', message: `feature analysis names "${a.feature}"` });

  // Obligations: QA-owned debt vs developer-owned context.
  const pv = parsePendingVerification(text('Pending Verification (owed to QA)'));
  problems.push(...pv.problems);
  const qaRows = pv.rows.filter((r) => r.owner === 'qa'); // invariant:qa-owned-only
  const misfiled = pv.rows.filter((r) => r.owner === 'developer');
  for (const r of pv.rows.filter((x) => x.owner !== 'qa' && x.owner !== 'developer')) problems.push({ code: 'MALFORMED_DEBT_ROW', message: `unknown owner "${r.owner}" for ${r.rule_id} — ownership is never guessed` });
  const accessibility = accessibilityOf(text('Accessibility Check'));
  const handoffLink = hFile.rel;
  const qaDebt = qaRows.map((r) => ({
    id: `HV-${sha(canonical([r.domain, r.rule_id, r.required_verification])).slice(7, 15)}`,
    description: r.required_verification,
    domain: r.domain,
    rule_id: r.rule_id,
    ...(r.why_not_automatable ? { why_not_automatable: r.why_not_automatable } : {}),
    owner: 'qa',
    source: `${handoffLink}#${anchor('Pending Verification (owed to QA)')}`,
  }));
  if (accessibility.attention) {
    qaDebt.push({ id: 'HV-a11y-not-recorded', description: 'Accessibility status is notRecorded (or missing) for part of this handoff — QA must verify accessibility; it is not covered', domain: 'accessibility', owner: 'qa', source: `${handoffLink}#${anchor('Accessibility Check')}` });
  }

  const blocking = problems.filter((p) => ['MISSING_SECTION', 'MISSING_FRONTMATTER', 'MALFORMED_DEBT_ROW'].includes(p.code));
  return {
    resolved_by: resolvedBy,
    breakdown: { path: bFile.rel, encoding: breakdown.encoding, frontmatter: b },
    handoff: {
      path: handoffLink,
      encoding: handoff.encoding,
      fingerprint: sha(hFile.bytes),
      frontmatter: h,
      status: h.status ?? null,
      sections: names,
      missing_sections: missing,
      unrecognized_sections: names.filter((n) => !HANDOFF_SECTIONS.includes(n)),
      contract_ok: blocking.length === 0,
      build_instructions_ref: `${handoffLink}#${anchor('Build / Install / Testing Instructions')}`,
    },
    analysis: analysis && { path: analysis.path, encoding: analysis.encoding, frontmatter: a },
    identity: {
      feature: b.feature,
      task_breakdown_link: bFile.rel,
      qa_handoff_link: handoffLink,
      feature_analysis_link: b.feature_analysis_link ?? null,
      dd_link: b.dd_link ?? h.dd_link ?? null,
      platform: b.platform ?? h.platform ?? null,
      device_type: b.device_type ?? h.device_type ?? null,
      surface: a.surface ?? null,
      capability: a.capability ?? null,
    },
    identity_errors: identityErrors,
    qa_debt: qaDebt,
    developer_context: { known_limitations: text('Known Limitations'), misfiled_developer_debt: misfiled },
    accessibility,
    problems,
  };
}
