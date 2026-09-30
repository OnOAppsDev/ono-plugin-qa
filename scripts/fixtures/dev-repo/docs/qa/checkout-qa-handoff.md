---
feature: checkout
platform: react-native
device_type: mobile
dd_link: docs/checkout-DD.md
task_breakdown_link: docs/checkout-task-breakdown.md
status: ready-for-qa # draft | ready-for-qa
generated_by: create-dev-qa-notes
date: 2026-09-10
---

# QA Handoff

<!-- Written by /create-dev-qa-notes. The section headings below are a contract. -->

<!-- One paragraph: what was built. -->
## Feature Summary

Checkout lets a signed-in user pay for the cart with a saved card, and retry safely after losing the network.

## How to Test

1. Sign in with the staging account.
2. Add any item and open the cart.
3. Tap "Pay now" with the saved card.

## Test Accounts & Environment

Staging account from the QA vault entry "checkout-staging". Feature flag `checkout_v2` on.

## Edge Cases

- An expired card shows "Card expired".
- Losing the network while paying shows a retry banner and makes no charge.

## Known Limitations

- Apple Pay is out of scope for this change (follow-up task T9).
- Outstanding developer verification: the payment-retry unit test could not run on CI (developer-testing, VERIFY-4, owner: developer).

## Screens & Flows Touched

- Cart
- Payment
- Confirmation

## Build / Install / Testing Instructions

### React Native

Install the internal build from the staging track (build 2.4.0 (103)).

## i18n / RTL Check

I18N-LAYOUT-1 applied; manual LTR/RTL walkthrough performed on the Payment screen.

## Accessibility Check

- T1: applicable — A11Y-LABEL-1 cited; mechanical label check passed.
- T2: notRecorded — the task predates the accessibility contract.

## Pending Verification (owed to QA)

| domain | rule ID | required verification | why the plugin could not perform it | owner |
|---|---|---|---|---|
| accessibility | A11Y-SR-1 | VoiceOver walkthrough of the Payment screen | Needs a screen reader on a real device | qa |
| i18n | I18N-TEST-1 | Manual RTL walkthrough of the Confirmation screen in Hebrew | A visual check on a device | qa |
