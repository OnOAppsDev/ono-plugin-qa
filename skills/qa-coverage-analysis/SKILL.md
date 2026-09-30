---
name: qa-coverage-analysis
description: Methodology for comparing a completed dev QA handoff doc against a QA test plan to find untested edge cases. Used by /check-qa-coverage via the qa-coverage-reviewer agent and the qa-coverage-report template.
---

## Methodology

1. **Treat the dev handoff's section structure as a fixed contract** — the ten sections listed in `docs/dev-handoff-contract.md`, which is the one place this plugin records the producer's current shape (`ono-mobile-dev-plugin`'s `templates/qa-handoff-template.md`). The command has already checked the handoff against it; if a supplied document still doesn't match, say so rather than guessing at its content.
2. **Build the checklist** from Screens & Flows Touched, Edge Cases, Known Limitations, i18n / RTL Check, Accessibility Check and Pending Verification (owed to QA) — plus anything "How to Test" mentions that isn't already listed elsewhere. An Accessibility Check entry recorded as `notRecorded` (or with no recognizable status) is never Covered by default: it is a Gap unless the plan has a matching accessibility test case.
3. **Match each checklist item against the QA test plan** by substance (a paraphrase counts as a match), across Screens & Flows Covered, Functional Test Cases, Edge Cases & Negative Tests, i18n/RTL Test Cases, and Accessibility Test Cases.
4. **Classify** each item Covered / Partially Covered / Gap. A Known Limitation only becomes a gap if it implies behavior QA should actually verify (e.g. a fallback state), not by rote for every limitation — developer-owned items there (e.g. outstanding developer testing, `VERIFY-4`) are the developer's obligation, never a QA gap.
5. **Flag possibly-stale QA test cases** as a secondary, clearly-labeled finding — a test case referencing something the dev handoff never mentions, or that seems to contradict "How to Test". Phrase as "verify" language since this agent never reads the actual code.
6. **Populate `templates/qa-coverage-report-template.md` in full**, with an explicit "None found" for empty sections, and a one-paragraph overall recommendation on whether the QA test plan needs updates before test execution starts.
