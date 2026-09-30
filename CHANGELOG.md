# Changelog

All notable changes to this plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- QA ledger foundation (lifecycle Stage 1): `scripts/qa-ledger.mjs`, a zero-dependency helper that is the only writer of `<qa-repo>/qa-ledger/`, plus `docs/qa-ledger-contract.md` and the Stage-1 boundary in `docs/qa-readiness-contract.md`.
  - **Records:** immutable build records; append-only, hash-chained event streams for scopes (`feature:`, standalone `bug:`, `release:`) and execution runs (`smoke`, `functional`, `regression`, `retest`, `reproduction`), with results `pass`/`fail`/`blocked`/`not_run`.
  - **Integrity:** in-run supersession for corrections, frozen terminal runs, referential-integrity validation.
  - **Derived views:** builds, runs, case history, latest result. Nothing derivable is stored.
  - **Test plans:** rows are referenced read-only by `<plan-folder>/<id>` with a row hash. Plans are never rewritten.
  - **Scope:** foundation only. No command, agent, skill or template uses the ledger yet, and every existing flow, the test-plan format and the xlsx export are unchanged.
  - **Tests:** `scripts/qa-ledger.test.mjs` (behavior, including an unchanged-xlsx golden check) and `scripts/qa-ledger.mutation.test.mjs` (each critical invariant disabled in turn must fail its tests).
- Feature execution + smoke (lifecycle Stage 2), on top of the ledger, with no schema change:
  - **Commands:**
    - `/register-build` — an immutable build delivered to QA, tied to its feature scope.
    - `/set-qa-scope` — required surfaces, devices/runtimes per surface, the approved test plan, per-surface exclusions, all QA-entered.
    - `/define-smoke-suite` — a QA-authored, per-surface smoke suite at `smoke/<surface>/smoke-suite.md` with stable `S<n>` ids and retired-id tracking, per the new `templates/smoke-suite-template.md`.
    - `/record-execution` — a manual smoke or functional run, walked case by case and persisted as each answer is given.
  - **Smoke:** runs once per build and surface; FAIL, BLOCKED or NOT_RUN rejects the build for that surface.
  - **Functional:** runs only against an approved plan attached to the scope, on a required surface and a declared device, once smoke passed or QA recorded a scope-specific override with a reason. `validate` re-checks the gate for every functional run.
  - **Results:** a FAIL is only a result, and no bug is created. Results recorded against a plan row that later changed are reported as stale, not current.
  - **Views:** `view smoke`, `view execution` (per-surface cases, pending/stale lists, device coverage, gate), `view run-cases`.
  - **Contract:** two additive scope context fields (`exclusions`, `smoke_overrides`) and the `suite check` helper command.
  - **Internal structure:** the helper is split into internal modules under `scripts/lib/qa-ledger/`. `qa-ledger.mjs` remains the single entry point and the only constructor of the write boundary.
  - **Tests:** `scripts/qa-execution.test.mjs` (25), and mutation tests extended to cover the smoke gates.
  - **Unchanged:** the existing planning commands, test-plan format and xlsx export.
- Bug lifecycle (lifecycle Stage 3), on the same ledger, with no schema change and no second bug store:
  - **Model:** a bug is its `bug:<id>` scope, with additive `bug.reported` / `bug.resolved` records, an optional `fixes_claimed` field on builds, and bug-only context fields (`severity`, `assignee`, `external_ref`, `evidence`, `linked_cases`).
  - **Derived state:** `new`, `verification_blocked`, `assigned`, `fix_delivered`, `reopened`, `closed_verified`, `closed_not_reproducible`, `closed_duplicate`, `closed_wont_fix`, with the next action (`qa_verify` / `dev_fix` / `qa_retest` / none). It is replayed from the reproduction and re-test runs and fix claims, never stored.
  - **Commands:**
    - `/report-bug` — from a FAIL QA chose to report (inherits run, case, build, surface, device and feature; starts with Dev) or as a standalone bug with no feature, plan, spec or Figma (starts `new`).
    - `/verify-bug` — REPRODUCED / NOT_REPRODUCIBLE / BLOCKED on a specific build and surface.
    - `/retest-bug` — only after the fix build passed smoke on that surface (the same Stage 2 per-build gate, or its explicit override). PASS closes only when every affected surface passed on the fix build; FAIL reopens it back to Dev and requires a new fix build; BLOCKED changes nothing. A later fix claim supersedes a pending one, and the superseded build can no longer be re-tested.
    - `/resolve-bug` — duplicate / wont_fix, with a person and a reason.
    - `/register-build --fixes` — a fix claim that never closes a bug by itself.
  - **Bug-owned case:** each bug has its repro / re-test case `bug:<id>#R1`, so standalone bugs need no plan. Links are many-to-many between bugs and test cases.
  - **Views:** `view bug`, `view bugs`, `view case-bugs`, and a regenerated, never-authoritative `bugs/<id>/bug.md`.
  - **Validation:** `validate` replays every transition (`INVALID_TRANSITION`).
  - **No external writes:** trackers are only referenced (`external_ref`).
  - **Smoke runs:** they record only their own suite's cases, so smoke never becomes bug evidence.
  - **Tests:** `scripts/qa-bugs.test.mjs` (39), and mutation tests extended to the bug transitions, the close/reopen guards, the re-test smoke gate and fix-claim supersession.
  - **Unchanged:** feature execution and smoke behavior.
- Dev → QA handoff integration (lifecycle Stage 4). `/check-qa-coverage` now:
  - **Finds the handoff deterministically:** Task Breakdown → `qa_handoff_link`, and Task Breakdown → `feature_analysis_link`. The breakdown is identified by its frontmatter, and the human is asked for a path only on `NEED_BREAKDOWN_PATH` / `NEED_HANDOFF_PATH`. The broken "starts with `# QA Handoff`" search is removed.
  - **Gates on status:** only `ready-for-qa` is accepted, unless a human records an attributed draft override, which is persisted and shown in the report.
  - **Checks the current section contract:** all ten producer sections, including `Build / Install / Testing Instructions` and `Pending Verification (owed to QA)`. This is documented once, in the new `docs/dev-handoff-contract.md`; the coverage agent and skill cite it instead of a stale 8-section list.
  - **Keeps ownership separate:** QA-owned Pending Verification becomes QA debt on the feature scope, and accessibility `notRecorded` needs QA attention (never "covered"). Developer-owned Known Limitations / `VERIFY-4` debt stays developer context.
  - **Binds identity:** the canonical Dev identity (feature, breakdown/handoff/analysis links, platform, device_type, surface, capability, build-instructions reference) is bound to the existing feature scope.
  - **Makes the report machine-linkable:** the coverage report gets delimited frontmatter with that identity; its body and the Covered / Partially Covered / Gap methodology are unchanged.
  - **Ledger changes:** `handoff resolve` / `handoff ingest` helper commands; additive scope fields `dev_handoff`, `handoff_overrides`; optional `why_not_automatable` / `owner` on `debt`.
  - **Read-only on the code repo:** nothing there is ever written.
  - **Tests:** `scripts/qa-handoff.test.mjs` (20), and 10 new mutants.
- Project Knowledge + regression (lifecycle Stage 5), for feature and standalone-bug scopes alike.
  - **Vendored verbatim:** the ecosystem's Project Knowledge contract (`docs/repo-knowledge-contract.md`, from the Inspector) and the Dev plugin's reader (`scripts/vendor/read-repo-knowledge.ts`). They're consumed through one QA module, `scripts/lib/qa-ledger/knowledge.mjs`, with the reader's own trusted / verifyOnUse / deriveLive semantics and no second freshness mechanism.
  - **Capability identity:** by exact id, exact name or source path only. A Stage 4 binding is used as-is, and several matches are never auto-selected.
  - **Candidates:** `regression candidates` lists the capability's first-degree relationships, with evidence always re-checked against the current source. Edges whose evidence fails are dropped from context; there's no transitive expansion and no scoring. Existing QA coverage (bound scopes' plan cases, bug scenarios, generated automation, Project Knowledge test evidence) is shown, or reported as unknown.
  - **`/plan-regression` and `regression decide`:** QA's explicit decision is persisted as `regression_decisions`:
    - required yes/no, never defaulted, always with a reason;
    - every candidate included or excluded with a reason;
    - existing cases from approved plans (or the bug's own `R1`);
    - target builds and surfaces.
  - **Regression runs:** Stage 1 runs of type `regression`, bound to the current decision, only on its targets (no carry-forward to a new build), only through the Stage 2 smoke gate, and only the selected cases. A FAIL stays a FAIL. `view regression` shows the status per target, and `validate` re-checks every regression run.
  - **Planning isolation:** test planning and sync never consume Project Knowledge, and a repo without it plans regression manually.
  - **Tests:** `scripts/qa-regression.test.mjs` (28), and 13 new mutants (first-degree guard, evidence re-check, manual decision, regression smoke gate, selected-case restriction, …).
- QA readiness + sign-off (lifecycle Stage 6), specified in `docs/qa-readiness-contract.md`.
  - **Deterministic verdict:** READY / READY_WITH_EXCEPTIONS / NOT_READY, computed only from the ledger. No Project Knowledge, Dev plugin, release tool or tracker is read.
  - **Rules:** R1 smoke, R2 plan, R3 functional (including stale evidence), R4 bugs (blocking severities critical/major), R5 re-tests, R6 regression decision, R7 regression execution, R8 QA debt, R9 surface coverage. A standalone bug needs no plan. Automation never blocks.
  - **Candidate build:** per surface, the latest smoke-passed build unless QA pins one (`readiness pin` / `unpin`).
  - **Exceptions:** explicit and exact (`readiness except`: blocker id, kind, reason, approver, optional build). Only they make a verdict READY_WITH_EXCEPTIONS.
  - **Debt discharge:** by an effective PASS (`readiness discharge`).
  - **Sign-off:** `/qa-signoff` / `readiness signoff` pins the verdict and a fingerprint over every consumed source record: scope and linked-bug events, consumed runs, builds and plan content, with sign-offs and generated Markdown excluded. It goes stale automatically on any change; `view signoffs` lists validity and every stale sign-off.
  - **Report:** `/qa-readiness` writes the deterministic `readiness/<kind>/<id>.md` report, with frontmatter per the contract and sections from the per-surface matrix to the Release Notes Input.
  - **Release scopes:** only aggregate their members. There is no release artifact and no Release integration.
  - **Ledger changes:** additive, managed context fields `candidate_builds`, `exceptions`, `debt_discharges`, `signoffs`; `MANAGED_FIELD` for a generic write to them.
  - **Tests:** `scripts/qa-readiness.test.mjs` (27), and 24 new mutants (every rule, exception matching, the verdict, fingerprint coverage, sign-off validity).

## [0.7.0] - 2026-08-25

### Added
- `/verify-automation-locators` — replays a generated automation spec's `it()` blocks against a live simulator/device via the new `appium` MCP server (`npx appium-mcp@latest`), through the new `automation-locator-verifier` agent and `appium-live-verification` skill. Checks that each locator actually resolves (and is displayed, not just present) at the point in the flow the spec expects, without running the full WebdriverIO/mocha suite. Misses are categorized as a stale locator, a timing issue, a missed WebView context switch, or a genuine platform limitation no locator can ever fix — never reported as a blanket "broken." Stops immediately if it can't open a live Appium session rather than guessing. Writes `<feature-slug>/automation-verification-report.md`; never edits the generated spec/page objects, never `git add`/`commit`/`push`.
- `appium` MCP server declared in `plugin.json`, alongside `figma`. It's the only piece of this plugin that needs something local and stateful (a reachable Appium install, a booted device) — every other command still works with it entirely absent, and `/generate-automation-scripts` deliberately doesn't depend on it.

## [0.6.0] - 2026-08-17

### Added
- `/generate-automation-scripts` — generates Appium (WebdriverIO) automation from an **approved** test plan's test cases, via the new `automation-test-writer` agent and `automation-test-generation` skill. One `it()` per test-plan `id` (e.g. `TC1`, `EC1`), locators resolved from the code repo's real `testID`s (never fabricated — an unstable/missing one is flagged with a `// TODO` instead of a guessed XPath), page objects reused across features from `automation/pages/`, native/WebView context switching for the app's WebView content. Scaffolds a minimal `automation/` WebdriverIO project on first use, from `templates/automation-project-scaffold/`. Same write discipline as the rest of the plugin: writes local files only, never `git add`/`commit`/`push`.

## [0.5.1] - 2026-08-16

### Fixed
- The `block-qa-repo-git-writes` hook no longer blocks `git commit`/`git push` in **every** repository on the machine merely because this plugin is installed. It matched on the command string alone with no notion of where the command would run, so an unrelated repo (e.g. `ono-mobile-dev-plugin`) could not be committed to while this plugin was enabled. It now resolves the active repository root with `git rev-parse --show-toplevel` and blocks only when that root is a repo this plugin actually touches: the QA repo it writes `test-plan.md` / `coverage-report.md` / `test-cases.xlsx` into, or this plugin's own source repo. Protection inside the QA repo is unchanged, an explicit `git -C <qa-repo>` from outside is still caught, and read-only git commands plus `git add` still pass through everywhere.
- The QA repo is identified the same way the commands resolve it (see "Resolving the workspace" in `commands/create-qa-test-plan.md`): `.claude/qa-workspace.json`'s `qaRepoPath` is authoritative when present, otherwise the documented `qa`-in-the-folder-name convention. The plugin's own repo is identified by the `name` in its `.claude-plugin/plugin.json`, so a differently-named clone is still protected.

### Added
- `hooks/block-qa-repo-git-writes.test.sh` — 24 cases over throwaway temp git repos covering both directions: blocked inside the QA repo (including from a feature subfolder and via `git -C`) and inside the plugin repo, allowed in unrelated repos, in the sibling code repo, and outside any repo; plus cache-authoritative resolution and the folder-name fallback. Run with `bash hooks/block-qa-repo-git-writes.test.sh`.

## [0.5.0] - 2026-07-29

### Added
- `/create-qa-test-plan` now also exports the plan's test cases to a Hebrew/RTL `test-cases.xlsx` file (fixed 6-column schema: Test ID / Summary / Action / Expected Result / Test Data-Parameter / Comments) alongside `test-plan.md`, per the new `templates/qa-test-cases-xlsx-schema.md` contract and the zero-dependency `scripts/build-test-cases-xlsx.mjs` builder. `/sync-qa-test-plan` regenerates it whenever the plan's test cases change.
- `qa-assistant-guidelines` skill — foundational working rules (read source documents in full without skipping, think through the simplest/fastest/safest approach before acting, proofread output before presenting it, never write to a shared destination unless explicitly told to) now invoked first by `qa-test-designer`, `qa-coverage-reviewer`, and `qa-test-plan-syncer`.

## [0.4.0] - 2026-07-21

### Changed
- `/create-qa-test-plan` no longer silently continues or hard-stops when the code repo sibling is missing from the workspace — it now pauses, explains that Phase 1 doesn't need the code repo but `/check-qa-coverage` will, and asks the human whether to continue anyway or stop to complete the workspace first.
- `/check-qa-coverage` now asks the human for the dev QA handoff doc's path/link upfront, mirroring how `/create-qa-test-plan` asks for Figma/spec — it only falls back to searching the code repo for the doc if the human explicitly opts into a search, instead of always searching by default.

## [0.3.0] - 2026-07-07

### Changed
- Renamed the plugin from `ono-plugin-QA-ReactNative` to `ono-plugin-qa` and generalized its description to cover React, React Native, iOS, and Android — the plugin's actual test-planning and coverage-analysis logic has never had any platform-specific assumptions, so this is a branding/naming fix, not a behavior change.
- Updated all references to the companion dev plugin from its old name `ono-react-native-dev-plugin` to its current name `ono-mobile-dev-plugin`.

## [0.2.0] - 2026-07-06

### Added
- `/approve-qa-test-plan` command — marks a test plan `approved`, now required before `/check-qa-coverage` will run.
- `/sync-qa-test-plan` command and `qa-test-plan-syncer` agent — re-checks a test plan's recorded sources for changes and appends a dated change log entry, resetting approval if the change was substantive.
- `--spec=` option on `/create-qa-test-plan` — test plans can now be grounded in a spec/LLD document in addition to or instead of a Figma link (either source skippable with a stated reason), with every source used recorded for later re-checks.

### Changed
- Repo resolution now expects a shared workspace root containing the code repo and QA repo as direct subfolders (auto-detected by git-repo presence and "qa" in the folder name), instead of assuming the QA repo is a filesystem sibling of the code repo — the old assumption broke under Claude Code's sandboxed file access.
- `/check-qa-coverage` now requires the test plan's status to be `approved` before it will run.

## [0.1.0] - 2026-07-06

### Added
- Initial release: two-phase Claude Code plugin for QA, run in parallel with `ono-react-native-dev-plugin`.
- `/create-qa-test-plan` command and `qa-test-designer` agent — authors a QA test plan from a feature's Figma design independent of dev's progress.
- `/check-qa-coverage` command and `qa-coverage-reviewer` agent — diffs the QA test plan against the dev plugin's QA handoff notes to surface untested edge cases.
