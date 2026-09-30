---
description: Compute the deterministic QA readiness of a feature, a standalone bug or a release scope from the QA ledger — READY, READY_WITH_EXCEPTIONS or NOT_READY — and write its readiness report.
argument-hint: [feature-name | bug-id | release:<id>] [--qa-repo=path?]
---

Compute QA readiness for the scope in `$ARGUMENTS`: `feature:<slug>`, `bug:<id>`, or `release:<id>`. A release scope only aggregates its members' readiness.

The verdict is computed by the helper from facts already in the ledger (`docs/qa-readiness-contract.md`). Never judge readiness yourself, and never soften a verdict.

All reads and writes go through `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" <command> --qa-repo "<qa-repo-path>" …`, which prints one JSON object per call; branch on `ok` and `error.code`.

1. Resolve the scope from `$ARGUMENTS`, and resolve the QA repo. See "Resolving the workspace" in `create-qa-test-plan.md`. Only the QA repo is needed: readiness reads nothing else.
2. Run `view readiness --scope <scope>` and show the human:
   - the verdict;
   - the candidate build per surface, and whether it's pinned;
   - each rule's status (R1–R9);
   - every blocker, with its exact id and message.

   For a release scope, show each member's verdict and the aggregated blockers.
3. **Candidate builds.** By default, each surface's candidate is the latest build whose smoke passed. Pin a different one only if the human asks, with their reason:
   - pin: `readiness pin --scope <scope> --surface <s> --build <b> --reason "…" --by "<name>"`;
   - unpin: `readiness unpin --scope <scope> --surface <s> --reason "…" --by "<name>"`.

   Changing the candidate changes the verdict's fingerprint, so any sign-off goes stale.
4. **Blockers are resolved by recording facts, not by editing readiness.** For example:
   - run the missing smoke, functional or regression cases (`/record-execution`);
   - re-test a delivered fix (`/retest-bug`);
   - record the missing regression decision (`/plan-regression`);
   - discharge QA debt with an existing effective PASS from a closed run of this scope: `readiness discharge --scope <scope> --debt <id> --result <result-id> --by "<name>"`.
5. **Exceptions.** Record one only if the human explicitly accepts shipping with a specific blocker. Never propose one to make a verdict look better. An exception names one exact blocker id from step 2, a kind, a reason and the approver:

   `readiness except --scope <scope> --item <blocker-id> --kind known_issue|limitation|waived_regression|waived_debt|waiver --reason "…" --approved-by "<name>" [--build <b>]`

   Only when every blocker is excepted does the verdict become READY_WITH_EXCEPTIONS.
6. Write the report: `readiness render --scope <scope>` writes `readiness/<kind>/<id>.md`. It's a deterministic, derived view with the per-surface matrix, smoke, functional, regression, bugs, re-tests, debt, exceptions, known issues, tested builds, QA notes and Release Notes input. Never edit it by hand. A release scope has no report; its aggregate is shown in step 2 only.
7. Sign-off is a separate, explicit step: `/qa-signoff`.
8. Never run `git add`/`commit`/`push` in the QA repo. Tell the human to review and commit manually.
