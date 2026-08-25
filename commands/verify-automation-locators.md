---
description: Verify a generated Appium spec's locators against a live simulator/device via the appium MCP server, without running the full WebdriverIO suite.
argument-hint: [feature-name] [--qa-repo=path?]
---

Verify the generated Appium automation for the feature in `$ARGUMENTS` against a live, already-running app instance.

This command needs a booted simulator/connected device with the app already installed — unlike `/generate-automation-scripts`, it can't run with just the two repos. If you don't have one up right now, stop here and come back once you do.

1. Resolve `feature-name` from `$ARGUMENTS`.
2. Resolve the QA repo path — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here. This command doesn't need the code repo.
3. Slugify the feature name and confirm `<qa-repo-path>/automation/tests/<feature-slug>/<feature-slug>.spec.js` exists. If it doesn't, stop and tell the human to run `/generate-automation-scripts` first.
4. Apply the `appium-live-verification` skill via the `automation-locator-verifier` agent. The agent's first move is to try opening a live Appium session through the `appium` MCP server using `<qa-repo-path>/automation/wdio.conf.js`'s capabilities — if that fails (no reachable Appium, no booted device, app not installed), it stops immediately rather than guessing at what would have happened.
5. Have the agent replay the spec's `it()` blocks against the live app, checking that each locator actually resolves at the point the spec expects — not re-running the suite through its own WebdriverIO/mocha harness, just walking the same steps via direct MCP tool calls.
6. Write the findings to `<qa-repo-path>/<feature-slug>/automation-verification-report.md`, shaped per `templates/automation-verification-report-template.md` — every miss categorized as a stale locator, a timing issue, a missed WebView context switch, or a platform limitation no locator can fix.
7. Never edit the generated spec/page-object files, and never run `git add`/`commit`/`push` in the QA repo — the human decides what to do with the findings.

## Resolving the workspace

Same as `create-qa-test-plan.md` — see "Resolving the workspace" there. This command only needs the QA repo to resolve; the code repo is irrelevant here since it isn't read.
