// Stage 3 — the bug lifecycle. A bug is its `bug:<id>` scope: one `bug.reported`
// record (seq 1), optional `bug.resolved`, bug-only context fields, reproduction and
// re-test runs (Stage 1 run types) and fix claims carried by build records. Its
// state is never stored — it is replayed here from those records, and the same
// replay drives write-time guards, views and post-hoc validation.
// Internal module of scripts/qa-ledger.mjs. Read-only: nothing here writes.
'use strict';

import { fail, canonical, sha, isStr, strictObject, idOk, parseScopeRef } from './core.mjs';
import { orderedBuilds, runOrder } from './query.mjs';
import { readPlan, readSmokeSuite, rowCells } from './plans.mjs';

export const SEVERITIES = ['critical', 'major', 'minor', 'trivial'];
export const RESOLUTIONS = ['duplicate', 'wont_fix'];
export const BUG_CASE_ID = 'R1';
export const CLOSED = ['closed_verified', 'closed_not_reproducible', 'closed_duplicate', 'closed_wont_fix'];
const DEV_OWNED = ['assigned', 'reopened'];
const AWAITING_VERIFICATION = ['new', 'verification_blocked'];
const NEXT_ACTION = { new: 'qa_verify', verification_blocked: 'qa_verify', assigned: 'dev_fix', reopened: 'dev_fix', fix_delivered: 'qa_retest' };
const BUG_RUN_TYPES = ['reproduction', 'retest'];

// ---------- records ----------

export function bugReport(scope) {
  if (!scope || scope.kind !== 'bug') return null;
  return scope.events.find((e) => e.kind === 'bug.reported') ?? null;
}

// The bug-owned scenario: its reproduction steps and expected behavior. Re-tests and
// reproduction attempts execute it as `bug:<id>#R1`; FAIL means the bug is present.
export function bugCase(scope) {
  const r = bugReport(scope);
  return r ? { id: BUG_CASE_ID, steps: r.steps, expected: r.expected } : null;
}
export const bugCaseKey = (ref) => `${ref}#${BUG_CASE_ID}`;
export const bugCaseHash = (scope) => sha(canonical(bugCase(scope)));

const device = (d) => strictObject(d, ['surface', 'device'], ['os_runtime']) && idOk(d.surface) && isStr(d.device) && (d.os_runtime === undefined || isStr(d.os_runtime));
function originOk(o) {
  if (strictObject(o, ['kind']) && o.kind === 'intake') return true;
  return strictObject(o, ['kind', 'run_id', 'result_id', 'case_key']) && o.kind === 'execution' && isStr(o.run_id) && isStr(o.result_id) && isStr(o.case_key);
}

export function bugShapeErrors(rec, where) {
  const bad = (message) => [{ code: 'INVALID_RECORD', where, message }];
  if (rec.kind === 'bug.reported') {
    const keys = ['v', 'seq', 'prev', 'at', 'kind', 'title', 'description', 'steps', 'expected', 'actual', 'severity', 'origin', 'found_in_build', 'surfaces', 'devices', 'linked_cases', 'related_scopes', 'evidence', 'external_ref', 'by', 'hash'];
    if (!strictObject(rec, keys)) return bad('unexpected bug.reported fields');
    if (!isStr(rec.title) || !(rec.description === null || isStr(rec.description)) || !isStr(rec.expected) || !isStr(rec.actual) || !isStr(rec.by)) return bad('invalid bug text');
    if (!Array.isArray(rec.steps) || !rec.steps.length || !rec.steps.every(isStr)) return bad('steps must be a non-empty list');
    if (!SEVERITIES.includes(rec.severity)) return bad(`severity must be one of ${SEVERITIES.join(', ')}`);
    if (!originOk(rec.origin)) return bad('invalid origin');
    if (!(rec.found_in_build === null || idOk(rec.found_in_build)) || !(rec.external_ref === null || isStr(rec.external_ref))) return bad('invalid bug references');
    if (!Array.isArray(rec.surfaces) || !rec.surfaces.length || !rec.surfaces.every(idOk) || !Array.isArray(rec.devices) || !rec.devices.every(device)) return bad('invalid surfaces or devices');
    if (![rec.linked_cases, rec.related_scopes, rec.evidence].every((a) => Array.isArray(a) && a.every(isStr))) return bad('invalid links or evidence');
    return [];
  }
  if (rec.kind === 'bug.resolved') {
    if (!strictObject(rec, ['v', 'seq', 'prev', 'at', 'kind', 'resolution', 'reason', 'reference', 'by', 'hash'])) return bad('unexpected bug.resolved fields');
    if (!RESOLUTIONS.includes(rec.resolution)) return bad(`resolution must be one of ${RESOLUTIONS.join(', ')} — verified comes only from a re-test`);
    if (!isStr(rec.reason) || !isStr(rec.by) || !(rec.reference === null || isStr(rec.reference))) return bad('a resolution needs a reason and a person');
    return [];
  }
  return null;
}

// Bug-only context fields (merged into model.FIELDS).
export const BUG_FIELDS = {
  severity: { op: 'set', kinds: ['bug'], valid: (v) => SEVERITIES.includes(v) },
  assignee: { op: 'set', kinds: ['bug'], valid: (v) => v === null || isStr(v) },
  external_ref: { op: 'set', kinds: ['bug'], valid: (v) => v === null || isStr(v) },
  evidence: { op: 'add', kinds: ['bug'], valid: isStr },
  linked_cases: { op: 'add', kinds: ['bug'], ref: 'case', valid: isStr },
};

// A test-plan or smoke-suite case key, resolved read-only to its row.
export function resolveCaseKey(root, key) {
  const slash = key.lastIndexOf('/');
  const prefix = slash > 0 ? key.slice(0, slash) : '';
  const id = key.slice(slash + 1);
  let rows = [];
  try {
    rows = prefix.startsWith('smoke/') ? readSmokeSuite(root, `${prefix}/smoke-suite.md`).rows : readPlan(root, `${prefix}/test-plan.md`).rows;
  } catch {
    /* reported below */
  }
  if (!rows.some((r) => r.id === id && r.case_key === key)) fail('UNKNOWN_CASE', `${key} is not a case of a test plan or smoke suite in the QA repo`);
  return key;
}

// Steps and expected result of the case a failing result was recorded against.
export function caseScenario(root, model, result) {
  const ref = result.case_ref;
  if (ref.kind === 'plan_row') {
    const cells = rowCells(root, ref.source, result.case_key.slice(result.case_key.lastIndexOf('/') + 1));
    return cells ? { steps: cells[2] ? [cells[2]] : [], expected: cells[3] ?? null, linked: true } : { steps: [], expected: null, linked: true };
  }
  const scope = model.scopes.get(ref.source);
  const c = bugCase(scope);
  return c ? { steps: c.steps, expected: c.expected, linked: false } : { steps: [], expected: null, linked: false };
}

// ---------- replay ----------

function runOutcome(run, ref) {
  const effective = run.results.filter((r) => r.superseded_by === null);
  if (!effective.some((r) => r.case_key === bugCaseKey(ref))) return null;
  const results = effective.map((r) => r.result);
  if (results.includes('fail')) return 'fail';
  if (results.includes('blocked') || results.includes('not_run')) return 'blocked';
  return 'pass';
}
const REPRO = { fail: 'reproduced', pass: 'not_reproducible', blocked: 'blocked' };

// The full derived bug: current state, next action, fix cycles, attempts, history.
export function deriveBug(model, ref) {
  const scope = model.scopes.get(ref);
  const report = bugReport(scope);
  if (!report) return null;
  const c = scope.context;
  const surfaces = c.surfaces ?? report.surfaces;
  const idx = new Map(orderedBuilds(model).map((b, i) => [b.build_id, i]));

  const events = [{ at: report.at, rank: 0, type: 'reported', key: '' }];
  for (const b of model.builds.values()) if ((b.fixes_claimed ?? []).includes(ref)) events.push({ at: b.registered_at, rank: 1, type: 'fix_claimed', key: b.build_id, build: b });
  for (const run of runOrder(model)) {
    const h = run.header;
    if (h.bug_ref === ref && BUG_RUN_TYPES.includes(h.execution_type) && run.state === 'closed') events.push({ at: run.endedAt, rank: 2, type: h.execution_type, key: h.run_id, run });
  }
  for (const e of scope.events) {
    if (e.kind === 'bug.resolved') events.push({ at: e.at, rank: 3, type: 'resolved', key: String(e.seq), e });
    if (e.kind?.startsWith('context.')) events.push({ at: e.at, rank: 4, type: 'context', key: String(e.seq), e });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));

  let state = report.origin.kind === 'execution' ? 'assigned' : 'new';
  let foundIn = report.found_in_build;
  let fixedIn = null;
  let cycle = null;
  let resolution = null;
  const claims = [];
  const reproductions = [];
  const retests = [];
  const history = [];
  const violations = [];
  const violate = (at, message) => violations.push({ code: 'INVALID_TRANSITION', where: ref, message: `${at}: ${message}` });
  const close = (at, next, res, detail) => {
    state = next;
    resolution = res;
    history.push({ at, event: 'closed', detail });
  };

  for (const ev of events) {
    if (ev.type === 'reported') {
      history.push({ at: ev.at, event: 'reported', detail: report.origin.kind === 'execution' ? `from ${report.origin.case_key} in ${report.origin.run_id}` : 'standalone intake' });
    } else if (ev.type === 'fix_claimed') {
      const claim = { build_id: ev.build.build_id, registered_at: ev.at, outcome: 'pending' };
      claims.push(claim);
      history.push({ at: ev.at, event: 'fix_claimed', detail: `build ${claim.build_id}` });
      if (state !== 'fix_delivered' && !DEV_OWNED.includes(state)) {
        claim.outcome = 'rejected';
        violate(ev.at, `build ${claim.build_id} claims a fix while the bug is ${state}`);
        continue;
      }
      if (cycle) cycle.claim.outcome = 'superseded';
      cycle = { claim, idx: idx.get(claim.build_id), passed: new Set() };
      state = 'fix_delivered';
    } else if (ev.type === 'reproduction' || ev.type === 'retest') {
      const h = ev.run.header;
      const raw = runOutcome(ev.run, ref);
      const r = ev.run.results.find((x) => x.case_key === bugCaseKey(ref) && x.superseded_by === null);
      const entry = { run_id: h.run_id, build_id: h.build_id, surface: h.surface, device: h.device, os_runtime: h.os_runtime, executor: h.executor, at: ev.at, notes: r?.notes ?? null, evidence: r?.evidence ?? [] };
      if (raw === null) {
        violate(ev.at, `${h.execution_type} run ${h.run_id} closed without a ${bugCaseKey(ref)} result`);
        continue;
      }
      if (!surfaces.includes(h.surface)) violate(ev.at, `${h.execution_type} on ${h.surface}, which is not an affected surface`);
      if (ev.type === 'reproduction') {
        entry.outcome = REPRO[raw];
        reproductions.push(entry);
        history.push({ at: ev.at, event: 'reproduction', detail: `${entry.outcome} on ${h.build_id} / ${h.surface}` });
        if (!AWAITING_VERIFICATION.includes(state)) {
          violate(ev.at, `reproduction attempted while the bug is ${state}`);
          continue;
        }
        if (entry.outcome === 'reproduced') {
          state = 'assigned';
          foundIn ??= h.build_id;
        } else if (entry.outcome === 'not_reproducible') close(ev.at, 'closed_not_reproducible', 'not_reproducible', `not reproducible on ${h.build_id}`);
        else state = 'verification_blocked';
      } else {
        entry.outcome = raw;
        entry.fix_build = cycle ? cycle.claim.build_id : null;
        retests.push(entry);
        history.push({ at: ev.at, event: 'retest', detail: `${raw} on ${h.build_id} / ${h.surface}` });
        if (state !== 'fix_delivered') {
          violate(ev.at, `re-test while the bug is ${state} — a re-test needs a newer fix build`);
          continue;
        }
        if (idx.get(h.build_id) < cycle.idx) {
          violate(ev.at, `re-test on ${h.build_id}, older than the fix build ${cycle.claim.build_id}`);
          continue;
        }
        if (raw === 'fail') {
          cycle.claim.outcome = 'failed';
          cycle = null;
          state = 'reopened';
          history.push({ at: ev.at, event: 'reopened', detail: `fix in ${entry.fix_build} failed on ${h.surface}` });
        } else if (raw === 'pass') {
          cycle.passed.add(h.surface);
          if (surfaces.every((s) => cycle.passed.has(s))) {
            cycle.claim.outcome = 'verified';
            fixedIn = cycle.claim.build_id;
            cycle = null;
            close(ev.at, 'closed_verified', 'verified', `verified on ${surfaces.join(', ')} with ${fixedIn}`);
          }
        }
      }
    } else if (ev.type === 'resolved') {
      history.push({ at: ev.at, event: 'resolved', detail: `${ev.e.resolution}: ${ev.e.reason}` });
      if (CLOSED.includes(state)) {
        violate(ev.at, `resolution recorded on a ${state} bug`);
        continue;
      }
      if (cycle) cycle.claim.outcome = 'superseded';
      cycle = null;
      close(ev.at, `closed_${ev.e.resolution}`, ev.e.resolution, ev.e.reason);
    } else {
      const verb = ev.e.kind === 'context.set' ? 'set' : ev.e.kind === 'context.add' ? 'added' : 'retracted';
      history.push({ at: ev.at, event: `${ev.e.field}_${verb}`, detail: typeof ev.e.value === 'string' ? ev.e.value : canonical(ev.e.value) });
    }
  }

  const resolvedBy = [...scope.events].reverse().find((e) => e.kind === 'bug.resolved');
  const resolvedByRes = resolvedBy && state === `closed_${resolvedBy.resolution}`;
  return {
    bug: ref,
    id: ref.slice(4),
    title: c.title ?? report.title,
    description: report.description,
    steps: report.steps,
    expected: report.expected,
    actual: report.actual,
    severity: c.severity ?? report.severity,
    state,
    next_action: NEXT_ACTION[state] ?? 'none',
    resolution,
    resolution_reason: resolvedByRes ? resolvedBy.reason : null,
    resolution_reference: resolvedByRes ? resolvedBy.reference : null,
    resolved_by: resolvedByRes ? resolvedBy.by : null,
    origin: report.origin,
    reported_by: report.by,
    reported_at: report.at,
    found_in_build: foundIn,
    current_fix_build: cycle ? cycle.claim.build_id : null,
    fixed_in_build: fixedIn,
    surfaces,
    pending_retest_surfaces: state === 'fix_delivered' ? surfaces.filter((s) => !cycle.passed.has(s)) : [],
    devices: c.devices ?? report.devices,
    linked_cases: [...report.linked_cases, ...(c.linked_cases ?? [])],
    related_scopes: [...new Set([...report.related_scopes, ...(c.related_scopes ?? [])])],
    evidence: [...report.evidence, ...(c.evidence ?? [])],
    external_ref: c.external_ref !== undefined ? c.external_ref : report.external_ref,
    assignee: c.assignee ?? null,
    capability: c.capability ?? null,
    case_key: bugCaseKey(ref),
    fix_claims: claims,
    reproductions,
    retests,
    history,
    violations,
  };
}

export function requireReportedBug(model, ref) {
  const s = parseScopeRef(ref);
  if (s.kind !== 'bug') fail('INVALID_BUG_REF', `${ref} is not a bug (bug:<id>)`);
  if (!model.scopes.has(s.ref)) fail('UNKNOWN_SCOPE', `bug ${s.ref} does not exist`);
  const bug = deriveBug(model, s.ref);
  if (!bug) fail('NOT_A_REPORTED_BUG', `${s.ref} has no bug report — create bugs with /report-bug`);
  return bug;
}

// ---------- write-time guards ----------

// Opening a reproduction or re-test run for a reported bug (no-op for other runs).
export function checkBugRunOpen(model, type, bugRef, buildId, surface) {
  if (!BUG_RUN_TYPES.includes(type) || !bugRef) return;
  const bug = deriveBug(model, bugRef);
  if (!bug) return;
  if (!bug.surfaces.includes(surface)) fail('BUG_SURFACE_MISMATCH', `${bugRef} affects ${bug.surfaces.join(', ')}, not ${surface}`);
  if (CLOSED.includes(bug.state)) fail('BUG_CLOSED', `${bugRef} is ${bug.state}`);
  if (type === 'reproduction') {
    if (!AWAITING_VERIFICATION.includes(bug.state)) fail('BUG_NOT_AWAITING_VERIFICATION', `${bugRef} is ${bug.state} — reproduction is only for a bug not yet reproduced`);
    return;
  }
  if (AWAITING_VERIFICATION.includes(bug.state)) fail('BUG_NOT_REPRODUCED', `${bugRef} is ${bug.state} — verify it before any re-test`);
  if (DEV_OWNED.includes(bug.state)) fail('BUG_AWAITING_FIX', `${bugRef} is ${bug.state} — the next step is a Dev fix: register a new build with --fixes ${bugRef}`);
  const superseded = bug.fix_claims.find((c) => c.build_id === buildId && c.outcome === 'superseded');
  if (superseded) fail('FIX_CLAIM_SUPERSEDED', `build ${buildId}'s fix claim was superseded by build ${bug.current_fix_build} — re-test the current fix build`);
  const idx = new Map(orderedBuilds(model).map((b, i) => [b.build_id, i]));
  if (idx.get(buildId) < idx.get(bug.current_fix_build)) fail('RETEST_BUILD_BEFORE_FIX', `the fix under test is build ${bug.current_fix_build}; ${buildId} is older`);
}

export function checkBugResult(model, run, caseKey, result) {
  const h = run.header;
  if (!BUG_RUN_TYPES.includes(h.execution_type) || !h.bug_ref || !bugReport(model.scopes.get(h.bug_ref))) return;
  if (caseKey === bugCaseKey(h.bug_ref) && result === 'not_run') fail('INVALID_VALUE', `${caseKey} needs a real outcome: pass, fail or blocked`);
}

export function checkBugRunClose(model, run) {
  const h = run.header;
  if (!BUG_RUN_TYPES.includes(h.execution_type) || !h.bug_ref || !bugReport(model.scopes.get(h.bug_ref))) return;
  if (runOutcome(run, h.bug_ref) === null) fail('BUG_OUTCOME_REQUIRED', `record ${bugCaseKey(h.bug_ref)} before closing — it carries the outcome`);
  checkBugRunOpen(model, h.execution_type, h.bug_ref, h.build_id, h.surface);
}

// A build's fix claims: each must be a reported bug that Dev currently owns.
export function checkFixClaims(model, refs, buildSurfaces) {
  const out = [];
  for (const r of refs) {
    const bug = requireReportedBug(model, r);
    if (CLOSED.includes(bug.state)) fail('BUG_CLOSED', `${bug.bug} is ${bug.state} — a closed bug takes no fix claim`);
    if (AWAITING_VERIFICATION.includes(bug.state)) fail('BUG_NOT_REPRODUCED', `${bug.bug} is ${bug.state} — QA must reproduce it before a fix is claimed`);
    if (!bug.surfaces.some((s) => buildSurfaces.includes(s))) fail('FIX_SURFACE_MISMATCH', `${bug.bug} affects ${bug.surfaces.join(', ')}; this build ships ${buildSurfaces.join(', ')}`);
    if (!out.includes(bug.bug)) out.push(bug.bug);
  }
  return out;
}

// ---------- validation (post hoc) ----------

export function bugErrors(model) {
  const errors = [];
  for (const scope of model.scopes.values()) {
    const bugEvents = scope.events.filter((e) => e.kind?.startsWith('bug.'));
    if (!bugEvents.length) continue;
    if (scope.kind !== 'bug') {
      errors.push({ code: 'INVALID_RECORD', where: scope.ref, message: 'bug records belong only in bug scopes' });
      continue;
    }
    const reports = bugEvents.filter((e) => e.kind === 'bug.reported');
    if (reports.length !== 1 || reports[0].seq !== 1) errors.push({ code: 'INVALID_RECORD', where: scope.ref, message: 'a bug has exactly one bug.reported, right after scope.created' });
    if (reports.length) {
      try {
        errors.push(...deriveBug(model, scope.ref).violations);
      } catch {
        errors.push({ code: 'INVALID_RECORD', where: scope.ref, message: 'bug history cannot be replayed' });
      }
    }
  }
  for (const b of model.builds.values()) {
    for (const r of b.fixes_claimed ?? []) if (!bugReport(model.scopes.get(r))) errors.push({ code: 'DANGLING_REFERENCE', where: `builds/${b.build_id}.json`, message: `fixes_claimed → ${r} is not a reported bug` });
  }
  return errors;
}

export const fixesClaimedOk = (v) => v === undefined || (Array.isArray(v) && v.length > 0 && v.every((r) => typeof r === 'string' && r.startsWith('bug:')));

// ---------- views ----------

const summary = (b) => ({ bug: b.bug, title: b.title, severity: b.severity, state: b.state, next_action: b.next_action, surfaces: b.surfaces, found_in_build: b.found_in_build, current_fix_build: b.current_fix_build, fixed_in_build: b.fixed_in_build, external_ref: b.external_ref, assignee: b.assignee });

function allBugs(model) {
  return [...model.scopes.values()]
    .filter((s) => bugReport(s))
    .map((s) => deriveBug(model, s.ref))
    .sort((a, b) => (a.bug < b.bug ? -1 : 1));
}

export function viewBug(model, o) {
  const { violations, ...bug } = requireReportedBug(model, o.bug);
  return { bug };
}

export function viewBugs(model, o) {
  let list = allBugs(model);
  if (o.scope) list = list.filter((b) => b.related_scopes.includes(o.scope));
  if (o.state) list = list.filter((b) => b.state === o.state);
  return { bugs: list.map(summary) };
}

export function viewCaseBugs(model, o) {
  const viaResults = new Map();
  for (const run of model.runs.values()) for (const r of run.results) if (r.case_key === o.case) for (const b of r.bug_refs) viaResults.set(b, true);
  const bugs = allBugs(model)
    .map((b) => ({ b, link: b.linked_cases.includes(o.case) ? 'linked' : b.origin.case_key === o.case ? 'origin' : viaResults.has(b.bug) ? 'result' : null }))
    .filter((x) => x.link)
    .map(({ b, link }) => ({ ...summary(b), link }));
  return { case: o.case, bugs };
}

// ---------- markdown ----------

const NEXT_LABEL = {
  qa_verify: 'QA: verify — reproduce it on a registered build (/verify-bug)',
  dev_fix: 'Dev: fix — deliver a new build that claims the fix (/register-build --fixes)',
  qa_retest: 'QA: re-test the fix build on every pending surface (/retest-bug)',
  none: 'None — the bug is closed',
};
const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' '));
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') : 'None.');
const list = (items) => (items.length ? items.map((i) => `- ${i}`).join('\n') : 'None.');

// Deterministic: the same ledger always renders the same bytes.
export function renderBugMarkdown(b) {
  const origin = b.origin.kind === 'execution' ? `Execution — ${b.origin.case_key}, result ${b.origin.result_id}` : 'Standalone intake';
  return `${[
    `# ${b.id} — ${b.title}`,
    '> Generated from the QA ledger (`qa-ledger/`) — a derived view, never read back. Do not edit; regenerate with `qa-ledger.mjs bug render`.',
    table(['Field', 'Value'], [
      ['Bug', b.bug],
      ['State', b.state],
      ['Next action', NEXT_LABEL[b.next_action]],
      ['Severity', b.severity],
      ['Origin', origin],
      ['Affected surfaces', b.surfaces.join(', ')],
      ['Found in build', b.found_in_build],
      ['Fix under test', b.current_fix_build],
      ['Pending re-test surfaces', b.pending_retest_surfaces.join(', ')],
      ['Fixed in build', b.fixed_in_build],
      ['Resolution', b.resolution ? `${b.resolution}${b.resolution_reason ? ` — ${b.resolution_reason}` : ''}${b.resolution_reference ? ` (${b.resolution_reference})` : ''}` : null],
      ['External reference', b.external_ref],
      ['Assignee', b.assignee],
      ['Capability', b.capability],
      ['Reported', `${b.reported_by}, ${b.reported_at}`],
    ]),
    '## Summary',
    b.description ?? '—',
    '## Reproduction Steps',
    b.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    `**Expected:** ${b.expected}\n\n**Actual:** ${b.actual}`,
    '## Devices',
    table(['Surface', 'Device', 'Runtime'], b.devices.map((d) => [d.surface, d.device, d.os_runtime])),
    '## Linked Test Cases',
    list(b.linked_cases),
    '## Related Scopes',
    list(b.related_scopes),
    '## Fix Claims',
    table(['Build', 'Claimed at', 'Outcome'], b.fix_claims.map((c) => [c.build_id, c.registered_at, c.outcome])),
    '## Reproduction History',
    table(['Run', 'Build', 'Surface', 'Device', 'Outcome', 'At', 'Notes'], b.reproductions.map((r) => [r.run_id, r.build_id, r.surface, [r.device, r.os_runtime].filter(Boolean).join(' / '), r.outcome, r.at, r.notes])),
    '## Re-test History',
    table(['Run', 'Build', 'Fix build', 'Surface', 'Device', 'Outcome', 'At', 'Notes'], b.retests.map((r) => [r.run_id, r.build_id, r.fix_build, r.surface, [r.device, r.os_runtime].filter(Boolean).join(' / '), r.outcome, r.at, r.notes])),
    '## Evidence',
    list([...b.evidence, ...b.reproductions.flatMap((r) => r.evidence), ...b.retests.flatMap((r) => r.evidence)]),
    '## History',
    table(['At', 'Event', 'Detail'], b.history.map((h) => [h.at, h.event, h.detail])),
  ].join('\n\n')}\n`;
}
