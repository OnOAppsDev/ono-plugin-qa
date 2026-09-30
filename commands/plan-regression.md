---
description: Plan regression for a feature or a standalone bug — Project Knowledge suggests direct, evidence-backed candidates; QA decides and the decision is recorded.
argument-hint: [feature-name | bug-id] [--capability=?] [--path=?] [--code-repo=path?] [--qa-repo=path?]
---

Plan regression for the scope in `$ARGUMENTS` — `feature:<slug>` for a feature, `bug:<id>` for a bug (including a standalone bug with no feature or plan). **Project Knowledge suggests; QA decides.** Candidates are context, never scope: nothing is added to regression until QA explicitly includes it, every candidate QA leaves out is excluded with a reason, and Project Knowledge never writes a test-plan case, never runs anything and never decides PASS/FAIL.

All reads and writes go through `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" <command> --qa-repo "<qa-repo-path>" …` (one JSON object per call — branch on `ok` and `error.code`). Project Knowledge is read only through that helper's vendored reader (see `docs/qa-project-knowledge.md`) — never by opening `.ono/` or `docs/project/` yourself.

1. Resolve the scope from `$ARGUMENTS` (a feature name → `feature:<slug>`; a bug id → `bug:<id>`), plus any `--capability=` / `--path=`.
2. Resolve the workspace — see "Resolving the workspace" in `create-qa-test-plan.md`. The code repo is optional here: without it (or without `.ono/repo-knowledge.json` in it) regression is planned manually, which is always allowed.
3. **Capability.** Run `regression candidates --scope <scope> --code-repo "<code-repo-path>"` and read `capability`:
   - A feature already bound by `/check-qa-coverage` (Stage 4) uses that exact capability id (`source: scope`) — no re-matching.
   - `none` → ask the human which capability this is. Look it up by exact id, exact name or a source path: `knowledge lookup --code-repo "<code-repo-path>" --capability "<id or name>"` (or `--path <repo path>`). Never pick one by similarity.
   - `ambiguous` → show the matches and ask; nothing is chosen for them.
   - When the human confirms one, bind it: `scope event --scope <scope> --op set --field capability --value '"<id>"' --by "<name>"`, and re-run `regression candidates`.
   - `unavailable` / `not-in-knowledge` → Project Knowledge can't help; continue manually.
4. **Show the candidates** — first-degree only — with *why* each is related: relationship type, direction, evidence kind and the evidence refs (every one re-checked against the current source). Say plainly that a relationship is not proof of impact, and that `related_to` in particular is only advisory. Show `dropped_relationships` separately: their evidence no longer holds, so they are not current context — QA may still reason about those areas manually. Never look at a candidate's own relationships.
5. **Show existing coverage** per candidate (`existing_coverage`): QA scopes bound to that capability and their plan cases, the bug scenario of bugs bound to it, generated automation, and Project Knowledge test evidence. When `known` is false, say that no coverage is known — don't propose made-up cases. Show `capability_coverage` for the capability under test too.
6. **Ask the human once, upfront, for the decision** — nothing is assumed:
   - regression **required: yes or no**, and the **reason** (always);
   - for each candidate: **include**, or **exclude with a reason**;
   - any other area QA judges related that Project Knowledge didn't suggest (`--candidate <id>`, then include or exclude it);
   - the **existing cases** to run (`--case <plan-folder>/<id>`, from approved plans; for a bug scope also its own `bug:<id>#R1`);
   - the **target build(s) and surface(s)** (`--target <build>@<surface>`).
7. Record it: `regression decide --scope <scope> --code-repo "<code-repo-path>" --required yes|no --reason "…" --by "<name>" [--include <id>]… [--exclude "<id>=<why>"]… [--candidate <id>]… [--case <key>]… [--target <build>@<surface>]…`. It refuses an unaddressed candidate (`UNADDRESSED_CANDIDATE`), an exclusion without a reason, a "not required" decision that still selects cases, a required one without cases or targets, and cases from unapproved plans. A new decision supersedes the previous one; both stay in history (`view regression --scope <scope>`).
8. Tell the human the next step when regression is required: for each target, smoke must have passed on that exact build and surface, then `/record-execution <scope> regression <build> <surface>` runs the selected cases only. Evidence never carries to another build — a new build needs a new decision.
9. Never write test-plan cases here — this command never authors a test plan case from Project Knowledge, and never edits `test-plan.md`. Never run `git add`/`commit`/`push` in the QA repo, and never write to the code repo.
