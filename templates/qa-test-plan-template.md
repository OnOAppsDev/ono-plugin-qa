# QA Test Plan

```yaml
feature: # feature name
figma_link: # Figma file/frame(s) this plan was authored against — or "N/A — <reason>" if this feature has no UI
spec_link: # spec/LLD doc path or link this plan was authored against — or "N/A — <reason>" if none exists
author: # QA engineer / qa-test-designer
status: draft # draft | approved — flip via /approve-qa-test-plan, never hand-edit
approved_by: # set by /approve-qa-test-plan
approved_date: # set by /approve-qa-test-plan, YYYY-MM-DD
date: # YYYY-MM-DD
```

<!-- 2-4 sentences: what this feature does, based on the sources below alone — written before dev has shipped anything, so describe intended behavior, not implementation. -->
## Feature Summary (from Design)

<!-- Every source this plan was actually grounded in: Figma, spec/LLD, and anything else QA supplied. Include an explicit "N/A — <reason>" row for any category that doesn't apply (e.g. no Figma because no UI) rather than omitting it. /sync-qa-test-plan reads this table to know what to re-check when sources change. -->
## Input Sources

| type | source | description | date_added |
|---|---|---|---|
| figma | | | |
| spec/lld | | | |

<!-- Every distinct screen, frame, and state (loading/empty/error/success/permission-prompt/validation) found across the sources above for this feature, with the frame name/link or spec section. /check-qa-coverage matches this against the dev handoff's "Screens & Flows Touched" — keep it complete and specific. -->
## Screens & Flows Covered

<!-- Every test case below follows the qa-test-case-writing skill: steps start with logging in and spell out the full navigation path, preconditions go in "test data" (never in "steps"), expected results are concrete and verifiable, undefined behavior goes in "comments" per its policy. "test data" and "comments" may be empty. -->
<!-- Functional test cases, one ### sub-section per screen/flow in navigation order (with further sub-sections for that screen's popups, drawers and save bar when useful), each naming actual button/label text from the design or behavior from the spec. -->
## Functional Test Cases

### <!-- screen/flow -->

| id | screen/flow | steps | expected result | test data | comments |
|---|---|---|---|---|---|
| TC1 | | | | | |

<!-- Every error screen in the sources, including ones that appear only in Figma: its structure and every button with its destination. -->
## Error Screens

| id | screen/flow | steps | expected result | test data | comments |
|---|---|---|---|---|---|
| ERR1 | | | | | |

<!-- Boundary/negative/error conditions. "From Design/Spec" includes the required cases per data-rule type; "Universal" covers the general edge-case checklist. -->
## Edge Cases & Negative Tests

### From Design/Spec

| id | screen/flow | steps | expected result | test data | comments |
|---|---|---|---|---|---|
| EC1 | | | | | |

### API Failures (Hypothetical)

<!-- One row per screen or action (calls that serve the same screen share a row), with no step that causes the failure. "comments" says: hypothetical, relevant only if call X actually fails. -->
| id | screen/flow | steps | expected result | test data | comments |
|---|---|---|---|---|---|
| API1 | | | | | |

### Universal

| id | screen/flow | steps | expected result | test data | comments |
|---|---|---|---|---|---|
| EC-U1 | | | | | |

<!-- Optional, and always the last test section: include it only when the spec or Figma calls for accessibility, or the human confirmed which accessibility tests to include; otherwise delete this section. Scenario-level checks only, plain language: screen reader label/order, focus order, dynamic font size, color contrast — as testable steps, not standard citations. -->
## Accessibility Test Cases

| id | screen/flow | steps | expected result | test data | comments |
|---|---|---|---|---|---|
| A11Y1 | | | | | |

<!-- Every item of the general edge-case checklist in the qa-test-case-writing skill, each "covered in <id>" or "not relevant because …". No item skipped. -->
## Edge-Case Checklist Report

<!-- What test accounts, environment, feature flags, or seed data this plan assumes will be needed. Authored before dev is done — mark unknowns explicitly. Once dev's handoff exists, its "Test Accounts & Environment" section is the source of truth, not this one. -->
## Assumed Test Accounts & Environment

<!-- Anything the sources above left ambiguous or undesigned that a designer/PM/dev needs to resolve, or any conflict between Figma and the spec/LLD. Do not silently guess or silently pick one source over another. -->
## Open Questions / Design Gaps

<!-- Append-only history of what changed since the initial version. /sync-qa-test-plan appends a new dated entry here each time it updates this plan from refreshed sources — never edit or remove a past entry. -->
## Change Log

- Initial version — <!-- date -->
