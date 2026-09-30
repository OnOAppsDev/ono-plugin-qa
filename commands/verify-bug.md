---
description: Verify (reproduce) a new or standalone bug on a specific build, surface and device — REPRODUCED, NOT_REPRODUCIBLE or BLOCKED.
argument-hint: [bug-id] [build-id] [surface] [--device=?] [--os-runtime=?] [--qa-repo=path?]
---

Record one reproduction attempt for the bug in `$ARGUMENTS`, before any fix. Every attempt is kept — a BLOCKED attempt never erases anything, and a later attempt is simply added to the history.

All writes go through `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" <command> --qa-repo "<qa-repo-path>" …` (one JSON object per call — branch on `ok` and `error.code`).

1. Resolve the bug id (`bug:<id>`), build id and surface from `$ARGUMENTS`, plus any `--device=` / `--os-runtime=`.
2. Resolve the QA repo path — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here. This command only needs the QA repo.
3. Run `view bug --bug bug:<id>`. Verification is only for a bug whose state is `new` or `verification_blocked`; a bug reported from a failing execution is already reproduced. If it's in any other state, explain its next action instead. The build must be registered (`/register-build`) and ship an affected surface of the bug.
4. Show the human the bug's reproduction steps and expected behavior exactly as recorded, and ask once, upfront, for the executor (their name), the device and runtime, and the outcome after they execute the steps:
   - **REPRODUCED** — the bug happens as described.
   - **NOT_REPRODUCIBLE** — the expected behavior happened; the bug could not be reproduced.
   - **BLOCKED** — the attempt could not be completed (environment down, missing account, build won't install). Ask for a note on why.
   Plus optional notes and evidence references.
5. Record it: `bug verify --bug bug:<id> --build <build-id> --surface <surface> --device "<device>" [--os-runtime "<runtime>"] --executor "<name>" --outcome reproduced|not_reproducible|blocked [--notes "…"] [--evidence "<ref>"]…`. This writes one reproduction run of `bug:<id>#R1`.
6. Tell the human the result:
   - **REPRODUCED** → the bug is **assigned**: next step is a Dev fix, delivered as a new build registered with `/register-build … --fixes bug:<id>`.
   - **NOT_REPRODUCIBLE** → the bug is **closed_not_reproducible**.
   - **BLOCKED** → the bug is **verification_blocked** and can be verified again once unblocked.
7. Never run `git add`/`commit`/`push` in the QA repo — tell the human to review and commit manually.
