// Stage 6 — deterministic QA readiness and sign-off. The verdict is a pure function of
// ledger records (Stages 1–5) plus this stage's explicit pins, exceptions and debt
// discharges — no Project Knowledge, no Dev plugin, no network, no judgment. It reuses
// the Stage 2/3/5 derivations (smoke status, per-case execution status, derived bug
// state, regression status) rather than re-deriving them, and fingerprints exactly the
// source records it read. See docs/qa-readiness-contract.md.
// Internal module of scripts/qa-ledger.mjs. Read-only.
'use strict';

import { canonical, sha, isStr, idOk, strictObject, fail } from './core.mjs';
import { readPlan } from './plans.mjs';
import { orderedBuilds, runOrder, scopeBuildIds, decisionsOf, requireScope } from './query.mjs';
import { smokeStatus, viewExecution } from './execution.mjs';
import { viewRegression } from './regression.mjs';
import { bugReport, deriveBug } from './bugs.mjs';
import { freshnessToken } from './freshness.mjs';

// Schema 2 (Stage 7 follow-up): adds freshness_token, dev_feature, qa_bug_id, external_ref,
// and the release artifact (member_count + Members). Schema-1 artifacts carry no freshness
// token, so a consumer cannot prove them current.
export const READINESS_SCHEMA = 2;
export const VERDICTS = ['READY', 'READY_WITH_EXCEPTIONS', 'NOT_READY'];
export const BLOCKING_SEVERITIES = ['critical', 'major'];
export const EXCEPTION_KINDS = ['known_issue', 'limitation', 'waived_regression', 'waived_debt', 'waiver'];
const BLOCKING_CLOSES = ['closed_verified', 'closed_duplicate', 'closed_not_reproducible'];
const RULES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'];
const SIGNOFF_FIELD = 'signoffs';

// ---------- additive context fields (managed: written only by `readiness …` commands) ----------

export const READINESS_FIELDS = {
  candidate_builds: { op: 'add', managed: true, keyOf: (v) => v.surface, valid: (v) => strictObject(v, ['surface', 'build_id', 'reason']) && idOk(v.surface) && idOk(v.build_id) && isStr(v.reason) },
  exceptions: {
    op: 'add',
    managed: true,
    keyOf: (v) => v.id,
    valid: (v) => strictObject(v, ['id', 'item', 'kind', 'reason', 'approved_by', 'build_id']) && /^EX-[1-9][0-9]*$/.test(v.id) && isStr(v.item) && EXCEPTION_KINDS.includes(v.kind) && isStr(v.reason) && isStr(v.approved_by) && (v.build_id === null || idOk(v.build_id)),
  },
  debt_discharges: { op: 'add', managed: true, keyOf: (v) => v.debt_id, valid: (v) => strictObject(v, ['debt_id', 'result_id']) && idOk(v.debt_id) && isStr(v.result_id) },
  signoffs: {
    op: 'add',
    managed: true,
    keyOf: (v) => v.id,
    valid: (v) => strictObject(v, ['id', 'verdict', 'fingerprint', 'notes', 'signed_by']) && /^SO-[1-9][0-9]*$/.test(v.id) && VERDICTS.includes(v.verdict) && isStr(v.fingerprint) && (v.notes === null || isStr(v.notes)) && isStr(v.signed_by),
  },
};

const eventsOf = (scope, field) => scope.events.filter((e) => e.kind === 'context.add' && e.field === field);
const dateOf = (scope, field, key, keyOf) => eventsOf(scope, field).filter((e) => keyOf(e.value) === key).at(-1)?.at ?? null;

// ---------- inputs ----------

function allReportedBugs(model) {
  return [...model.scopes.values()].filter((s) => bugReport(s)).map((s) => deriveBug(model, s.ref)).sort((a, b) => (a.bug < b.bug ? -1 : 1));
}
function linkedBugs(model, scope) {
  if (scope.kind === 'bug') return bugReport(scope) ? [deriveBug(model, scope.ref)] : [];
  return allReportedBugs(model).filter((b) => b.related_scopes.includes(scope.ref));
}
function requiredSurfaces(scope, bugs) {
  if (scope.kind === 'bug') return bugs[0]?.surfaces ?? [];
  return scope.context.surfaces ?? [];
}
function scopeBuilds(model, scope, bugs) {
  const ids = scopeBuildIds(model, scope.ref);
  for (const b of bugs) for (const c of b.fix_claims) ids.add(c.build_id);
  return ids;
}

// Per surface: QA's explicit pin, else the latest build whose smoke passed.
export function candidateBuilds(model, scope, surfaces, buildIds) {
  const pins = scope.context.candidate_builds ?? [];
  return surfaces.map((surface) => {
    const pin = pins.find((p) => p.surface === surface);
    if (pin) return { surface, build_id: pin.build_id, pinned: true, reason: pin.reason };
    const accepted = orderedBuilds(model).filter((b) => buildIds.has(b.build_id) && b.surfaces.includes(surface) && smokeStatus(model, b.build_id, surface).status === 'passed');
    return { surface, build_id: accepted.length ? accepted.at(-1).build_id : null, pinned: false };
  });
}

// ---------- rules ----------

function evaluate(root, model, scope) {
  const bugs = linkedBugs(model, scope);
  const surfaces = requiredSurfaces(scope, bugs);
  const buildIds = scopeBuilds(model, scope, bugs);
  const candidates = candidateBuilds(model, scope, surfaces, buildIds);
  const cand = new Map(candidates.map((c) => [c.surface, c.build_id]));
  const idx = new Map(orderedBuilds(model).map((b, i) => [b.build_id, i]));
  const blockers = [];
  const applies = new Set();
  const add = (id, rule, message, extra = {}) => blockers.push({ id, rule, message, ...extra });
  const feature = scope.kind === 'feature';

  // R1 — smoke accepted the candidate build on every required surface.
  applies.add('R1');
  const smoke = candidates.map((c) => ({ ...c, smoke: c.build_id ? smokeStatus(model, c.build_id, c.surface).status : 'no_build' }));
  for (const s of smoke) if (s.build_id && s.smoke !== 'passed') add(`R1:${s.surface}:${s.build_id}`, 'R1', `smoke on ${s.build_id} / ${s.surface} is ${s.smoke}`, { surface: s.surface, build_id: s.build_id }); // invariant:r1-smoke

  // R2 — every plan of a feature scope is approved.
  const plans = feature ? (scope.context.plans ?? []).map((p) => {
    try {
      const plan = readPlan(root, p);
      return { plan: p, status: plan.status, fingerprint: plan.fingerprint };
    } catch {
      return { plan: p, status: 'missing', fingerprint: null };
    }
  }) : [];
  if (feature) {
    applies.add('R2');
    if (!plans.length) add('R2:no-plan', 'R2', 'no test plan is attached to the scope');
    for (const p of plans) if (p.status !== 'approved') add(`R2:${p.plan}`, 'R2', `${p.plan} is ${p.status ?? 'unstamped'}, not approved`); // invariant:r2-plan
  }

  // R3 — every applicable functional case PASSes on every required surface (feature only).
  let functional = [];
  if (feature) {
    applies.add('R3');
    const ex = viewExecution(root, model, { scope: scope.ref });
    functional = ex.surfaces.filter((sv) => surfaces.includes(sv.surface));
    for (const sv of functional) {
      for (const c of sv.cases) {
        if (c.status === 'pass' || c.status === 'excluded') continue; // invariant:r3-functional
        const detail = c.status === 'stale' ? 'stale — its plan row changed since it was executed' : c.status;
        add(`R3:${sv.surface}:${c.case_key}`, 'R3', `${c.case_key} on ${sv.surface} is ${detail}`, { surface: sv.surface });
      }
    }
  }

  // R4 — linked bugs: blocking ones verified / duplicate / not reproducible; any other bug closed.
  applies.add('R4');
  for (const b of bugs) {
    if (b.state === 'fix_delivered') continue;
    const blocking = BLOCKING_SEVERITIES.includes(b.severity);
    const ok = blocking ? BLOCKING_CLOSES.includes(b.state) : b.state.startsWith('closed_');
    if (!ok) add(`R4:${b.bug}`, 'R4', `${b.bug} (${b.severity}) is ${b.state}`, { bug: b.bug }); // invariant:r4-bugs
  }

  // R5 — a delivered fix is re-tested, and a verified fix is inside the candidate build.
  applies.add('R5');
  for (const b of bugs) {
    if (b.state === 'fix_delivered') add(`R5:${b.bug}`, 'R5', `${b.bug}: fix in ${b.current_fix_build} awaits re-test on ${b.pending_retest_surfaces.join(', ')}`, { bug: b.bug }); // invariant:r5-retest
    if (b.state === 'closed_verified' && b.fixed_in_build) {
      for (const s of b.surfaces) {
        const c = cand.get(s);
        if (c && idx.get(c) < idx.get(b.fixed_in_build)) add(`R5:${b.bug}:${s}`, 'R5', `candidate ${c} on ${s} predates the fix verified in ${b.fixed_in_build}`, { bug: b.bug, surface: s, build_id: c });
      }
    }
  }

  // R6 — an explicit regression decision exists ("not required" is valid).
  applies.add('R6');
  const decision = decisionsOf(scope).at(-1) ?? null;
  if (!decision) add('R6', 'R6', 'no regression decision is recorded — /plan-regression'); // invariant:r6-decision

  // R7 — a required regression PASSes on the candidate build of each targeted surface.
  let regression = null;
  if (decision?.required) {
    applies.add('R7');
    regression = viewRegression(root, model, scope.ref).status;
    for (const t of regression.targets) {
      for (const c of t.cases) if (c.status !== 'pass') add(`R7:${t.build_id}@${t.surface}:${c.case_key}`, 'R7', `regression ${c.case_key} on ${t.build_id} / ${t.surface} is ${c.status}`, { surface: t.surface, build_id: t.build_id }); // invariant:r7-regression
    }
    for (const s of surfaces) {
      const onSurface = decision.targets.filter((t) => t.surface === s);
      if (onSurface.length && !onSurface.some((t) => t.build_id === cand.get(s))) add(`R7:${s}:target`, 'R7', `${decision.id} targets ${onSurface.map((t) => t.build_id).join(', ')} on ${s}, not the candidate ${cand.get(s) ?? '(none)'}`, { surface: s, build_id: cand.get(s) ?? null });
    }
  }

  // R8 — every QA debt item is discharged by passing evidence (or excepted).
  applies.add('R8');
  const discharged = new Set((scope.context.debt_discharges ?? []).map((d) => d.debt_id));
  const debt = (scope.context.debt ?? []).map((d) => ({ ...d, discharged: discharged.has(d.id) }));
  for (const d of debt) if (!d.discharged) add(`R8:${d.id}`, 'R8', `QA debt ${d.id} (${d.description}) is not discharged`, { debt: d.id }); // invariant:r8-debt

  // R9 — every required surface has a candidate build, and a regression target when required.
  applies.add('R9');
  if (!surfaces.length) add('R9:no-surfaces', 'R9', scope.kind === 'bug' ? 'the bug has no affected surfaces' : 'no required surfaces are set (/set-qa-scope)');
  for (const c of candidates) if (!c.build_id) add(`R9:${c.surface}:candidate`, 'R9', `no accepted build on ${c.surface} — smoke has not passed on any build, and none is pinned`, { surface: c.surface }); // invariant:r9-coverage
  if (decision?.required) for (const s of surfaces) if (!decision.targets.some((t) => t.surface === s)) add(`R9:${s}:regression`, 'R9', `regression is required but ${decision.id} has no target on ${s}`, { surface: s });

  return { bugs, surfaces, buildIds, candidates, smoke, plans, functional, decision, regression, debt, blockers, applies };
}

// Exceptions apply only to the exact blocker they name (and, if pinned to a build, only to
// that build). Nothing is excepted implicitly.
function applyExceptions(scope, blockers, cand) {
  const exceptions = (scope.context.exceptions ?? []).map((e) => ({ ...e, date: dateOf(scope, 'exceptions', e.id, (v) => v.id) }));
  for (const b of blockers) {
    const ex = exceptions.find((e) => e.item === b.id && (e.build_id === null || e.build_id === (b.build_id ?? cand.get(b.surface)))); // invariant:exception-match
    if (ex) b.excepted_by = ex.id;
  }
  const used = new Set(blockers.map((b) => b.excepted_by).filter(Boolean));
  return exceptions.map((e) => ({ ...e, applied: used.has(e.id) }));
}

export function verdictOf(blockers) {
  if (blockers.some((b) => !b.excepted_by)) return 'NOT_READY'; // invariant:verdict
  return blockers.length ? 'READY_WITH_EXCEPTIONS' : 'READY';
}

// ---------- fingerprint ----------

// Every source record the verdict read: the scope's own events (sign-offs excluded), linked
// bugs' events, the runs consumed (the scope's, linked bugs', and smoke on its builds),
// the builds those touch plus candidates and fix builds, and the plan files' content.
function consumedRecords(root, model, scope, e) {
  const out = [];
  const stream = (s) => {
    for (const r of s.events) if (r.field !== SIGNOFF_FIELD) out.push({ key: `scope:${s.ref}:${r.seq}`, hash: r.hash, at: r.at }); // invariant:fingerprint-scope
  };
  stream(scope);
  const bugRefs = new Set(e.bugs.map((b) => b.bug));
  for (const ref of bugRefs) if (ref !== scope.ref) stream(model.scopes.get(ref));
  const builds = new Set(e.candidates.map((c) => c.build_id).filter(Boolean));
  for (const b of e.bugs) for (const c of b.fix_claims) builds.add(c.build_id);
  for (const run of model.runs.values()) {
    const h = run.header;
    const mine = h.scope === scope.ref || bugRefs.has(h.bug_ref) || bugRefs.has(h.scope);
    const smokeOnScope = h.execution_type === 'smoke' && e.buildIds.has(h.build_id) && e.surfaces.includes(h.surface);
    if (!mine && !smokeOnScope) continue;
    const last = run.results.at(-1) ?? h;
    out.push({ key: `run:${h.run_id}:${run.state}`, hash: run.endedAt ? `${last.hash}:${run.endedAt}` : last.hash, at: run.endedAt ?? last.at }); // invariant:fingerprint-runs
    builds.add(h.build_id);
  }
  for (const id of builds) {
    const b = model.builds.get(id);
    if (b) out.push({ key: `build:${id}`, hash: b.hash, at: b.registered_at });
  }
  const planPaths = new Set([...e.plans.map((p) => p.plan), ...(e.decision?.cases ?? []).filter((k) => !k.includes('#')).map((k) => `${k.slice(0, k.lastIndexOf('/'))}/test-plan.md`)]);
  for (const p of planPaths) {
    let fp = 'missing';
    try {
      fp = readPlan(root, p).fingerprint;
    } catch {
      /* a missing plan is itself an input */
    }
    out.push({ key: `plan:${p}`, hash: fp, at: null });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

const fingerprintOf = (records) => sha(canonical(records.map(({ key, hash }) => [key, hash])));
const latestAt = (records) => records.map((r) => r.at).filter(Boolean).sort().at(-1) ?? null;

// ---------- sign-off ----------

export function signoffsOf(scope, current) {
  return eventsOf(scope, SIGNOFF_FIELD).map((ev, i, all) => ({
    ...ev.value,
    signed_at: ev.at,
    status: i === all.length - 1 && current && ev.value.fingerprint === current.fingerprint && ev.value.verdict === current.verdict ? 'valid' : i === all.length - 1 ? 'stale' : 'superseded', // invariant:signoff-validity
  }));
}

// ---------- the readiness of one scope ----------

export function computeReadiness(root, model, ref) {
  const s = requireScope(model, ref);
  const scope = model.scopes.get(s.ref);
  if (scope.kind === 'release') return releaseReadiness(root, model, scope);
  const e = evaluate(root, model, scope);
  const cand = new Map(e.candidates.map((c) => [c.surface, c.build_id]));
  const exceptions = applyExceptions(scope, e.blockers, cand);
  const verdict = verdictOf(e.blockers);
  const records = consumedRecords(root, model, scope, e);
  const fingerprint = fingerprintOf(records);
  const rules = RULES.map((rule) => {
    if (!e.applies.has(rule)) return { rule, status: 'not_applicable' };
    const mine = e.blockers.filter((b) => b.rule === rule);
    return { rule, status: !mine.length ? 'pass' : mine.every((b) => b.excepted_by) ? 'excepted' : 'blocked' };
  });
  const testedBuilds = [...new Set(runOrder(model).filter((r) => r.header.scope === s.ref || e.bugs.some((b) => b.bug === r.header.bug_ref)).map((r) => r.header.build_id))];
  const current = { verdict, fingerprint };
  const signoffs = signoffsOf(scope, current);
  const ownBug = scope.kind === 'bug' ? e.bugs.find((b) => b.bug === s.ref) : null;
  return {
    scope: s.ref,
    kind: scope.kind,
    verdict,
    rules,
    blockers: e.blockers,
    exceptions,
    known_issues: exceptions.filter((x) => x.kind === 'known_issue' && x.applied),
    candidate_builds: e.candidates,
    surfaces: e.smoke.map((c) => {
      const fv = e.functional.find((f) => f.surface === c.surface);
      return { surface: c.surface, candidate_build: c.build_id, pinned: c.pinned, smoke: c.smoke, functional: fv ? fv.summary : null, regression: e.regression?.targets.filter((t) => t.surface === c.surface).map((t) => ({ build_id: t.build_id, summary: t.summary })) ?? null };
    }),
    plans: e.plans,
    bugs: e.bugs.map((b) => ({ bug: b.bug, title: b.title, severity: b.severity, state: b.state, fixed_in_build: b.fixed_in_build, current_fix_build: b.current_fix_build, retests: b.retests.map((r) => ({ build_id: r.build_id, surface: r.surface, outcome: r.outcome })) })),
    regression_decision: e.decision ? { id: e.decision.id, required: e.decision.required, reason: e.decision.reason, targets: e.decision.targets, cases: e.decision.cases } : null,
    debt: e.debt,
    tested_builds: testedBuilds,
    dev_feature: scope.context.dev_handoff?.feature ?? null,
    // Bug identity: the QA id and the bug's external_ref — either may be absent.
    qa_bug_id: ownBug ? s.ref.slice('bug:'.length) : null,
    external_ref: ownBug?.external_ref ?? null,
    fingerprint,
    freshness_token: freshnessToken(root, s.ref),
    generated_at: latestAt(records),
    consumed: records.length,
    signoff: signoffs.at(-1) ?? null,
  };
}

// Per surface, the members' candidates must agree; disagreeing members block the release.
function releaseCandidates(members) {
  const surfaces = [...new Set(members.flatMap((m) => m.candidate_builds.map((c) => c.surface)))].sort();
  return surfaces.map((surface) => {
    const cs = members.flatMap((m) => m.candidate_builds.filter((c) => c.surface === surface && c.build_id));
    const ids = [...new Set(cs.map((c) => c.build_id))].sort();
    if (ids.length > 1) return { surface, build_id: null, pinned: false, conflict: ids }; // invariant:release-candidate-conflict
    return { surface, build_id: ids[0] ?? null, pinned: cs.some((c) => c.pinned) };
  });
}

function releaseReadiness(root, model, scope) {
  const members = (scope.context.members ?? []).map((m) => computeReadiness(root, model, m));
  const candidates = releaseCandidates(members);
  const blockers = [];
  if (!members.length) blockers.push({ id: 'RELEASE:no-members', rule: 'RELEASE', message: 'the release scope has no member scopes' });
  for (const c of candidates) if (c.conflict) blockers.push({ id: `RELEASE:candidate-conflict:${c.surface}`, rule: 'RELEASE', surface: c.surface, message: `members disagree on the ${c.surface} candidate build (${c.conflict.join(', ')})` });
  const ownBlocked = blockers.length > 0;
  for (const m of members) for (const b of m.blockers) blockers.push({ ...b, member: m.scope });
  const verdict = ownBlocked || members.some((m) => m.verdict === 'NOT_READY') ? 'NOT_READY' : members.some((m) => m.verdict === 'READY_WITH_EXCEPTIONS') ? 'READY_WITH_EXCEPTIONS' : 'READY'; // invariant:release-verdict
  const ownEvents = scope.events.filter((r) => r.field !== SIGNOFF_FIELD);
  const own = ownEvents.map((r) => [`scope:${scope.ref}:${r.seq}`, r.hash]);
  const fingerprint = sha(canonical([own, members.map((m) => [m.scope, m.fingerprint])])); // invariant:release-fingerprint
  const signoffs = signoffsOf(scope, { verdict, fingerprint });
  const seenBugs = new Set();
  return {
    scope: scope.ref,
    kind: 'release',
    verdict,
    members: members.map((m) => ({ scope: m.scope, kind: m.kind, verdict: m.verdict, fingerprint: m.fingerprint, blocker_count: m.blockers.filter((b) => !b.excepted_by).length, dev_feature: m.dev_feature, qa_bug_id: m.qa_bug_id, external_ref: m.external_ref })),
    blockers,
    exceptions: members.flatMap((m) => m.exceptions.filter((x) => x.applied).map((x) => ({ ...x, member: m.scope }))),
    known_issues: members.flatMap((m) => m.known_issues.map((x) => ({ ...x, member: m.scope }))),
    candidate_builds: candidates,
    surfaces: candidates.map((c) => ({ surface: c.surface, candidate_build: c.build_id, pinned: c.pinned, members: members.filter((m) => m.candidate_builds.some((x) => x.surface === c.surface)).map((m) => m.scope) })),
    bugs: members.flatMap((m) => m.bugs.map((b) => ({ ...b, member: m.scope }))).filter((b) => !seenBugs.has(b.bug) && seenBugs.add(b.bug)),
    tested_builds: [...new Set(members.flatMap((m) => m.tested_builds))],
    dev_feature: null,
    qa_bug_id: null,
    external_ref: null,
    fingerprint,
    freshness_token: freshnessToken(root, scope.ref),
    generated_at: [...members.map((m) => m.generated_at), ...ownEvents.map((r) => r.at)].filter(Boolean).sort().at(-1) ?? null,
    signoff: signoffs.at(-1) ?? null,
  };
}

// ---------- write-time checks for the readiness commands ----------

export function requireNonRelease(scope) {
  if (scope.kind === 'release') fail('RELEASE_AGGREGATION_ONLY', `${scope.ref} only aggregates its members' readiness — pins, exceptions and debt discharges belong to the member scopes`);
}

export function pinValue(model, scope, o, surfaces) {
  const build = model.builds.get(o.build);
  if (!build) fail('UNKNOWN_BUILD', `build ${o.build} is not registered`);
  if (!build.surfaces.includes(o.surface)) fail('SURFACE_NOT_IN_BUILD', `build ${o.build} does not ship ${o.surface}`);
  if (!surfaces.includes(o.surface)) fail('SURFACE_NOT_IN_SCOPE', `${o.surface} is not a required surface of ${scope.ref}`);
  return { surface: o.surface, build_id: o.build, reason: o.reason };
}

export function exceptionValue(model, scope, o, current) {
  if (!EXCEPTION_KINDS.includes(o.kind)) fail('INVALID_VALUE', `--kind must be one of ${EXCEPTION_KINDS.join(', ')}`);
  if (!current.blockers.some((b) => b.id === o.item)) fail('UNKNOWN_BLOCKER', `${o.item} is not a current blocker of ${scope.ref} — an exception names an exact blocker id from view readiness`); // invariant:exception-names-blocker
  if (o.build && !model.builds.has(o.build)) fail('UNKNOWN_BUILD', `build ${o.build} is not registered`);
  const n = eventsOf(scope, 'exceptions').length + 1;
  return { id: `EX-${n}`, item: o.item, kind: o.kind, reason: o.reason, approved_by: o['approved-by'], build_id: o.build ?? null };
}

export function dischargeValue(model, scope, o) {
  if (!(scope.context.debt ?? []).some((d) => d.id === o.debt)) fail('UNKNOWN_DEBT', `${scope.ref} has no QA debt ${o.debt}`);
  const result = model.results.get(o.result);
  if (!result) fail('UNKNOWN_RESULT', `result ${o.result} does not exist`);
  const run = model.runs.get(o.result.slice(0, o.result.lastIndexOf('/')));
  if (run.header.scope !== scope.ref || run.state !== 'closed' || result.superseded_by !== null || result.result !== 'pass') fail('INVALID_VALUE', `QA debt is discharged only by an effective PASS in a closed run of ${scope.ref}`); // invariant:discharge-needs-pass
  return { debt_id: o.debt, result_id: o.result };
}

// Post-hoc referential checks for the Stage 6 fields.
export function readinessErrors(model) {
  const errors = [];
  for (const s of model.scopes.values()) {
    for (const p of s.context.candidate_builds ?? []) if (!model.builds.has(p.build_id)) errors.push({ code: 'DANGLING_REFERENCE', where: s.ref, message: `candidate build ${p.build_id} does not exist` });
    for (const d of s.context.debt_discharges ?? []) if (!model.results?.has(d.result_id)) errors.push({ code: 'DANGLING_REFERENCE', where: s.ref, message: `debt discharge → ${d.result_id} does not exist` });
    for (const x of s.context.exceptions ?? []) if (x.build_id && !model.builds.has(x.build_id)) errors.push({ code: 'DANGLING_REFERENCE', where: s.ref, message: `exception build ${x.build_id} does not exist` });
  }
  return errors;
}

// ---------- views ----------

export function viewSignoffs(root, model, o) {
  const scopes = o.scope ? [model.scopes.get(requireScope(model, o.scope).ref)] : [...model.scopes.values()].sort((a, b) => (a.ref < b.ref ? -1 : 1));
  const all = [];
  for (const s of scopes) {
    if (!eventsOf(s, SIGNOFF_FIELD).length) continue;
    const r = computeReadiness(root, model, s.ref);
    for (const so of signoffsOf(s, r)) all.push({ scope: s.ref, ...so, current_verdict: r.verdict, current_fingerprint: r.fingerprint });
  }
  return { signoffs: all, stale: all.filter((x) => x.status === 'stale') };
}

// ---------- markdown ----------

const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' '));
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') : 'None.');

// Tamper evidence (contract "Artifact integrity"): sha256 over the rendered artifact without
// its artifact_integrity line, which is then added as the last frontmatter line. Removing
// that one line from the published file gives back exactly the bytes that were hashed.
function sealArtifact(text) {
  const end = text.indexOf('\n---\n', 4);
  return `${text.slice(0, end)}\nartifact_integrity: ${sha(text)}${text.slice(end)}`; // invariant:artifact-integrity
}

// Deterministic: every value comes from the ledger (generated_at is the latest consumed
// record's time), so the same ledger always renders the same bytes.
export function renderReadinessMarkdown(r) {
  return sealArtifact(renderUnsealed(r));
}

function renderUnsealed(r) {
  const so = r.signoff;
  const fm = [
    '---',
    `qa_readiness_schema: ${READINESS_SCHEMA}`,
    `scope: ${r.scope}`,
    `scope_kind: ${r.kind}`,
    `dev_feature: ${r.dev_feature ?? 'null'}`,
    `qa_bug_id: ${r.qa_bug_id ?? 'null'}`,
    `external_ref: ${r.external_ref ?? 'null'}`,
    ...(r.kind === 'release' ? [`member_count: ${r.members.length}`] : []),
    'candidate_builds:',
    ...(r.candidate_builds.length ? r.candidate_builds.map((c) => `  - ${c.surface}: ${c.build_id ?? 'null'}${c.pinned ? ' # pinned' : ''}`) : ['  []']),
    `verdict: ${r.verdict}`,
    `blocker_count: ${r.blockers.filter((b) => !b.excepted_by).length}`,
    `exception_count: ${r.exceptions.filter((x) => x.applied).length}`,
    `fingerprint: ${r.fingerprint}`,
    `freshness_token: ${r.freshness_token}`,
    `generated_at: ${r.generated_at ?? 'null'}`,
    `signed_off_by: ${so?.signed_by ?? 'null'}`,
    `signed_off_date: ${so?.signed_at ?? 'null'}`,
    `signoff_fingerprint: ${so?.fingerprint ?? 'null'}`,
    `signoff_status: ${so?.status ?? 'none'}`,
    '---',
  ];
  if (r.kind === 'release') return `${fm.join('\n')}\n\n${releaseBody(r).join('\n\n')}\n`;
  const bugLines = r.bugs;
  const body = [
    `# QA Readiness — ${r.scope}`,
    '> Generated from the QA ledger — a derived view, never read back. Regenerate with `qa-ledger.mjs readiness render`.',
    `**Verdict: ${r.verdict}**`,
    '## Blockers',
    table(['Blocker', 'Rule', 'Detail', 'Exception'], r.blockers.map((b) => [b.id, b.rule, b.message, b.excepted_by])),
    '## Per-Surface Matrix',
    table(['Surface', 'Candidate build', 'Pinned', 'Smoke', 'Functional (pass / total)', 'Regression'], r.surfaces.map((s) => [s.surface, s.candidate_build, s.pinned ? 'yes' : 'no', s.smoke, s.functional ? `${s.functional.pass + s.functional.excluded} / ${s.functional.total}` : 'n/a', s.regression ? s.regression.map((t) => `${t.build_id}: ${t.summary.pass} pass`).join('; ') || '—' : 'n/a'])),
    '## Smoke',
    table(['Surface', 'Build', 'Status'], r.surfaces.map((s) => [s.surface, s.candidate_build, s.smoke])),
    '## Functional',
    r.kind === 'bug' ? 'Not applicable — a bug scope has no feature plan.' : table(['Surface', 'Pass', 'Fail', 'Blocked', 'Not run', 'Stale', 'Pending', 'Excluded'], r.surfaces.filter((s) => s.functional).map((s) => [s.surface, s.functional.pass, s.functional.fail, s.functional.blocked, s.functional.not_run, s.functional.stale, s.functional.pending, s.functional.excluded])),
    '## Regression',
    r.regression_decision ? `${r.regression_decision.id}: ${r.regression_decision.required ? 'required' : 'not required'} — ${r.regression_decision.reason}` : 'No decision recorded.',
    '## Bugs',
    table(['Bug', 'Severity', 'State', 'Fixed in'], bugLines.map((b) => [b.bug, b.severity, b.state, b.fixed_in_build])),
    '## Retests',
    table(['Bug', 'Build', 'Surface', 'Outcome'], bugLines.flatMap((b) => b.retests.map((t) => [b.bug, t.build_id, t.surface, t.outcome]))),
    '## QA Debt',
    table(['Debt', 'Description', 'Discharged'], r.debt.map((d) => [d.id, d.description, d.discharged ? 'yes' : 'no'])),
    '## Exceptions',
    table(['Exception', 'Item', 'Kind', 'Reason', 'Approved by', 'Date', 'Build', 'Applied'], r.exceptions.map((x) => [x.id, x.item, x.kind, x.reason, x.approved_by, x.date, x.build_id, x.applied ? 'yes' : 'no'])),
    '## Known Issues',
    table(['Item', 'Reason', 'Approved by'], r.known_issues.map((x) => [x.item, x.reason, x.approved_by])),
    '## Tested Builds',
    r.tested_builds.length ? r.tested_builds.map((b) => `- ${b}`).join('\n') : 'None.',
    '## QA Notes',
    so?.notes ?? '—',
    '## Release Notes Input',
    [
      `- Scope: ${r.scope}${r.dev_feature ? ` (Dev feature ${r.dev_feature})` : ''}`,
      `- Bug fixes verified: ${bugLines.filter((b) => b.state === 'closed_verified').map((b) => `${b.bug} (fixed in ${b.fixed_in_build})`).join(', ') || 'none'}`,
      `- Builds tested: ${r.tested_builds.join(', ') || 'none'}`,
      `- Surfaces tested: ${r.surfaces.map((s) => s.surface).join(', ') || 'none'}`,
      `- Known issues: ${r.known_issues.map((x) => `${x.item} — ${x.reason}`).join('; ') || 'none'}`,
      `- Exceptions: ${r.exceptions.filter((x) => x.applied).map((x) => `${x.id} ${x.item} (${x.kind})`).join('; ') || 'none'}`,
      `- QA verdict: ${r.verdict}`,
    ].join('\n'),
  ];
  return `${fm.join('\n')}\n\n${body.join('\n\n')}\n`;
}

// The release artifact: the same contract sections, aggregated from the members. Member
// exception ids are qualified (<member>#EX-n); per-scope detail stays in member artifacts.
function releaseBody(r) {
  const so = r.signoff;
  const applied = r.exceptions;
  const q = (x, v) => `${x.member}#${v}`;
  const seeMembers = 'Per member — see each member scope’s readiness artifact.';
  return [
    `# QA Readiness — ${r.scope}`,
    '> Generated from the QA ledger — a derived view, never read back. Regenerate with `qa-ledger.mjs readiness render`.',
    `**Verdict: ${r.verdict}**`,
    '## Members',
    table(['Scope', 'Kind', 'Dev feature', 'QA bug id', 'External ref', 'Verdict', 'Fingerprint'], r.members.map((m) => [m.scope, m.kind, m.dev_feature, m.qa_bug_id, m.external_ref, m.verdict, m.fingerprint])),
    '## Blockers',
    table(['Blocker', 'Member', 'Rule', 'Detail', 'Exception'], r.blockers.map((b) => [b.id, b.member, b.rule, b.message, b.excepted_by ? q(b, b.excepted_by) : null])),
    '## Per-Surface Matrix',
    table(['Surface', 'Candidate build', 'Pinned', 'Members'], r.surfaces.map((s) => [s.surface, s.candidate_build, s.pinned ? 'yes' : 'no', s.members.join(', ')])),
    '## Smoke',
    seeMembers,
    '## Functional',
    seeMembers,
    '## Regression',
    seeMembers,
    '## Bugs',
    table(['Bug', 'Severity', 'State', 'Fixed in'], r.bugs.map((b) => [b.bug, b.severity, b.state, b.fixed_in_build])),
    '## Retests',
    table(['Bug', 'Build', 'Surface', 'Outcome'], r.bugs.flatMap((b) => b.retests.map((t) => [b.bug, t.build_id, t.surface, t.outcome]))),
    '## QA Debt',
    seeMembers,
    '## Exceptions',
    table(['Exception', 'Item', 'Kind', 'Reason', 'Approved by', 'Date', 'Build', 'Applied'], applied.map((x) => [q(x, x.id), x.item, x.kind, x.reason, x.approved_by, x.date, x.build_id, 'yes'])),
    '## Known Issues',
    table(['Item', 'Reason', 'Approved by'], r.known_issues.map((x) => [q(x, x.item), x.reason, x.approved_by])),
    '## Tested Builds',
    r.tested_builds.length ? r.tested_builds.map((b) => `- ${b}`).join('\n') : 'None.',
    '## QA Notes',
    so?.notes ?? '—',
    '## Release Notes Input',
    [
      `- Scope: ${r.scope}`,
      `- Features tested: ${r.members.filter((m) => m.kind === 'feature').map((m) => (m.dev_feature ? `${m.scope} (Dev feature ${m.dev_feature})` : m.scope)).join(', ') || 'none'}`,
      `- Bug fixes verified: ${r.bugs.filter((b) => b.state === 'closed_verified').map((b) => `${b.bug} (fixed in ${b.fixed_in_build})`).join(', ') || 'none'}`,
      `- Builds tested: ${r.tested_builds.join(', ') || 'none'}`,
      `- Surfaces tested: ${r.surfaces.map((s) => s.surface).join(', ') || 'none'}`,
      `- Known issues: ${r.known_issues.map((x) => `${q(x, x.item)} — ${x.reason}`).join('; ') || 'none'}`,
      `- Exceptions: ${applied.map((x) => `${q(x, x.id)} ${x.item} (${x.kind})`).join('; ') || 'none'}`,
      `- QA verdict: ${r.verdict}`,
    ].join('\n'),
  ];
}
