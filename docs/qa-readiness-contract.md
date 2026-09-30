# QA Readiness Contract — Stage 1 boundary

**Status: boundary only.** Stage 1 implements **no** readiness computation, no verdict, no sign-off, and no Release integration. This document fixes what later stages may rely on from the ledger (`docs/qa-ledger-contract.md`), so readiness can be added without reshaping the ledger.

## What a later stage will produce

A QA-owned readiness verdict per scope (`feature:<id>`, `bug:<id>`, `release:<id>`):

| Verdict | Meaning (to be specified by the readiness stage) |
|---|---|
| `READY` | No open blocker |
| `READY_WITH_EXCEPTIONS` | Every blocker is covered by a recorded, human-approved exception or known issue |
| `NOT_READY` | At least one blocker without an exception |

Release will consume this verdict and its evidence, not the Dev QA handoff. Release Notes stay Release-owned; QA supplies evidence and status only.

## What readiness will be derived from

Readiness will be **derived, never stored as authoritative state.** It will be computed deterministically from ledger records only, with no Project Knowledge, no network and no device. Stage 1 already guarantees each of these inputs:

| Future input | Stage-1 ledger source |
|---|---|
| Builds tested, candidate build per surface | Build records and their order |
| Required surfaces and devices | Scope `surfaces` / `devices` context |
| Smoke, functional, regression, re-test, reproduction evidence | Runs by `execution_type`, their state, and effective results |
| Per-case latest result without losing history | `latest-result` / `case-history` derivations |
| Results recorded against an older plan row | `case_ref.row_hash` vs the plan's current row hash |
| Approved plan (feature scopes) | Scope `plans` context plus the plan's own `status` (read-only) |
| QA debt | Scope `debt` context |
| Bugs linked to work | `bug:` scopes, `bug_ref`, result `bug_refs`, scope `result_refs` / `related_scopes` |
| Release contents | `release:` scope `members` |

A standalone bug scope needs no plan; any rule about an approved plan applies to feature scopes only. Automation evidence, when a later stage imports it, is ordinary run evidence (`executor: automation:<tool>`). Automation availability never gates readiness by itself.

## Reserved for later stages

These are **not** in Stage 1. A Stage-1 helper rejects them as `UNKNOWN_EVENT_KIND`:

- regression decisions;
- exceptions / waivers and known issues;
- QA sign-off;
- bug lifecycle events;
- smoke suite definitions and gates.

- They will be added **additively** to schema v1 as new scope record kinds.
- A sign-off will pin a fingerprint of the ledger records the verdict read, so any later record makes the sign-off stale. This reuses the ledger's hashes and adds no second freshness mechanism.
- The readiness artifact path `<qa-repo>/readiness/<scope>.md` is reserved.
