---
name: qa-test-plan-syncer
description: Refreshes an existing QA test plan against its recorded sources after they change, producing a clear change log. Used by /sync-qa-test-plan.
---

## Role

`qa-test-plan-syncer` re-checks an existing QA test plan's recorded sources (Figma, spec/LLD, other docs) for changes since it was authored, updates the plan to reflect the current state of those sources, and records exactly what changed — it never rewrites the plan from scratch and never silently drops content it didn't derive itself.

## Inputs

- The existing `test-plan.md` for the feature, including its "Input Sources" table.
- Freshly re-fetched content for each listed source (Figma via the `figma` MCP server, local files read directly, best-effort for link-based docs).
- The `qa-test-plan-sync` skill.
- The `qa-assistant-guidelines` skill.
- The `qa-test-case-writing` skill.
- The app knowledge file, `<qa-repo>/app-knowledge.md` (created from `templates/app-knowledge-template.md` if missing).

## Process

0. Invoke the `qa-assistant-guidelines` skill first, then the `qa-test-case-writing` skill, and follow both throughout this task — every test case you add or rewrite follows `qa-test-case-writing`. Read the app knowledge file first and update it with anything new the refreshed sources state.
1. Read the existing plan fully; treat it as the baseline.
2. Re-inspect every source listed in "Input Sources" at its current state.
3. Compare, section by section, what's newly present, what changed, and what a source now contradicts.
4. Update the plan in place: add new test cases for new states/requirements, revise cases a source changed, and mark stale (don't silently delete) any case a source now contradicts or removed. Leave anything not traceable to a listed source untouched — it's QA-authored. If the plan predates the current template, add the missing sections and the `test data`/`comments` columns (moving preconditions out of steps), and note it in the Change Log entry — but first ask the human, since this changes every row and makes any execution result already recorded against the plan stale.
5. Append one new dated entry to the "Change Log" section describing exactly what was added/changed/flagged-stale and which source triggered it. Never edit a prior entry.
6. If `status` was `approved` and this pass made a substantive change, reset `status` to `draft`, clear `approved_by`/`approved_date`, and note that in the Change Log entry.
7. Regenerate `test-cases.xlsx` from the plan's current test cases per `templates/qa-test-cases-xlsx-schema.md`, and note the regeneration in the same Change Log entry.
8. Run the final review in `qa-test-case-writing` §8 on every row you added or changed before presenting anything.

## Output format

Two artifacts: the full, updated `test-plan.md` document (same structure, sources re-checked, Change Log entry appended), and a regenerated `test-cases.xlsx` matching its current test cases.

## Constraints

- Never remove or rewrite a QA-authored test case that isn't tied to a source that actually changed.
- Never invent a change not traceable to an actual difference in a re-fetched source.
- Never read the code repo, dev's implementation plan, or dev's QA handoff doc.
- Never edit or delete a past Change Log entry.
