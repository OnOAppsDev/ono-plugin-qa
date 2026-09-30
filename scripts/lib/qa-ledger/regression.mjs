// Stage 5 — regression decisions and regression execution. A decision is QA's explicit,
// persisted choice on a scope: required or not (with a reason), which candidates are in
// or out (each exclusion with a reason), which existing cases run, on which build(s) and
// surface(s). Regression runs are ordinary Stage 1 runs of type `regression` tied to one
// decision; they pass the Stage 2 smoke gate and record only the selected cases.
// Internal module of scripts/qa-ledger.mjs. Read-only: it validates and derives.
'use strict';

import { fail, ID_RE, isStr, strictObject } from './core.mjs';
import { readPlan, isSmokePath } from './plans.mjs';
import { runOrder, decisionsOf, findDecision } from './query.mjs';
import { gateFor } from './execution.mjs';
import { bugReport, bugCaseKey, bugCaseHash, resolveCaseKey } from './bugs.mjs';

const target = (t) => strictObject(t, ['build_id', 'surface']) && ID_RE.test(t.build_id) && ID_RE.test(t.surface);
const strList = (v) => Array.isArray(v) && v.every(isStr);

export function decisionOk(v) {
  if (!strictObject(v, ['id', 'required', 'reason', 'capability', 'candidates', 'included', 'excluded', 'cases', 'targets', 'knowledge', 'decided_by'])) return false;
  if (!/^RD-[1-9][0-9]*$/.test(v.id) || typeof v.required !== 'boolean' || !isStr(v.reason) || !isStr(v.decided_by)) return false;
  if (!(v.capability === null || isStr(v.capability)) || ![v.candidates, v.included, v.cases].every(strList)) return false;
  if (!Array.isArray(v.excluded) || !v.excluded.every((x) => strictObject(x, ['capability', 'reason']) && isStr(x.capability) && isStr(x.reason))) return false;
  if (!Array.isArray(v.targets) || !v.targets.every(target)) return false;
  return v.knowledge === null || strictObject(v.knowledge, ['available', 'freshness', 'capabilities']);
}

// Builds and validates a decision value from QA's explicit choices. `pkCandidates` are the
// direct candidates Project Knowledge presented (possibly none); QA may add manual ones.
export function buildDecision(root, model, scope, o, { capability, pkCandidates, knowledge }) {
  if (!['yes', 'no'].includes(o.required)) fail('INVALID_VALUE', '--required must be yes or no — regression is never required by default'); // invariant:explicit-required
  const required = o.required === 'yes';
  for (const c of o.candidate ?? []) if (!ID_RE.test(c)) fail('INVALID_ID', `candidate "${c}" is not a capability id`);
  const candidates = [...new Set([...pkCandidates, ...(o.candidate ?? [])])].sort();
  const included = [...new Set(o.include ?? [])].sort();
  const excluded = (o.exclude ?? []).map((raw) => {
    const i = raw.indexOf('=');
    const cap = i < 0 ? raw.trim() : raw.slice(0, i).trim();
    const reason = i < 0 ? '' : raw.slice(i + 1).trim();
    if (!reason) fail('MISSING_ARGUMENT', `--exclude ${cap} needs a reason: --exclude "${cap}=<why>"`);
    return { capability: cap, reason };
  });
  excluded.sort((a, b) => (a.capability < b.capability ? -1 : 1));
  for (const c of [...included, ...excluded.map((x) => x.capability)]) if (!candidates.includes(c)) fail('UNKNOWN_CANDIDATE', `${c} is not a direct regression candidate — add it with --candidate if QA judges it related`);
  const excludedIds = excluded.map((x) => x.capability);
  if (included.some((c) => excludedIds.includes(c)) || new Set(excludedIds).size !== excludedIds.length) fail('INVALID_VALUE', 'a candidate is either included or excluded, once');
  const unaddressed = candidates.filter((c) => !included.includes(c) && !excludedIds.includes(c));
  if (unaddressed.length) fail('UNADDRESSED_CANDIDATE', `QA must include or exclude every candidate — not addressed: ${unaddressed.join(', ')}`, { unaddressed }); // invariant:every-candidate-decided

  const cases = [...new Set(o.case ?? [])];
  const targets = (o.target ?? []).map((raw) => {
    const [build_id, surface] = raw.split('@');
    if (!build_id || !surface) fail('INVALID_VALUE', `--target must be <build>@<surface>, got "${raw}"`);
    const build = model.builds.get(build_id);
    if (!build) fail('UNKNOWN_BUILD', `build ${build_id} is not registered`);
    if (!build.surfaces.includes(surface)) fail('SURFACE_NOT_IN_BUILD', `build ${build_id} does not ship ${surface}`);
    return { build_id, surface };
  });
  if (!required && (cases.length || targets.length || included.length)) fail('INVALID_VALUE', 'a "not required" decision includes no candidates, cases or targets');
  if (required && !cases.length) fail('REGRESSION_CASES_REQUIRED', 'a required regression selects at least one existing case (--case)');
  if (required && !targets.length) fail('REGRESSION_TARGETS_REQUIRED', 'a required regression names at least one <build>@<surface> target');
  for (const key of cases) {
    if (key.includes('#')) {
      if (key !== bugCaseKey(scope.ref) || !bugReport(scope)) fail('INVALID_VALUE', `${key}: only this bug's own scenario (${scope.kind === 'bug' ? bugCaseKey(scope.ref) : 'none for a feature'}) may be selected by case key`);
      continue;
    }
    if (isSmokePath(key)) fail('INVALID_VALUE', `${key} is a smoke case — smoke runs once per build, it is not regression`);
    resolveCaseKey(root, key);
    const plan = readPlan(root, `${key.slice(0, key.lastIndexOf('/'))}/test-plan.md`);
    if (plan.status !== 'approved') fail('PLAN_NOT_APPROVED', `${plan.plan} is ${plan.status ?? 'unstamped'} — regression runs approved cases only`);
  }
  const id = `RD-${decisionsOf(scope, { all: true }).length + 1}`;
  return { id, required, reason: o.reason, capability, candidates, included, excluded, cases, targets, knowledge, decided_by: o.by };
}

const planOf = (key) => `${key.slice(0, key.lastIndexOf('/'))}/test-plan.md`;

// Opening a regression run: the scope's current decision, required, on one of its targets.
// Returns the plans the run references — always the ones the decision's cases come from.
export function checkRegressionOpen(model, scopeRef, o) {
  if (!o.decision) fail('REGRESSION_DECISION_REQUIRED', 'a regression run executes a QA regression decision — pass --decision RD-<n> (see /plan-regression)');
  const scope = model.scopes.get(scopeRef);
  const decision = findDecision(scope, o.decision);
  if (!decision) fail('UNKNOWN_DECISION', `${scopeRef} has no regression decision ${o.decision}`);
  const current = decisionsOf(scope).at(-1);
  if (!current || current.id !== decision.id) fail('REGRESSION_DECISION_SUPERSEDED', `${o.decision} was superseded by ${current?.id ?? 'a retraction'} — run the current decision`);
  if (!decision.required) fail('REGRESSION_NOT_REQUIRED', `${decision.id} decided regression is not required: ${decision.reason}`);
  if (!decision.targets.some((t) => t.build_id === o.build && t.surface === o.surface)) fail('REGRESSION_TARGET_MISMATCH', `${decision.id} targets ${decision.targets.map((t) => `${t.build_id}@${t.surface}`).join(', ')} — evidence never carries to another build; decide again for ${o.build}@${o.surface}`); // invariant:regression-target
  const plans = [...new Set(decision.cases.filter((k) => !k.includes('#')).map(planOf))].sort();
  if (o.plan && [...new Set(o.plan)].sort().join('\n') !== plans.join('\n')) fail('REGRESSION_PLAN_MISMATCH', `a regression run references exactly the decision's plans: ${plans.join(', ') || 'none'}`);
  return { decision, plans };
}

export function checkRegressionResult(model, run, caseKey) {
  const h = run.header;
  if (h.execution_type !== 'regression') return;
  const decision = findDecision(model.scopes.get(h.scope), h.regression_decision);
  if (!decision.cases.includes(caseKey)) fail('CASE_NOT_SELECTED', `${caseKey} is not among the cases QA selected in ${decision.id}`); // invariant:selected-cases-only
}

// Post-hoc checks: every regression run belongs to a real, required decision of its scope,
// on one of its targets, recording only its cases, opened through the smoke gate.
export function regressionErrors(model) {
  const errors = [];
  for (const run of model.runs.values()) {
    const h = run.header;
    if (h.execution_type !== 'regression' || !model.scopes.has(h.scope) || !model.builds.has(h.build_id)) continue;
    const decision = findDecision(model.scopes.get(h.scope), h.regression_decision);
    if (!decision) {
      errors.push({ code: 'DANGLING_REFERENCE', where: h.run_id, message: `regression decision ${h.regression_decision} does not exist on ${h.scope}` });
      continue;
    }
    const onTarget = decision.targets.some((t) => t.build_id === h.build_id && t.surface === h.surface);
    const strays = run.results.filter((r) => !decision.cases.includes(r.case_key)).map((r) => r.case_key);
    if (!decision.required || !onTarget || strays.length) errors.push({ code: 'REGRESSION_OUTSIDE_DECISION', where: h.run_id, message: `run is outside ${decision.id}${!onTarget ? ` (target ${h.build_id}@${h.surface})` : ''}${strays.length ? ` (cases ${strays.join(', ')})` : ''}` });
    const gateHeld = gateFor(model, h.scope, h.build_id, h.surface, h.at).open;
    if (!gateHeld) errors.push({ code: 'GATE_NOT_HELD', where: h.run_id, message: `regression opened with the smoke gate closed on ${h.build_id} / ${h.surface}` });
  }
  return errors;
}

// ---------- views ----------

function currentHash(root, model, key) {
  if (key.includes('#')) return bugCaseHash(model.scopes.get(key.slice(0, key.indexOf('#'))));
  try {
    return readPlan(root, planOf(key)).rows.find((r) => r.case_key === key)?.row_hash ?? null;
  } catch {
    return null;
  }
}

export function viewRegression(root, model, scopeRef) {
  const scope = model.scopes.get(scopeRef);
  const at = (id) => scope.events.find((e) => e.kind === 'context.add' && e.field === 'regression_decisions' && e.value.id === id)?.at ?? null;
  const withTime = (d) => ({ ...d, decided_at: at(d.id) });
  const history = decisionsOf(scope, { all: true }).map(withTime);
  const active = decisionsOf(scope);
  const current = active.length ? withTime(active.at(-1)) : null;
  let status = null;
  if (current?.required) {
    const runs = runOrder(model).filter((r) => r.header.scope === scopeRef && r.header.execution_type === 'regression' && r.header.regression_decision === current.id);
    status = {
      decision_id: current.id,
      targets: current.targets.map((t) => {
        const mine = runs.filter((r) => r.header.build_id === t.build_id && r.header.surface === t.surface);
        const latest = new Map();
        for (const run of mine.filter((r) => r.state === 'closed')) for (const r of run.results) if (r.superseded_by === null) latest.set(r.case_key, { run, r });
        const cases = current.cases.map((key) => {
          const hit = latest.get(key);
          const hash = currentHash(root, model, key);
          const state = !hit ? 'pending' : hit.r.case_ref.row_hash !== hash ? 'stale' : hit.r.result;
          return { case_key: key, status: state, latest: hit ? { result_id: hit.r.result_id, run_id: hit.run.header.run_id, result: hit.r.result, notes: hit.r.notes, recorded_at: hit.r.at } : null };
        });
        const summary = { pass: 0, fail: 0, blocked: 0, not_run: 0, stale: 0, pending: 0 };
        for (const c of cases) summary[c.status]++;
        return { build_id: t.build_id, surface: t.surface, gate: gateFor(model, scopeRef, t.build_id, t.surface), runs: mine.map((r) => ({ run_id: r.header.run_id, state: r.state })), cases, summary };
      }),
    };
  }
  return { scope: scopeRef, current, history, status };
}
