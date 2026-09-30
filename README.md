# ono-plugin-qa

A [Claude Code](https://claude.com/claude-code) plugin for the QA team, run in **parallel** with `ono-mobile-dev-plugin`'s dev SDLC pipeline rather than after it. QA authors a test plan grounded in Figma and/or a spec/LLD while dev is still implementing, approves it, keeps it in sync as the design/spec changes, then — once dev delivers their QA handoff notes — checks the approved test plan against what was actually built to surface untested edge cases before test execution starts, can generate Appium automation scripts from the approved test cases, and can verify those scripts' locators against a live simulator/device before ever wiring up the full test runner.

## Relationship to the dev plugin and repos

Each project has two repos: the **code repo** (dev works here; `ono-mobile-dev-plugin` runs here; its `/create-dev-qa-notes` command writes the completed QA handoff doc here) and a separate **QA repo** on Bitbucket (QA has write access; this plugin writes test plans and coverage reports here). **This plugin never commits or pushes to either repo** — the QA engineer always reviews the diff and pushes manually.

## Required setup: a workspace root containing both repos

This plugin needs to read from the code repo and write to the QA repo in the same session, so QA should clone both repos as **direct children of one shared workspace folder**, and launch Claude Code from that workspace root — not from inside either repo individually:

```
qa-workspace/              ← launch `claude` from here
├── ono-app-x/              ← code repo (git)
└── ono-app-x-qa/           ← QA repo (git), name contains "qa"
```

Since the workspace root itself is **not** a git repo, install the plugin **"for me"** rather than "for me and this repo" when prompted — the commands work the same regardless of which folder they're launched from, as long as it's the workspace root described above.

If the plugin is launched from a folder that doesn't match this shape (e.g. from inside a single repo, or a workspace with the wrong number of repos), it stops and asks rather than guessing — see "Resolving the workspace" below.

## Install

From the marketplace:

```
/plugin marketplace add OnOAppsDev/ono-plugin-marketplace
/plugin install ono-plugin-qa@ono-plugin-marketplace
```

Local (for development of the plugin itself):

```bash
claude --plugin-dir /path/to/ono-plugin-qa
```

## Quick start

```
# Run from the workspace root (see "Required setup" above)

# Phase 1 — while dev is implementing
/create-qa-test-plan checkout-redesign https://figma.com/file/... --spec=./checkout-redesign-lld.md
#  → writes ono-app-x-qa/checkout-redesign/test-plan.md (status: draft) and test-cases.xlsx (Hebrew/RTL)

/approve-qa-test-plan checkout-redesign
#  → flips status: approved once you're satisfied with the plan

# If the design/spec changes before dev hands off:
/sync-qa-test-plan checkout-redesign
#  → refreshes test-plan.md against its recorded sources, appends a Change Log entry,
#     and regenerates test-cases.xlsx (resets status to draft if the change was substantive)

# Phase 2 — after dev hands off (dev has run /create-dev-qa-notes)
/check-qa-coverage checkout-redesign
#  → requires test-plan.md's status to be "approved"; writes ono-app-x-qa/checkout-redesign/coverage-report.md

# Once the plan is approved, any time:
/generate-automation-scripts checkout-redesign
#  → writes ono-app-x-qa/automation/tests/checkout-redesign/checkout-redesign.spec.js
#     (scaffolds ono-app-x-qa/automation/ on first use)

# Once you have a booted simulator/device with the app running:
/verify-automation-locators checkout-redesign
#  → writes ono-app-x-qa/checkout-redesign/automation-verification-report.md
#     (needs the appium MCP server + a live app instance; skip if none is up)

# Then: review the diffs in the QA repo yourself and commit/push
```

## Commands

| Command | Arguments | What it does |
|---|---|---|
| `/create-qa-test-plan` | feature name, Figma link (optional), `--spec=` (optional), `--code-repo=`/`--qa-repo=` (optional overrides) | Authors a QA test plan from Figma and/or a spec/LLD, independent of dev's progress |
| `/approve-qa-test-plan` | feature name, `--qa-repo=` (optional override) | Marks a QA test plan `approved`, required before `/check-qa-coverage` and `/generate-automation-scripts` will run |
| `/sync-qa-test-plan` | feature name, `--qa-repo=` (optional override) | Re-checks a test plan's recorded sources for changes and updates it with a dated change log |
| `/check-qa-coverage` | feature name, dev handoff path (optional), `--breakdown=`, `--code-repo=`/`--qa-repo=` (optional overrides) | Compares an **approved** QA test plan against dev's completed QA handoff notes and reports coverage gaps. Finds the handoff deterministically (Task Breakdown → `qa_handoff_link`), accepts only a `ready-for-qa` handoff unless a human approves a draft, and binds the Dev identity and QA-owned Pending Verification into the feature's QA scope (see `docs/dev-handoff-contract.md`) |
| `/generate-automation-scripts` | feature name, `--code-repo=`/`--qa-repo=` (optional overrides) | Generates Appium (WebdriverIO) automation scripts from an **approved** test plan's test cases |
| `/verify-automation-locators` | feature name, `--qa-repo=` (optional override) | Replays a generated spec's locators against a live simulator/device via the `appium` MCP server, no full test-run required |
| `/register-build` | feature name, build id, `--surfaces=`, `--version=`/`--source=` (optional) | Registers a build delivered to QA in the QA ledger — immutable, one record per build |
| `/set-qa-scope` | feature name | Records the feature's required surfaces, devices/runtimes per surface, approved test plan and per-surface exclusions — all QA-entered |
| `/define-smoke-suite` | surface | Creates/updates the QA-authored smoke suite for one surface (`smoke/<surface>/smoke-suite.md`) |
| `/record-execution` | feature name, `smoke`\|`functional`, build id, surface | Walks a manual smoke or functional run case by case, persisting PASS/FAIL/BLOCKED/NOT_RUN — functional only after smoke passes (or an explicit, reasoned override) |
| `/report-bug` | `--from-run=`/`--case=` (a FAIL QA chose to report), or standalone | Creates a bug from a failed execution (already reproduced, with Dev), or an existing standalone bug with no feature/plan/spec/Figma |
| `/verify-bug` | bug id, build id, surface | Records one reproduction attempt: REPRODUCED → Dev, NOT_REPRODUCIBLE → closed, BLOCKED → retry later |
| `/retest-bug` | bug id, build id, surface | Re-tests the fix build: PASS on every affected surface closes the bug; FAIL reopens it back to Dev for a new fix build |
| `/resolve-bug` | bug id, `duplicate`\|`wont_fix` | Closes an open bug by a recorded human decision with a reason |
| `/qa-readiness` | feature name, bug id or `release:<id>` | Computes the deterministic QA verdict — READY / READY_WITH_EXCEPTIONS / NOT_READY — from the ledger, lists every blocker by id, and writes `readiness/<kind>/<id>.md` |
| `/qa-signoff` | feature name or bug id | Signs off the current verdict with its ledger fingerprint; the sign-off goes stale automatically when anything it covered changes |
| `/plan-regression` | feature name or bug id, `--capability=`/`--path=` (optional) | Shows direct, evidence-checked regression candidates from Project Knowledge with existing QA coverage; QA decides (required or not, included/excluded with reasons, cases, target builds) and the decision is recorded. Regression then runs via `/record-execution … regression` |

## Pipeline

| Phase | Command | Skill | Agent |
|---|---|---|---|
| 1. Test planning | `/create-qa-test-plan` | `qa-test-planning` | `qa-test-designer` |
| 1. Approval | `/approve-qa-test-plan` | — (frontmatter edit) | — |
| 1. Sync (as needed) | `/sync-qa-test-plan` | `qa-test-plan-sync` | `qa-test-plan-syncer` |
| 2. Coverage check | `/check-qa-coverage` | `qa-coverage-analysis` | `qa-coverage-reviewer` |
| 3. Automation | `/generate-automation-scripts` | `automation-test-generation` | `automation-test-writer` |
| 3. Live verification (optional, as needed) | `/verify-automation-locators` | `appium-live-verification` | `automation-locator-verifier` |
| 4. Execution (per delivered build) | `/register-build`, `/set-qa-scope`, `/define-smoke-suite`, `/record-execution` | — (helper-driven) | — |
| 5. Bugs (as needed) | `/report-bug`, `/verify-bug`, `/retest-bug`, `/resolve-bug` | — (helper-driven) | — |
| 6. Regression (QA decides) | `/plan-regression`, `/record-execution … regression` | — (helper-driven) | — |
| 7. Readiness + sign-off | `/qa-readiness`, `/qa-signoff` | — (helper-driven) | — |

Phase 1 depends on nothing but a Figma link and/or a spec/LLD doc — it can run the moment a feature is designed/specified, in parallel with dev's implementation. A test plan must be approved via `/approve-qa-test-plan` before Phase 2 will run against it; `/sync-qa-test-plan` can be run any time beforehand (or after) to catch up with design/spec changes, and resets approval if it makes a substantive change. Phase 2 depends on both an approved Phase 1 test plan and the dev plugin's `qa-handoff-template.md` output for the same feature, so it only runs once dev has handed off. `/verify-automation-locators` is a separate, optional follow-up to Phase 3 — unlike every other command here, it needs a live simulator/device with the app running, so `/generate-automation-scripts` itself still works with nothing but the two repos, and this step is only run when someone actually has a device up.

## Resolving the workspace

Both commands resolve the code repo and QA repo paths in this order, stopping to ask if the layout doesn't resolve unambiguously:

1. Explicit `--code-repo=`/`--qa-repo=` paths passed in the command's arguments.
2. `.claude/qa-workspace.json` in the workspace root (current working directory) — a local cache: `{"codeRepoPath": "...", "qaRepoPath": "..."}`.
3. Auto-detect: list the working directory's immediate subdirectories that contain a `.git` folder. If exactly two are found and exactly one has `qa` in its name, that's the QA repo and the other is the code repo — this mapping is then offered to be cached to `.claude/qa-workspace.json`.
4. Otherwise — e.g. the current folder is itself a git repo (wrong launch point), or there aren't exactly two identifiable repos — the command stops, explains what it actually found, and asks the human to clarify which folder is which or to relaunch from the correct workspace root.

Within the QA repo, artifacts are organized per feature: `<feature-slug>/test-plan.md`, `<feature-slug>/test-cases.xlsx`, `<feature-slug>/coverage-report.md`, and `<feature-slug>/automation-verification-report.md`. Generated automation lives at the repo root instead, shared across features: `automation/tests/<feature-slug>/`, `automation/pages/`.

## Safety hooks

One hook is always active while the plugin is installed:

| Hook | What it does |
|---|---|
| `block-qa-repo-git-writes` | Blocks any `git commit`/`git push` run via Bash while this plugin is active. It only ever writes local files (Markdown plans/reports, the Hebrew/RTL `test-cases.xlsx` export) — the QA engineer always reviews and pushes manually. |

## MCP servers

- **`figma`** (`https://mcp.figma.com/mcp`) — the hosted Figma MCP server, used by `/create-qa-test-plan` to inspect the actual screens/states/frames a feature's test plan is grounded in. Each QA engineer authenticates once via OAuth on first use (`/mcp` to check connection status).
- **`appium`** (`npx appium-mcp@latest`, local stdio) — used only by `/verify-automation-locators`. Unlike `figma`, this one is launched locally and needs a reachable Appium install plus a booted simulator/connected device — it has nothing to talk to otherwise. Declared here the same way `figma` is so Claude Code starts it and lists its tools, but every other command in this plugin works with it entirely absent.

## Plugin internals

| Piece | Contents |
|---|---|
| `commands/` | `create-qa-test-plan`, `approve-qa-test-plan`, `sync-qa-test-plan`, `check-qa-coverage`, `generate-automation-scripts`, `verify-automation-locators` |
| `skills/` | `qa-test-planning`, `qa-test-plan-sync`, `qa-coverage-analysis`, `qa-assistant-guidelines`, `automation-test-generation`, `appium-live-verification` |
| `agents/` | `qa-test-designer`, `qa-test-plan-syncer`, `qa-coverage-reviewer`, `automation-test-writer`, `automation-locator-verifier` |
| `templates/` | `qa-test-plan-template.md`, `qa-coverage-report-template.md`, `qa-test-cases-xlsx-schema.md`, `appium-test-spec-template.js`, `automation-project-scaffold/`, `automation-verification-report-template.md` |
| `scripts/` | `build-test-cases-xlsx.mjs` — zero-dependency Node OOXML writer for the Hebrew/RTL Excel export; `qa-ledger.mjs` — the QA ledger helper (see below) |
| `docs/` | `qa-ledger-contract.md`, `qa-readiness-contract.md` — lifecycle contracts |
| `hooks/` | `block-qa-repo-git-writes` |

## QA ledger and execution

`scripts/qa-ledger.mjs` is the groundwork for tracking QA work after a plan exists: builds delivered to QA, the scope they serve (`feature:<slug>`, a standalone `bug:<id>`, or a `release:<id>`), and every execution result recorded against them. It keeps that state as append-only records under `<qa-repo>/qa-ledger/`, alongside the existing per-feature artifacts, and never rewrites a test plan. The existing planning commands never touch it; the execution commands below are its only users. The contract is in [`docs/qa-ledger-contract.md`](docs/qa-ledger-contract.md).

Execution (Phase 4) runs on top of it, per delivered build: `/register-build`, then `/set-qa-scope` (required surfaces, devices, the approved plan, exclusions), a QA-authored smoke suite per surface (`/define-smoke-suite`), then `/record-execution` — smoke first, once per build and surface; functional execution only after smoke passes or QA records an explicit override with a reason. Every result is PASS / FAIL / BLOCKED / NOT_RUN, append-only; a result recorded against a plan row that `/sync-qa-test-plan` later changed shows as stale. Everything is manual — no automation or device connection is needed. A FAIL is only a failed result until QA decides to report it.

Bugs (Phase 5) use the same ledger. A bug is reported either from a FAIL QA chose to report (`/report-bug --from-run … --case …` — it starts with Dev) or as an existing standalone bug with no feature or plan (it starts `new`, and `/verify-bug` reproduces it on a build). Dev's fix arrives as a build registered with `--fixes bug:<id>`; that claim never closes anything. The fix build passes smoke on each surface first — the same per-build gate as feature execution — and then `/retest-bug` decides: PASS on every affected surface closes it as verified, FAIL reopens it and the next step is a new fix build, not another re-test. Duplicates and won't-fix are explicit human decisions (`/resolve-bug`). Each bug's state is derived from the ledger, and `bugs/<id>/bug.md` is a regenerated, read-only view of it; external trackers are referenced (`external_ref`), never written.

Regression (Phase 6) works for features and standalone bugs alike. Project Knowledge (the Inspector's `.ono/repo-knowledge.json`, read through the Dev plugin's reader vendored verbatim) resolves the capability by exact identity and suggests its **direct** neighbours, each with its re-checked evidence and any existing QA coverage. QA decides — required or not, which candidates are in or out and why, which existing cases, which builds — and only that decision runs, only after smoke passed on that build. Test planning never uses Project Knowledge, and a repo without it still plans regression manually. See `docs/qa-project-knowledge.md`.

Readiness (Phase 7) is a pure function of that ledger — nine rules (smoke, plan, functional, bugs, re-tests, regression decision, regression results, QA debt, surface coverage) over each required surface's candidate build (the latest smoke-passed build, unless QA pins one). A blocker is only ever cleared by recording a fact, or by an explicit exception naming it with a reason and an approver; only then is the verdict READY_WITH_EXCEPTIONS. A sign-off pins the verdict's fingerprint over every record it read, so any later change makes it stale automatically. A release scope aggregates its member features and bugs into its own signable artifact, `readiness/release/<id>.md`. Every artifact carries the bug identity (`qa_bug_id`, `external_ref`) a ledger freshness token and an `artifact_integrity` hash, so a release tool can reject a report rendered from an outdated ledger or edited after rendering. See `docs/qa-readiness-contract.md`.

Tests: `node --test scripts/qa-ledger.test.mjs scripts/qa-execution.test.mjs scripts/qa-bugs.test.mjs scripts/qa-handoff.test.mjs scripts/qa-regression.test.mjs scripts/qa-readiness.test.mjs scripts/qa-ledger.mutation.test.mjs`.
