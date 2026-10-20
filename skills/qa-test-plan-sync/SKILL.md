---
name: qa-test-plan-sync
description: Methodology for refreshing an existing QA test plan against its recorded sources (Figma, spec/LLD, other docs) after they change, with a clear change log. Used by /sync-qa-test-plan via the qa-test-plan-syncer agent.
---

## Methodology

0. **Read the app knowledge file** (`<qa-repo>/app-knowledge.md`, created from `templates/app-knowledge-template.md` if missing) and keep it updated with anything new the refreshed sources state. Every test case you add or rewrite follows the `qa-test-case-writing` skill.
1. **Read the existing test plan in full**, especially its "Input Sources" table and the current content of every section — this is the baseline to diff against.
2. **Re-inspect each listed source at its current state**: re-run the relevant `figma` MCP calls for any Figma source, re-read any local file path directly, and best-effort re-fetch any link-based spec/LLD. If a source can't be re-fetched automatically, ask the human to paste its current content or share an updated copy rather than assuming nothing changed.
3. **Diff conceptually, section by section** (Screens & Flows Covered, Functional Test Cases, Error Screens, Edge Cases including API Failures, Accessibility when present, Edge-Case Checklist Report, Open Questions): identify what's newly present, what changed, and what a source now contradicts or no longer shows.
4. **Never remove a test case just because it wasn't re-derived.** Only mark something stale or remove it when a refreshed source actively contradicts or removes what it was testing. Anything in the plan that isn't traceable to a source at all is treated as QA-authored and left untouched.
5. **Update the plan in place** with additions/changes, keeping the existing ID scheme. If the plan predates the current template (no Error Screens / API Failures sections, or tables without `test data` and `comments` columns), bring its structure up to the current `templates/qa-test-plan-template.md` — add the missing sections and columns, moving any precondition already written into a row's steps into its test data — and say so in the Change Log entry. This changes every row, so any execution result already recorded against the plan becomes stale and the plan must be run again; before upgrading a plan that has recorded results, ask the human whether to upgrade now or keep the old structure for this sync. Don't reword an existing row otherwise unless its source changed.
5a. **Rows that the current `qa-test-case-writing` rules leave out** (an i18n/RTL section, anything §6.1 lists — device matrices, network cases beyond offline, WebView content and so on) are not removed or marked stale. List them by id in the Change Log entry as "out of scope under the current rules — remove?" and let QA decide; execution results and bugs already recorded may point at those ids.
6. **Append one dated "Change Log" entry** describing exactly what was added, changed, or flagged stale, and which source triggered each change. Never edit or remove a past entry.
7. **If the plan's `status` was `approved` and anything substantive changed**, reset `status` to `draft` and clear `approved_by`/`approved_date`, and say so explicitly in the new Change Log entry so it's clear re-approval is needed. If nothing substantive changed, leave `status` untouched.
8. **Regenerate `test-cases.xlsx`** from the plan's current test cases per `templates/qa-test-cases-xlsx-schema.md`, the same way `qa-test-planning` produces it initially — it's a derived artifact, so rebuild it every sync rather than leaving a stale Hebrew export next to an updated plan. Note in the Change Log entry that the export was regenerated.

## Unchanged constraints

- Never read the code repo, dev's implementation plan, or dev's QA handoff doc.
- Don't invent a change that isn't traceable to an actual difference in a source.
