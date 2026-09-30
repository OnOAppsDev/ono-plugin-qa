---
feature: # QA feature slug (the plan folder)
qa_scope: # feature:<slug> — the QA ledger scope this report belongs to
qa_feature_path: # <slug>/
dev_feature: # canonical Dev feature id, verbatim from the Task Breakdown
task_breakdown_link: # code-repo path of the Task Breakdown
qa_handoff_link: # code-repo path of the Dev QA handoff (the breakdown's qa_handoff_link)
dev_handoff_source: # same as qa_handoff_link — kept for existing readers
feature_analysis_link: # code-repo path of the Feature Analysis, or null
handoff_status: # ready-for-qa | draft — as read from the handoff
handoff_fingerprint: # sha256 of the handoff content compared against
handoff_draft_override_by: # who approved working from a non-ready handoff, or null
handoff_draft_override_reason: # why, or null
handoff_draft_override_at: # when, or null
platform: # from the Dev chain
device_type: # from the Dev chain
surface: # from the Feature Analysis, or null
capability: # from the Feature Analysis, or null
accessibility_status: # statuses read from the handoff's Accessibility Check
qa_debt_ids: # QA-owned debt ids recorded on the scope from Pending Verification
test_plan_source: # path to the QA test plan compared against
coverage_covered: # number of checklist items marked Covered
coverage_partial: # number marked Partially Covered
coverage_gap: # number marked Gap
possibly_stale: # number of possibly-stale QA test cases flagged
author: # qa-coverage-reviewer / human
date: # YYYY-MM-DD
---

# QA Coverage Report

<!-- 1-2 sentences: which two documents were compared and when, so this report is self-contained if read later. -->
## Comparison Scope

<!-- Every item from the dev handoff's Screens & Flows Touched / Edge Cases / Known Limitations / i18n-RTL Check / Accessibility Check sections, each marked Covered / Partially Covered / Gap, with matching QA test case id(s) if any. The core output of this report. -->
## Coverage Matrix

| dev-documented item | source section | status | matching test case(s) | notes |
|---|---|---|---|---|

<!-- Every item marked Gap above, expanded: what dev documented, why no QA test case covers it, and a suggested test case to add. The actionable "weak spots" list. Use "None found" if empty. -->
## Gaps (Dev-Documented, Not Covered by QA)

<!-- Optional secondary finding: QA test cases referencing something the dev handoff doesn't mention, or that seem to contradict it. Flagged as "verify" — this agent doesn't read code. Use "None found" if empty. -->
## Possibly-Stale QA Test Cases

<!-- One paragraph: how much of the dev-documented behavior is covered, and whether the QA test plan needs updates before test execution starts. -->
## Summary & Recommendation
