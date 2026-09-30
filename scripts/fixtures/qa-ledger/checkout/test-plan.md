# QA Test Plan

```yaml
feature: checkout
figma_link: https://www.figma.com/file/EXAMPLE/checkout
spec_link: N/A — fixture
author: qa-test-designer
status: approved
approved_by: fixture
approved_date: 2026-09-01
date: 2026-09-01
```

## Feature Summary (from Design)

Fixture plan used by the QA ledger tests. Its content is never rewritten by the ledger helper.

## Input Sources

| type | source | description | date_added |
|---|---|---|---|
| figma | https://www.figma.com/file/EXAMPLE/checkout | checkout frames | 2026-09-01 |
| spec/lld | N/A — fixture | | 2026-09-01 |

## Screens & Flows Covered

- Cart, Payment, Confirmation

## Functional Test Cases

| id | screen/flow | steps | expected result |
|---|---|---|---|
| TC1 | Cart | Open the cart | The cart lists the added items |
| TC14 | Payment | Tap "Pay now" with a valid card | The confirmation screen appears |

## Edge Cases & Negative Tests

### From Design/Spec

| id | screen/flow | steps | expected result |
|---|---|---|---|
| EC1 | Payment | Tap "Pay now" with an expired card | The "Card expired" error is shown |

### Universal

| id | screen/flow | steps | expected result |
|---|---|---|---|
| EC-U1 | Payment | Lose network while paying | A retry message is shown and no charge is made |

## i18n / RTL Test Cases

| id | screen/flow | steps | expected result |
|---|---|---|---|
| I18N1 | Cart | Switch the device to Hebrew | The layout mirrors without truncation |

## Accessibility Test Cases

| id | screen/flow | steps | expected result |
|---|---|---|---|
| A11Y1 | Payment | Navigate with a screen reader | "Pay now" is announced as a button |

## Assumed Test Accounts & Environment

A staging account with a saved card.

## Open Questions / Design Gaps

None.

## Change Log

- Initial version — 2026-09-01
