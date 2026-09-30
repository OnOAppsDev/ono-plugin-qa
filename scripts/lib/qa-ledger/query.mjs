// Deterministic ordering and lookups over a loaded ledger model.
// Internal module of scripts/qa-ledger.mjs. Read-only.
'use strict';

import { fail, parseScopeRef } from './core.mjs';

// Builds are ordered by registration time, then id — deterministic across machines.
export function orderedBuilds(model) {
  return [...model.builds.values()].sort((a, b) => (a.registered_at < b.registered_at ? -1 : a.registered_at > b.registered_at ? 1 : a.build_id < b.build_id ? -1 : 1));
}
export function runOrder(model) {
  const idx = new Map(orderedBuilds(model).map((b, i) => [b.build_id, i]));
  return [...model.runs.values()].sort((a, b) => {
    const d = idx.get(a.header.build_id) - idx.get(b.header.build_id);
    if (d) return d;
    if (a.header.at !== b.header.at) return a.header.at < b.header.at ? -1 : 1;
    return a.header.run_id < b.header.run_id ? -1 : 1;
  });
}
export function scopeBuildIds(model, scope) {
  const ids = new Set();
  for (const b of model.builds.values()) if (b.related_scopes.includes(scope)) ids.add(b.build_id);
  for (const r of model.runs.values()) if (r.header.scope === scope) ids.add(r.header.build_id);
  return ids;
}

export function requireScope(model, ref) {
  const s = parseScopeRef(ref);
  if (!model.scopes.has(s.ref)) fail('UNKNOWN_SCOPE', `scope ${s.ref} does not exist`);
  return s;
}
export function requireBugScope(model, ref) {
  const s = parseScopeRef(ref);
  if (s.kind !== 'bug') fail('INVALID_BUG_REF', `${ref} is not a bug scope (bug:<id>)`);
  if (!model.scopes.has(s.ref)) fail('UNKNOWN_SCOPE', `bug scope ${s.ref} does not exist`);
  return s.ref;
}
export function findCaseInsensitive(names, name) {
  return names.some((n) => n.toLowerCase() === name.toLowerCase());
}
