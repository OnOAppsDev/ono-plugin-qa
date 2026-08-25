---
name: appium-live-verification
description: Methodology for verifying a generated Appium spec's locators against a live simulator/device via the appium MCP server, without running the full WebdriverIO suite. Used by /verify-automation-locators via the automation-locator-verifier agent.
---

## Methodology

1. **Confirm a live session before doing anything else.** Try to create/attach an Appium session via the MCP server using the same capabilities already declared in `automation/wdio.conf.js` (bundle id, device name, platform version, automation name). If this fails for any reason — Appium unreachable, no booted simulator, app not installed — stop immediately and say so plainly. Don't proceed partially or guess at what a screen would have shown.
2. **Trace the existing spec, don't re-invent navigation.** Walk the generated spec file's `it()` blocks in order, and for each one, walk the page-object methods it calls. Replay each step as the equivalent MCP tool call (tap by accessibility id, set value, switch context, etc.) in the same sequence the spec already encodes — this agent verifies the path that's already written, it doesn't design a new one.
3. **Existence and visibility are different checks.** A locator can resolve in the element tree while the element itself is hidden (zero opacity, off-screen, covered by another view) — report these separately. A "found but not displayed" result usually points at an app bug or a step-ordering issue, not a bad locator (e.g. this is exactly what "menu hidden over empty state" or "empty-state overlay covering a populated card" look like from the automation's point of view).
4. **On a miss, diagnose before reporting.** Before writing a locator off as broken, check the current context (`NATIVE_APP` vs a `WEBVIEW_*`) and take a screenshot. Categorize every miss as one of:
   - **Wrong/stale locator** — the id in the generated code doesn't match anything currently in the tree (fixable in the spec/page object).
   - **Timing** — the element appears after a delay the generated code didn't wait for (fixable with a wait, not a different locator).
   - **WebView-context issue** — the element is real but lives in a WebView context the code didn't switch into first.
   - **Platform limitation** — no locator will ever resolve this on this platform (e.g. the simulator has no camera; an iOS `PHPickerViewController` grid cell is intentionally not exposed to the accessibility tree at all). This isn't a defect in the generated code — flag it as a permanent limitation, not a TODO.
5. **Never touch the generated automation code.** This agent verifies `automation/tests/` and `automation/pages/`, it doesn't edit them — findings go into a separate report so a human decides what (if anything) to change.
6. **This is not a substitute for running the suite.** It checks that each locator resolves at the point in the flow the spec expects, screen by screen — it doesn't assert outcomes the way `npm test` running the real WebdriverIO/mocha harness does, and it doesn't replace that run.

## Unchanged constraints

- Never mark a step "verified" that couldn't actually be replayed (e.g. a biometric hardware prompt, a real camera capture) — report it as not verifiable via MCP instead of guessing a pass or silently omitting it.
- Never fabricate a fix for a miss — describe the root cause and let a human decide the change, same discipline as `automation-test-generation` never fabricating a locator in the first place.
