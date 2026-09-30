---
description: Close an open bug as a duplicate or won't-fix — a human decision with a recorded reason. Verified closure only ever comes from a passing re-test.
argument-hint: [bug-id] [duplicate|wont_fix] [--reference=?] [--qa-repo=path?]
---

Close the bug in `$ARGUMENTS` by an explicit human decision. Only two resolutions are recorded this way:

- **duplicate** — the same defect is already tracked (reference the other bug, e.g. `bug:BUG-27`).
- **wont_fix** — the team decided not to fix it (reference the decision, e.g. a product ticket).

There is no way to mark a bug *verified* here: `closed_verified` is reached only through `/retest-bug` passing on every affected surface, and `closed_not_reproducible` only through `/verify-bug`.

All writes go through `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" <command> --qa-repo "<qa-repo-path>" …` (one JSON object per call — branch on `ok` and `error.code`).

1. Resolve the bug id (`bug:<id>`) and resolution from `$ARGUMENTS`.
2. Resolve the QA repo path — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here. This command only needs the QA repo.
3. Run `view bug --bug bug:<id>` and show its current state. A closed bug can't be resolved again (`BUG_CLOSED`).
4. Ask once, upfront, for: who made the decision (a name — never assume it), the reason, and an optional reference. Never decide a duplicate or won't-fix on your own judgment; if the human hasn't made the decision, stop.
5. Record it: `bug resolve --bug bug:<id> --resolution duplicate|wont_fix --reason "…" --by "<name>" [--reference "bug:<other-id>" | "<ticket>"]`. A `bug:` reference must be another existing bug.
6. Show the closed bug (`view bug`) and its regenerated `bugs/<id>/bug.md`.
7. Never write to an external tracker, and never run `git add`/`commit`/`push` in the QA repo — tell the human to review and commit manually.
