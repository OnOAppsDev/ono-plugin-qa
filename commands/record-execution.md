---
description: Record a manual smoke or functional execution against a registered build — PASS / FAIL / BLOCKED / NOT_RUN per case, walked one case at a time.
argument-hint: [feature-name] [smoke|functional] [build-id] [surface] [--device=?] [--os-runtime=?] [--qa-repo=path?]
---

Record an execution for the feature in `$ARGUMENTS` against a registered build on one surface. The QA engineer executes each case by hand; this command walks the cases in a fixed order and persists every answer immediately, so an interrupted session loses nothing. No automation, device connection or Appium session is involved.

All writes go through `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" <command> --qa-repo "<qa-repo-path>" …` (one JSON object per call — branch on `ok` and `error.code`). The helper enforces every rule below; never work around a refusal and never edit `qa-ledger/` by hand.

1. Resolve `feature-name` (slugify it), the execution type (`smoke` or `functional` — the only two this command records), `build-id`, `surface`, and any `--device=` / `--os-runtime=` from `$ARGUMENTS`.
2. Resolve the QA repo path — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here. This command only needs the QA repo.
3. If `view scope --scope feature:<feature-slug>` returns `UNKNOWN_SCOPE` or `LEDGER_NOT_INITIALIZED`, stop and point to `/register-build` and `/set-qa-scope`. If the build isn't registered (`view builds --scope feature:<feature-slug>`), stop and point to `/register-build`.
4. Check the preconditions and explain them before opening anything:
   - **Smoke:** `smoke/<surface>/smoke-suite.md` must exist — if not, stop and point to `/define-smoke-suite <surface>`; never write a suite here. Run `view smoke --build <build-id> --surface <surface>`: smoke runs **once per build and surface**. If it's already `passed`, `failed`, `blocked` or `incomplete`, stop — a rejected build is normally followed by a new build (`/register-build`), never by a second smoke on the same build. If it's `in_progress`, offer to resume that open run (step 7) instead.
   - **Functional:** run `view execution --scope feature:<feature-slug> --surface <surface>`. The surface must be required and the device declared (else point to `/set-qa-scope`), and the plan approved (else `/approve-qa-test-plan`). If the smoke gate for this build is closed, explain the smoke status and the options: run smoke first, register a newer build, or — **only if the human explicitly asks** — record an override with their reason: `scope event --scope feature:<feature-slug> --op add --field smoke_overrides --value '{"build_id":"<build-id>","surface":"<surface>","reason":"<their reason>"}' --by "<name>"`. Never record an override on your own initiative.
5. Ask the human once, upfront, for the executor (their name) and, if not given, the device and runtime — for functional runs, one of the devices declared for this surface in the scope.
6. Open the run:
   - smoke: `run open --type smoke --scope feature:<feature-slug> --build <build-id> --surface <surface> --device "<device>" [--os-runtime "<runtime>"] --executor "<name>" --plan smoke/<surface>/smoke-suite.md`
   - functional: `run open --type functional … --plan <feature-slug>/test-plan.md`
   A refusal (`SMOKE_GATE_CLOSED`, `SMOKE_ALREADY_RECORDED`, `DEVICE_NOT_IN_SCOPE`, `PLAN_NOT_APPROVED`, …) is final for this invocation — explain it and stop.
7. Walk the cases: `view run-cases --run <run-id>` lists them in a fixed order (excluded cases are already left out) with what has been recorded. For each case in `remaining`, show its id, section, steps and expected result from the plan/suite file exactly as written, and ask for **PASS / FAIL / BLOCKED / NOT_RUN**, plus optional notes and evidence references (screenshot/video paths or links). Record it right away: `result add --run <run-id> --case <case_key> --result pass|fail|blocked|not_run [--notes "…"] [--evidence "<ref>"]…`. To correct an answer before the run is closed: `result add … --supersedes <earlier result_id>` — the original stays in history.
   - A **FAIL is only a failed result** — do not create a bug, open a ticket, or write anywhere else. Suggest capturing the observed behavior in `--notes` and evidence.
8. Finish the run:
   - smoke: every suite case needs a result (NOT_RUN counts) before `run close --run <run-id>`; the helper refuses with `SMOKE_INCOMPLETE` otherwise.
   - functional: `run close --run <run-id>` when the human is done — cases not reached stay pending and can be executed in a later run.
   - If the session was invalid (wrong build installed, device failure), `run abort --run <run-id> --reason "…"` instead — an aborted run never counts as evidence.
9. Report with `view smoke --build <build-id> --surface <surface>` (smoke) or `view execution --scope feature:<feature-slug> --surface <surface>` (functional): counts, pending and stale cases, and the smoke gate. Results recorded against a plan row that `/sync-qa-test-plan` later changed show as `stale` — they stay in history but need re-execution.
10. Never run `git add`/`commit`/`push` in the QA repo — tell the human to review the new `qa-ledger/` records and commit them manually.
