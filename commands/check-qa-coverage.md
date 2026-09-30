---
description: Compare a QA test plan against the dev team's completed QA handoff notes to surface untested edge cases.
argument-hint: [feature-name] [dev-handoff-path?] [--breakdown=path?] [--code-repo=path?] [--qa-repo=path?]
---

Compare the QA test plan for the feature in `$ARGUMENTS` against the dev team's completed QA handoff notes for the same feature, once dev has delivered.

The Dev artifacts are found and read through the plugin's helper, `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" <command> --qa-repo "<qa-repo-path>" …`, which prints one JSON object — branch on `ok` and `error.code`. The handoff's current shape, the discovery chain and the ownership rules are documented once, in `docs/dev-handoff-contract.md`. The code repo is only ever read.

1. Resolve `feature-name` from `$ARGUMENTS`, plus an optional handoff path (positional `dev-handoff-path`) and `--breakdown=` path.
2. Resolve the workspace layout to find both the code repo and QA repo paths — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here, **except** the "exactly one repo found" leniency described there is specific to `/create-qa-test-plan`. Here, a missing code repo is always a hard stop — the handoff can't be read without it.
3. Read `<qa-repo-path>/<feature-slug>/test-plan.md` from the resolved QA repo. If it doesn't exist, stop and tell the human to run `/create-qa-test-plan` for this feature first.
4. Check the test plan's `status` field. If it isn't `approved`, stop and tell the human to run `/approve-qa-test-plan` for this feature first — never run the comparison against an unapproved plan.
5. Run `init`, and if `view scope --scope feature:<feature-slug>` returns `UNKNOWN_SCOPE`, create it once the human confirms: `scope create --scope feature:<feature-slug> --created-by "<name>"`.
6. **Resolve the Dev chain deterministically** — Task Breakdown → `qa_handoff_link` → handoff, and Task Breakdown → `feature_analysis_link` → Feature Analysis: `handoff resolve --code-repo "<code-repo-path>" --scope feature:<feature-slug> --feature "<feature-name>" [--breakdown <path>] [--handoff <path>]`. Don't search the repo for the handoff yourself. Ask the human for a path **only** when the helper cannot resolve the chain:
   - `NEED_BREAKDOWN_PATH` — no Task Breakdown, or several, declare this feature. Show `error.details.candidates` and ask which one (or for the path); never pick one yourself. Re-run with `--breakdown`.
   - `NEED_HANDOFF_PATH` — the breakdown has no `qa_handoff_link` yet (dev hasn't run `/create-dev-qa-notes`, or the link wasn't recorded), or the linked file is missing. Ask for the handoff path, or wait for dev. Re-run with `--handoff`.
7. **Bind the handoff to the QA scope**: `handoff ingest --scope feature:<feature-slug> --code-repo "<code-repo-path>" --by "<name>"` with the same `--feature`/`--breakdown`/`--handoff` as step 6. This records the canonical Dev identity (`dev_handoff`), binds the plan, and records every QA-owned Pending Verification entry as QA debt on the scope — idempotently. Stop and explain on:
   - `HANDOFF_NOT_READY` — the handoff is `draft` (or unset), not `ready-for-qa`: dev hasn't signed it off. Stop there by default. Only if the human explicitly wants to work from the draft, re-run with `--override-by "<who approved it>" --override-reason "<why>"` — never on your own initiative. The approval is recorded with who, why and when, and shows in the report.
   - `HANDOFF_CONTRACT_MISMATCH` — the handoff doesn't match the current contract (a section missing, a malformed Pending Verification row); list `error.details.problems` and ask dev to fix the handoff rather than guessing.
   - `IDENTITY_MISMATCH` / `IDENTITY_CONFLICT` — the Dev artifacts disagree about the feature, or this QA scope is already bound to a different Dev feature. Never rebind silently.
8. Show the human, separately: the QA-owned debt now on the scope (`qa_debt`), the accessibility status (`notRecorded` needs QA attention — it is never covered), and the developer-owned context (`developer_context`: Known Limitations and any developer-owned rows) — that context stays developer-owned and is not QA's obligation.
9. Apply the `qa-coverage-analysis` skill methodology via the `qa-coverage-reviewer` agent to compare the two documents section-by-section, treating the dev handoff's section structure in `docs/dev-handoff-contract.md` as a stable contract.
10. Have the agent populate `templates/qa-coverage-report-template.md` in full — every dev-documented screen/flow, edge case, known limitation and pending verification gets an explicit Covered/Partially Covered/Gap verdict; never omit an item to make coverage look more complete than it is. Fill the frontmatter with `coverage_frontmatter` from step 7 verbatim, plus the Covered / Partially Covered / Gap / possibly-stale counts from the matrix, the author and the date.
11. Write (create or overwrite) the report to `<qa-repo-path>/<feature-slug>/coverage-report.md`.
12. Never run `git add`/`commit`/`push` in the QA repo — the QA engineer reviews and commits manually, exactly as in `/create-qa-test-plan`. Never write anything in the code repo.
