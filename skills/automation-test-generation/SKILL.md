---
name: automation-test-generation
description: Methodology for converting an approved QA test plan's test cases into Appium/WebdriverIO automation scripts. Used by /generate-automation-scripts via the automation-test-writer agent.
---

## Methodology

1. **One `it()` per test case, named after its plan `id`.** A `test-plan.md` row `TC1`, `EC1`, `EC-U1`, `I18N1`, or `A11Y1` becomes `it('TC1 - <summary>', ...)`. This keeps a generated test traceable back to the exact row that produced it — a failing `TC1` in CI should point straight back to that row in `test-plan.md`.
2. **Locator priority: `testID`/accessibility id first, always.** Search the code repo for the screen's actual React Native component and its `testID` prop (WebdriverIO reads it via `~testID`, the accessibility-id locator strategy). Never write a raw XPath or text-match locator as a first choice — those break on copy changes and layout shifts. If a component genuinely has no `testID`, that's a gap in the app, not something to paper over with a fragile locator: write a `// TODO: needs a stable testID — see <file>` comment in its place and report it, don't guess.
3. **One page object per screen, reused across features.** Before writing a new page object, check `automation/pages/` for one that already covers the screen — most screens are exercised by more than one feature's test plan over time. A page object exposes the screen's elements and simple actions (`login()`, `submit()`); the spec file composes those into a scenario, it doesn't hold raw selectors itself.
4. **WebView steps need an explicit context switch.** This app mixes native RN screens and WebView content. Before any step that interacts with WebView content, switch context (`await driver.switchContext({type: 'WEBVIEW'})` or the current SDK's equivalent) and switch back to `NATIVE_APP` before the next native step. Never assume the previous step's context carries over — get the current context list (`driver.getContexts()`) rather than hardcoding a context name that may vary by session.
5. **Map plan language to code directly, don't paraphrase.** A step like "Tap the 'Continue' button" becomes an action on the element whose visible text/testID corresponds to "Continue" — don't invent an intermediate step the plan didn't describe. An expected result like "the app shows the welcome screen" becomes an assertion on that screen's page object being displayed, not a weaker proxy (e.g. don't assert on a URL or generic loading state finishing when the plan says a specific screen appears).
6. **Edge cases that describe environment conditions, not element interactions, need a setup/teardown, not a locator.** "Network loss" or "app backgrounded" test cases drive the test through WebdriverIO/Appium's device-level APIs (`driver.toggleAirplaneMode()`, `driver.background(seconds)`) rather than a UI step — write these explicitly rather than skipping them as "can't automate."
7. **Don't invent assertions the plan doesn't make.** If a test case's expected result is vague ("the app behaves correctly"), assert only what's actually stated — flag the vagueness in the command's final summary rather than guessing a stronger assertion the plan didn't specify.

## Unchanged constraints

- Never generate a test case not present in the source `test-plan.md` — this skill only translates existing, approved test cases into code, it doesn't design new ones (that's `qa-test-planning`'s job, in Phase 1).
- Never fabricate a locator to make a test "complete" — an honestly flagged gap is more useful than a test that passes against the wrong element.
