#!/usr/bin/env node
// QA ledger helper — the only writer of <qa-repo>/qa-ledger/. Zero dependencies,
// same as build-test-cases-xlsx.mjs: only Node (bundled with Claude Code) is assumed.
//
// Contract: docs/qa-ledger-contract.md. Every command prints one JSON object on
// stdout and exits 0 when `ok: true`, 1 otherwise — branch on `error.code`.
//
//   node qa-ledger.mjs <command> [subcommand] --qa-repo <path> [options]
//
// The helper enforces structure only (identity, references, append-only history,
// terminal runs). Lifecycle judgment — smoke gates, bug transitions, readiness —
// belongs to later stages and is deliberately absent here.
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 1;
export const EXECUTION_TYPES = ['smoke', 'functional', 'regression', 'retest', 'reproduction'];
export const RESULTS = ['pass', 'fail', 'blocked', 'not_run'];
export const SCOPE_KINDS = ['feature', 'bug', 'release'];
const BUG_REF_TYPES = ['retest', 'reproduction'];
const LEDGER_DIR = 'qa-ledger';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID_RE = /^[a-z]+-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const PLAN_ROW_ID_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// ---------- errors & output ----------

class LedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => {
  throw new LedgerError(code, message, details);
};

// ---------- canonical records ----------

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
const sha = (s) => `sha256:${crypto.createHash('sha256').update(s).digest('hex')}`;
function seal(record) {
  const { hash, ...rest } = record;
  return { ...rest, hash: sha(canonical(rest)) };
}
function hashOk(record) {
  const { hash, ...rest } = record;
  return typeof hash === 'string' && hash === sha(canonical(rest));
}

function now() {
  const forced = process.env.QA_LEDGER_NOW;
  if (forced) {
    if (!ISO_RE.test(forced)) fail('INVALID_VALUE', 'QA_LEDGER_NOW must be an ISO-8601 UTC timestamp');
    return forced;
  }
  return new Date().toISOString();
}

// ---------- identities ----------

function checkId(value, what) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail('INVALID_ID', `${what} "${value}" must match ${ID_RE} (letters, digits, . _ -; no path separators)`);
  }
  return value;
}

export function parseScopeRef(ref) {
  if (typeof ref !== 'string' || !ref.includes(':')) fail('INVALID_SCOPE', `scope "${ref}" must be <kind>:<id>`);
  const i = ref.indexOf(':');
  const kind = ref.slice(0, i);
  const id = ref.slice(i + 1);
  if (!SCOPE_KINDS.includes(kind)) fail('INVALID_SCOPE', `scope kind "${kind}" must be one of ${SCOPE_KINDS.join(', ')}`);
  checkId(id, 'scope id');
  return { kind, id, ref: `${kind}:${id}` };
}

// ---------- filesystem boundary ----------

function resolveQaRepo(arg) {
  if (!arg) fail('MISSING_ARGUMENT', '--qa-repo <path> is required');
  let root;
  try {
    root = fs.realpathSync(path.resolve(arg));
  } catch {
    fail('NOT_A_QA_REPO', `${arg} does not exist`);
  }
  if (!fs.statSync(root).isDirectory()) fail('NOT_A_QA_REPO', `${root} is not a directory`);
  if (!fs.existsSync(path.join(root, '.git'))) fail('NOT_A_QA_REPO', `${root} is not a git repository root`);
  if (fs.existsSync(path.join(root, '.ono'))) {
    fail('NOT_A_QA_REPO', `${root} has .ono/ (Project Knowledge) — that is an application repo, never the QA repo`);
  }
  const manifest = path.join(root, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(manifest)) {
    let name = null;
    try {
      name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name;
    } catch {
      /* not a plugin manifest we recognize */
    }
    if (name === 'ono-plugin-qa') fail('NOT_A_QA_REPO', `${root} is this plugin's own repository`);
  }
  return root;
}

class Store {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, LEDGER_DIR);
  }

  // Every ledger path is built here: plain segments only, contained in qa-ledger/,
  // and no symlink anywhere between qa-ledger/ and the target.
  p(...segments) {
    for (const s of segments) {
      if (!s || s.includes('/') || s.includes('\\') || s === '.' || s === '..') fail('INVALID_ID', `unsafe path segment "${s}"`);
    }
    const full = path.join(this.dir, ...segments);
    if (full !== this.dir && !full.startsWith(this.dir + path.sep)) fail('PATH_OUTSIDE_QA_REPO', `${full} escapes ${this.dir}`);
    let cur = this.dir;
    for (const s of ['', ...segments]) {
      cur = s ? path.join(cur, s) : cur;
      let st = null;
      try {
        st = fs.lstatSync(cur);
      } catch {
        break;
      }
      if (st.isSymbolicLink()) fail('SYMLINK_REFUSED', `${path.relative(this.root, cur)} is a symlink — the ledger never follows links`);
    }
    return full;
  }

  initialized() {
    return fs.existsSync(this.p('ledger.json'));
  }

  mkdirs(...segments) {
    let cur = [];
    for (const s of segments) {
      cur = [...cur, s];
      const full = this.p(...cur);
      if (!fs.existsSync(full)) fs.mkdirSync(full);
    }
  }

  // Create a new file; never replaces an existing one.
  create(segments, content) {
    this.mkdirs(...segments.slice(0, -1));
    const full = this.p(...segments);
    try {
      fs.writeFileSync(full, content, { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') fail('ALREADY_EXISTS', `${path.relative(this.root, full)} already exists`);
      throw e;
    }
  }

  append(segments, line) {
    fs.appendFileSync(this.p(...segments), line);
  }

  list(...segments) {
    const full = this.p(...segments);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full).sort();
  }
}

// A QA-repo-relative path to an existing file, for read-only use (plans).
function resolveQaFile(root, rel) {
  if (typeof rel !== 'string' || !rel) fail('INVALID_VALUE', 'a QA-repo-relative path is required');
  const abs = path.resolve(root, rel);
  if (path.isAbsolute(rel) || !abs.startsWith(root + path.sep)) fail('PATH_OUTSIDE_QA_REPO', `${rel} is outside the QA repo`);
  if (!fs.existsSync(abs)) fail('UNKNOWN_PLAN', `${rel} does not exist in the QA repo`);
  const real = fs.realpathSync(abs);
  if (!real.startsWith(root + path.sep)) fail('PATH_OUTSIDE_QA_REPO', `${rel} resolves outside the QA repo`);
  if (!fs.statSync(real).isFile()) fail('UNKNOWN_PLAN', `${rel} is not a file`);
  const posix = path.relative(root, abs).split(path.sep).join('/');
  if (posix.startsWith(`${LEDGER_DIR}/`) || !posix.includes('/')) {
    fail('UNKNOWN_PLAN', `${rel} must be a plan inside a feature folder, e.g. <feature-slug>/test-plan.md`);
  }
  return { abs, rel: posix };
}

// ---------- test plan rows (read-only) ----------

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\s+/g, ' '));
}

// Rows of every markdown table whose first cell is a plan id (TC1, EC-U1, I18N1, …).
// The row hash covers the normalized cells, so a whitespace-only reflow does not
// count as a change but any wording change does.
export function parsePlanRows(text) {
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
    rows.push({ id, section, line: i + 1, row_hash: sha(cells.join('\u001f')) });
  });
  const seen = new Map();
  for (const r of rows) seen.set(r.id, (seen.get(r.id) || 0) + 1);
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  return { rows, duplicates };
}

function readPlan(root, rel) {
  const { abs, rel: norm } = resolveQaFile(root, rel);
  const bytes = fs.readFileSync(abs);
  const parsed = parsePlanRows(bytes.toString('utf8'));
  const dir = path.posix.dirname(norm);
  return {
    plan: norm,
    fingerprint: sha(bytes),
    duplicates: parsed.duplicates,
    rows: parsed.rows.map((r) => ({ ...r, case_key: `${dir}/${r.id}` })),
  };
}

// ---------- scope context fields ----------

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isIso = (v) => typeof v === 'string' && ISO_RE.test(v);
function strictObject(v, required, optional = []) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (!required.every((k) => keys.includes(k))) return false;
  return keys.every((k) => required.includes(k) || optional.includes(k));
}
const uniqueCanon = (arr) => new Set(arr.map(canonical)).size === arr.length;
const idOk = (v) => typeof v === 'string' && ID_RE.test(v);

export const FIELDS = {
  title: { op: 'set', valid: isStr },
  surfaces: { op: 'set', valid: (v) => Array.isArray(v) && v.every(idOk) && uniqueCanon(v) },
  devices: {
    op: 'set',
    valid: (v) =>
      Array.isArray(v) &&
      uniqueCanon(v) &&
      v.every((d) => strictObject(d, ['surface', 'device'], ['os_runtime']) && idOk(d.surface) && isStr(d.device) && (d.os_runtime === undefined || isStr(d.os_runtime))),
  },
  capability: { op: 'set', valid: (v) => v === null || idOk(v) },
  plans: { op: 'add', valid: isStr, ref: 'plan' },
  related_scopes: { op: 'add', valid: isStr, ref: 'scope' },
  members: { op: 'add', valid: isStr, ref: 'scope', kinds: ['release'] },
  dev_artifacts: { op: 'add', valid: (v) => strictObject(v, ['kind', 'ref']) && idOk(v.kind) && isStr(v.ref) },
  debt: {
    op: 'add',
    key: 'id',
    valid: (v) => strictObject(v, ['id', 'description'], ['domain', 'rule_id', 'source']) && idOk(v.id) && isStr(v.description) && ['domain', 'rule_id', 'source'].every((k) => v[k] === undefined || isStr(v[k])),
  },
  cases: { op: 'add', key: 'id', valid: (v) => strictObject(v, ['id', 'summary']) && idOk(v.id) && isStr(v.summary) },
  result_refs: { op: 'add', valid: isStr, ref: 'result' },
  notes: { op: 'add', valid: isStr },
};

// Replays one scope's context events into the current derived context. Never
// mutates anything; a hand-edited stream that no helper could have written is
// reported as INVALID_RECORD.
function replayContext(scope, events) {
  const context = {};
  const errors = [];
  for (const e of events) {
    const spec = FIELDS[e.field];
    const where = `${scope} seq ${e.seq}`;
    if (!spec) {
      errors.push({ code: 'UNKNOWN_FIELD', where, message: `unknown context field "${e.field}"` });
      continue;
    }
    if (e.kind === 'context.set') {
      if (spec.op !== 'set') errors.push({ code: 'INVALID_RECORD', where, message: `${e.field} is not a set field` });
      else context[e.field] = e.value;
    } else if (e.kind === 'context.add') {
      if (spec.op !== 'add') {
        errors.push({ code: 'INVALID_RECORD', where, message: `${e.field} is not an add field` });
        continue;
      }
      const list = (context[e.field] ??= []);
      const k = keyOf(spec, e.value);
      if (list.some((x) => keyOf(spec, x) === k)) errors.push({ code: 'INVALID_RECORD', where, message: `duplicate ${e.field} value` });
      else list.push(e.value);
    } else if (e.kind === 'context.retract') {
      const list = context[e.field];
      const k = spec.key ? e.value : canonical(e.value);
      const i = spec.op === 'add' && list ? list.findIndex((x) => keyOf(spec, x) === k) : -1;
      if (i < 0) errors.push({ code: 'INVALID_RECORD', where, message: `retract of a ${e.field} value that is not present` });
      else list.splice(i, 1);
    }
  }
  return { context, errors };
}
const keyOf = (spec, v) => (spec.key ? v[spec.key] : canonical(v));

// ---------- runs ----------

// Replays one run stream into its derived state: results, supersession, state.
function replayRun(records) {
  const header = records[0];
  const results = [];
  const byId = new Map();
  const effectiveByCase = new Map();
  const errors = [];
  let state = 'open';
  let endedAt = null;
  for (const r of records.slice(1)) {
    const where = `${header.run_id} seq ${r.seq}`;
    if (state !== 'open') {
      errors.push({ code: 'EVENT_AFTER_TERMINAL', where, message: `record after the run was ${state}` });
      continue;
    }
    if (r.kind === 'run.closed' || r.kind === 'run.aborted') {
      state = r.kind === 'run.closed' ? 'closed' : 'aborted';
      endedAt = r.at;
      if (state === 'closed' && results.length === 0) errors.push({ code: 'INVALID_RECORD', where, message: 'a closed run must hold at least one result' });
      continue;
    }
    if (r.result_id !== `${header.run_id}/${r.seq}`) errors.push({ code: 'INVALID_RECORD', where, message: 'result_id must be <run_id>/<seq>' });
    const entry = { ...r, superseded_by: null };
    if (r.supersedes !== null) {
      const prior = byId.get(r.supersedes);
      if (!prior) errors.push({ code: 'INVALID_RECORD', where, message: `supersedes unknown result ${r.supersedes}` });
      else if (prior.case_key !== r.case_key) errors.push({ code: 'INVALID_RECORD', where, message: 'supersedes a result for a different case' });
      else if (prior.superseded_by !== null) errors.push({ code: 'INVALID_RECORD', where, message: `${r.supersedes} was already superseded` });
      else prior.superseded_by = r.result_id;
    } else if (effectiveByCase.has(r.case_key)) {
      errors.push({ code: 'INVALID_RECORD', where, message: `${r.case_key} recorded twice without supersedes` });
    }
    effectiveByCase.set(r.case_key, entry);
    results.push(entry);
    byId.set(r.result_id, entry);
  }
  return { header, results, byId, state, endedAt, errors };
}

// ---------- record shapes ----------

function shapeErrors(rec, where) {
  const bad = (message) => [{ code: 'INVALID_RECORD', where, message }];
  if (rec.v !== SCHEMA) return bad(`v must be ${SCHEMA}`);
  switch (rec.kind) {
    case 'build.registered':
      if (!strictObject(rec, ['v', 'kind', 'build_id', 'version', 'surfaces', 'source', 'related_scopes', 'registered_by', 'registered_at', 'hash'])) return bad('unexpected build fields');
      if (!idOk(rec.build_id) || !(rec.version === null || isStr(rec.version)) || !(rec.source === null || isStr(rec.source))) return bad('invalid build identity');
      if (!Array.isArray(rec.surfaces) || rec.surfaces.length === 0 || !rec.surfaces.every(idOk) || !uniqueCanon(rec.surfaces)) return bad('invalid surfaces');
      if (!Array.isArray(rec.related_scopes) || !rec.related_scopes.every(isStr) || !isStr(rec.registered_by) || !isIso(rec.registered_at)) return bad('invalid build metadata');
      return [];
    case 'scope.created':
      if (!strictObject(rec, ['v', 'seq', 'prev', 'at', 'kind', 'scope', 'title', 'by', 'hash']) || !isStr(rec.by) || !(rec.title === null || isStr(rec.title))) return bad('invalid scope.created');
      return [];
    case 'context.set':
    case 'context.add':
      if (!strictObject(rec, ['v', 'seq', 'prev', 'at', 'kind', 'field', 'value', 'by', 'hash']) || !isStr(rec.by)) return bad(`invalid ${rec.kind}`);
      if (FIELDS[rec.field] && !FIELDS[rec.field].valid(rec.value)) return bad(`invalid ${rec.field} value`);
      return [];
    case 'context.retract':
      if (!strictObject(rec, ['v', 'seq', 'prev', 'at', 'kind', 'field', 'value', 'by', 'reason', 'hash']) || !isStr(rec.by) || !isStr(rec.reason)) return bad('invalid context.retract');
      return [];
    case 'run.opened':
      if (!strictObject(rec, ['v', 'seq', 'prev', 'at', 'kind', 'run_id', 'execution_type', 'scope', 'build_id', 'surface', 'device', 'os_runtime', 'executor', 'plan_refs', 'bug_ref', 'hash'])) return bad('unexpected run fields');
      if (!EXECUTION_TYPES.includes(rec.execution_type) || !idOk(rec.surface) || !isStr(rec.device) || !isStr(rec.executor)) return bad('invalid run header');
      if (!(rec.os_runtime === null || isStr(rec.os_runtime)) || !(rec.bug_ref === null || isStr(rec.bug_ref))) return bad('invalid run header');
      if (!Array.isArray(rec.plan_refs) || !rec.plan_refs.every((p) => strictObject(p, ['plan', 'fingerprint']) && isStr(p.plan) && isStr(p.fingerprint))) return bad('invalid plan_refs');
      return [];
    case 'result.recorded':
      if (!strictObject(rec, ['v', 'seq', 'prev', 'at', 'kind', 'result_id', 'case_key', 'case_ref', 'result', 'notes', 'evidence', 'bug_refs', 'supersedes', 'hash'])) return bad('unexpected result fields');
      if (!RESULTS.includes(rec.result)) return bad(`result must be one of ${RESULTS.join(', ')}`);
      if (!isStr(rec.case_key) || !strictObject(rec.case_ref, ['kind', 'source', 'row_hash']) || !['plan_row', 'scope_case'].includes(rec.case_ref.kind)) return bad('invalid case reference');
      if (!(rec.notes === null || isStr(rec.notes)) || !(rec.supersedes === null || isStr(rec.supersedes))) return bad('invalid result metadata');
      if (!Array.isArray(rec.evidence) || !rec.evidence.every(isStr) || !Array.isArray(rec.bug_refs) || !rec.bug_refs.every(isStr)) return bad('invalid evidence or bug_refs');
      return [];
    case 'run.closed':
      if (!strictObject(rec, ['v', 'seq', 'prev', 'at', 'kind', 'hash'])) return bad('invalid run.closed');
      return [];
    case 'run.aborted':
      if (!strictObject(rec, ['v', 'seq', 'prev', 'at', 'kind', 'reason', 'hash']) || !isStr(rec.reason)) return bad('invalid run.aborted');
      return [];
    default:
      return [{ code: 'UNKNOWN_EVENT_KIND', where, message: `unknown record kind "${rec.kind}" — written by a newer helper, or hand-edited` }];
  }
}

// ---------- loading & validation ----------

function readStreamFile(store, segments, errors) {
  const where = segments.join('/');
  const text = fs.readFileSync(store.p(...segments), 'utf8');
  const records = [];
  if (text.length && !text.endsWith('\n')) errors.push({ code: 'PARSE_ERROR', where, message: 'truncated final line' });
  const lines = text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  let prev = null;
  let ok = true;
  lines.forEach((line, i) => {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      errors.push({ code: 'PARSE_ERROR', where: `${where}:${i + 1}`, message: 'not valid JSON' });
      ok = false;
      return;
    }
    if (!hashOk(rec)) {
      errors.push({ code: 'HASH_MISMATCH', where: `${where}:${i + 1}`, message: 'record content does not match its hash' });
      ok = false;
    }
    if (rec.seq !== records.length || rec.prev !== (records.length ? prev : null)) {
      errors.push({ code: 'CHAIN_BROKEN', where: `${where}:${i + 1}`, message: 'sequence or prev-hash link broken — a record was removed, reordered or inserted' });
      ok = false;
    }
    if (!isIso(rec.at)) errors.push({ code: 'INVALID_RECORD', where: `${where}:${i + 1}`, message: 'at must be an ISO-8601 UTC timestamp' });
    errors.push(...shapeErrors(rec, `${where}:${i + 1}`));
    prev = rec.hash;
    records.push(rec);
  });
  if (!lines.length) {
    errors.push({ code: 'INVALID_RECORD', where, message: 'empty stream' });
    ok = false;
  }
  return { records, ok };
}

function loadLedger(store) {
  const errors = [];
  const warnings = [];
  if (!store.initialized()) fail('LEDGER_NOT_INITIALIZED', `no ${LEDGER_DIR}/ledger.json — run \`init\` first`);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(store.p('ledger.json'), 'utf8'));
  } catch {
    errors.push({ code: 'PARSE_ERROR', where: 'ledger.json', message: 'not valid JSON' });
    return { errors, warnings, builds: new Map(), scopes: new Map(), runs: new Map(), corrupt: new Set() };
  }
  if (meta.qa_ledger_schema !== SCHEMA) {
    errors.push({ code: 'UNSUPPORTED_SCHEMA', where: 'ledger.json', message: `ledger schema ${meta.qa_ledger_schema} is not supported by this helper (supports ${SCHEMA}) — upgrade the plugin` });
    return { errors, warnings, builds: new Map(), scopes: new Map(), runs: new Map(), corrupt: new Set() };
  }
  if (!hashOk(meta) || !isIso(meta.created_at)) errors.push({ code: 'HASH_MISMATCH', where: 'ledger.json', message: 'ledger.json was edited' });

  const corrupt = new Set();
  for (const name of store.list()) {
    if (!['ledger.json', 'builds', 'scopes', 'runs'].includes(name)) warnings.push({ code: 'UNEXPECTED_ENTRY', where: name, message: 'not part of the ledger; ignored' });
  }

  const builds = new Map();
  for (const name of store.list('builds')) {
    const where = `builds/${name}`;
    if (!name.endsWith('.json')) {
      warnings.push({ code: 'UNEXPECTED_ENTRY', where, message: 'ignored' });
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(store.p('builds', name), 'utf8'));
    } catch {
      errors.push({ code: 'PARSE_ERROR', where, message: 'not valid JSON' });
      continue;
    }
    if (!hashOk(rec)) errors.push({ code: 'HASH_MISMATCH', where, message: 'build record was edited — builds are immutable' });
    errors.push(...shapeErrors(rec, where));
    if (rec.build_id !== name.slice(0, -5)) errors.push({ code: 'ID_MISMATCH', where, message: `file name does not match build_id "${rec.build_id}"` });
    builds.set(name.slice(0, -5), rec);
  }

  const scopes = new Map();
  for (const kind of store.list('scopes')) {
    if (!SCOPE_KINDS.includes(kind)) {
      warnings.push({ code: 'UNEXPECTED_ENTRY', where: `scopes/${kind}`, message: 'ignored' });
      continue;
    }
    for (const name of store.list('scopes', kind)) {
      if (!name.endsWith('.jsonl')) {
        warnings.push({ code: 'UNEXPECTED_ENTRY', where: `scopes/${kind}/${name}`, message: 'ignored' });
        continue;
      }
      const ref = `${kind}:${name.slice(0, -6)}`;
      const { records, ok } = readStreamFile(store, ['scopes', kind, name], errors);
      if (!ok) corrupt.add(ref);
      if (!records.length) continue;
      const [created, ...events] = records;
      if (created.kind !== 'scope.created' || created.scope !== ref) errors.push({ code: 'ID_MISMATCH', where: `scopes/${kind}/${name}`, message: 'first record must be scope.created for this scope' });
      const contextEvents = events.filter((e) => e.kind?.startsWith('context.'));
      for (const e of events) if (e.kind === 'scope.created') errors.push({ code: 'INVALID_RECORD', where: `${ref} seq ${e.seq}`, message: 'scope.created may appear only once' });
      const replay = replayContext(ref, contextEvents);
      errors.push(...replay.errors);
      scopes.set(ref, { ref, kind, created, events: records, context: replay.context });
    }
  }

  const runs = new Map();
  for (const name of store.list('runs')) {
    if (!name.endsWith('.jsonl')) {
      warnings.push({ code: 'UNEXPECTED_ENTRY', where: `runs/${name}`, message: 'ignored' });
      continue;
    }
    const id = name.slice(0, -6);
    const { records, ok } = readStreamFile(store, ['runs', name], errors);
    if (!ok) corrupt.add(id);
    if (!records.length) continue;
    if (records[0].kind !== 'run.opened' || records[0].run_id !== id) {
      errors.push({ code: 'ID_MISMATCH', where: `runs/${name}`, message: 'first record must be run.opened for this run id' });
      continue;
    }
    for (const r of records.slice(1)) {
      if (!['result.recorded', 'run.closed', 'run.aborted'].includes(r.kind)) errors.push({ code: 'INVALID_RECORD', where: `${id} seq ${r.seq}`, message: `${r.kind} does not belong in a run` });
    }
    const replay = replayRun(records.filter((r, i) => i === 0 || ['result.recorded', 'run.closed', 'run.aborted'].includes(r.kind)));
    errors.push(...replay.errors);
    runs.set(id, replay);
  }

  // Referential integrity across records.
  const dangling = (where, message) => errors.push({ code: 'DANGLING_REFERENCE', where, message });
  const results = new Map();
  for (const run of runs.values()) for (const r of run.results) results.set(r.result_id, r);
  for (const [id, b] of builds) for (const s of b.related_scopes ?? []) if (!scopes.has(s)) dangling(`builds/${id}.json`, `related scope ${s} does not exist`);
  for (const s of scopes.values()) {
    for (const f of ['related_scopes', 'members']) for (const x of s.context[f] ?? []) if (!scopes.has(x)) dangling(s.ref, `${f} → ${x} does not exist`);
    for (const x of s.context.result_refs ?? []) if (!results.has(x)) dangling(s.ref, `result_refs → ${x} does not exist`);
    for (const x of s.context.plans ?? []) if (!fs.existsSync(path.join(store.root, x))) warnings.push({ code: 'PLAN_MISSING', where: s.ref, message: `${x} no longer exists in the QA repo` });
  }
  for (const [id, run] of runs) {
    const h = run.header;
    if (!scopes.has(h.scope)) dangling(id, `scope ${h.scope} does not exist`);
    const build = builds.get(h.build_id);
    if (!build) dangling(id, `build ${h.build_id} does not exist`);
    else if (!build.surfaces?.includes(h.surface)) errors.push({ code: 'INVALID_RECORD', where: id, message: `surface ${h.surface} is not one of build ${h.build_id}'s surfaces` });
    if (h.bug_ref !== null && (!h.bug_ref.startsWith('bug:') || !scopes.has(h.bug_ref))) dangling(id, `bug_ref ${h.bug_ref} is not an existing bug scope`);
    if (BUG_REF_TYPES.includes(h.execution_type) && h.bug_ref === null) errors.push({ code: 'INVALID_RECORD', where: id, message: `${h.execution_type} runs require a bug_ref` });
    for (const r of run.results) {
      for (const b of r.bug_refs) if (!b.startsWith('bug:') || !scopes.has(b)) dangling(r.result_id, `bug ${b} is not an existing bug scope`);
      const src = r.case_ref?.source;
      if (r.case_ref?.kind === 'plan_row' && !h.plan_refs.some((p) => p.plan === src)) errors.push({ code: 'INVALID_RECORD', where: r.result_id, message: `case ${r.case_key} is not from a plan this run referenced` });
      if (r.case_ref?.kind === 'scope_case' && src !== h.scope && src !== h.bug_ref) errors.push({ code: 'INVALID_RECORD', where: r.result_id, message: `case ${r.case_key} does not belong to this run's scope or bug` });
    }
  }
  return { errors, warnings, builds, scopes, runs, results, corrupt };
}

// Loaded ledger for a write: must be structurally valid, and the target stream intact.
function loadForWrite(store, target) {
  const model = loadLedger(store);
  if (target && model.corrupt.has(target)) fail('CORRUPT_STREAM', `${target} is corrupt — refusing to extend it; run validate`, model.errors);
  if (model.errors.length) fail('CORRUPT_LEDGER', 'the ledger has validation errors — refusing to write; run validate', model.errors);
  return model;
}

function loadForRead(store) {
  const model = loadLedger(store);
  if (model.errors.length) fail('CORRUPT_LEDGER', 'the ledger has validation errors — derived views are withheld; run validate', model.errors);
  return model;
}

// ---------- ordering ----------

// Builds are ordered by registration time, then id — deterministic across machines.
function orderedBuilds(model) {
  return [...model.builds.values()].sort((a, b) => (a.registered_at < b.registered_at ? -1 : a.registered_at > b.registered_at ? 1 : a.build_id < b.build_id ? -1 : 1));
}
function runOrder(model) {
  const idx = new Map(orderedBuilds(model).map((b, i) => [b.build_id, i]));
  return [...model.runs.values()].sort((a, b) => {
    const d = idx.get(a.header.build_id) - idx.get(b.header.build_id);
    if (d) return d;
    if (a.header.at !== b.header.at) return a.header.at < b.header.at ? -1 : 1;
    return a.header.run_id < b.header.run_id ? -1 : 1;
  });
}
function scopeBuildIds(model, scope) {
  const ids = new Set();
  for (const b of model.builds.values()) if (b.related_scopes.includes(scope)) ids.add(b.build_id);
  for (const r of model.runs.values()) if (r.header.scope === scope) ids.add(r.header.build_id);
  return ids;
}

// ---------- commands ----------

function requireScope(model, ref) {
  const s = parseScopeRef(ref);
  if (!model.scopes.has(s.ref)) fail('UNKNOWN_SCOPE', `scope ${s.ref} does not exist`);
  return s;
}
function requireBugScope(model, ref) {
  const s = parseScopeRef(ref);
  if (s.kind !== 'bug') fail('INVALID_BUG_REF', `${ref} is not a bug scope (bug:<id>)`);
  if (!model.scopes.has(s.ref)) fail('UNKNOWN_SCOPE', `bug scope ${s.ref} does not exist`);
  return s.ref;
}
function findCaseInsensitive(names, name) {
  return names.some((n) => n.toLowerCase() === name.toLowerCase());
}

function cmdInit(store) {
  store.p();
  if (store.initialized()) {
    const meta = JSON.parse(fs.readFileSync(store.p('ledger.json'), 'utf8'));
    if (meta.qa_ledger_schema !== SCHEMA) fail('UNSUPPORTED_SCHEMA', `ledger schema ${meta.qa_ledger_schema} is not supported`);
    return { created: false, ledger: LEDGER_DIR };
  }
  if (!fs.existsSync(store.dir)) fs.mkdirSync(store.dir);
  store.create(['ledger.json'], `${canonical(seal({ qa_ledger_schema: SCHEMA, created_at: now() }))}\n`);
  return { created: true, ledger: LEDGER_DIR };
}

function cmdBuildAdd(store, o) {
  const id = checkId(o.id, 'build id');
  const surfaces = o.surfaces.split(',').map((s) => checkId(s.trim(), 'surface'));
  if (!uniqueCanon(surfaces)) fail('INVALID_VALUE', 'surfaces must be unique');
  const model = loadForWrite(store);
  if (findCaseInsensitive(store.list('builds'), `${id}.json`)) fail('DUPLICATE_BUILD', `build ${id} is already registered — builds are immutable`); // invariant:duplicate-build
  const related = (o['related-scope'] ?? []).map((r) => requireScope(model, r).ref);
  const record = seal({
    v: SCHEMA,
    kind: 'build.registered',
    build_id: id,
    version: o.version ?? null,
    surfaces,
    source: o.source ?? null,
    related_scopes: [...new Set(related)],
    registered_by: o['registered-by'],
    registered_at: now(),
  });
  store.create(['builds', `${id}.json`], `${canonical(record)}\n`);
  return { build: record };
}

function appendEvent(store, segments, records, body) {
  const last = records[records.length - 1];
  const rec = seal({ v: SCHEMA, seq: records.length, prev: last ? last.hash : null, at: now(), ...body });
  if (records.length === 0) store.create(segments, `${canonical(rec)}\n`);
  else store.append(segments, `${canonical(rec)}\n`);
  return rec;
}

function cmdScopeCreate(store, o) {
  const s = parseScopeRef(o.scope);
  loadForWrite(store);
  if (findCaseInsensitive(store.list('scopes', s.kind), `${s.id}.jsonl`)) fail('DUPLICATE_SCOPE', `scope ${s.ref} already exists`);
  const rec = appendEvent(store, ['scopes', s.kind, `${s.id}.jsonl`], [], { kind: 'scope.created', scope: s.ref, title: o.title ?? null, by: o['created-by'] });
  return { scope: s.ref, event: rec };
}

function cmdScopeEvent(store, o) {
  const s = parseScopeRef(o.scope);
  const model = loadForWrite(store, s.ref);
  if (!model.scopes.has(s.ref)) fail('UNKNOWN_SCOPE', `scope ${s.ref} does not exist`);
  const scope = model.scopes.get(s.ref);
  if (!['set', 'add', 'retract'].includes(o.op)) fail('INVALID_VALUE', '--op must be set, add or retract');
  const spec = FIELDS[o.field];
  if (!spec) fail('UNKNOWN_FIELD', `unknown context field "${o.field}" — known: ${Object.keys(FIELDS).join(', ')}`);
  if (spec.kinds && !spec.kinds.includes(s.kind)) fail('INVALID_FIELD_FOR_SCOPE', `${o.field} applies only to ${spec.kinds.join('/')} scopes`);
  if ((o.op === 'set') !== (spec.op === 'set')) fail('INVALID_OP', `${o.field} is a${spec.op === 'set' ? ' set' : 'n add'} field — use --op ${spec.op === 'set' ? 'set' : 'add or retract'}`);
  let value;
  try {
    value = JSON.parse(o.value);
  } catch {
    fail('INVALID_VALUE', '--value must be JSON');
  }
  const current = scope.context[o.field] ?? [];
  if (o.op === 'retract') {
    if (!o.reason) fail('MISSING_ARGUMENT', '--reason is required for a retract');
    const k = spec.key ? value : canonical(value);
    if (!current.some((x) => keyOf(spec, x) === k)) fail('NOT_PRESENT', `${o.field} has no such value to retract`);
    const rec = appendEvent(store, ['scopes', s.kind, `${s.id}.jsonl`], scope.events, { kind: 'context.retract', field: o.field, value, by: o.by, reason: o.reason });
    return { scope: s.ref, event: rec };
  }
  if (!spec.valid(value)) fail('INVALID_VALUE', `invalid value for ${o.field}`);
  if (spec.ref === 'plan') value = resolveQaFile(store.root, value).rel;
  if (spec.ref === 'scope') {
    const target = requireScope(model, value).ref;
    if (target === s.ref) fail('INVALID_VALUE', 'a scope cannot reference itself');
    value = target;
  }
  if (spec.ref === 'result' && !model.results.has(value)) fail('UNKNOWN_RESULT', `result ${value} does not exist`);
  if (o.op === 'add' && current.some((x) => keyOf(spec, x) === keyOf(spec, value))) fail('DUPLICATE_VALUE', `${o.field} already holds that value`);
  const rec = appendEvent(store, ['scopes', s.kind, `${s.id}.jsonl`], scope.events, { kind: `context.${o.op}`, field: o.field, value, by: o.by });
  return { scope: s.ref, event: rec };
}

function cmdRunOpen(store, o) {
  if (!EXECUTION_TYPES.includes(o.type)) fail('INVALID_VALUE', `--type must be one of ${EXECUTION_TYPES.join(', ')}`);
  const surface = checkId(o.surface, 'surface');
  const model = loadForWrite(store);
  const scope = requireScope(model, o.scope); // invariant:run-scope-exists
  const build = model.builds.get(o.build);
  if (!build) fail('UNKNOWN_BUILD', `build ${o.build} is not registered`); // invariant:run-build-exists
  if (!build.surfaces.includes(surface)) fail('SURFACE_NOT_IN_BUILD', `build ${o.build} does not ship surface ${surface} (it ships ${build.surfaces.join(', ')})`);
  let bugRef = o['bug-ref'] ? requireBugScope(model, o['bug-ref']) : null;
  if (!bugRef && scope.kind === 'bug') bugRef = scope.ref;
  if (BUG_REF_TYPES.includes(o.type) && !bugRef) fail('BUG_REF_REQUIRED', `${o.type} runs are about a bug — pass --bug-ref bug:<id>`);
  const planRefs = [];
  for (const p of o.plan ?? []) {
    const plan = readPlan(store.root, p);
    if (!planRefs.some((x) => x.plan === plan.plan)) planRefs.push({ plan: plan.plan, fingerprint: plan.fingerprint });
  }
  const at = now();
  const header = {
    kind: 'run.opened',
    execution_type: o.type,
    scope: scope.ref,
    build_id: build.build_id,
    surface,
    device: o.device,
    os_runtime: o['os-runtime'] ?? null,
    executor: o.executor,
    plan_refs: planRefs,
    bug_ref: bugRef,
  };
  const runId = `${o.type}-${at.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${sha(canonical({ ...header, at })).slice(7, 15)}`;
  if (model.runs.has(runId)) fail('DUPLICATE_RUN', `run ${runId} already exists`);
  const rec = seal({ v: SCHEMA, seq: 0, prev: null, at, run_id: runId, ...header });
  store.create(['runs', `${runId}.jsonl`], `${canonical(rec)}\n`);
  return { run_id: runId, run: rec };
}

function requireOpenRun(model, id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) fail('INVALID_ID', `run id "${id}" is malformed`);
  const run = model.runs.get(id);
  if (!run) fail('UNKNOWN_RUN', `run ${id} does not exist`);
  if (run.state !== 'open') fail('RUN_NOT_OPEN', `run ${id} is ${run.state} — terminal runs are immutable`); // invariant:terminal-run
  return run;
}

function resolveCase(store, model, run, key) {
  const h = run.header;
  const hashIdx = key.lastIndexOf('#');
  if (hashIdx > 0) {
    const scopeRef = key.slice(0, hashIdx);
    const caseId = key.slice(hashIdx + 1);
    if ((scopeRef !== h.scope && scopeRef !== h.bug_ref) || !model.scopes.has(scopeRef)) fail('UNKNOWN_CASE', `${key}: scope-owned cases must belong to this run's scope or bug`);
    const found = (model.scopes.get(scopeRef).context.cases ?? []).find((c) => c.id === caseId);
    if (!found) fail('UNKNOWN_CASE', `${scopeRef} declares no case "${caseId}" — declare it with a cases context event first`);
    return { kind: 'scope_case', source: scopeRef, row_hash: sha(canonical(found)) };
  }
  const slash = key.lastIndexOf('/');
  const prefix = slash > 0 ? key.slice(0, slash) : null;
  const id = key.slice(slash + 1);
  const ref = h.plan_refs.find((p) => path.posix.dirname(p.plan) === prefix);
  if (!ref) fail('UNKNOWN_CASE', `${key} is not from a plan this run references (--plan at run open)`);
  const plan = readPlan(store.root, ref.plan);
  if (plan.duplicates.includes(id)) fail('AMBIGUOUS_CASE', `${ref.plan} defines ${id} more than once`);
  const row = plan.rows.find((r) => r.id === id);
  if (!row) fail('UNKNOWN_CASE', `${ref.plan} has no test case ${id} — the ledger never invents test cases`);
  return { kind: 'plan_row', source: ref.plan, row_hash: row.row_hash };
}

function cmdResultAdd(store, o) {
  const model = loadForWrite(store, o.run);
  const run = requireOpenRun(model, o.run);
  if (!RESULTS.includes(o.result)) fail('INVALID_VALUE', `--result must be one of ${RESULTS.join(', ')}`);
  const bugRefs = [...new Set((o.bug ?? []).map((b) => requireBugScope(model, b)))];
  let supersedes = null;
  if (o.supersedes) {
    const prior = run.byId.get(o.supersedes);
    if (!prior) fail('UNKNOWN_RESULT', `${o.supersedes} is not a result of run ${o.run} — corrections stay inside their run`);
    if (prior.case_key !== o.case) fail('SUPERSEDE_CASE_MISMATCH', `${o.supersedes} is for ${prior.case_key}, not ${o.case}`); // invariant:supersede-case
    if (prior.superseded_by !== null) fail('ALREADY_SUPERSEDED', `${o.supersedes} was already superseded by ${prior.superseded_by}`);
    supersedes = prior.result_id;
  } else if (run.results.some((r) => r.case_key === o.case && r.superseded_by === null)) {
    fail('DUPLICATE_CASE_IN_RUN', `${o.case} already has a result in this run — pass --supersedes <result-id> to correct it`);
  }
  const caseRef = resolveCase(store, model, run, o.case);
  const seq = run.results.length + 1;
  const records = [run.header, ...run.results.map(({ superseded_by, ...r }) => r)];
  const rec = appendEvent(store, ['runs', `${o.run}.jsonl`], records, {
    kind: 'result.recorded',
    result_id: `${o.run}/${seq}`,
    case_key: o.case,
    case_ref: caseRef,
    result: o.result,
    notes: o.notes ?? null,
    evidence: o.evidence ?? [],
    bug_refs: bugRefs,
    supersedes,
  });
  return { result_id: rec.result_id, result: rec };
}

function cmdRunEnd(store, o, kind) {
  const model = loadForWrite(store, o.run);
  const run = requireOpenRun(model, o.run);
  if (kind === 'run.closed' && run.results.length === 0) fail('EMPTY_RUN', `run ${o.run} has no results — abort it instead`);
  if (kind === 'run.aborted' && !o.reason) fail('MISSING_ARGUMENT', '--reason is required to abort a run');
  const records = [run.header, ...run.results.map(({ superseded_by, ...r }) => r)];
  const rec = appendEvent(store, ['runs', `${o.run}.jsonl`], records, kind === 'run.aborted' ? { kind, reason: o.reason } : { kind });
  return { run_id: o.run, state: kind === 'run.closed' ? 'closed' : 'aborted', event: rec };
}

// ---------- views ----------

function runSummary(run) {
  const h = run.header;
  return {
    run_id: h.run_id,
    type: h.execution_type,
    scope: h.scope,
    build_id: h.build_id,
    surface: h.surface,
    device: h.device,
    os_runtime: h.os_runtime,
    executor: h.executor,
    bug_ref: h.bug_ref,
    plan_refs: h.plan_refs,
    started_at: h.at,
    ended_at: run.endedAt,
    state: run.state,
    result_count: run.results.length,
    effective_count: run.results.filter((r) => r.superseded_by === null).length,
  };
}

function caseHistory(model, o) {
  const out = [];
  for (const run of runOrder(model)) {
    const h = run.header;
    if (o.surface && h.surface !== o.surface) continue;
    if (o.scope && h.scope !== o.scope) continue;
    for (const r of run.results) {
      if (r.case_key !== o.case) continue;
      out.push({
        result_id: r.result_id,
        run_id: h.run_id,
        run_state: run.state,
        type: h.execution_type,
        scope: h.scope,
        build_id: h.build_id,
        surface: h.surface,
        device: h.device,
        os_runtime: h.os_runtime,
        executor: h.executor,
        result: r.result,
        notes: r.notes,
        evidence: r.evidence,
        bug_refs: r.bug_refs,
        case_ref: r.case_ref,
        recorded_at: r.at,
        supersedes: r.supersedes,
        superseded_by: r.superseded_by,
      });
    }
  }
  return out;
}

function viewScope(model, ref) {
  const s = requireScope(model, ref);
  const scope = model.scopes.get(s.ref);
  const buildIds = scopeBuildIds(model, s.ref);
  return {
    scope: {
      scope: s.ref,
      kind: s.kind,
      id: s.id,
      title: scope.context.title ?? scope.created.title,
      created_at: scope.created.at,
      created_by: scope.created.by,
      context: scope.context,
      event_count: scope.events.length,
      builds: orderedBuilds(model).filter((b) => buildIds.has(b.build_id)).map((b) => b.build_id),
      runs: runOrder(model).filter((r) => r.header.scope === s.ref).map((r) => r.header.run_id),
    },
  };
}

function buildList(model, o) {
  let list = orderedBuilds(model);
  if (o.scope) {
    const ids = scopeBuildIds(model, requireScope(model, o.scope).ref);
    list = list.filter((b) => ids.has(b.build_id));
  }
  if (o.surface) list = list.filter((b) => b.surfaces.includes(o.surface));
  return list;
}

function cmdView(store, what, o) {
  const model = loadForRead(store);
  switch (what) {
    case 'scope':
      return viewScope(model, o.scope);
    case 'builds':
      return { builds: buildList(model, o) };
    case 'latest-build': {
      const list = buildList(model, o);
      return { surface: o.surface, build: list.length ? list[list.length - 1] : null };
    }
    case 'runs': {
      if (o.scope) requireScope(model, o.scope);
      const runs = runOrder(model).filter((r) => (!o.build || r.header.build_id === o.build) && (!o.scope || r.header.scope === o.scope));
      return { runs: runs.map(runSummary) };
    }
    case 'case-history':
      return { case: o.case, history: caseHistory(model, o) };
    case 'latest-result': {
      // Latest effective result from closed runs only: open runs are provisional,
      // aborted runs are void. Nothing here removes or rewrites history.
      const all = caseHistory(model, o);
      const eligible = all.filter((h) => h.run_state === 'closed' && h.superseded_by === null);
      return {
        case: o.case,
        surface: o.surface,
        latest: eligible.length ? eligible[eligible.length - 1] : null,
        history_count: all.length,
        excluded_open: all.filter((h) => h.run_state === 'open').length,
        excluded_aborted: all.filter((h) => h.run_state === 'aborted').length,
      };
    }
    default:
      fail('UNKNOWN_COMMAND', `unknown view "${what}"`);
  }
}

function cmdValidate(store) {
  const model = loadLedger(store);
  const counts = { builds: model.builds.size, scopes: model.scopes.size, runs: model.runs.size, results: model.results ? model.results.size : 0 };
  return { ok: model.errors.length === 0, errors: model.errors, warnings: model.warnings, counts };
}

// ---------- CLI ----------

const COMMANDS = {
  init: { opts: [], run: (s) => cmdInit(s) },
  validate: { opts: [], run: (s) => cmdValidate(s) },
  'build add': { req: ['id', 'surfaces', 'registered-by'], opts: ['version', 'source', 'related-scope'], run: cmdBuildAdd },
  'scope create': { req: ['scope', 'created-by'], opts: ['title'], run: cmdScopeCreate },
  'scope event': { req: ['scope', 'op', 'field', 'value', 'by'], opts: ['reason'], run: cmdScopeEvent },
  'run open': { req: ['type', 'scope', 'build', 'surface', 'device', 'executor'], opts: ['os-runtime', 'plan', 'bug-ref'], run: cmdRunOpen },
  'run close': { req: ['run'], opts: [], run: (s, o) => cmdRunEnd(s, o, 'run.closed') },
  'run abort': { req: ['run'], opts: ['reason'], run: (s, o) => cmdRunEnd(s, o, 'run.aborted') },
  'result add': { req: ['run', 'case', 'result'], opts: ['notes', 'evidence', 'bug', 'supersedes'], run: cmdResultAdd },
  'view scope': { req: ['scope'], opts: [], run: (s, o) => cmdView(s, 'scope', o) },
  'view builds': { opts: ['scope', 'surface'], run: (s, o) => cmdView(s, 'builds', o) },
  'view latest-build': { req: ['surface'], opts: ['scope'], run: (s, o) => cmdView(s, 'latest-build', o) },
  'view runs': { opts: ['scope', 'build'], run: (s, o) => cmdView(s, 'runs', o) },
  'view case-history': { req: ['case'], opts: ['surface', 'scope'], run: (s, o) => cmdView(s, 'case-history', o) },
  'view latest-result': { req: ['case', 'surface'], opts: ['scope'], run: (s, o) => cmdView(s, 'latest-result', o) },
  'plan rows': {
    req: ['plan'],
    opts: [],
    ledgerless: true,
    run: (s, o) => {
      if (o.plan.length !== 1) fail('DUPLICATE_ARGUMENT', 'plan rows reads exactly one --plan');
      return readPlan(s.root, o.plan[0]);
    },
  },
};
const REPEATABLE = new Set(['plan', 'evidence', 'bug', 'related-scope']);

function parseArgs(argv) {
  const words = [];
  let i = 0;
  while (i < argv.length && !argv[i].startsWith('--')) words.push(argv[i++]);
  const opts = {};
  while (i < argv.length) {
    const flag = argv[i++];
    if (!flag.startsWith('--')) fail('UNKNOWN_ARGUMENT', `unexpected argument "${flag}"`);
    const name = flag.slice(2);
    const value = argv[i++];
    if (value === undefined || value === '' || value.startsWith('--')) fail('MISSING_ARGUMENT', `${flag} needs a value`);
    if (REPEATABLE.has(name)) (opts[name] ??= []).push(value);
    else if (name in opts) fail('DUPLICATE_ARGUMENT', `${flag} given more than once`);
    else opts[name] = value;
  }
  return { words, opts };
}

export function main(argv) {
  const { words, opts } = parseArgs(argv);
  const key = words.join(' ');
  const cmd = COMMANDS[key];
  if (!cmd) fail('UNKNOWN_COMMAND', `unknown command "${key}" — one of: ${Object.keys(COMMANDS).join(' | ')}`);
  const allowed = new Set(['qa-repo', ...(cmd.req ?? []), ...cmd.opts]);
  for (const name of Object.keys(opts)) if (!allowed.has(name)) fail('UNKNOWN_ARGUMENT', `--${name} is not an option of ${key}`);
  const root = resolveQaRepo(opts['qa-repo']);
  for (const name of cmd.req ?? []) if (opts[name] === undefined) fail('MISSING_ARGUMENT', `--${name} is required for ${key}`);
  const store = new Store(root);
  store.p(); // refuses a symlinked qa-ledger/ before anything else reads or writes
  if (!cmd.ledgerless && key !== 'init' && !store.initialized()) fail('LEDGER_NOT_INITIALIZED', `no ${LEDGER_DIR}/ in ${root} — run \`init\` first`);
  const out = cmd.run(store, opts);
  return out.ok === false ? out : { ok: true, ...out };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  let out;
  try {
    out = main(process.argv.slice(2));
  } catch (e) {
    out = e instanceof LedgerError ? { ok: false, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } } : { ok: false, error: { code: 'INTERNAL_ERROR', message: String(e?.stack || e) } };
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = out.ok ? 0 : 1;
}
