# Dev → QA Handoff Contract (consumer side)

**Producer:** `ono-mobile-dev-plugin`, verified against its `origin/main` at `9472f43`:
- `templates/qa-handoff-template.md`
- `templates/task-breakdown-template.md`
- `templates/feature-analysis-template.md`
- `commands/create-dev-qa-notes.md`
- `standards/shared/qa-handoff.md` (`QA-FILE-1`, `QA-LINK-1`, `QA-A11Y-1..3`)
- `standards/shared/verification.md` (`VERIFY-3`, `VERIFY-4`)
- `docs/planning-doc-contract.md` (frontmatter encodings)

**Consumer:** this plugin's `/check-qa-coverage`, through `scripts/qa-ledger.mjs handoff resolve|ingest` (`scripts/lib/qa-ledger/handoff.mjs`).

This is the **one** place in this plugin that lists the handoff's shape. The coverage agent and skill cite it; they don't restate it. When the producer changes its template, change this file and `HANDOFF_SECTIONS` in `handoff.mjs` together.

**Read-only:** everything below lives in the code repo. The QA plugin never writes there.

## Deterministic discovery chain

```
Task Breakdown ──qa_handoff_link──────► Dev QA Handoff
      └────────feature_analysis_link──► Feature Analysis
```

**1. The Task Breakdown** is found in this order:
1. an explicit path given by the human;
2. the `task_breakdown_link` already recorded on the QA feature scope (`dev_handoff`);
3. the unique Markdown file in the code repo whose **frontmatter** carries the Task Breakdown keys (`feature`, `feature_analysis_link`, `dd_link`, `dev_plan_link`) and a `feature` equal to the given feature name (exact or slug-equal). Hidden folders and `node_modules`, `Pods`, `build`, `dist`, `vendor` are skipped.

Zero or several candidates → `NEED_BREAKDOWN_PATH`, with the candidate list. The human chooses; nothing is picked silently.

**2. The handoff** is the breakdown's `qa_handoff_link`, or a path the human gives explicitly. An empty link or a missing file → `NEED_HANDOFF_PATH`.

There is **no** search for a file starting with `# QA Handoff`. The producer's handoff opens with frontmatter, and that heading-based search is removed.

**3. The Feature Analysis** is the breakdown's `feature_analysis_link`. If it's missing, `surface` and `capability` are reported as unknown (`null`); this is never fatal.

Every link is repo-relative. A link that escapes the code repo → `PATH_OUTSIDE_CODE_REPO`. The code repo can never be the QA repo (`CODE_REPO_IS_QA_REPO`).

## Frontmatter

There are two accepted encodings, per the producer's planning-doc contract:
- **`delimited`**: the file opens with `---`.
- **`fenced-yaml`**: the first ` ```yaml ` fence before the first `## ` heading.

`delimited` wins when both could match. Trailing `# comments`, empty values and `null` read as null.

| Artifact | Fields read |
|---|---|
| Task Breakdown | `feature` (canonical Dev feature id), `feature_analysis_link`, `dd_link`, `dev_plan_link`, `qa_handoff_link`, `platform`, `device_type`, `status` |
| QA handoff | `feature`, `platform`, `device_type`, `dd_link`, `task_breakdown_link`, `status` (`draft` \| `ready-for-qa`), `generated_by`, `date` |
| Feature Analysis | `feature`, `platform`, `device_type`, `surface`, `capability` (both may be `null` or absent in older analyses) |

**Identity checks** (`IDENTITY_MISMATCH`):
- the handoff's `feature` equals the breakdown's;
- `platform` and `device_type` agree when both are set;
- the handoff's `task_breakdown_link` points back at the breakdown.

A different analysis `feature` spelling is reported, not fatal.

## Status gate

- `ready-for-qa` → accepted.
- Anything else (`draft`, missing) → `HANDOFF_NOT_READY`.
  - A human may explicitly approve working from that exact handoff content: `--override-by` plus `--override-reason`, both required.
  - The approval is recorded on the feature scope as a `handoff_overrides` entry, keyed by the handoff's content fingerprint, with who, why and when.
  - It appears in the coverage report frontmatter.
  - A changed draft needs a new approval.
  - A draft is never recorded as ready.

## Sections

All ten are required, in the producer's order and exact names:

| # | Section | How QA uses it |
|---|---|---|
| 1 | `Feature Summary` | Context for the comparison |
| 2 | `How to Test` | Screens and flows it mentions join the coverage checklist |
| 3 | `Test Accounts & Environment` | Context; supersedes the plan's assumed environment |
| 4 | `Edge Cases` | Coverage checklist |
| 5 | `Known Limitations` | Coverage checklist **only** where a limitation implies observable behavior QA should confirm. Developer-owned context otherwise (see ownership). |
| 6 | `Screens & Flows Touched` | Coverage checklist, matched against the plan's Screens & Flows Covered |
| 7 | `Build / Install / Testing Instructions` | Referenced by anchor (`#build--install--testing-instructions`) as the build/testing instructions of record |
| 8 | `i18n / RTL Check` | Coverage checklist |
| 9 | `Accessibility Check` | Coverage checklist. Tri-state per task: `applicable` / `notApplicable` / `notRecorded`. |
| 10 | `Pending Verification (owed to QA)` | QA-owned debt, ingested into the ledger |

- A missing section, missing frontmatter or malformed Pending Verification row → `HANDOFF_CONTRACT_MISMATCH`. The handoff is not guessed at.
- An extra, unknown section is reported (`unrecognized_sections`) and never fatal.
- The current producer has **no** separate "implementation summary", "changed areas", "acceptance criteria" or "risks" sections:
  - Feature Summary and Screens & Flows Touched cover the first two;
  - acceptance criteria live in the Task Breakdown's rows, and QA does not read them;
  - there is no risks section.

## Ownership boundary

**QA-owned debt.** Each row of `Pending Verification (owed to QA)` has five parts: `domain · rule ID · required verification · why the plugin could not perform it · owner`. It may be a table row or a `·`-separated bullet. "None recorded" means no rows.
- Every row with owner `qa` becomes a `debt` entry on the feature scope: `{ id, description, domain, rule_id, why_not_automatable, owner: qa, source }`.
- The `id` is `HV-<8 hex>`, derived from domain + rule + required verification, so re-ingesting never duplicates.
- **Accessibility `notRecorded`** (or no recognizable status) is **never** read as covered. It adds the QA-owned item `HV-a11y-not-recorded`.
- Discharging debt, and carrying it into readiness, belongs to later stages. Stage 4 only makes sure no obligation is lost.

**Developer-owned (never QA debt).**
- `Known Limitations`, including outstanding developer testing (`developer-testing`, `VERIFY-4`), is shown as developer context and is never ingested.
- A row with owner `developer` found under Pending Verification is reported as `misfiled_developer_debt` and not ingested.
- A row with any other owner is a contract problem; ownership is never guessed.

## Feature identity binding

The QA feature scope `feature:<qa-slug>` keeps its slug (the plan folder), and records the Dev identity verbatim in one context field:

| Field | Content |
|---|---|
| `dev_handoff` (set) | `feature` (canonical Dev id), `task_breakdown_link`, `qa_handoff_link`, `feature_analysis_link`, `dd_link`, `platform`, `device_type`, `surface`, `capability`, `handoff_status`, `handoff_fingerprint`, `handoff_date`, `build_instructions_ref` |

- `capability` is also set as the scope's Stage 1 `capability` reference. It's a reference only; the Project Knowledge manifest is not read.
- The existing `<qa-slug>/test-plan.md` is added to the scope's `plans`. The plan file is never touched.
- A scope bound to one Dev feature is never silently rebound to another (`IDENTITY_CONFLICT`).
- QA's required surfaces stay QA-entered (`/set-qa-scope`). The Dev `surface` is recorded as identity, not copied into `surfaces`.
