---
description: Record a QA sign-off on a scope's current readiness — who, when, notes and the ledger fingerprint; it goes stale automatically when anything it covered changes.
argument-hint: [feature-name | bug-id] [--qa-repo=path?]
---

Record QA sign-off for the scope in `$ARGUMENTS` (`feature:<slug>` or `bug:<id>`).

A sign-off pins the **current** readiness verdict and its ledger fingerprint. When any record that verdict read changes, the sign-off becomes stale by itself; there's nothing to invalidate by hand. Examples of such a change:
- a bug;
- an execution result;
- the scope's context, debt or an exception;
- the regression decision;
- the candidate build;
- a plan row.

All writes go through `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" <command> --qa-repo "<qa-repo-path>" …`.

1. Resolve the scope and the QA repo. See "Resolving the workspace" in `create-qa-test-plan.md`.
2. Run `view readiness --scope <scope>` and show the verdict, blockers and exceptions.
   - A `NOT_READY` scope can't be signed off (`SIGNOFF_NOT_READY`); point to `/qa-readiness`.
   - A release scope can be signed off like any scope, once its aggregated verdict isn't NOT_READY. Its pins, exceptions and debt discharges belong to its members (`RELEASE_AGGREGATION_ONLY`).
3. Ask the human to confirm they are signing off this exact verdict. Ask for their name and optional notes.
4. Record it: `readiness signoff --scope <scope> --by "<name>" [--notes "…"]`. This records the sign-off, with its id, verdict, fingerprint, notes and who, and when (the event time). It also regenerates `readiness/<kind>/<id>.md`.
5. To check later whether a sign-off still holds, run `view signoffs --scope <scope>`. Each sign-off shows as `valid`, `stale` or `superseded`. `view signoffs` without a scope lists every stale sign-off.
6. Never run `git add`/`commit`/`push` in the QA repo. Tell the human to review and commit manually.
