---
description: Create or update the QA-authored smoke suite for one surface — product-level cases every build on that surface must pass before deeper QA.
argument-hint: [surface] [--qa-repo=path?]
---

Create or update the smoke suite for the surface in `$ARGUMENTS`, at `<qa-repo-path>/smoke/<surface>/smoke-suite.md`, shaped per `templates/smoke-suite-template.md`. A smoke suite is product-level QA knowledge for one surface, not part of any one feature: every build delivered on that surface is smoke-tested against it once, before functional execution.

**QA authors every smoke case.** Never propose, generate or "suggest" smoke cases yourself — not from Figma, a spec, the code repo, project documentation, or a feature's test plan. The only help offered is listing existing approved test-plan cases the QA engineer may *choose* to reference.

1. Resolve the `surface` id from `$ARGUMENTS` (e.g. `ios`, `android`, `tvos`, `android-tv`, `web`). If it's missing, ask.
2. Resolve the QA repo path — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here. This command only needs the QA repo.
3. If `smoke/<surface>/smoke-suite.md` exists, this is an update: read it in full first and show the human its current cases and Retired IDs.
4. Ask the human once, upfront, in a single pause, for the cases to add, change or remove. For each new case they may either:
   - write it themselves (steps + expected result) — its `source` is `QA-authored`; or
   - reference an existing approved test-plan case: offer the list from `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" plan rows --plan <feature>/test-plan.md --qa-repo "<qa-repo-path>"` for each `*/test-plan.md` in the QA repo whose `status` is `approved`, and copy the chosen row's steps and expected result verbatim, with `source` `<feature>/<id>`.
5. Assign ids as `S<n>`, continuing after the highest id ever used in this suite — including Retired IDs. **Never renumber and never reuse an id**: execution history is keyed by it. A removed case's row is deleted and its id is listed under "Retired IDs" with a one-line reason.
6. Write the suite (frontmatter `surface` must equal the folder name), and append a dated line to its Change Log describing what was added, changed or retired.
7. Run `suite check --suite smoke/<surface>/smoke-suite.md` via the helper. Fix every reported error before finishing — `SURFACE_MISMATCH`, `DUPLICATE_CASE_ID`, `RETIRED_ID_REUSED`, `INVALID_CASE_ID` make the suite unusable for smoke; `UNKNOWN_SOURCE` / `SOURCE_NOT_APPROVED` mean a referenced plan case moved or its plan is no longer approved.
8. Tell the human the suite is ready and that editing it later only affects future smoke runs — smoke already recorded against a build keeps the row it was run against.
9. Never run `git add`/`commit`/`push` in the QA repo — tell the human to review and commit manually.
