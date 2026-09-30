```yaml
doc_schema_version: 1
feature: checkout
feature_analysis_link: docs/checkout-feature-analysis.md
source_fingerprint: sha256:0000000000000000000000000000000000000000000000000000000000000000
dd_link: docs/checkout-DD.md
dev_plan_link: docs/checkout-dev-plan.md
qa_handoff_link: docs/qa/checkout-qa-handoff.md
design_reference_status: provided
design_reference_type: figma
design_reference: null
figma_link: https://www.figma.com/file/EXAMPLE/checkout
platform: react-native
device_type: mobile
status: approved
date: 2026-09-05
```

| id | description | platform | files touched | depends-on | size | acceptance criteria |
|---|---|---|---|---|---|---|
| T1 | Pay with a saved card | react-native | `src/features/checkout/PayButton.tsx` | — | M | The confirmation screen appears after a successful payment |
| T2 | Retry after a network loss | react-native | `src/features/checkout/paymentSlice.ts` | T1 | S | A retry banner is shown and no charge is made |
