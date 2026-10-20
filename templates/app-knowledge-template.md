# App Knowledge — <!-- app name -->

<!-- One file per QA repo, at <qa-repo>/app-knowledge.md. Read before writing or syncing test cases; updated as new information arrives (spec, Figma, conversation, bug description). Only what a source states — never extrapolate. Contradictions between sources go under "QA notes" as open items, unresolved. -->

## General
<!-- App name, purpose, target audience, user types/roles and their permissions. -->

## What the tester can control
<!-- Access differs per app. For each backend service, whether the tester can change it in this app and whether that is confirmed (e.g. "Firebase: confirmed — feature flags, Remote Config, sending Push"; "Umbraco: not confirmed"). Ask once when it is not recorded. Rows that need an unconfirmed service get `רלוונטי רק אם יש גישה ל-…` in Comments. Which backend services the tester can change, and how (e.g. "Firebase: feature flags, Remote Config, sending Push"; "Umbraco: CMS content"). Which they cannot (backend DB, API servers, proxy/mock tools). Whether a read-only network logger is available. Failure tests for anything outside this list are hypothetical. -->

## Design
<!-- Visual language, colors, RTL/LTR, typography, recurring UI patterns and components. -->

## Screens & navigation
<!-- Every known screen by its visible title, and the exact navigation path to it from login — reused word for word in every test case, e.g.:
- "מידע אישי": 1. התחבר לחשבון 2. לחץ על התפריט 3. לחץ על "מידע אישי"
-->

## Buttons & UI elements
<!-- What each button, toggle, tab or interactive element does, per screen. -->

## Flows & processes
<!-- End-to-end user journeys. -->

## Functionality
<!-- Feature-by-feature breakdown. -->

## Environment & flags
<!-- Feature flags, remote config, environment-specific behavior, backend dependencies. -->

## QA notes
<!-- Known bugs or quirks, flaky areas, untested flows, edge cases, open questions, Figma–spec discrepancies. -->
