# Changelog

All notable changes to this plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
