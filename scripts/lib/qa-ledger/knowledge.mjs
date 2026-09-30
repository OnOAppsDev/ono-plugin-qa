// Stage 5 — the QA plugin's one Project Knowledge consumer. It runs the reader vendored
// verbatim from ono-mobile-dev-plugin (scripts/vendor/read-repo-knowledge.ts), so
// trusted / verifyOnUse / deriveLive, freshness and evidence re-checks are exactly the
// ecosystem's — see docs/repo-knowledge-contract.md and docs/qa-project-knowledge.md.
//
// Project Knowledge is context: it resolves a capability by deterministic identity and
// suggests its DIRECT neighbours as regression candidates. It never authors test cases,
// never decides scope, never scores, and never looks past the first degree.
// Internal module of scripts/qa-ledger.mjs. Read-only.
'use strict';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlan } from './plans.mjs';
import { bugReport, bugCaseKey } from './bugs.mjs';

export const READER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'read-repo-knowledge.ts');
const NO_COVERAGE = 'No existing QA or automated coverage is known for this capability — QA selects or writes cases manually.';

// Runs the vendored reader. It always prints JSON; if it cannot run at all (e.g. a Node
// without TypeScript stripping), knowledge is simply unavailable — never fatal.
export function readKnowledge(codeRoot, q = {}) {
  if (!codeRoot) return { available: false, reason: 'no-code-repo', summary: 'No code repo given — Project Knowledge not consulted.' };
  const args = ['--no-warnings', READER, codeRoot];
  if (q.capability) args.push('--capability', q.capability);
  for (const p of q.paths ?? []) args.push('--path', p);
  if (q.surface) args.push('--surface', q.surface);
  // QA re-checks every evidence ref it shows against the current source, fresh or not.
  args.push('--verify'); // invariant:always-verify
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { available: false, reason: 'reader-failed', summary: `The Project Knowledge reader could not run (${(r.stderr || '').split('\n')[0] || 'no output'}) — plan manually.` };
  }
}

export function knowledgeSummary(k) {
  return {
    available: Boolean(k.available),
    reason: k.reason ?? null,
    freshness: k.freshness ?? null,
    capabilities: k.extendedCategories?.capabilities?.status ?? 'deriveLive',
    surfaces: k.extendedCategories?.surfaces?.status ?? 'deriveLive',
    summary: k.summary ?? null,
  };
}

// Which capability a query is about. A capability already bound to the scope is looked up
// by exact id only — never re-matched by name or similarity.
export function resolveCapability(k, { bound, explicit, paths }) {
  const lookup = k.query?.capability;
  if (!explicit && !bound && !(paths ?? []).length) return { id: null, source: null, status: 'none' };
  const source = explicit ? 'argument' : bound ? 'scope' : 'path';
  if (!k.available || !lookup || lookup.status === 'derive-live') return { id: explicit ?? bound ?? null, source, status: 'unavailable' };
  if (bound && !explicit) {
    const exact = lookup.matches.find((m) => m.id === bound && m.matchedBy === 'id');
    if (!exact) return { id: bound, source, status: 'not-in-knowledge' };
    if (lookup.matches.length > 1) return { id: bound, source, status: 'ambiguous', matches: lookup.matches };
    return { id: bound, source, status: 'found', matched_by: 'id' };
  }
  if (lookup.status === 'found') return { id: lookup.matches[0].id, source, status: 'found', matched_by: lookup.matches[0].matchedBy };
  return { id: null, source, status: lookup.status, matches: lookup.matches };
}

// The capability's DIRECT relationships, as advisory candidates. Only edges whose
// evidence was re-checked and still holds are shown as context; the rest are dropped
// for QA to reason about manually.
export function directCandidates(k, capId) {
  const ctx = k.query?.capability?.context;
  if (!capId || !ctx || ctx.status !== 'found') return { candidates: [], dropped: [], manual: [] };
  const edges = (k.capabilityRelationships ?? []).filter((e) => e.from === capId || e.to === capId); // invariant:first-degree-only
  const checked = new Map(ctx.relationships.map((r) => [r.id, r]));
  const byOther = new Map();
  const dropped = [];
  for (const e of edges) {
    const rel = checked.get(e.id);
    const other = e.from === capId ? e.to : e.from;
    if (!rel) {
      dropped.push({ id: e.id, type: e.type, other, evidence_status: 'unchecked', reason: 'not in the reader’s first-degree context for this capability' });
      continue;
    }
    if (rel.verification.status !== 'verified') { // invariant:evidence-verified
      dropped.push({ id: e.id, type: e.type, other, evidence_status: rel.verification.status, reason: rel.verification.failed.map((f) => f.reason).join('; ') || 'evidence not re-checked' });
      continue;
    }
    const cand = byOther.get(other) ?? { capability: other, name: rel.other.name, anchor: rel.other.anchor, advisory: true, relationships: [] };
    cand.relationships.push({ id: e.id, type: e.type, direction: rel.direction, evidence_kind: e.evidenceKind, evidence: e.evidence, evidence_status: 'verified' });
    byOther.set(other, cand);
  }
  const droppedIds = new Set(dropped.map((d) => d.id));
  return {
    candidates: [...byOther.values()].sort((a, b) => (a.capability < b.capability ? -1 : 1)),
    dropped: dropped.sort((a, b) => (a.id < b.id ? -1 : 1)),
    manual: (ctx.deriveLive ?? []).filter((id) => !droppedIds.has(id)),
  };
}

// Existing QA coverage for one capability: QA scopes bound to it (their plan cases or the
// bug's own scenario), generated automation for those features, and Project Knowledge
// test evidence. Nothing is invented; an empty result says so.
export function coverageFor(root, model, capId, k) {
  const scopes = [...model.scopes.values()].filter((s) => s.context.capability === capId || s.context.dev_handoff?.capability === capId).sort((a, b) => (a.ref < b.ref ? -1 : 1));
  const qaCases = [];
  const automation = [];
  for (const s of scopes) {
    if (s.kind === 'feature') {
      for (const p of s.context.plans ?? []) {
        try {
          const plan = readPlan(root, p);
          for (const r of plan.rows) qaCases.push({ case_key: r.case_key, plan: plan.plan, plan_status: plan.status, scope: s.ref });
        } catch {
          /* a moved plan is simply not listed */
        }
      }
      const dir = path.join(root, 'automation', 'tests', s.ref.slice('feature:'.length));
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.spec.js')) automation.push(`automation/tests/${s.ref.slice('feature:'.length)}/${f}`);
    }
    if (s.kind === 'bug' && bugReport(s)) qaCases.push({ case_key: bugCaseKey(s.ref), plan: null, plan_status: null, scope: s.ref });
  }
  const pkCap = (k.capabilities ?? []).find((c) => c.id === capId);
  const codeTests = pkCap ? [...pkCap.tests] : [];
  const known = qaCases.length + automation.length + codeTests.length > 0;
  return { known, qa_scopes: scopes.map((s) => s.ref), qa_cases: qaCases, automation, code_tests: codeTests, ...(known ? {} : { note: NO_COVERAGE }) };
}
