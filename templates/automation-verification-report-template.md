# Automation Locator Verification Report

```yaml
feature: # feature name
spec_source: # path to the automation spec file verified against
test_plan_source: # path to the QA test plan the spec was generated from
device: # e.g. iPhone 16 / iOS 18.4, from wdio.conf.js capabilities
author: # automation-locator-verifier / human
date: # YYYY-MM-DD
```

<!-- 1-2 sentences: which spec was replayed, against which running app instance, so this report is self-contained if read later. -->
## Verification Scope

<!-- One row per it() replayed. Result is one of: found & displayed / found but hidden / not found / not verifiable via MCP. -->
## Locator Verification Matrix

| test case id | locator(s) checked | result | notes |
|---|---|---|---|

<!-- Every miss (found but hidden / not found), expanded with its root cause category: stale locator, timing, WebView-context, or platform limitation. Use "None found" if empty. -->
## Misses & Root Causes

<!-- Steps that couldn't be replayed via MCP at all — hardware-dependent (biometric prompts, real camera capture) or otherwise outside the MCP server's reach. Not counted as pass or fail. Use "None found" if empty. -->
## Not Verifiable via MCP

<!-- One paragraph: how much of the spec verified cleanly, and what (if anything) needs a human's attention before relying on this suite. -->
## Summary & Recommendation
