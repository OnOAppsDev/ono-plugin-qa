// Loading, replay and structural validation of the QA ledger.
// Internal module of scripts/qa-ledger.mjs. Read-only: it never writes.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA, EXECUTION_TYPES, RESULTS, SCOPE_KINDS, BUG_REF_TYPES, LEDGER_DIR, fail, canonical, hashOk, isStr, isIso, strictObject, uniqueCanon, idOk } from './core.mjs';
import { executionErrors } from './execution.mjs';

// ---------- scope context fields ----------

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
  // Stage 2 (additive): a case that does not apply on one surface, and QA's explicit,
  // reasoned decision to go past a closed smoke gate for one build and surface.
  exclusions: {
    op: 'add',
    keyOf: (v) => `${v.case_key}@${v.surface}`,
    kinds: ['feature'],
    ref: 'exclusion',
    valid: (v) => strictObject(v, ['case_key', 'surface', 'reason']) && isStr(v.case_key) && idOk(v.surface) && isStr(v.reason),
  },
  smoke_overrides: {
    op: 'add',
    keyOf: (v) => `${v.build_id}@${v.surface}`,
    ref: 'smoke_override',
    valid: (v) => strictObject(v, ['build_id', 'surface', 'reason']) && idOk(v.build_id) && idOk(v.surface) && isStr(v.reason),
  },
};

export const keyOf = (spec, v) => (spec.keyOf ? spec.keyOf(v) : spec.key ? v[spec.key] : canonical(v));
// A retract names a keyed value by its key string, any other value by the value itself.
export const retractKey = (spec, v) => (spec.keyOf || spec.key ? v : canonical(v));

// Replays one scope's context events into the current derived context. Never
// mutates anything; a hand-edited stream that no helper could have written is
// reported as INVALID_RECORD.
export function replayContext(scope, events) {
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
      const k = retractKey(spec, e.value);
      const i = spec.op === 'add' && list ? list.findIndex((x) => keyOf(spec, x) === k) : -1;
      if (i < 0) errors.push({ code: 'INVALID_RECORD', where, message: `retract of a ${e.field} value that is not present` });
      else list.splice(i, 1);
    }
  }
  return { context, errors };
}

// ---------- runs ----------

// Replays one run stream into its derived state: results, supersession, state.
export function replayRun(records) {
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

export function loadLedger(store) {
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
    for (const o of s.context.smoke_overrides ?? []) if (!builds.has(o.build_id)) dangling(s.ref, `smoke_overrides → build ${o.build_id} does not exist`);
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
  const model = { errors, warnings, builds, scopes, runs, results, corrupt };
  errors.push(...executionErrors(model));
  return model;
}

// Loaded ledger for a write: must be structurally valid, and the target stream intact.
export function loadForWrite(store, target) {
  const model = loadLedger(store);
  if (target && model.corrupt.has(target)) fail('CORRUPT_STREAM', `${target} is corrupt — refusing to extend it; run validate`, model.errors);
  if (model.errors.length) fail('CORRUPT_LEDGER', 'the ledger has validation errors — refusing to write; run validate', model.errors);
  return model;
}

export function loadForRead(store) {
  const model = loadLedger(store);
  if (model.errors.length) fail('CORRUPT_LEDGER', 'the ledger has validation errors — derived views are withheld; run validate', model.errors);
  return model;
}
