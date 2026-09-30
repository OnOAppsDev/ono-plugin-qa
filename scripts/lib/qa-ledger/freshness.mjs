// Ledger freshness token — the contract algorithm (docs/qa-readiness-contract.md,
// "Freshness token"). A derivation-free digest over a SUPERSET of the ledger records a
// scope's readiness can depend on, selected by simple header rules only, so a release
// tool can recompute it from the raw ledger without the readiness engine. Any change to
// a record the verdict could read moves it; changes to unrelated scopes, builds and runs
// do not. ono-mobile-dev-plugin's scripts/qa-release-gate.ts implements the same rules;
// shared fixtures keep the two in agreement.
// Internal module of scripts/qa-ledger.mjs. Read-only.
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonical } from './core.mjs';

const sha = (s) => `sha256:${crypto.createHash('sha256').update(s).digest('hex')}`;

function reader(root) {
  const L = path.join(root, 'qa-ledger');
  const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const list = (...d) => {
    const dir = path.join(L, ...d);
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  };
  const stream = (ref) => {
    const i = ref.indexOf(':');
    const f = path.join(L, 'scopes', ref.slice(0, i), `${ref.slice(i + 1)}.jsonl`);
    return fs.existsSync(f) ? lines(f) : null;
  };
  const runs = list('runs').filter((n) => n.endsWith('.jsonl')).map((n) => ({ id: n.slice(0, -6), records: lines(path.join(L, 'runs', n)) }));
  const builds = new Map(list('builds').filter((n) => n.endsWith('.json')).map((n) => [n.slice(0, -5), JSON.parse(fs.readFileSync(path.join(L, 'builds', n), 'utf8'))]));
  const bugRefs = list('scopes', 'bug').filter((n) => n.endsWith('.jsonl')).map((n) => `bug:${n.slice(0, -6)}`);
  return { stream, runs, builds, bugRefs };
}

const planOf = (key) => `${key.slice(0, key.lastIndexOf('/'))}/test-plan.md`;
const addsOf = (records, field) => records.filter((r) => r.kind === 'context.add' && r.field === field).map((r) => r.value);
const ownHashes = (records) => records.filter((r) => r.field !== 'signoffs').map((r) => r.hash); // invariant:freshness-excludes-signoffs

function scopeToken(root, db, ref) {
  const own = db.stream(ref);
  if (!own) return sha(canonical({ scope: ref, missing: true }));
  if (ref.startsWith('release:')) {
    const members = [...new Set(addsOf(own, 'members'))].sort();
    return sha(canonical({ scope: ref, stream: ownHashes(own), members: members.map((m) => [m, scopeToken(root, db, m)]) }));
  }
  // Bugs that reference the scope anywhere, or the bug scope itself.
  const bugs = new Set(ref.startsWith('bug:') ? [ref] : []);
  for (const b of db.bugRefs) {
    const recs = db.stream(b) ?? [];
    if (recs.some((r) => (r.kind === 'bug.reported' && (r.related_scopes ?? []).includes(ref)) || (r.field === 'related_scopes' && r.value === ref))) bugs.add(b); // invariant:freshness-bugs
  }
  const watched = new Set([ref, ...bugs]);
  const header = (run) => run.records[0] ?? {};
  const direct = db.runs.filter((run) => watched.has(header(run).scope) || bugs.has(header(run).bug_ref)); // invariant:freshness-runs
  const builds = new Set(direct.map((run) => header(run).build_id));
  for (const [id, b] of db.builds) if ((b.related_scopes ?? []).includes(ref) || (b.fixes_claimed ?? []).some((x) => bugs.has(x))) builds.add(id); // invariant:freshness-builds
  const smoke = db.runs.filter((run) => header(run).execution_type === 'smoke' && builds.has(header(run).build_id));
  const runs = [...new Map([...direct, ...smoke].map((run) => [run.id, run])).values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const plans = new Set(addsOf(own, 'plans'));
  for (const d of addsOf(own, 'regression_decisions')) for (const k of d.cases ?? []) if (!k.includes('#')) plans.add(planOf(k));
  const planDigest = [...plans].sort().map((p) => {
    const f = path.join(root, p);
    return [p, fs.existsSync(f) ? sha(fs.readFileSync(f)) : 'missing']; // invariant:freshness-plans
  });
  return sha(canonical({
    scope: ref,
    streams: [...watched].sort().map((s) => [s, ownHashes(db.stream(s) ?? [])]),
    runs: runs.map((run) => [run.id, run.records.map((r) => r.hash)]),
    builds: [...builds].sort().map((id) => [id, db.builds.get(id)?.hash ?? 'missing']),
    plans: planDigest,
  }));
}

export function freshnessToken(root, ref) {
  return scopeToken(root, reader(root), ref);
}
