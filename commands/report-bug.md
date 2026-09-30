---
description: Report a bug — either from a FAIL QA chose to report during execution, or as an existing standalone bug with no feature, plan, spec or Figma.
argument-hint: [--from-run=<run-id> --case=<case-key>] | [standalone] [--id=?] [--external-ref=?] [--qa-repo=path?]
---

Report a bug into the QA ledger. A bug is created **only** because the QA engineer decided to report one — a FAIL is never turned into a bug automatically, and a feature may finish with zero bugs.

All writes go through `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" <command> --qa-repo "<qa-repo-path>" …` (one JSON object per call — branch on `ok` and `error.code`). Never edit `qa-ledger/` or `bugs/` by hand; `bugs/<id>/bug.md` is regenerated from the ledger after every change.

1. Resolve the QA repo path — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here. This command only needs the QA repo. Run `init`.
2. Decide the mode from `$ARGUMENTS`:
   - **From execution** — `--from-run=<run-id>` and `--case=<case-key>` are given (or the human points at a FAIL just recorded by `/record-execution`).
   - **Standalone** — an existing bug entering QA on its own (a customer report, a tracker ticket). It needs **no** feature, test plan, spec or Figma — never create a feature scope or a plan for it.
3. **From execution:** confirm with the human that they want this FAIL reported as a bug. The helper refuses anything that isn't an effective FAIL (`NOT_A_FAILURE`), a result that doesn't exist (`UNKNOWN_RESULT`), or an aborted run (`RUN_ABORTED`). Ask once, upfront, for: a title, the severity, anything to add to the actual behavior (it defaults to the result's notes), extra affected surfaces beyond the one it failed on, other test cases it also breaks (`--linked-case`, repeatable), and an optional external tracker reference. Build, surface, device, feature scope, failing case, reproduction steps and expected result are inherited from the failed result — don't re-ask for them.
   `bug report --from-run <run-id> --case <case-key> --title "…" --severity critical|major|minor|trivial --by "<name>" [--actual "…"] [--surfaces a,b] [--linked-case <key>]… [--external-ref "…"] [--id <id>]`
   The bug starts **assigned** — it was reproduced by the failing execution, so the next step is a Dev fix.
4. **Standalone:** ask once, upfront, for: an id (the external tracker key if there is one — otherwise leave it out and the helper generates a QA-owned `QA-<date>-<hash>` id), title, description, numbered reproduction steps, expected and actual behavior, severity, affected surfaces, optional devices/runtimes, optional build it was found in, optional external reference, and evidence references.
   `bug report --id <id> --title "…" --step "…" --step "…" --expected "…" --actual "…" --severity <severity> --surfaces <a,b> --by "<name>" [--description "…"] [--affected-device "<surface>|<device>|<runtime>"]… [--found-in-build <build>] [--external-ref "…"] [--evidence "<ref>"]…`
   The bug starts **new** — QA verifies it next with `/verify-bug`. Its steps and expected result become its own repro / re-test scenario, `bug:<id>#R1`; no test plan is written.
5. Severity is recorded exactly as the human chose: `critical`, `major`, `minor` or `trivial`. It does not decide anything in this stage.
6. The external reference is only stored. Never create, update or comment on a ticket in Jira or any other tracker unless the human explicitly asks for that specific write.
7. Show the human the new bug (`view bug --bug bug:<id>`): state, next action and `bugs/<id>/bug.md`.
8. Never run `git add`/`commit`/`push` in the QA repo — tell the human to review and commit manually.
