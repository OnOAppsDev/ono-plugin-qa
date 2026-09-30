# QA Readiness Contract — boundary (Stages 1–4)

**Status: boundary only.** Stages 1–4 implement **no** readiness computation, no verdict, no sign-off, and no Release integration. Their views are operational only. This document fixes what later stages may rely on from the ledger (`docs/qa-ledger-contract.md`), so readiness can be added without reshaping the ledger.

## What a later stage will produce

A QA-owned readiness verdict per scope (`feature:<id>`, `bug:<id>`, `release:<id>`):

| Verdict | Meaning (to be specified by the readiness stage) |
|---|---|
| `READY` | No open blocker |
| `READY_WITH_EXCEPTIONS` | Every blocker is covered by a recorded, human-approved exception or known issue |
| `NOT_READY` | At least one blocker without an exception |

Release will consume this verdict and its evidence, not the Dev QA handoff. Release Notes stay Release-owned; QA supplies evidence and status only.

## What readiness will be derived from

Readiness will be **derived, never stored as authoritative state.** It will be computed deterministically from ledger records only, with no Project Knowledge, no network and no device. The ledger already provides each of these inputs:

| Future input | Ledger source |
|---|---|
| Builds tested, candidate build per surface | Build records and their order |
| Smoke per (build, surface) | Stage 2 smoke status (`view smoke`), including any `smoke_overrides` with their reasons |
| Functional evidence per case and surface, including stale evidence | Stage 2 `view execution` (current results, `stale`, `pending`, `excluded`) |
| Required surfaces and devices | Scope `surfaces` / `devices` context |
| Smoke, functional, regression, re-test, reproduction evidence | Runs by `execution_type`, their state, and effective results |
| Per-case latest result without losing history | `latest-result` / `case-history` derivations |
| Results recorded against an older plan row | `case_ref.row_hash` vs the plan's current row hash |
| Approved plan (feature scopes) | Scope `plans` context plus the plan's own `status` (read-only) |
| QA debt | Scope `debt` context — since Stage 4 populated from the Dev handoff's Pending Verification (owed to QA) and accessibility `notRecorded`, QA-owned only (`docs/dev-handoff-contract.md`) |
| Dev handoff sign-off | Scope `dev_handoff.handoff_status`, and any attributed `handoff_overrides` |
| Bugs linked to work | `bug:` scopes, `bug_ref`, result `bug_refs`, scope `result_refs` / `related_scopes` |
| Bug state, severity, open re-tests, fix builds | Stage 3 `view bug` / `view bugs` (derived state, next action, pending re-test surfaces, fixed-in build). Severity is recorded only; which severities block is readiness's decision. |
| Release contents | `release:` scope `members` |

A standalone bug scope needs no plan; any rule about an approved plan applies to feature scopes only. Automation evidence, when a later stage imports it, is ordinary run evidence (`executor: automation:<tool>`). Automation availability never gates readiness by itself.

## Reserved for later stages

These are **not** implemented yet. A current helper rejects them as `UNKNOWN_EVENT_KIND`:

- regression decisions;
- exceptions / waivers and known issues;
- QA sign-off.

- They will be added **additively** to schema v1 as new scope record kinds.
- A sign-off will pin a fingerprint of the ledger records the verdict read, so any later record makes the sign-off stale. This reuses the ledger's hashes and adds no second freshness mechanism.
- The readiness artifact path `<qa-repo>/readiness/<scope>.md` is reserved.

Smoke suites and the smoke gate were reserved here and are now implemented by Stage 2, and bug lifecycle events by Stage 3 (`bug.reported`, `bug.resolved`). See `docs/qa-ledger-contract.md`.
