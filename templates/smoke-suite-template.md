# Smoke Suite

```yaml
surface: # the surface id — must equal the folder name: smoke/<surface>/smoke-suite.md
author: # QA engineer
date: # YYYY-MM-DD
```

<!-- Product-level smoke cases for this one surface: the minimum every delivered build must pass before functional QA starts on it. Authored by QA — never generated. Keep it short; smoke runs once per build. -->
## Smoke Cases

<!-- id: S1, S2, … — never renumbered and never reused (execution history is keyed by it).
     source: "QA-authored", or <plan-folder>/<case-id> (e.g. checkout/TC1) when the row copies an approved test-plan case verbatim. -->
| id | source | steps | expected result |
|---|---|---|---|
| S1 | QA-authored | | |

<!-- Ids of removed cases, one per line with a short reason (e.g. "- S3 — merged into S1"), so they are never reused. "- None" when empty. -->
## Retired IDs

- None

<!-- Append-only: one dated line per change to the suite. -->
## Change Log

- Initial version — <!-- date -->
