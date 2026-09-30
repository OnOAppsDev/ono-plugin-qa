// Stage 2 — feature execution and smoke: the smoke gate, functional-run rules,
// per-surface exclusions, stale-row detection and the operational views built on
// them. Internal module of scripts/qa-ledger.mjs. Read-only: every function here
// either checks a proposed write (and throws) or derives a view from the model.
'use strict';

import { fail } from './core.mjs';
import { readPlan, readSmokeSuite, smokeSuitePath, isSmokePath } from './plans.mjs';
import { orderedBuilds, runOrder, scopeBuildIds, requireScope } from './query.mjs';
import { bugCase, bugCaseKey } from './bugs.mjs';

// ---------- smoke ----------

function smokeOutcome(counts) {
  if (counts.fail) return 'failed';
  if (counts.blocked) return 'blocked';
  if (counts.not_run) return 'incomplete';
  return 'passed';
}

// Smoke status of one (build, surface). Exactly one closed smoke run decides it;
// aborted runs are void; an open run means smoke is in progress.
export function smokeStatus(model, buildId, surface) {
  const runs = runOrder(model).filter((r) => r.header.execution_type === 'smoke' && r.header.build_id === buildId && r.header.surface === surface);
  const closed = runs.find((r) => r.state === 'closed');
  const counts = { pass: 0, fail: 0, blocked: 0, not_run: 0 };
  let status;
  if (closed) {
    for (const res of closed.results) if (res.superseded_by === null) counts[res.result]++;
    status = smokeOutcome(counts);
  } else {
    status = runs.some((r) => r.state === 'open') ? 'in_progress' : 'not_started';
  }
  return {
    status,
    run_id: closed ? closed.header.run_id : null,
    closed_at: closed ? closed.endedAt : null,
    counts,
    history: runs.map((r) => ({ run_id: r.header.run_id, state: r.state, device: r.header.device, executor: r.header.executor, started_at: r.header.at, ended_at: r.endedAt })),
  };
}

// Overrides a scope holds, replayed from its events (optionally only those recorded by `at`).
function activeOverrides(scope, at = null) {
  const active = new Map();
  for (const e of scope.events) {
    if (e.field !== 'smoke_overrides' || (at !== null && e.at > at)) continue;
    if (e.kind === 'context.add') active.set(`${e.value.build_id}@${e.value.surface}`, { ...e.value, by: e.by, at: e.at });
    else if (e.kind === 'context.retract') active.delete(e.value);
  }
  return active;
}

// Whether deeper QA may run for a scope on (build, surface): smoke passed, or the
// scope recorded an explicit override. With `at`, answers as of that moment.
export function gateFor(model, scopeRef, buildId, surface, at = null) {
  const smoke = smokeStatus(model, buildId, surface);
  if (smoke.status === 'passed' && (at === null || smoke.closed_at <= at)) return { open: true, via: 'smoke', build_id: buildId };
  const scope = model.scopes.get(scopeRef);
  const override = scope ? activeOverrides(scope, at).get(`${buildId}@${surface}`) : undefined;
  if (override) return { open: true, via: 'override', build_id: buildId, reason: override.reason };
  return { open: false, via: null, build_id: buildId };
}

// ---------- write-time rules ----------

// The Stage 2 smoke gate for deeper QA on one (build, surface): smoke passed on that
// exact build, or the run's scope holds an explicit override. Functional runs and bug
// re-tests both go through here — there is one gate, never a per-stage copy.
export function requireSmokeGate(model, scopeRef, buildId, surface) {
  const gate = gateFor(model, scopeRef, buildId, surface);
  if (!gate.open) {
    const smoke = smokeStatus(model, buildId, surface).status;
    fail('SMOKE_GATE_CLOSED', `smoke on build ${buildId} / ${surface} is ${smoke} — deeper QA waits for a smoke PASS on this build or an explicit override`, { smoke_status: smoke, build_id: buildId, surface });
  }
  return gate;
}

function resolveDevice(scope, surface, device, osRuntime) {
  const declared = (scope.context.devices ?? []).filter((d) => d.surface === surface && d.device === device);
  const matching = osRuntime ? declared.filter((d) => d.os_runtime === undefined || d.os_runtime === osRuntime) : declared;
  if (!matching.length) fail('DEVICE_NOT_IN_SCOPE', `${device}${osRuntime ? ` (${osRuntime})` : ''} is not a declared ${surface} device for ${scope.ref} — declare it with /set-qa-scope`);
  if (osRuntime) return osRuntime;
  const runtimes = [...new Set(matching.map((d) => d.os_runtime ?? null))];
  if (runtimes.length > 1) fail('AMBIGUOUS_DEVICE', `${device} is declared with several runtimes (${runtimes.join(', ')}) — pass --os-runtime`);
  return runtimes[0];
}

// Stage 2 rules for opening a run, applied after the Stage 1 structural checks.
// Returns the os_runtime to record (functional runs inherit the declared one).
export function checkRunOpen(root, model, scope, build, surface, opts, planRefs) {
  const type = opts.type;
  if (type === 'smoke') {
    if (!planRefs.length) fail('SMOKE_SUITE_REQUIRED', `smoke runs execute the QA-authored suite — pass --plan ${smokeSuitePath(surface)}`);
    if (planRefs.length !== 1 || planRefs[0].plan !== smokeSuitePath(surface)) fail('INVALID_SMOKE_SUITE', `smoke on ${surface} runs exactly ${smokeSuitePath(surface)}`);
    const suite = readSmokeSuite(root, planRefs[0].plan);
    if (suite.structural.length) fail('INVALID_SMOKE_SUITE', `${suite.suite} is not usable — run suite check`, suite.structural);
    const smoke = smokeStatus(model, build.build_id, surface);
    if (smoke.run_id) fail('SMOKE_ALREADY_RECORDED', `build ${build.build_id} already has its smoke run on ${surface} (${smoke.status}) — smoke runs once per build; a rejected build needs a new build`, { smoke_status: smoke.status, run_id: smoke.run_id });
    if (smoke.status === 'in_progress') fail('SMOKE_IN_PROGRESS', `a smoke run for build ${build.build_id} on ${surface} is already open — finish or abort it`);
    // Smoke is product-level, so any device may run it; a declared device still lends its runtime.
    if (opts['os-runtime']) return opts['os-runtime'];
    const runtimes = [...new Set((model.scopes.get(scope.ref).context.devices ?? []).filter((d) => d.surface === surface && d.device === opts.device).map((d) => d.os_runtime ?? null))];
    return runtimes.length === 1 ? runtimes[0] : null;
  }
  for (const p of planRefs) if (isSmokePath(p.plan)) fail('INVALID_VALUE', `${p.plan} is a smoke suite — only smoke runs execute it`);
  if (type !== 'functional') return opts['os-runtime'] ?? null;

  if (scope.kind !== 'feature') fail('FUNCTIONAL_REQUIRES_FEATURE', `functional runs execute a feature's approved test plan — ${scope.ref} is not a feature scope`);
  if (!planRefs.length) fail('PLAN_REQUIRED', 'functional runs need --plan <feature>/test-plan.md');
  const sc = model.scopes.get(scope.ref);
  for (const p of planRefs) {
    if (!(sc.context.plans ?? []).includes(p.plan)) fail('PLAN_NOT_IN_SCOPE', `${p.plan} is not attached to ${scope.ref} — add it with /set-qa-scope`);
    const status = readPlan(root, p.plan).status;
    if (status !== 'approved') fail('PLAN_NOT_APPROVED', `${p.plan} is ${status ?? 'unstamped'} — run /approve-qa-test-plan first`);
  }
  if (!(sc.context.surfaces ?? []).includes(surface)) fail('SURFACE_NOT_IN_SCOPE', `${surface} is not a required surface of ${scope.ref} — set it with /set-qa-scope`);
  const osRuntime = resolveDevice(sc, surface, opts.device, opts['os-runtime']);
  requireSmokeGate(model, scope.ref, build.build_id, surface);
  return osRuntime;
}

export function checkResultAdd(model, run, caseKey) {
  const h = run.header;
  if (h.execution_type === 'smoke' && !caseKey.startsWith(`smoke/${h.surface}/`)) fail('UNKNOWN_CASE', `a smoke run records only its suite's cases (smoke/${h.surface}/S<n>), not ${caseKey}`);
  if (h.execution_type !== 'functional') return;
  const scope = model.scopes.get(h.scope);
  const excluded = (scope.context.exclusions ?? []).find((x) => x.case_key === caseKey && x.surface === h.surface);
  if (excluded) fail('CASE_EXCLUDED', `${caseKey} is excluded on ${h.surface}: ${excluded.reason}`);
}

export function checkRunClose(root, run) {
  const h = run.header;
  if (h.execution_type !== 'smoke') return;
  const suite = readSmokeSuite(root, h.plan_refs[0].plan);
  const done = new Set(run.results.filter((r) => r.superseded_by === null).map((r) => r.case_key));
  const missing = suite.rows.map((r) => r.case_key).filter((k) => !done.has(k));
  if (missing.length) fail('SMOKE_INCOMPLETE', `every smoke case needs a result before close (NOT_RUN counts) — missing ${missing.join(', ')}`, { missing });
}

// Checks a Stage 2 context value against the ledger before it is appended.
export function checkContextValue(root, model, scope, field, value) {
  if (field === 'exclusions') {
    if (!(scope.context.surfaces ?? []).includes(value.surface)) fail('SURFACE_NOT_IN_SCOPE', `${value.surface} is not a required surface of ${scope.ref}`);
    const slash = value.case_key.lastIndexOf('/');
    const prefix = value.case_key.slice(0, slash);
    const plan = (scope.context.plans ?? []).find((p) => p.slice(0, p.lastIndexOf('/')) === prefix);
    const found = plan && readPlan(root, plan).rows.some((r) => r.case_key === value.case_key);
    if (!found) fail('UNKNOWN_CASE', `${value.case_key} is not a case of a plan attached to ${scope.ref}`);
  }
  if (field === 'smoke_overrides') {
    const build = model.builds.get(value.build_id);
    if (!build) fail('UNKNOWN_BUILD', `build ${value.build_id} is not registered`);
    if (!build.surfaces.includes(value.surface)) fail('SURFACE_NOT_IN_BUILD', `build ${value.build_id} does not ship ${value.surface}`);
  }
}

// ---------- validation (post hoc) ----------

// Stage 2 structural checks over the whole ledger, so a hand-written run cannot
// slip past the gate: validate re-derives the gate as of each run's open time.
export function executionErrors(model) {
  const errors = [];
  const closedSmoke = new Map();
  for (const run of model.runs.values()) {
    const h = run.header;
    if (!h || !model.builds.has(h.build_id) || !model.scopes.has(h.scope)) continue;
    if (h.execution_type === 'smoke') {
      if (h.plan_refs.length !== 1 || h.plan_refs[0].plan !== smokeSuitePath(h.surface)) errors.push({ code: 'INVALID_RECORD', where: h.run_id, message: `a smoke run must execute ${smokeSuitePath(h.surface)}` });
      if (run.state === 'closed') {
        const key = `${h.build_id}@${h.surface}`;
        if (closedSmoke.has(key)) errors.push({ code: 'DUPLICATE_SMOKE', where: h.run_id, message: `build ${h.build_id} / ${h.surface} already has smoke run ${closedSmoke.get(key)}` });
        else closedSmoke.set(key, h.run_id);
      }
    }
    if (h.execution_type === 'functional') {
      if (!h.scope.startsWith('feature:') || !h.plan_refs.length) errors.push({ code: 'INVALID_RECORD', where: h.run_id, message: 'a functional run needs a feature scope and a plan' });
      if (!gateFor(model, h.scope, h.build_id, h.surface, h.at).open) errors.push({ code: 'GATE_NOT_HELD', where: h.run_id, message: `opened with the smoke gate closed on ${h.build_id} / ${h.surface}` });
    }
    if (h.execution_type === 'retest' && !gateFor(model, h.scope, h.build_id, h.surface, h.at).open) {
      errors.push({ code: 'GATE_NOT_HELD', where: h.run_id, message: `re-test opened with the smoke gate closed on ${h.build_id} / ${h.surface}` });
    }
  }
  return errors;
}

// ---------- views ----------

export function viewSmoke(model, o) {
  const build = model.builds.get(o.build);
  if (!build) fail('UNKNOWN_BUILD', `build ${o.build} is not registered`);
  if (o.surface && !build.surfaces.includes(o.surface)) fail('SURFACE_NOT_IN_BUILD', `build ${o.build} does not ship ${o.surface}`);
  const surfaces = o.surface ? [o.surface] : build.surfaces;
  return {
    build_id: build.build_id,
    version: build.version,
    surfaces: surfaces.map((surface) => {
      const s = smokeStatus(model, build.build_id, surface);
      const overrides = [];
      for (const scope of model.scopes.values()) {
        const ov = activeOverrides(scope).get(`${build.build_id}@${surface}`);
        if (ov) overrides.push({ scope: scope.ref, reason: ov.reason, by: ov.by });
      }
      return { surface, status: s.status, run_id: s.run_id, counts: s.counts, gate_open: s.status === 'passed', overrides, history: s.history };
    }),
  };
}

function scopeCases(root, scope) {
  const plans = [];
  const cases = [];
  for (const p of scope.context.plans ?? []) {
    let plan;
    try {
      plan = readPlan(root, p);
    } catch {
      plans.push({ plan: p, status: 'missing', fingerprint: null });
      continue;
    }
    plans.push({ plan: plan.plan, status: plan.status, fingerprint: plan.fingerprint });
    for (const r of plan.rows) cases.push({ ...r, plan: plan.plan });
  }
  return { plans, cases };
}

function caseStatus(latest, row) {
  if (!latest) return 'pending';
  if (latest.case_ref.row_hash !== row.row_hash) return 'stale';
  return latest.result;
}

function surfaceView(root, model, scope, surface, required, rows) {
  const buildIds = scopeBuildIds(model, scope.ref);
  const builds = orderedBuilds(model).filter((b) => buildIds.has(b.build_id) && b.surfaces.includes(surface));
  const latestBuild = builds.length ? builds[builds.length - 1].build_id : null;
  const runs = runOrder(model).filter((r) => r.header.scope === scope.ref && r.header.surface === surface);
  const closedFunctional = runs.filter((r) => r.header.execution_type === 'functional' && r.state === 'closed');

  // Latest effective result per case, from closed functional runs of this scope on this surface.
  const latestByCase = new Map();
  for (const run of closedFunctional) {
    for (const r of run.results) if (r.superseded_by === null) latestByCase.set(r.case_key, { run, r });
  }
  const excluded = new Map((scope.context.exclusions ?? []).filter((x) => x.surface === surface).map((x) => [x.case_key, x.reason]));
  const summary = { pass: 0, fail: 0, blocked: 0, not_run: 0, stale: 0, pending: 0, excluded: 0, total: rows.length };
  const cases = rows.map((row) => {
    const hit = latestByCase.get(row.case_key);
    const latest = hit
      ? { result_id: hit.r.result_id, run_id: hit.run.header.run_id, build_id: hit.run.header.build_id, device: hit.run.header.device, os_runtime: hit.run.header.os_runtime, executor: hit.run.header.executor, result: hit.r.result, notes: hit.r.notes, evidence: hit.r.evidence, bug_refs: hit.r.bug_refs, recorded_at: hit.r.at, row_hash: hit.r.case_ref.row_hash, case_ref: hit.r.case_ref }
      : null;
    const status = excluded.has(row.case_key) ? 'excluded' : caseStatus(latest, row);
    summary[status]++;
    const out = { case_key: row.case_key, section: row.section, plan: row.plan, status, current_row_hash: row.row_hash, latest, on_latest_build: latest ? latest.build_id === latestBuild : null };
    if (status === 'excluded') out.exclusion_reason = excluded.get(row.case_key);
    return out;
  });

  const declared = (scope.context.devices ?? []).filter((d) => d.surface === surface);
  const devKey = (device, os) => `${device}\u0000${os ?? ''}`;
  const devices = declared.map((d) => ({ device: d.device, os_runtime: d.os_runtime ?? null, declared: true, functional_results: 0, smoke_runs: 0 }));
  const byKey = new Map(devices.map((d) => [devKey(d.device, d.os_runtime), d]));
  for (const run of runs) {
    const k = devKey(run.header.device, run.header.os_runtime);
    if (!byKey.has(k)) {
      const d = { device: run.header.device, os_runtime: run.header.os_runtime, declared: false, functional_results: 0, smoke_runs: 0 };
      devices.push(d);
      byKey.set(k, d);
    }
    const d = byKey.get(k);
    if (run.state !== 'closed') continue;
    if (run.header.execution_type === 'smoke') d.smoke_runs++;
    if (run.header.execution_type === 'functional') d.functional_results += run.results.filter((r) => r.superseded_by === null).length;
  }

  return {
    surface,
    required,
    latest_build: latestBuild,
    builds: builds.map((b) => ({ build_id: b.build_id, version: b.version, smoke: smokeStatus(model, b.build_id, surface).status })),
    smoke: latestBuild ? (({ history, ...s }) => s)(smokeStatus(model, latestBuild, surface)) : { status: 'no_build', run_id: null },
    gate: latestBuild ? gateFor(model, scope.ref, latestBuild, surface) : { open: false, via: null, build_id: null },
    devices,
    summary,
    pending: cases.filter((c) => c.status === 'pending').map((c) => c.case_key),
    stale: cases.filter((c) => c.status === 'stale').map((c) => c.case_key),
    cases,
  };
}

export function viewExecution(root, model, o) {
  const ref = requireScope(model, o.scope).ref;
  const scope = model.scopes.get(ref);
  const required = scope.context.surfaces ?? [];
  const seen = runOrder(model).filter((r) => r.header.scope === ref).map((r) => r.header.surface);
  const surfaces = o.surface ? [o.surface] : [...required, ...seen.filter((s, i) => !required.includes(s) && seen.indexOf(s) === i)];
  const { plans, cases } = scopeCases(root, scope);
  return {
    scope: ref,
    plans,
    surfaces: surfaces.map((s) => surfaceView(root, model, scope, s, required.includes(s), cases)),
  };
}

export function viewRunCases(root, model, o) {
  const run = model.runs.get(o.run);
  if (!run) fail('UNKNOWN_RUN', `run ${o.run} does not exist`);
  const h = run.header;
  let rows = [];
  if (h.execution_type === 'smoke') rows = readSmokeSuite(root, h.plan_refs[0].plan).rows;
  else for (const p of h.plan_refs) rows.push(...readPlan(root, p.plan).rows);
  for (const ref of h.execution_type === 'smoke' ? [] : [...new Set([h.scope, h.bug_ref].filter(Boolean))]) {
    if (bugCase(model.scopes.get(ref))) rows.push({ case_key: bugCaseKey(ref), section: 'Bug scenario' });
    for (const c of model.scopes.get(ref)?.context.cases ?? []) rows.push({ case_key: `${ref}#${c.id}`, section: 'Scope cases' });
  }
  if (h.execution_type === 'functional') {
    const excluded = new Set((model.scopes.get(h.scope).context.exclusions ?? []).filter((x) => x.surface === h.surface).map((x) => x.case_key));
    rows = rows.filter((r) => !excluded.has(r.case_key));
  }
  const effective = new Map(run.results.filter((r) => r.superseded_by === null).map((r) => [r.case_key, r]));
  const cases = rows.map((r) => ({ case_key: r.case_key, section: r.section, result: effective.get(r.case_key)?.result ?? null, result_id: effective.get(r.case_key)?.result_id ?? null }));
  return { run_id: h.run_id, type: h.execution_type, state: run.state, surface: h.surface, build_id: h.build_id, cases, remaining: cases.filter((c) => c.result === null).map((c) => c.case_key) };
}
