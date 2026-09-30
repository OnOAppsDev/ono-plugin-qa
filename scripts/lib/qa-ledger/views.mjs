// Read-only derived views over a loaded ledger model.
// Internal module of scripts/qa-ledger.mjs. Nothing here writes or stores state.
'use strict';

import { fail } from './core.mjs';
import { orderedBuilds, runOrder, scopeBuildIds, requireScope } from './query.mjs';
import { viewSmoke, viewExecution, viewRunCases } from './execution.mjs';

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

export function view(root, model, what, o) {
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
    case 'smoke':
      return viewSmoke(model, o);
    case 'execution':
      return viewExecution(root, model, o);
    case 'run-cases':
      return viewRunCases(root, model, o);
    default:
      fail('UNKNOWN_COMMAND', `unknown view "${what}"`);
  }
}
