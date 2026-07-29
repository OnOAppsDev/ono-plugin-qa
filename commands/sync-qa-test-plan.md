---
description: Refresh a QA test plan against its recorded sources (Figma, spec/LLD, other docs) after they change, with a clear change log.
argument-hint: [feature-name] [--qa-repo=path?]
---

Refresh the QA test plan for the feature in `$ARGUMENTS` against its recorded sources.

1. Resolve `feature-name` from `$ARGUMENTS`.
2. Resolve the QA repo path — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here.
3. Slugify the feature name and read `<qa-repo-path>/<feature-slug>/test-plan.md`. If it doesn't exist, stop and tell the human to run `/create-qa-test-plan` first.
4. Read its "Input Sources" table to get the list of sources to re-check.
5. Re-fetch each source's current state: re-run the relevant `figma` MCP calls for any Figma source, re-read any local file path directly, and best-effort re-fetch any link-based spec/LLD — if a source can't be fetched automatically, ask the human to paste its current content.
6. Apply the `qa-test-plan-sync` skill methodology via the `qa-test-plan-syncer` agent, passing it the existing plan and the freshly re-fetched source content.
7. The agent updates the plan in place and appends a dated "Change Log" entry describing exactly what was added/changed/flagged-stale and which source triggered it — it never removes QA-authored content that isn't tied to a changed source, and never edits a past Change Log entry.
8. If the plan's `status` was `approved` and the agent made a substantive change, it resets `status` to `draft` and clears `approved_by`/`approved_date` — this command runs regardless of the plan's approval status; it does not gate on it.
9. Write the updated document back to `<qa-repo-path>/<feature-slug>/test-plan.md`, and have the agent regenerate `<qa-repo-path>/<feature-slug>/test-cases.xlsx` from the plan's current test cases per `templates/qa-test-cases-xlsx-schema.md`. Never run `git add`/`commit`/`push` in the QA repo — tell the human to review the diff (especially the new Change Log entry, and the regenerated `test-cases.xlsx`) and commit manually. If `status` was reset to `draft`, tell them re-approval via `/approve-qa-test-plan` is needed before `/check-qa-coverage` can run again.
