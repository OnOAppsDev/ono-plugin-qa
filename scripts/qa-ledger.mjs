#!/usr/bin/env node
// QA ledger helper — the only writer of <qa-repo>/qa-ledger/. Zero dependencies,
// same as build-test-cases-xlsx.mjs: only Node (bundled with Claude Code) is assumed.
//
// Contract: docs/qa-ledger-contract.md. Every command prints one JSON object on
// stdout and exits 0 when `ok: true`, 1 otherwise — branch on `error.code`.
//
//   node qa-ledger.mjs <command> [subcommand] --qa-repo <path> [options]
//
// This file is the single CLI entry point and the only place a Store (the write
// boundary) is constructed. Internal modules under lib/qa-ledger/ check, parse and
// derive; they never write. Stage 1 enforces structure (identity, references,
// append-only history, terminal runs); Stage 2 adds the smoke gate and functional
// execution rules (lib/qa-ledger/execution.mjs); Stage 3 the bug lifecycle
// (lib/qa-ledger/bugs.mjs). Regression and readiness come later.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA, EXECUTION_TYPES, RESULTS, BUG_REF_TYPES, LEDGER_DIR, RUN_ID_RE, LedgerError, fail, canonical, sha, seal, now, checkId, parseScopeRef, uniqueCanon } from './lib/qa-ledger/core.mjs';
import { resolveQaRepo, Store, resolveQaFile } from './lib/qa-ledger/store.mjs';
import { readPlan, readSmokeSuite } from './lib/qa-ledger/plans.mjs';
import { FIELDS, keyOf, retractKey, loadLedger, loadForWrite, loadForRead } from './lib/qa-ledger/model.mjs';
import { requireScope, requireBugScope, findCaseInsensitive } from './lib/qa-ledger/query.mjs';
import { checkRunOpen, checkResultAdd, checkRunClose, checkContextValue, requireSmokeGate } from './lib/qa-ledger/execution.mjs';
import { view } from './lib/qa-ledger/views.mjs';
import { readKnowledge, knowledgeSummary, resolveCapability, directCandidates, coverageFor } from './lib/qa-ledger/knowledge.mjs';
import { buildDecision, checkRegressionOpen, checkRegressionResult } from './lib/qa-ledger/regression.mjs';
import { computeReadiness, renderReadinessMarkdown, requireNonRelease, pinValue, exceptionValue, dischargeValue } from './lib/qa-ledger/readiness.mjs';
import { READY_STATUS, resolveCodeRepo, resolveHandoff } from './lib/qa-ledger/handoff.mjs';
import { SEVERITIES, RESOLUTIONS, CLOSED, bugReport, bugCase, bugCaseKey, bugCaseHash, deriveBug, requireReportedBug, resolveCaseKey, caseScenario, checkBugRunOpen, checkBugResult, checkBugRunClose, checkFixClaims, renderBugMarkdown } from './lib/qa-ledger/bugs.mjs';

// ---------- commands ----------

function cmdInit(store) {
  store.p();
  if (store.initialized()) {
    const meta = JSON.parse(fs.readFileSync(store.p('ledger.json'), 'utf8'));
    if (meta.qa_ledger_schema !== SCHEMA) fail('UNSUPPORTED_SCHEMA', `ledger schema ${meta.qa_ledger_schema} is not supported`);
    return { created: false, ledger: LEDGER_DIR };
  }
  store.ensureDir();
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
  // Stage 3: a build may claim to fix reported bugs. The claim never closes a bug —
  // only a QA re-test on this (or a later) build can.
  const fixes = o.fixes ? checkFixClaims(model, o.fixes, surfaces) : null;
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
    ...(fixes ? { fixes_claimed: fixes } : {}),
  });
  store.create(['builds', `${id}.json`], `${canonical(record)}\n`);
  return { build: record, render: fixes ?? [] };
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
  if (spec.managed) fail('MANAGED_FIELD', `${o.field} is written only through its readiness command (readiness pin|unpin|except|discharge|signoff), which validates it`);
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
    const k = retractKey(spec, value);
    if (!current.some((x) => keyOf(spec, x) === k)) fail('NOT_PRESENT', `${o.field} has no such value to retract`);
    const rec = appendEvent(store, ['scopes', s.kind, `${s.id}.jsonl`], scope.events, { kind: 'context.retract', field: o.field, value, by: o.by, reason: o.reason });
    return { scope: s.ref, event: rec, render: bugReport(scope) ? [s.ref] : [] };
  }
  if (!spec.valid(value)) fail('INVALID_VALUE', `invalid value for ${o.field}`);
  if (o.field === 'cases' && value.id === 'R1' && bugReport(scope)) fail('INVALID_VALUE', `${s.ref}#R1 is the bug's own scenario, taken from its report`);
  if (spec.ref === 'case') value = resolveCaseKey(store.root, value);
  if (spec.ref === 'plan') value = resolveQaFile(store.root, value).rel;
  if (spec.ref === 'scope') {
    const target = requireScope(model, value).ref;
    if (target === s.ref) fail('INVALID_VALUE', 'a scope cannot reference itself');
    value = target;
  }
  if (spec.ref === 'result' && !model.results.has(value)) fail('UNKNOWN_RESULT', `result ${value} does not exist`);
  if (spec.ref === 'exclusion' || spec.ref === 'smoke_override') checkContextValue(store.root, model, scope, o.field, value);
  if (o.op === 'add' && current.some((x) => keyOf(spec, x) === keyOf(spec, value))) fail('DUPLICATE_VALUE', `${o.field} already holds that value`);
  const rec = appendEvent(store, ['scopes', s.kind, `${s.id}.jsonl`], scope.events, { kind: `context.${o.op}`, field: o.field, value, by: o.by });
  return { scope: s.ref, event: rec, render: bugReport(scope) ? [s.ref] : [] };
}

// Checks a run open and builds its header record without writing it.
function prepareRunOpen(store, model, o) {
  if (!EXECUTION_TYPES.includes(o.type)) fail('INVALID_VALUE', `--type must be one of ${EXECUTION_TYPES.join(', ')}`);
  const surface = checkId(o.surface, 'surface');
  const scope = requireScope(model, o.scope); // invariant:run-scope-exists
  const build = model.builds.get(o.build);
  if (!build) fail('UNKNOWN_BUILD', `build ${o.build} is not registered`); // invariant:run-build-exists
  if (!build.surfaces.includes(surface)) fail('SURFACE_NOT_IN_BUILD', `build ${o.build} does not ship surface ${surface} (it ships ${build.surfaces.join(', ')})`);
  let bugRef = o['bug-ref'] ? requireBugScope(model, o['bug-ref']) : null;
  if (!bugRef && scope.kind === 'bug') bugRef = scope.ref;
  if (BUG_REF_TYPES.includes(o.type) && !bugRef) fail('BUG_REF_REQUIRED', `${o.type} runs are about a bug — pass --bug-ref bug:<id>`);
  let decision = null;
  if (o.type === 'regression') {
    // Stage 5: a regression run executes one QA decision; its plans come from that decision.
    const r = checkRegressionOpen(model, scope.ref, { ...o, surface });
    decision = r.decision;
    o = { ...o, plan: r.plans };
  } else if (o.decision) fail('INVALID_VALUE', '--decision applies only to regression runs');
  const planRefs = [];
  for (const p of o.plan ?? []) {
    const plan = readPlan(store.root, p);
    if (!planRefs.some((x) => x.plan === plan.plan)) planRefs.push({ plan: plan.plan, fingerprint: plan.fingerprint });
  }
  const osRuntime = checkRunOpen(store.root, model, scope, build, surface, o, planRefs);
  checkBugRunOpen(model, o.type, bugRef, build.build_id, surface);
  // A delivered fix build is re-tested only once the exact (build, surface) passed
  // smoke (or holds an explicit override) — the same Stage 2 gate functional runs use.
  if (o.type === 'retest') requireSmokeGate(model, scope.ref, build.build_id, surface);
  // Regression runs go through the same per-build smoke gate (Stage 5).
  if (o.type === 'regression') requireSmokeGate(model, scope.ref, build.build_id, surface);
  const at = now();
  const header = {
    kind: 'run.opened',
    execution_type: o.type,
    scope: scope.ref,
    build_id: build.build_id,
    surface,
    device: o.device,
    os_runtime: osRuntime,
    executor: o.executor,
    plan_refs: planRefs,
    bug_ref: bugRef,
    ...(decision ? { regression_decision: decision.id } : {}),
  };
  const runId = `${o.type}-${at.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${sha(canonical({ ...header, at })).slice(7, 15)}`;
  if (model.runs.has(runId)) fail('DUPLICATE_RUN', `run ${runId} already exists`);
  return seal({ v: SCHEMA, seq: 0, prev: null, at, run_id: runId, ...header });
}

function cmdRunOpen(store, o) {
  const rec = prepareRunOpen(store, loadForWrite(store), o);
  store.create(['runs', `${rec.run_id}.jsonl`], `${canonical(rec)}\n`);
  return { run_id: rec.run_id, run: rec };
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
    const bugScenario = caseId === 'R1' ? bugCase(model.scopes.get(scopeRef)) : null;
    if (bugScenario) return { kind: 'scope_case', source: scopeRef, row_hash: bugCaseHash(model.scopes.get(scopeRef)) };
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
  checkResultAdd(model, run, o.case);
  checkBugResult(model, run, o.case, o.result);
  checkRegressionResult(model, run, o.case);
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
  if (kind === 'run.closed') checkRunClose(store.root, run);
  if (kind === 'run.closed') checkBugRunClose(model, run);
  if (kind === 'run.aborted' && !o.reason) fail('MISSING_ARGUMENT', '--reason is required to abort a run');
  const records = [run.header, ...run.results.map(({ superseded_by, ...r }) => r)];
  const rec = appendEvent(store, ['runs', `${o.run}.jsonl`], records, kind === 'run.aborted' ? { kind, reason: o.reason } : { kind });
  const bugRef = run.header.bug_ref;
  return { run_id: o.run, state: kind === 'run.closed' ? 'closed' : 'aborted', event: rec, render: bugRef && bugReport(model.scopes.get(bugRef)) ? [bugRef] : [] };
}

// ---------- bugs (Stage 3) ----------

const BUG_ID_RE = /^QA-\d{8}-[0-9a-f]{6}$/;
function parseDevice(spec) {
  const [surface, device, osRuntime] = spec.split('|').map((x) => x.trim());
  if (!surface || !device) fail('INVALID_VALUE', `--affected-device must be "<surface>|<device>[|<runtime>]", got "${spec}"`);
  checkId(surface, 'surface');
  return osRuntime ? { surface, device, os_runtime: osRuntime } : { surface, device };
}
const csv = (v) => v.split(',').map((x) => checkId(x.trim(), 'surface'));

function cmdBugReport(store, o) {
  const model = loadForWrite(store);
  if (!SEVERITIES.includes(o.severity)) fail('INVALID_VALUE', `--severity must be one of ${SEVERITIES.join(', ')}`);
  let origin;
  let foundIn = null;
  let surfaces;
  let devices;
  let steps = o.step ?? null;
  let expected = o.expected ?? null;
  let actual = o.actual ?? null;
  const linked = [];
  const related = [];
  const evidence = [];
  if (o['from-run']) {
    // Bug found while executing: QA chose to report this specific FAIL.
    if (!o.case) fail('MISSING_ARGUMENT', '--case is required with --from-run');
    const run = model.runs.get(o['from-run']);
    if (!run) fail('UNKNOWN_RUN', `run ${o['from-run']} does not exist`);
    if (run.state === 'aborted') fail('RUN_ABORTED', `run ${o['from-run']} was aborted — its results are void`);
    if (['retest', 'reproduction'].includes(run.header.execution_type)) fail('INVALID_VALUE', 'a failed re-test or reproduction belongs to its own bug — it is not a new report');
    const result = run.results.find((r) => r.case_key === o.case && r.superseded_by === null);
    if (!result) fail('UNKNOWN_RESULT', `run ${o['from-run']} has no result for ${o.case}`);
    if (result.result !== 'fail') fail('NOT_A_FAILURE', `${o.case} is ${result.result} in that run — only a FAIL can be reported as a bug`); // invariant:report-needs-fail
    const h = run.header;
    const scenario = caseScenario(store.root, model, result);
    steps ??= scenario.steps.length ? scenario.steps : null;
    expected ??= scenario.expected;
    actual ??= result.notes;
    if (!steps || !expected || !actual) fail('MISSING_ARGUMENT', 'steps, expected and actual could not all be taken from the failed case — pass --step/--expected/--actual');
    origin = { kind: 'execution', run_id: h.run_id, result_id: result.result_id, case_key: o.case };
    foundIn = h.build_id;
    surfaces = o.surfaces ? csv(o.surfaces) : [h.surface];
    if (!surfaces.includes(h.surface)) fail('INVALID_VALUE', `the affected surfaces must include ${h.surface}, where the failure was seen`);
    devices = [h.os_runtime ? { surface: h.surface, device: h.device, os_runtime: h.os_runtime } : { surface: h.surface, device: h.device }];
    if (scenario.linked) linked.push(o.case);
    if (h.scope.startsWith('feature:')) related.push(h.scope);
    evidence.push(...result.evidence);
  } else {
    // Existing bug entering QA on its own: no feature, plan, spec or Figma.
    for (const [name, v] of [['step', steps], ['expected', expected], ['actual', actual], ['surfaces', o.surfaces]]) if (!v) fail('MISSING_ARGUMENT', `--${name} is required for a standalone bug`);
    origin = { kind: 'intake' };
    surfaces = csv(o.surfaces);
    devices = (o['affected-device'] ?? []).map(parseDevice);
    if (o['found-in-build']) {
      if (!model.builds.has(o['found-in-build'])) fail('UNKNOWN_BUILD', `build ${o['found-in-build']} is not registered`);
      foundIn = o['found-in-build'];
    }
  }
  if (new Set(surfaces).size !== surfaces.length) fail('INVALID_VALUE', 'surfaces must be unique');
  for (const k of o['linked-case'] ?? []) if (!linked.includes(resolveCaseKey(store.root, k))) linked.push(k);
  for (const r of o['related-scope'] ?? []) {
    const ref = requireScope(model, r).ref;
    if (!related.includes(ref)) related.push(ref);
  }
  evidence.push(...(o.evidence ?? []));
  const at = now();
  const id = o.id ? checkId(o.id, 'bug id') : `QA-${at.slice(0, 10).replace(/-/g, '')}-${sha(canonical({ title: o.title, steps, at })).slice(7, 13)}`;
  if (!o.id && !BUG_ID_RE.test(id)) fail('INTERNAL_ERROR', 'generated bug id is malformed');
  const ref = `bug:${id}`;
  if (findCaseInsensitive(store.list('scopes', 'bug'), `${id}.jsonl`)) fail('DUPLICATE_SCOPE', `bug ${ref} already exists`);
  const created = seal({ v: SCHEMA, seq: 0, prev: null, at, kind: 'scope.created', scope: ref, title: o.title, by: o.by });
  const reported = seal({
    v: SCHEMA,
    seq: 1,
    prev: created.hash,
    at,
    kind: 'bug.reported',
    title: o.title,
    description: o.description ?? null,
    steps,
    expected,
    actual,
    severity: o.severity,
    origin,
    found_in_build: foundIn,
    surfaces,
    devices,
    linked_cases: linked,
    related_scopes: related,
    evidence,
    external_ref: o['external-ref'] ?? null,
    by: o.by,
  });
  store.create(['scopes', 'bug', `${id}.jsonl`], `${canonical(created)}\n${canonical(reported)}\n`);
  return { bug: bugOut(store, ref), render: [ref] };
}

const bugOut = (store, ref) => {
  const { violations, ...bug } = deriveBug(loadForRead(store), ref);
  return bug;
};

// One reproduction attempt or re-test, written as a single atomic run:
// run.opened + the bug scenario's result + run.closed.
const OUTCOMES = {
  reproduction: { reproduced: 'fail', not_reproducible: 'pass', blocked: 'blocked' },
  retest: { pass: 'pass', fail: 'fail', blocked: 'blocked' },
};
function cmdBugRun(store, o, type) {
  const model = loadForWrite(store);
  const bug = requireReportedBug(model, o.bug);
  const result = OUTCOMES[type][o.outcome];
  if (!result) fail('INVALID_VALUE', `--outcome must be one of ${Object.keys(OUTCOMES[type]).join(', ')}`);
  if (!bug.surfaces.includes(o.surface)) fail('BUG_SURFACE_MISMATCH', `${bug.bug} affects ${bug.surfaces.join(', ')}, not ${o.surface}`);
  const header = prepareRunOpen(store, model, { type, scope: bug.bug, build: o.build, surface: o.surface, device: o.device, 'os-runtime': o['os-runtime'], executor: o.executor });
  const scope = model.scopes.get(bug.bug);
  const res = seal({ v: SCHEMA, seq: 1, prev: header.hash, at: header.at, kind: 'result.recorded', result_id: `${header.run_id}/1`, case_key: bugCaseKey(bug.bug), case_ref: { kind: 'scope_case', source: bug.bug, row_hash: bugCaseHash(scope) }, result, notes: o.notes ?? null, evidence: o.evidence ?? [], bug_refs: [], supersedes: null });
  const closed = seal({ v: SCHEMA, seq: 2, prev: res.hash, at: header.at, kind: 'run.closed' });
  store.create(['runs', `${header.run_id}.jsonl`], [header, res, closed].map((r) => `${canonical(r)}\n`).join(''));
  return { run_id: header.run_id, outcome: o.outcome, bug: bugOut(store, bug.bug), render: [bug.bug] };
}

function cmdBugResolve(store, o) {
  const model = loadForWrite(store, o.bug);
  const bug = requireReportedBug(model, o.bug);
  if (!RESOLUTIONS.includes(o.resolution)) fail('INVALID_VALUE', `--resolution must be ${RESOLUTIONS.join(' or ')} — "verified" is reached only through a passing re-test`);
  if (CLOSED.includes(bug.state)) fail('BUG_CLOSED', `${bug.bug} is ${bug.state}`); // invariant:resolve-open-only
  let reference = o.reference ?? null;
  if (reference && reference.startsWith('bug:')) {
    reference = requireBugScope(model, reference);
    if (reference === bug.bug) fail('INVALID_VALUE', 'a bug cannot reference itself');
  }
  const scope = model.scopes.get(bug.bug);
  appendEvent(store, ['scopes', 'bug', `${bug.id}.jsonl`], scope.events, { kind: 'bug.resolved', resolution: o.resolution, reason: o.reason, reference, by: o.by });
  return { bug: bugOut(store, bug.bug), render: [bug.bug] };
}

function renderBug(store, ref) {
  const bug = deriveBug(loadForRead(store), ref);
  store.writeDerived(['bugs', bug.id, 'bug.md'], renderBugMarkdown(bug));
  return `bugs/${bug.id}/bug.md`;
}

function cmdValidate(store) {
  const model = loadLedger(store);
  const counts = { builds: model.builds.size, scopes: model.scopes.size, runs: model.runs.size, results: model.results ? model.results.size : 0 };
  return { ok: model.errors.length === 0, errors: model.errors, warnings: model.warnings, counts };
}

function cmdSuiteCheck(store, o) {
  const suite = readSmokeSuite(store.root, o.suite);
  const errors = [...suite.structural, ...suite.source];
  return { ok: errors.length === 0, ...suite, errors };
}

// ---------- Dev → QA handoff (Stage 4) ----------

function recordedHandoff(store, scopeRef) {
  if (!scopeRef || !store.initialized()) return null;
  const model = loadForRead(store);
  return model.scopes.get(parseScopeRef(scopeRef).ref)?.context.dev_handoff ?? null;
}

function cmdHandoffResolve(store, o) {
  const code = resolveCodeRepo(o['code-repo'], store.root);
  return resolveHandoff(code, store.root, o, recordedHandoff(store, o.scope));
}

// Binds a ready (or explicitly approved draft) Dev handoff into the feature scope:
// canonical Dev identity, the QA plan, capability reference and QA-owned debt.
function cmdHandoffIngest(store, o) {
  const s = parseScopeRef(o.scope);
  if (s.kind !== 'feature') fail('INVALID_FIELD_FOR_SCOPE', 'a Dev handoff binds to a feature scope');
  if (Boolean(o['override-by']) !== Boolean(o['override-reason'])) fail('MISSING_ARGUMENT', 'a draft override needs both --override-by and --override-reason');
  const model = loadForWrite(store, s.ref);
  if (!model.scopes.has(s.ref)) fail('UNKNOWN_SCOPE', `scope ${s.ref} does not exist`);
  const scope = model.scopes.get(s.ref);
  const code = resolveCodeRepo(o['code-repo'], store.root);
  const recorded = scope.context.dev_handoff ?? null;
  const r = resolveHandoff(code, store.root, o, recorded);
  if (!r.handoff.contract_ok) fail('HANDOFF_CONTRACT_MISMATCH', `${r.handoff.path} does not match the current Dev handoff contract (docs/dev-handoff-contract.md)`, { problems: r.problems });
  if (r.identity_errors.length) fail('IDENTITY_MISMATCH', `the Dev artifacts disagree: ${r.identity_errors.join('; ')}`, { errors: r.identity_errors });
  if (recorded && recorded.feature !== r.identity.feature) fail('IDENTITY_CONFLICT', `${s.ref} is bound to Dev feature "${recorded.feature}", not "${r.identity.feature}" — never rebound silently`);

  // Status gate: ready-for-qa, or an attributed override for exactly this handoff content.
  const fingerprint = r.handoff.fingerprint;
  const events = [...scope.events];
  const append = (body) => {
    const rec = appendEvent(store, ['scopes', 'feature', `${s.id}.jsonl`], events, body);
    events.push(rec);
    return rec;
  };
  let override = null;
  if (r.handoff.status !== READY_STATUS) { // invariant:handoff-status-gate
    const existing = events.find((e) => e.kind === 'context.add' && e.field === 'handoff_overrides' && e.value.handoff_fingerprint === fingerprint);
    if (existing) override = { ...existing.value, at: existing.at };
    else if (o['override-by']) override = null;
    else fail('HANDOFF_NOT_READY', `${r.handoff.path} is "${r.handoff.status ?? 'unset'}", not ${READY_STATUS} — dev has not signed it off; an explicit, attributed override is needed to work from it`, { status: r.handoff.status });
    if (!existing) {
      const rec = append({ kind: 'context.add', field: 'handoff_overrides', value: { qa_handoff_link: r.handoff.path, handoff_fingerprint: fingerprint, status: r.handoff.status, reason: o['override-reason'], approved_by: o['override-by'] }, by: o.by });
      override = { ...rec.value, at: rec.at };
    }
  }

  const identity = { ...r.identity, handoff_status: r.handoff.status, handoff_fingerprint: fingerprint, handoff_date: r.handoff.frontmatter.date ?? null, build_instructions_ref: r.handoff.build_instructions_ref };
  if (!recorded || canonical(recorded) !== canonical(identity)) append({ kind: 'context.set', field: 'dev_handoff', value: identity, by: o.by });
  if (identity.capability && scope.context.capability !== identity.capability) append({ kind: 'context.set', field: 'capability', value: identity.capability, by: o.by });
  const plan = `${s.id}/test-plan.md`;
  const hasPlan = fs.existsSync(path.join(store.root, plan));
  if (hasPlan && !(scope.context.plans ?? []).includes(plan)) append({ kind: 'context.add', field: 'plans', value: resolveQaFile(store.root, plan).rel, by: o.by });
  const have = new Set((scope.context.debt ?? []).map((d) => d.id));
  const added = [];
  for (const d of r.qa_debt) {
    if (have.has(d.id)) continue;
    append({ kind: 'context.add', field: 'debt', value: d, by: o.by });
    added.push(d.id);
    have.add(d.id);
  }
  return {
    scope: s.ref,
    identity,
    handoff_status: r.handoff.status,
    override,
    debt_added: added,
    qa_debt: r.qa_debt,
    developer_context: r.developer_context,
    accessibility: r.accessibility,
    problems: r.problems,
    coverage_frontmatter: {
      feature: s.id,
      qa_scope: s.ref,
      qa_feature_path: `${s.id}/`,
      dev_feature: identity.feature,
      task_breakdown_link: identity.task_breakdown_link,
      qa_handoff_link: identity.qa_handoff_link,
      dev_handoff_source: identity.qa_handoff_link,
      feature_analysis_link: identity.feature_analysis_link,
      handoff_status: identity.handoff_status,
      handoff_fingerprint: fingerprint,
      handoff_draft_override_by: override?.approved_by ?? null,
      handoff_draft_override_reason: override?.reason ?? null,
      handoff_draft_override_at: override?.at ?? null,
      platform: identity.platform,
      device_type: identity.device_type,
      surface: identity.surface,
      capability: identity.capability,
      accessibility_status: r.accessibility.statuses.join(', ') || 'none recorded',
      qa_debt_ids: [...have],
      test_plan_source: hasPlan ? plan : null,
    },
  };
}

// ---------- Project Knowledge + regression (Stage 5) ----------

function knowledgeFor(store, o, bound) {
  const code = o['code-repo'] ? resolveCodeRepo(o['code-repo'], store.root) : null;
  const k = readKnowledge(code, { capability: o.capability ?? bound ?? undefined, paths: o.path, surface: o.surface });
  return { code, k };
}

function cmdKnowledgeLookup(store, o) {
  if (!o.capability && !o.path && !o.surface) fail('MISSING_ARGUMENT', 'look up by --capability <id or exact name>, --path <repo path> or --surface <id>');
  const { k } = knowledgeFor(store, o, null);
  const lookup = k.query?.capability ? (({ context, ...l }) => l)(k.query.capability) : null;
  return { knowledge: knowledgeSummary(k), lookup, surface: k.query?.surface ?? null };
}

function scopeCandidates(store, model, scope, o) {
  const bound = scope.context.capability ?? scope.context.dev_handoff?.capability ?? null;
  const { k } = knowledgeFor(store, o, bound);
  const capability = resolveCapability(k, { bound, explicit: o.capability, paths: o.path });
  const found = capability.status === 'found';
  const direct = found ? directCandidates(k, capability.id) : { candidates: [], dropped: [], manual: [] };
  return { k, capability, direct };
}

// Read-only: what Project Knowledge suggests for a scope. Nothing is recorded.
function cmdRegressionCandidates(store, o) {
  const model = loadForRead(store);
  const s = requireScope(model, o.scope);
  const scope = model.scopes.get(s.ref);
  const { k, capability, direct } = scopeCandidates(store, model, scope, o);
  const knowledge = knowledgeSummary(k);
  const note = !knowledge.available || knowledge.capabilities === 'deriveLive'
    ? 'Project Knowledge is not available for capabilities — plan regression manually (name candidates with --candidate).'
    : capability.status === 'found'
      ? 'First-degree context only: a relationship is not proof of impact. QA decides what, if anything, regression covers.'
      : capability.status === 'ambiguous'
        ? 'Several capabilities match — QA picks one (bind it with scope event --field capability); nothing was chosen.'
        : 'No capability resolved — bind one by exact id, name or path, or plan regression manually.';
  return {
    scope: s.ref,
    knowledge,
    capability,
    candidates: direct.candidates.map((c) => ({ ...c, existing_coverage: coverageFor(store.root, model, c.capability, k) })),
    dropped_relationships: direct.dropped,
    manual_review: direct.manual,
    capability_coverage: capability.id ? coverageFor(store.root, model, capability.id, k) : null,
    note,
  };
}

// Records QA's explicit regression decision on the scope.
function cmdRegressionDecide(store, o) {
  const s = parseScopeRef(o.scope);
  const model = loadForWrite(store, s.ref);
  if (!model.scopes.has(s.ref)) fail('UNKNOWN_SCOPE', `scope ${s.ref} does not exist`);
  const scope = model.scopes.get(s.ref);
  let capabilityId = null;
  let pkCandidates = [];
  let knowledge = null;
  if (o['code-repo']) {
    const { k, capability, direct } = scopeCandidates(store, model, scope, o);
    knowledge = (({ available, freshness, capabilities }) => ({ available, freshness, capabilities }))(knowledgeSummary(k));
    if (capability.status === 'ambiguous') fail('CAPABILITY_AMBIGUOUS', `several capabilities match "${o.capability ?? capability.id}" — QA picks one; nothing is chosen`, { matches: capability.matches });
    if (o.capability && capability.status === 'not-found') fail('CAPABILITY_NOT_FOUND', `no capability has id or exact name "${o.capability}"`);
    capabilityId = capability.id;
    pkCandidates = direct.candidates.map((c) => c.capability);
  } else {
    capabilityId = o.capability ?? scope.context.capability ?? null;
  }
  const value = buildDecision(store.root, model, scope, o, { capability: capabilityId, pkCandidates, knowledge });
  appendEvent(store, ['scopes', s.kind, `${s.id}.jsonl`], scope.events, { kind: 'context.add', field: 'regression_decisions', value, by: o.by });
  return { scope: s.ref, decision: value };
}

// ---------- QA readiness + sign-off (Stage 6) ----------

// Pins, exceptions and discharges are member-level; a release scope may be signed off.
function readinessTarget(store, ref, { release = false } = {}) {
  const s = parseScopeRef(ref);
  const model = loadForWrite(store, s.ref);
  if (!model.scopes.has(s.ref)) fail('UNKNOWN_SCOPE', `scope ${s.ref} does not exist`);
  const scope = model.scopes.get(s.ref);
  if (!release) requireNonRelease(scope);
  return { s, model, scope };
}
const appendTo = (store, scope, body) => appendEvent(store, ['scopes', scope.kind, `${scope.ref.slice(scope.kind.length + 1)}.jsonl`], scope.events, body);

function renderReadiness(store, ref) {
  const r = computeReadiness(store.root, loadForRead(store), ref);
  const [kind, id] = [r.kind, r.scope.slice(r.kind.length + 1)];
  store.writeDerived(['readiness', kind, `${id}.md`], renderReadinessMarkdown(r));
  return { rendered: `readiness/${kind}/${id}.md`, verdict: r.verdict, fingerprint: r.fingerprint };
}

function cmdReadinessPin(store, o) {
  const { model, scope } = readinessTarget(store, o.scope);
  const surfaces = computeReadiness(store.root, model, scope.ref).candidate_builds.map((c) => c.surface);
  const value = pinValue(model, scope, o, surfaces);
  const existing = (scope.context.candidate_builds ?? []).find((p) => p.surface === o.surface);
  if (existing) scope.events.push(appendTo(store, scope, { kind: 'context.retract', field: 'candidate_builds', value: o.surface, by: o.by, reason: `re-pinned: ${o.reason}` }));
  appendTo(store, scope, { kind: 'context.add', field: 'candidate_builds', value, by: o.by });
  return { scope: scope.ref, pin: value };
}

function cmdReadinessUnpin(store, o) {
  const { scope } = readinessTarget(store, o.scope);
  if (!(scope.context.candidate_builds ?? []).some((p) => p.surface === o.surface)) fail('NOT_PRESENT', `no candidate build is pinned on ${o.surface}`);
  appendTo(store, scope, { kind: 'context.retract', field: 'candidate_builds', value: o.surface, by: o.by, reason: o.reason });
  return { scope: scope.ref, unpinned: o.surface };
}

function cmdReadinessExcept(store, o) {
  const { model, scope } = readinessTarget(store, o.scope);
  const value = exceptionValue(model, scope, o, computeReadiness(store.root, model, scope.ref));
  appendTo(store, scope, { kind: 'context.add', field: 'exceptions', value, by: o['approved-by'] });
  return { scope: scope.ref, exception: value };
}

function cmdReadinessDischarge(store, o) {
  const { model, scope } = readinessTarget(store, o.scope);
  const value = dischargeValue(model, scope, o);
  if ((scope.context.debt_discharges ?? []).some((d) => d.debt_id === o.debt)) fail('DUPLICATE_VALUE', `${o.debt} is already discharged`);
  appendTo(store, scope, { kind: 'context.add', field: 'debt_discharges', value, by: o.by });
  return { scope: scope.ref, discharge: value };
}

// Sign-off pins the verdict and fingerprint of the readiness computed right now.
function cmdReadinessSignoff(store, o) {
  const { model, scope } = readinessTarget(store, o.scope, { release: true });
  const r = computeReadiness(store.root, model, scope.ref);
  if (r.verdict === 'NOT_READY') fail('SIGNOFF_NOT_READY', `${scope.ref} is NOT_READY — resolve or explicitly except its blockers first`, { blockers: r.blockers.filter((b) => !b.excepted_by).map((b) => b.id) }); // invariant:signoff-needs-ready
  const n = scope.events.filter((e) => e.kind === 'context.add' && e.field === 'signoffs').length + 1;
  const value = { id: `SO-${n}`, verdict: r.verdict, fingerprint: r.fingerprint, notes: o.notes ?? null, signed_by: o.by };
  appendTo(store, scope, { kind: 'context.add', field: 'signoffs', value, by: o.by });
  return { scope: scope.ref, signoff: value, ...renderReadiness(store, scope.ref) };
}

const viewCmd = (what) => (s, o) => view(s.root, loadForRead(s), what, o);

// ---------- CLI ----------

const COMMANDS = {
  init: { opts: [], run: (s) => cmdInit(s) },
  validate: { opts: [], run: (s) => cmdValidate(s) },
  'build add': { req: ['id', 'surfaces', 'registered-by'], opts: ['version', 'source', 'related-scope', 'fixes'], run: cmdBuildAdd },
  'scope create': { req: ['scope', 'created-by'], opts: ['title'], run: cmdScopeCreate },
  'scope event': { req: ['scope', 'op', 'field', 'value', 'by'], opts: ['reason'], run: cmdScopeEvent },
  'run open': { req: ['type', 'scope', 'build', 'surface', 'device', 'executor'], opts: ['os-runtime', 'plan', 'bug-ref', 'decision'], run: cmdRunOpen },
  'run close': { req: ['run'], opts: [], run: (s, o) => cmdRunEnd(s, o, 'run.closed') },
  'run abort': { req: ['run'], opts: ['reason'], run: (s, o) => cmdRunEnd(s, o, 'run.aborted') },
  'result add': { single: ['case'], req: ['run', 'case', 'result'], opts: ['notes', 'evidence', 'bug', 'supersedes'], run: cmdResultAdd },
  'view scope': { req: ['scope'], opts: [], run: viewCmd('scope') },
  'view builds': { opts: ['scope', 'surface'], run: viewCmd('builds') },
  'view latest-build': { req: ['surface'], opts: ['scope'], run: viewCmd('latest-build') },
  'view runs': { opts: ['scope', 'build'], run: viewCmd('runs') },
  'view case-history': { single: ['case'], req: ['case'], opts: ['surface', 'scope'], run: viewCmd('case-history') },
  'view latest-result': { single: ['case'], req: ['case', 'surface'], opts: ['scope'], run: viewCmd('latest-result') },
  'view smoke': { req: ['build'], opts: ['surface'], run: viewCmd('smoke') },
  'view execution': { req: ['scope'], opts: ['surface'], run: viewCmd('execution') },
  'view run-cases': { req: ['run'], opts: [], run: viewCmd('run-cases') },
  'plan rows': {
    req: ['plan'],
    opts: [],
    ledgerless: true,
    run: (s, o) => {
      if (o.plan.length !== 1) fail('DUPLICATE_ARGUMENT', 'plan rows reads exactly one --plan');
      return readPlan(s.root, o.plan[0]);
    },
  },
  'suite check': { req: ['suite'], opts: [], ledgerless: true, run: cmdSuiteCheck },
  'bug report': { single: ['case'], req: ['title', 'severity', 'by'], opts: ['id', 'description', 'step', 'expected', 'actual', 'surfaces', 'affected-device', 'found-in-build', 'external-ref', 'evidence', 'linked-case', 'related-scope', 'from-run', 'case'], run: cmdBugReport },
  'bug verify': { single: ['bug'], req: ['bug', 'build', 'surface', 'device', 'executor', 'outcome'], opts: ['os-runtime', 'notes', 'evidence'], run: (s, o) => cmdBugRun(s, o, 'reproduction') },
  'bug retest': { single: ['bug'], req: ['bug', 'build', 'surface', 'device', 'executor', 'outcome'], opts: ['os-runtime', 'notes', 'evidence'], run: (s, o) => cmdBugRun(s, o, 'retest') },
  'bug resolve': { single: ['bug'], req: ['bug', 'resolution', 'reason', 'by'], opts: ['reference'], run: cmdBugResolve },
  'bug render': { single: ['bug'], req: ['bug'], opts: [], run: (s, o) => ({ rendered: renderBug(s, requireReportedBug(loadForRead(s), o.bug).bug) }) },
  'view bug': { single: ['bug'], req: ['bug'], opts: [], run: viewCmd('bug') },
  'view bugs': { opts: ['scope', 'state'], run: viewCmd('bugs') },
  'view case-bugs': { single: ['case'], req: ['case'], opts: [], run: viewCmd('case-bugs') },
  'readiness pin': { req: ['scope', 'surface', 'build', 'reason', 'by'], opts: [], run: cmdReadinessPin },
  'readiness unpin': { req: ['scope', 'surface', 'reason', 'by'], opts: [], run: cmdReadinessUnpin },
  'readiness except': { req: ['scope', 'item', 'kind', 'reason', 'approved-by'], opts: ['build'], run: cmdReadinessExcept },
  'readiness discharge': { req: ['scope', 'debt', 'result', 'by'], opts: [], run: cmdReadinessDischarge },
  'readiness signoff': { req: ['scope', 'by'], opts: ['notes'], run: cmdReadinessSignoff },
  'readiness render': { req: ['scope'], opts: [], run: (s, o) => renderReadiness(s, o.scope) },
  'view readiness': { req: ['scope'], opts: [], run: viewCmd('readiness') },
  'view signoffs': { opts: ['scope'], run: viewCmd('signoffs') },
  'knowledge lookup': { req: ['code-repo'], opts: ['capability', 'path', 'surface'], ledgerless: true, run: cmdKnowledgeLookup },
  'regression candidates': { req: ['scope'], opts: ['code-repo', 'capability', 'path'], run: cmdRegressionCandidates },
  'regression decide': { req: ['scope', 'required', 'reason', 'by'], opts: ['code-repo', 'capability', 'path', 'candidate', 'include', 'exclude', 'case', 'target'], run: cmdRegressionDecide },
  'view regression': { req: ['scope'], opts: [], run: viewCmd('regression') },
  'handoff resolve': { req: ['code-repo'], opts: ['scope', 'feature', 'breakdown', 'handoff'], ledgerless: true, run: cmdHandoffResolve },
  'handoff ingest': { req: ['scope', 'code-repo', 'by'], opts: ['feature', 'breakdown', 'handoff', 'override-by', 'override-reason'], run: cmdHandoffIngest },
};
const REPEATABLE = new Set(['plan', 'evidence', 'bug', 'related-scope', 'fixes', 'step', 'linked-case', 'affected-device', 'path', 'candidate', 'include', 'exclude', 'case', 'target']);

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
  for (const name of cmd.single ?? []) {
    if (Array.isArray(opts[name]) && opts[name].length > 1) fail('DUPLICATE_ARGUMENT', `--${name} takes one value for ${key}`);
    if (Array.isArray(opts[name])) opts[name] = opts[name][0];
  }
  for (const name of cmd.req ?? []) if (opts[name] === undefined) fail('MISSING_ARGUMENT', `--${name} is required for ${key}`);
  const store = new Store(root);
  store.p(); // refuses a symlinked qa-ledger/ before anything else reads or writes
  if (!cmd.ledgerless && key !== 'init' && !store.initialized()) fail('LEDGER_NOT_INITIALIZED', `no ${LEDGER_DIR}/ in ${root} — run \`init\` first`);
  const { render = [], ...out } = cmd.run(store, opts);
  // Stage 3: every write that touches a reported bug regenerates its derived bug.md.
  const rendered = [...new Set(render)].map((ref) => renderBug(store, ref));
  if (rendered.length) out.rendered_views = rendered;
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
