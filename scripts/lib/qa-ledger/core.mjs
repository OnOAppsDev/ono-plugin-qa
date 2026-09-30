// Shared constants, errors, canonical records and identities for the QA ledger.
// Internal module of scripts/qa-ledger.mjs — see docs/qa-ledger-contract.md.
'use strict';

import crypto from 'node:crypto';

export const SCHEMA = 1;
export const EXECUTION_TYPES = ['smoke', 'functional', 'regression', 'retest', 'reproduction'];
export const RESULTS = ['pass', 'fail', 'blocked', 'not_run'];
export const SCOPE_KINDS = ['feature', 'bug', 'release'];
export const BUG_REF_TYPES = ['retest', 'reproduction'];
export const LEDGER_DIR = 'qa-ledger';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const RUN_ID_RE = /^[a-z]+-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
export const PLAN_ROW_ID_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// ---------- errors ----------

export class LedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export const fail = (code, message, details) => {
  throw new LedgerError(code, message, details);
};

// ---------- canonical records ----------

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
export const sha = (s) => `sha256:${crypto.createHash('sha256').update(s).digest('hex')}`;
export function seal(record) {
  const { hash, ...rest } = record;
  return { ...rest, hash: sha(canonical(rest)) };
}
export function hashOk(record) {
  const { hash, ...rest } = record;
  return typeof hash === 'string' && hash === sha(canonical(rest));
}

export function now() {
  const forced = process.env.QA_LEDGER_NOW;
  if (forced) {
    if (!ISO_RE.test(forced)) fail('INVALID_VALUE', 'QA_LEDGER_NOW must be an ISO-8601 UTC timestamp');
    return forced;
  }
  return new Date().toISOString();
}

// ---------- identities ----------

export function checkId(value, what) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail('INVALID_ID', `${what} "${value}" must match ${ID_RE} (letters, digits, . _ -; no path separators)`);
  }
  return value;
}

export function parseScopeRef(ref) {
  if (typeof ref !== 'string' || !ref.includes(':')) fail('INVALID_SCOPE', `scope "${ref}" must be <kind>:<id>`);
  const i = ref.indexOf(':');
  const kind = ref.slice(0, i);
  const id = ref.slice(i + 1);
  if (!SCOPE_KINDS.includes(kind)) fail('INVALID_SCOPE', `scope kind "${kind}" must be one of ${SCOPE_KINDS.join(', ')}`);
  checkId(id, 'scope id');
  return { kind, id, ref: `${kind}:${id}` };
}

// ---------- value predicates ----------

export const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
export const isIso = (v) => typeof v === 'string' && ISO_RE.test(v);
export function strictObject(v, required, optional = []) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (!required.every((k) => keys.includes(k))) return false;
  return keys.every((k) => required.includes(k) || optional.includes(k));
}
export const uniqueCanon = (arr) => new Set(arr.map(canonical)).size === arr.length;
export const idOk = (v) => typeof v === 'string' && ID_RE.test(v);
