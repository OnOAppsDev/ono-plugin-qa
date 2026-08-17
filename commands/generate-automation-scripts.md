---
description: Generate Appium (WebdriverIO) automation scripts from an approved QA test plan's test cases.
argument-hint: [feature-name] [--code-repo=path?] [--qa-repo=path?]
---

Generate Appium automation scripts for the feature in `$ARGUMENTS`, from its already-approved QA test plan.

1. Resolve `feature-name` from `$ARGUMENTS`.
2. Resolve the code repo and QA repo paths — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here.
3. Slugify the feature name and read `<qa-repo-path>/<feature-slug>/test-plan.md`. If it doesn't exist, stop and tell the human to run `/create-qa-test-plan` first.
4. Require `status: approved`. If it's still `draft`, stop and tell the human to run `/approve-qa-test-plan` first — automation is generated against a reviewed, stable set of test cases, not one still under revision.
5. If `<qa-repo-path>/automation/` doesn't exist yet, scaffold it once from `templates/automation-project-scaffold/` (a minimal WebdriverIO + Appium project: `package.json`, `wdio.conf.js`, a `pages/BasePage.js`). If it already exists, leave it as-is and build on top of it.
6. Apply the `automation-test-generation` skill via the `automation-test-writer` agent, passing it the feature slug, every test case in `test-plan.md` (Functional, Edge Cases, i18n/RTL, Accessibility), and read access to the code repo for locating real element identifiers.
7. If `<qa-repo-path>/automation/tests/<feature-slug>/` already contains spec files, ask the human before overwriting — never silently clobber existing automation for this feature. Offer to regenerate only the test cases whose `id` isn't yet covered.
8. Have the agent write one spec file per feature (`<qa-repo-path>/automation/tests/<feature-slug>/<feature-slug>.spec.js`), shaped per `templates/appium-test-spec-template.js`, with one `it()` per test case named after its `id` from `test-plan.md` (e.g. `TC1`, `EC1`, `I18N1`) — this keeps generated tests traceable back to the plan. New or reused page objects go in `<qa-repo-path>/automation/pages/`.
9. Never run `git add`/`commit`/`push` in the QA repo. Tell the human what was written, which test cases (if any) were skipped for lacking a stable element identifier in the code repo (flagged inline in the spec as `// TODO: needs a stable testID — see <screen/component>`), and that first run requires `npm install` inside `automation/` and a connected device/emulator (or Appium capability) configured in `wdio.conf.js`.

## Resolving the workspace

Same as `create-qa-test-plan.md` — see "Resolving the workspace" there. This command additionally requires the code repo (not leniently optional, unlike Phase 1): locating real element identifiers means reading the app's source, so if only the QA repo resolves, stop and ask the human to complete the workspace first.
