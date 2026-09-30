---
description: Re-test a bug on the build that claims to fix it — PASS closes it once every affected surface passed, FAIL reopens it back to Dev.
argument-hint: [bug-id] [build-id] [surface] [--device=?] [--os-runtime=?] [--qa-repo=path?]
---

Re-test the bug in `$ARGUMENTS` on a build that Dev delivered as its fix. A build claiming a fix never closes a bug by itself — only this re-test does.

All writes go through `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" <command> --qa-repo "<qa-repo-path>" …` (one JSON object per call — branch on `ok` and `error.code`).

1. Resolve the bug id (`bug:<id>`), build id and surface from `$ARGUMENTS`, plus any `--device=` / `--os-runtime=`.
2. Resolve the QA repo path — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here. This command only needs the QA repo.
3. Run `view bug --bug bug:<id>`. A re-test is only possible while the bug is `fix_delivered` — some build was registered with `--fixes bug:<id>` since the last failed fix. Use that build (`current_fix_build`) or a later one, on one of the surfaces in `pending_retest_surfaces`.
   - If the bug is `assigned` or `reopened`, **stop**: the next step is a Dev fix. Re-testing the same failed fix build again is not a new fix cycle — ask Dev for a new build and register it with `/register-build … --fixes bug:<id>`.
   - If it is `new` or `verification_blocked`, it hasn't been reproduced — point to `/verify-bug`.
   - If a **later** build has since claimed the same fix, the earlier fix build is superseded (`FIX_CLAIM_SUPERSEDED`) — re-test the current fix build instead.
4. **Smoke first.** A delivered fix build is re-tested only after that exact build passed smoke on this surface — the same per-build smoke gate as functional execution, whether the bug came from a feature or is standalone. Check `view smoke --build <build-id> --surface <surface>`:
   - `not_started` → run smoke on this build first. For a bug found in a feature, use `/record-execution <feature-name> smoke <build-id> <surface>`. For a standalone bug, walk the same smoke in the bug's scope: `run open --type smoke --scope bug:<id> --build <build-id> --surface <surface> --device "<device>" --executor "<name>" --plan smoke/<surface>/smoke-suite.md`, then record every case from `view run-cases --run <run-id>` with `result add` and `run close`, exactly as steps 7–8 of `/record-execution` describe. Smoke is shared by every scope using the build, and smoke from an earlier build never carries forward.
   - `failed`, `blocked` or `incomplete` → the build is rejected on this surface; the normal way forward is a new fix build. Only if the human explicitly asks, record an override with their reason on the bug scope: `scope event --scope bug:<id> --op add --field smoke_overrides --value '{"build_id":"<build-id>","surface":"<surface>","reason":"<their reason>"}' --by "<name>"` — the smoke result itself stays as recorded. Never override on your own initiative.
5. Show the human the bug's reproduction steps and expected behavior exactly as recorded, and ask once, upfront, for the executor, device and runtime, and the outcome after executing the steps on this build:
   - **PASS** — the expected behavior happens; the bug is gone on this surface.
   - **FAIL** — the bug still happens.
   - **BLOCKED** — the re-test could not be completed; it neither closes nor reopens anything.
   Plus optional notes and evidence references.
6. Record it: `bug retest --bug bug:<id> --build <build-id> --surface <surface> --device "<device>" [--os-runtime "<runtime>"] --executor "<name>" --outcome pass|fail|blocked [--notes "…"] [--evidence "<ref>"]…`.
7. Tell the human the result:
   - **PASS on every affected surface** → **closed_verified**, fixed in the fix build.
   - **PASS on some surfaces** → still `fix_delivered`; list the surfaces that still need a re-test.
   - **FAIL** → **reopened** and back with Dev. The next step is a new fix build — not another re-test of this one.
   - **BLOCKED** → unchanged; re-test again once unblocked.
8. Never run `git add`/`commit`/`push` in the QA repo — tell the human to review and commit manually.
