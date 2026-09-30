# QA Ledger Contract

**Schema version: 1** · **Stages: 1 (foundation), 2 (feature execution + smoke), 3 (bug lifecycle), 4 (Dev → QA handoff), 5 (Project Knowledge + regression), 6 (readiness + sign-off)**
Writer: `scripts/qa-ledger.mjs` — the **only** component that writes the ledger.
Readers: this plugin's later lifecycle stages (execution, bugs, regression, readiness).

The ledger is the single lifecycle state model for QA work after a test plan exists: which builds QA received, what scope of work each build serves, and every execution result recorded against them. New-feature QA and standalone-bug QA share it: there is one model, not a feature store and a bug store.

It sits **beside** the existing planning artifacts and never replaces them. `test-plan.md`, `test-cases.xlsx`, `coverage-report.md` and the automation files keep their formats. The ledger only *references* test-plan rows (see [Test-plan references](#test-plan-references)) and never rewrites a plan.

## Location and write boundary

```
<qa-repo>/qa-ledger/
  ledger.json                    schema record (written once by `init`)
  builds/<build-id>.json         one immutable record per build
  scopes/<kind>/<id>.jsonl       one append-only event stream per scope
  runs/<run-id>.jsonl            one append-only event stream per execution run
```

- The QA repo is passed explicitly as `--qa-repo`. Commands resolve it exactly as "Resolving the workspace" in `commands/create-qa-test-plan.md` describes. The helper does no resolution of its own.
- The helper refuses a `--qa-repo` that:
  - is not a git repository root;
  - contains `.ono/` (an application repo with Project Knowledge);
  - is this plugin's own repository (`.claude-plugin/plugin.json` named `ono-plugin-qa`).
- Writes happen only under `<qa-repo>/qa-ledger/`, plus two kinds of derived Markdown view: `<qa-repo>/bugs/<id>/bug.md` (Stage 3) and `<qa-repo>/readiness/<kind>/<id>.md` (Stage 6). Both are regenerated in full and never read back. Every path is built from validated segments (no separators, `.` or `..`). The helper never writes through a symlink anywhere between `qa-ledger/` and the target.
- The helper *reads* test plans only inside the QA repo and outside `qa-ledger/`, never through a link that leaves the repo.
- It never writes to the application repo, Inspector artifacts, Dev Plugin artifacts, or any external system. A value such as a Dev artifact path is stored as a reference string and never opened.
- It never runs git. The `block-qa-repo-git-writes` hook is unchanged; QA reviews and commits ledger files by hand like every other QA artifact.

## Identities

| Entity | Format | Uniqueness |
|---|---|---|
| id segment | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` | — |
| scope | `<kind>:<id>`, kind ∈ `feature` \| `bug` \| `release` | case-insensitive within a kind |
| build | `<id>` (e.g. `103`, `ios-2.4.0-88`) | case-insensitive, ledger-wide |
| surface | `<id>` (e.g. `android`, `tvos`, `android-tv`) | free vocabulary in Stage 1 |
| run | `<type>-<YYYYMMDDTHHMMSSZ>-<8 hex>`, derived from the header's hash | ledger-wide |
| result | `<run-id>/<seq>` | ledger-wide |
| plan case | `<plan-folder>/<plan-id>` (e.g. `checkout/TC14`) | as unique as the plan's ids |
| scope-owned case | `<scope>#<case-id>` (e.g. `bug:BUG-27#R1`) | unique within the scope |

- **Feature scope:** `feature:<slug>` uses the same slug as the plan folder (`<qa-repo>/<slug>/test-plan.md`). No plan is required for the scope to exist.
- **Bug scope:** `bug:<id>` is a first-class scope. It needs no feature and no test plan. Use the external tracker key as the id when one exists.
- **Release scope:** `release:<id>` groups other scopes through `members`. The id is whatever label Release supplies; QA does not own version numbers.

## Records

Every record is canonical JSON: keys sorted recursively, no insignificant whitespace, one record per line. Each record carries `hash = "sha256:" + sha256(canonical(record without hash))`.

Stream records (scopes, runs) also carry:

| Field | Meaning |
|---|---|
| `v` | schema version, `1` |
| `seq` | 0-based position in the stream |
| `prev` | `hash` of the previous record, `null` for `seq 0` |
| `at` | ISO-8601 UTC timestamp |
| `kind` | record kind (below) |

`seq` and `prev` form a hash chain. Removing, reordering, inserting or editing any record breaks it, and `validate` reports `CHAIN_BROKEN` / `HASH_MISMATCH`.

### `ledger.json`

`{ qa_ledger_schema: 1, created_at, hash }`. Written once by `init`, never rewritten.

### Build — `builds/<build-id>.json` (immutable)

| Field | Type | Notes |
|---|---|---|
| `kind` | `"build.registered"` | |
| `build_id` | id | Must equal the file name |
| `version` | string \| null | As delivered; QA does not own versioning |
| `surfaces` | non-empty unique id list | What this build ships |
| `source` | string \| null | CI link, handoff path, store track, … (reference only) |
| `related_scopes` | scope refs | Must exist at registration |
| `registered_by` | string | |
| `registered_at` | ISO | |

Order: builds are ordered by `(registered_at, build_id)`. "Latest build for a surface" is the last build in that order that ships the surface. A build is never edited or replaced: builds 103, 104 and 105 are three records.

### Scope — `scopes/<kind>/<id>.jsonl`

`seq 0` is `scope.created { scope, title, by }`, and it appears exactly once. After it come context events:

| Kind | Payload | Derived effect |
|---|---|---|
| `context.set` | `{ field, value, by }` | Latest value wins |
| `context.add` | `{ field, value, by }` | Value appended to the field's list |
| `context.retract` | `{ field, value, by, reason }` | Removes a previously added value (by `id` for keyed fields, else by exact value). `reason` is required. |

#### Stage-1 context fields

| Field | Op | Value | Integrity |
|---|---|---|---|
| `title` | set | string | |
| `surfaces` | set | unique surface ids | |
| `devices` | set | `[{ surface, device, os_runtime? }]` | |
| `capability` | set | id \| null | Reference only; Project Knowledge is not read in Stage 1 |
| `plans` | add | QA-repo-relative plan path | File must exist at write time; a later disappearance is a `PLAN_MISSING` warning |
| `related_scopes` | add | scope ref | Must exist; not self |
| `members` | add | scope ref | `release` scopes only; must exist |
| `dev_artifacts` | add | `{ kind, ref }` | Reference string, never opened |
| `debt` | add | `{ id, description, domain?, rule_id?, source? }` | Keyed by `id` |
| `cases` | add | `{ id, summary }` | Keyed by `id`; declares scope-owned cases (e.g. a bug's repro steps) |
| `result_refs` | add | result id | Must exist; links results to the scope after the fact (e.g. a bug created after the FAIL) |
| `notes` | add | string | |

Adding a value that is already present is refused (`DUPLICATE_VALUE`). The derived context lists only fields that were ever written.

### Run — `runs/<run-id>.jsonl`

`seq 0` is `run.opened`:

| Field | Notes |
|---|---|
| `run_id` | Must equal the file name |
| `execution_type` | `smoke` \| `functional` \| `regression` \| `retest` \| `reproduction` |
| `scope` | Existing scope |
| `build_id` | Existing build |
| `surface` | Must be one of the build's `surfaces` |
| `device` | string |
| `os_runtime` | string \| null |
| `executor` | Human name, or later `automation:<tool>` |
| `plan_refs` | `[{ plan, fingerprint }]`; fingerprint = sha256 of the plan bytes at open |
| `bug_ref` | Existing `bug:` scope \| null. **Required** for `retest` and `reproduction`; defaults to the run's own scope when that scope is a bug. |

Then zero or more `result.recorded` records, then **one** terminal record.

`result.recorded`:

| Field | Notes |
|---|---|
| `result_id` | `<run-id>/<seq>` |
| `case_key` | Plan case or scope-owned case (see identities) |
| `case_ref` | `{ kind: plan_row \| scope_case, source, row_hash }`: what the result was recorded against |
| `result` | `pass` \| `fail` \| `blocked` \| `not_run` |
| `notes` | string \| null |
| `evidence` | reference strings |
| `bug_refs` | Existing `bug:` scopes |
| `supersedes` | result id \| null |

Terminal records:

- `run.closed {}` needs at least one result; an empty run must be aborted instead.
- `run.aborted { reason }`.

**Stage 1 enforces structure only:** types, references and terminal state. Stage 2 adds the smoke and functional-execution rules in [Stage 2 — feature execution and smoke](#stage-2--feature-execution-and-smoke). Stage 3 adds the bug lifecycle in [Stage 3 — bug lifecycle](#stage-3--bug-lifecycle). Regression rules belong to later stages.

## Append-only guarantees

1. **Builds are immutable.** They are created with an exclusive create and never rewritten. Duplicate ids are refused, case-insensitively.
2. **Streams only grow.** Every write appends one record. No write ever rewrites an existing byte, so a later PASS never overwrites an earlier FAIL: both are records in their own runs.
3. **Terminal runs are frozen.** After `run.closed` or `run.aborted`, the helper refuses every further record (`RUN_NOT_OPEN`). A record found after a terminal one is `EVENT_AFTER_TERMINAL`.
4. **Corrections supersede, never edit.** While a run is open, a result may be corrected by a new result with `supersedes: <result-id>`. The superseded result must be:
   - in the same run;
   - for the same `case_key`;
   - not already superseded.

   Recording the same case twice without `supersedes` is refused. After a run is terminal, corrections are impossible; the correction is a new run. The original result always remains in history.
5. **Tamper evidence.** The per-record hash and the `seq`/`prev` chain make any edit, deletion, insertion or reordering inside a stream detectable. Removing a stream's *final* records, or deleting a whole file, is detectable only when something else references it (`DANGLING_REFERENCE`); git history remains the audit trail for that.
6. **Writes refuse a damaged ledger.** A write to a corrupt stream is refused with `CORRUPT_STREAM`. Any other validation error blocks all writes with `CORRUPT_LEDGER`, until the ledger is repaired from git history. Warnings never block.

## Derived state vs persisted events

Nothing that can be derived is persisted. There's no stored "status", "latest result" or "current build". The helper derives these on read:

| View | Derivation |
|---|---|
| Scope context | Replay of `context.*` events |
| Builds for a scope | Builds whose `related_scopes` include it, plus builds used by its runs |
| Latest build per surface | Last in build order shipping the surface (optionally within a scope) |
| Run state | `open` until a terminal record; `closed` \| `aborted` after |
| Case history | Every result for a case, in order: build order, then run open time, then `seq`. Superseded results are included, with `superseded_by`. |
| Latest result | Last *effective* result from **closed** runs. Open runs are provisional; aborted runs are void. Both stay visible in history. |

Views are withheld (`CORRUPT_LEDGER`) while the ledger has validation errors, so a derived answer is never computed from damaged history.

## Test-plan references

- The helper parses a plan read-only. It reads every markdown table row (outside code fences) whose first cell is a plan id: an uppercase token with a digit, e.g. `TC1`, `EC-U1`, `I18N1`, `A11Y1`.
- **`row_hash`** = sha256 of the row's cells, each trimmed and whitespace-collapsed, joined by U+001F. A reflow doesn't change it; any wording change does.
- **`fingerprint`** = sha256 of the whole plan file.
- A result for `checkout/TC14` must come from a run that referenced `checkout/test-plan.md`, and the row must exist exactly once. The ledger never invents a test case. Scope-owned cases must first be declared through the scope's `cases` field.
- The row hash is pinned into the result's `case_ref`. A later plan edit (e.g. `/sync-qa-test-plan`) changes the current row hash, so later stages can tell that a recorded result predates the edit. History stays valid either way.
- Existing plans are never migrated or rewritten.

## Stage 2 — feature execution and smoke

Stage 2 adds **no new record kind and no schema change**. It uses the Stage-1 records, plus two additive context fields and workflow rules the helper enforces when a run is opened or closed. The rules live in `scripts/lib/qa-ledger/execution.mjs`.

### Additive context fields

| Field | Op | Value | Rules |
|---|---|---|---|
| `exclusions` | add | `{ case_key, surface, reason }`, keyed `<case_key>@<surface>` | `feature` scopes only. The surface must be one of the scope's `surfaces`, and the case must be a row of a plan attached to the scope. Retract by `"<case_key>@<surface>"`. |
| `smoke_overrides` | add | `{ build_id, surface, reason }`, keyed `<build_id>@<surface>` | The build must exist and ship the surface. `reason` is required and non-empty. The override belongs to **one scope** only. Retract by `"<build_id>@<surface>"`. |

`surfaces` (Stage 1) is the list of **required** surfaces; a surface not in it is not required. `devices` (Stage 1) declares the devices and runtimes per surface.

### Smoke suites

- A smoke suite is QA-authored, product-level and per surface, at `<qa-repo>/smoke/<surface>/smoke-suite.md` (`templates/smoke-suite-template.md`).
- Its frontmatter `surface` must equal the folder name.
- Its rows are `| S<n> | source | steps | expected result |`, where `source` is `QA-authored` or `<plan-folder>/<case-id>` for a row copied from an approved plan case.
- IDs are never renumbered or reused; removed IDs are listed under `## Retired IDs`.
- Suite cases use the Stage-1 plan-row mechanism unchanged. The case key is `smoke/<surface>/S<n>`, and each result pins the suite row's `row_hash`.
- `suite check --suite <path>` reports two kinds of error:
  - **structural:** `SURFACE_MISMATCH`, `NO_CASES`, `INVALID_CASE_ID`, `DUPLICATE_CASE_ID`, `RETIRED_ID_REUSED`. These make a suite unusable for a smoke run.
  - **source:** `UNKNOWN_SOURCE`, `SOURCE_NOT_APPROVED`, `INVALID_SOURCE`. These only break traceability.
- The ledger never creates a suite.

### Smoke rules

| Rule | Enforced as |
|---|---|
| A smoke run executes exactly `smoke/<surface>/smoke-suite.md` for its own surface | `SMOKE_SUITE_REQUIRED` / `INVALID_SMOKE_SUITE` |
| At most one open smoke run per (build, surface) | `SMOKE_IN_PROGRESS` |
| At most one **closed** smoke run per (build, surface), ever. A rejected build needs a new build, never a second smoke. | `SMOKE_ALREADY_RECORDED`; validate: `DUPLICATE_SMOKE` |
| A smoke run closes only once every suite case has a result (NOT_RUN counts) | `SMOKE_INCOMPLETE` |
| Aborted smoke runs are void and don't use up the build's smoke | — |

**Smoke status** of (build, surface) is derived from the one closed smoke run:
- any FAIL → `failed`;
- else any BLOCKED → `blocked`;
- else any NOT_RUN → `incomplete`;
- else `passed`.

Without a closed smoke run, the status is `in_progress` (a smoke run is open) or `not_started`. Smoke is build-level: it is shared by every scope that uses the build.

### Functional rules

A `functional` run requires all of the following:

| Requirement | Refusal |
|---|---|
| A `feature` scope | `FUNCTIONAL_REQUIRES_FEATURE` |
| At least one `--plan` | `PLAN_REQUIRED` |
| Every plan attached to the scope (`plans`) | `PLAN_NOT_IN_SCOPE` |
| Every plan `status: approved`, read from the plan's frontmatter | `PLAN_NOT_APPROVED` |
| No smoke suite among the plans (true for every non-smoke run) | `INVALID_VALUE` |
| The surface is one of the scope's required `surfaces` | `SURFACE_NOT_IN_SCOPE` |
| The device (and runtime, if given) is declared for that surface | `DEVICE_NOT_IN_SCOPE` / `AMBIGUOUS_DEVICE`. The declared runtime is recorded when the run omits one. |
| **The smoke gate is open** for (scope, build, surface): smoke `passed`, or the scope holds an active `smoke_overrides` entry | `SMOKE_GATE_CLOSED`, with `details.smoke_status` |

- Recording a result for a case excluded on the run's surface is refused (`CASE_EXCLUDED`).
- A FAIL is only a result: nothing is created from it.
- `validate` re-derives the gate as of each functional run's open time, so a hand-written run that bypassed it is reported as `GATE_NOT_HELD`.
- Smoke runs may use any device, because smoke is product-level. A device declared by the run's scope lends its runtime when that runtime is unambiguous.

### Stale evidence

A case's current evidence on a surface is its latest effective result from **closed functional** runs of the scope on that surface.
- **Stale:** if that result's pinned `row_hash` differs from the plan row's current hash (e.g. after `/sync-qa-test-plan` reworded the row), the case is `stale`. The result stays in history and is shown, but it is not current evidence. A new run against the updated row makes the case current again.
- **Build currency:** reported only (`on_latest_build`), never judged.

### Stage 2 views

| View | Returns |
|---|---|
| `view smoke --build [--surface]` | Per surface: smoke status, the deciding run, counts, whether the gate opens by smoke (`gate_open`), active overrides per scope, and full smoke-run history |
| `view execution --scope [--surface]` | Per surface (required surfaces first, then any other surface the scope ran on): the scope's builds with their smoke status, latest build, smoke and gate on the latest build, device coverage (declared plus undeclared-but-used), and every plan case. Each case shows its status (`pass` / `fail` / `blocked` / `not_run` / `stale` / `pending` / `excluded`), latest result, current row hash and `on_latest_build`. Also includes a summary with the `pending` and `stale` lists. |
| `view run-cases --run` | The run's cases in fixed order (suite rows, or plan rows minus exclusions), each with this run's effective result, plus `remaining`. This is what `/record-execution` walks. |

These are operational views. None of them computes a readiness verdict.

### User-facing commands (Stage 2)

`/register-build`, `/set-qa-scope`, `/define-smoke-suite` and `/record-execution` drive the helper. Each command resolves the QA repo exactly like the existing commands, and never writes the ledger except through the helper.

## Stage 3 — bug lifecycle

A bug **is** its `bug:<id>` scope; there is no second bug store. Stage 3 adds only additive pieces:

- two record kinds, `bug.reported` and `bug.resolved`;
- an optional `fixes_claimed` field on build records;
- five bug-only context fields.

The bug's state is **never persisted**. `scripts/lib/qa-ledger/bugs.mjs` replays it from these records plus the Stage 1 `reproduction` and `retest` runs, and the same replay drives the write-time guards, the views and `validate`.

### Records

| Record | Where | Content |
|---|---|---|
| `bug.reported` | Bug scope stream, **seq 1** (written together with `scope.created`, exactly once) | `title`, `description`, `steps[]`, `expected`, `actual`, `severity`, `origin` (`{kind: intake}` or `{kind: execution, run_id, result_id, case_key}`), `found_in_build`, `surfaces[]` (affected), `devices[]`, `linked_cases[]`, `related_scopes[]`, `evidence[]`, `external_ref`, `by` |
| `bug.resolved` | Bug scope stream | `resolution` ∈ `duplicate` \| `wont_fix`, `reason` (required), `reference` (optional; a `bug:` reference must be another existing bug), `by` (the human who decided) |
| `fixes_claimed` | Optional field on a build record | Bug refs this build claims to fix; set at registration, immutable like the rest of the build |

**Bug-only context fields:**

| Field | Op | Value |
|---|---|---|
| `severity` | set | `critical` \| `major` \| `minor` \| `trivial` |
| `assignee` | set | string \| null |
| `external_ref` | set | string \| null |
| `evidence` | add | reference string |
| `linked_cases` | add | a test-plan or smoke-suite case key that must exist |

Stage 1 fields apply to bug scopes as well: `surfaces` (replaces the affected surfaces), `devices`, `related_scopes`, `capability` (reference only), `cases`.

**Severity** is recorded, never interpreted; readiness decides later what it means.

### The bug-owned case

Every reported bug has the case `bug:<id>#R1`: its reproduction steps and expected result, taken from the report and hashed like a plan row.
- Reproduction attempts and re-tests execute this case. A FAIL means the bug is present.
- A standalone bug therefore needs no test plan, feature, spec or Figma.
- `R1` can't be redeclared through `cases`.

### States

Every state below is derived:

| State | Next action | Reached by |
|---|---|---|
| `new` | `qa_verify` | Standalone intake |
| `verification_blocked` | `qa_verify` | A reproduction run with a BLOCKED outcome |
| `assigned` | `dev_fix` | Reported from a FAIL (already reproduced), or a REPRODUCED reproduction |
| `fix_delivered` | `qa_retest` | A build registered with `fixes_claimed` for the bug while Dev owns it |
| `reopened` | `dev_fix` | A re-test FAIL. The failed fix cycle ends: the next step is a **new** fix build. |
| `closed_verified` | none | Re-test PASS on **every** affected surface within the current fix cycle |
| `closed_not_reproducible` | none | A reproduction run with a NOT_REPRODUCIBLE outcome |
| `closed_duplicate` / `closed_wont_fix` | none | `bug.resolved` |

**Run outcomes** come from the effective results of a closed run:
- any FAIL → `fail`;
- else any BLOCKED or NOT_RUN → `blocked`;
- else `pass`.

`R1` must be among them and may not be NOT_RUN. For reproduction runs, `fail` means REPRODUCED and `pass` means NOT_REPRODUCIBLE.

A later fix claim while one is under test **supersedes** it: the later build becomes the fix under test, the earlier claim is kept with outcome `superseded`, and it can no longer be re-tested.

### Guards (write time; `validate` re-derives them)

| Rule | Refusal |
|---|---|
| A bug is reported only from an effective FAIL of a non-aborted smoke, functional or regression run | `NOT_A_FAILURE` / `UNKNOWN_RESULT` / `RUN_ABORTED` |
| Reproduction only while `new` or `verification_blocked` | `BUG_NOT_AWAITING_VERIFICATION` |
| A fix claim only while Dev owns the bug (`assigned`, `reopened`, `fix_delivered`), on a build shipping an affected surface | `BUG_NOT_REPRODUCED` / `BUG_CLOSED` / `FIX_SURFACE_MISMATCH` |
| A re-test only while `fix_delivered`, on the current fix build or a later one; never on a superseded fix build | `BUG_AWAITING_FIX` (after a reopen) / `BUG_NOT_REPRODUCED` / `FIX_CLAIM_SUPERSEDED` / `RETEST_BUILD_BEFORE_FIX` |
| **A re-test only through the Stage 2 smoke gate** of its exact (build, surface): smoke `passed` on that build, or an active `smoke_overrides` entry on the run's scope. The gate is the same one functional runs use (`requireSmokeGate`); smoke never carries forward from another build. Reproduction before a fix is not gated. | `SMOKE_GATE_CLOSED`; validate: `GATE_NOT_HELD` |
| A smoke run records only its own suite's cases, so smoke never becomes bug evidence | `UNKNOWN_CASE` |
| Reproduction and re-test only on an affected surface | `BUG_SURFACE_MISMATCH` |
| A reproduction or re-test run closes only with its `R1` outcome | `BUG_OUTCOME_REQUIRED` |
| `duplicate` / `wont_fix` need a reason and a person; closed bugs are final | `MISSING_ARGUMENT` / `BUG_CLOSED` |
| `verified` is never a manual resolution | `INVALID_VALUE`; validate: `INVALID_RECORD` |

`validate` replays every bug. A transition no helper could have written is reported as `INVALID_TRANSITION`: a hand-written re-test on a failed fix build, a claim on a closed bug, a reproduction after a reproduction.

A fix claim **never** closes a bug; only a QA re-test does.

### Views

| View | Returns |
|---|---|
| `view bug --bug` | Everything about one bug: report, current state, next action, resolution, found/fixed/current fix build, pending re-test surfaces, fix claims with outcomes (`pending`/`failed`/`verified`/`superseded`), reproduction and re-test history, links, evidence, and a chronological history |
| `view bugs [--scope] [--state]` | One summary line per reported bug |
| `view case-bugs --case` | Every bug linked to a case (`linked`, `origin` or via a result's `bug_refs`) |

`bug render --bug` regenerates `bugs/<id>/bug.md`. Every write that touches a reported bug re-renders it automatically. The file is deterministic, marked as generated, and never read by the helper: editing it changes nothing.

Bug scopes created with plain `scope create` (no report), as used by Stage 1's structural tests, carry no lifecycle and are not listed as bugs.

### Commands (Stage 3)

`/report-bug`, `/verify-bug`, `/retest-bug` and `/resolve-bug`, plus the `--fixes` option on `/register-build`.
- `bug verify` / `bug retest` write one atomic run: `run.opened`, the `R1` result, and `run.closed`.
- The generic `run open` / `result add` / `run close` path obeys the same guards.
- Nothing is written to external trackers; `external_ref` is only stored.

## Stage 4 — Dev → QA handoff

`/check-qa-coverage` binds the Dev plugin's handoff into the feature scope through `handoff resolve` / `handoff ingest` (`scripts/lib/qa-ledger/handoff.mjs`). Everything about the Dev input is specified in [`docs/dev-handoff-contract.md`](dev-handoff-contract.md):
- the discovery chain;
- frontmatter encodings;
- the status gate;
- the ten sections;
- the QA-vs-developer ownership boundary.

The code repo is read-only: it's passed as `--code-repo`, it can't be the QA repo, and links can't escape it.

Additive ledger changes (no new record kind, schema unchanged):

| Field | Op | Value |
|---|---|---|
| `dev_handoff` | set (`feature` scopes) | The bound Dev identity: `feature`, `task_breakdown_link`, `qa_handoff_link`, `feature_analysis_link`, `dd_link`, `platform`, `device_type`, `surface`, `capability`, `handoff_status`, `handoff_fingerprint`, `handoff_date`, `build_instructions_ref` |
| `handoff_overrides` | add (`feature` scopes), keyed by `handoff_fingerprint` | `{ qa_handoff_link, handoff_fingerprint, status, reason, approved_by }` — an attributed approval to work from a handoff that is not `ready-for-qa`; the event's `at` is when |
| `debt` (Stage 1) | add | Gains optional `why_not_automatable` and `owner` (only `qa`). Handoff debt ids are `HV-<8 hex>` and `HV-a11y-not-recorded`, so re-ingesting never duplicates. |

On ingest the scope also:
- takes the Dev `capability` as its Stage 1 `capability` reference;
- binds `<qa-slug>/test-plan.md` into `plans`. The plan file is never touched.

A scope bound to one Dev feature refuses another (`IDENTITY_CONFLICT`).

Discharging debt is not part of Stage 4.

## Stage 5 — Project Knowledge + regression

Project Knowledge is consumed only through `scripts/lib/qa-ledger/knowledge.mjs`, which runs the vendored reader. The rules are in [`docs/qa-project-knowledge.md`](qa-project-knowledge.md) and the vendored [`docs/repo-knowledge-contract.md`](repo-knowledge-contract.md). Regression lives in `scripts/lib/qa-ledger/regression.mjs`.

**Planning isolation.** Test-plan authoring and sync never consume Project Knowledge.

### Regression decision (additive context field, any scope kind)

| Field | Op | Value |
|---|---|---|
| `regression_decisions` | add, keyed `id` | `{ id: RD-<n>, required: bool, reason, capability, candidates[], included[], excluded[{capability, reason}], cases[], targets[{build_id, surface}], knowledge: {available, freshness, capabilities} \| null, decided_by }`. `decided_at` is the event's `at`. |

- **`required` is explicit.** It's `yes` or `no`, never defaulted, and `reason` is always required.
- **`candidates`** are the capability's first-degree neighbours whose evidence still holds (from Project Knowledge, when available), plus any QA adds manually (`--candidate`).
  - **Every** candidate is either included or excluded with a reason (`UNADDRESSED_CANDIDATE`).
  - Candidates never become scope by themselves.
- **"Not required"** selects no cases, targets or inclusions. **"Required"** selects at least one case and one target.
- **`cases`** are existing cases only:
  - plan cases (`<plan-folder>/<id>`) from approved plans, from any feature;
  - for a bug scope, its own `bug:<id>#R1`.

  Smoke cases and other scopes' bug cases are refused.
- **`targets`** are registered builds shipping the surface.
- The **current** decision is the last active one. Earlier decisions stay in history, and a newer one supersedes them (`REGRESSION_DECISION_SUPERSEDED` for the old id).

### Regression runs (Stage 1 run model, type `regression`)

A regression run's header carries `regression_decision` (additive; present on regression runs only).

To open one, all of the following must hold:
- the decision is the scope's current decision, and `required` (`REGRESSION_DECISION_REQUIRED` / `UNKNOWN_DECISION` / `REGRESSION_NOT_REQUIRED`);
- (build, surface) is one of its targets. Evidence never carries to another build (`REGRESSION_TARGET_MISMATCH`).
- the Stage 2 smoke gate is open for that exact (build, surface) (`SMOKE_GATE_CLOSED`);
- the run references exactly the decision's plans (`REGRESSION_PLAN_MISMATCH`).

**Results** may be recorded only for the decision's cases (`CASE_NOT_SELECTED`). A FAIL is only a result; a bug is reported through Stage 3 only if QA decides to.

**Validation.** `validate` re-checks every regression run: its decision exists, and it stays inside that decision's targets and cases (`REGRESSION_OUTSIDE_DECISION`). It also checks that the gate was held when the run opened (`GATE_NOT_HELD`).

`view regression --scope` shows the current decision (with `decided_at`), the full history, and, per target, the gate, runs and case statuses (`pass` / `fail` / `blocked` / `not_run` / `stale` / `pending`). `regression candidates --scope` is read-only and records nothing.

## Stage 6 — QA readiness + sign-off

Readiness is specified in [`docs/qa-readiness-contract.md`](qa-readiness-contract.md) and implemented in `scripts/lib/qa-ledger/readiness.mjs`. It covers the rules R1–R9, candidate builds, exceptions, the fingerprint, sign-off and release aggregation.

Four additive, **managed** context fields are written only through their `readiness …` commands. A generic `scope event` on them is refused (`MANAGED_FIELD`), so each one is always validated.

| Field | Op, key | Value |
|---|---|---|
| `candidate_builds` | add, keyed `surface` | `{ surface, build_id, reason }` — QA's explicit candidate pin; `readiness unpin` retracts it |
| `exceptions` | add, keyed `id` | `{ id: EX-<n>, item: <blocker id>, kind, reason, approved_by, build_id \| null }` |
| `debt_discharges` | add, keyed `debt_id` | `{ debt_id, result_id }` — an effective PASS from a closed run of the scope |
| `signoffs` | add, keyed `id` | `{ id: SO-<n>, verdict, fingerprint, notes \| null, signed_by }` — not part of the fingerprint |

`validate` checks that pins, exception builds and discharge results exist. Computing readiness writes nothing.

## Versioning and compatibility

- `qa_ledger_schema: 1`. The helper refuses any other value (`UNSUPPORTED_SCHEMA`); it does not guess at a newer shape.
- Later stages extend v1 **additively**, with new record kinds, new context fields, and new case namespaces (e.g. smoke suites). A helper that meets a kind or field it does not know reports `UNKNOWN_EVENT_KIND` / `UNKNOWN_FIELD` rather than ignoring it, so an old plugin never extends a ledger it cannot fully read. A breaking change bumps the schema.
- Bug lifecycle events fit the existing model without redesign. A bug *is* a `bug:` scope; its events (reported, reproduced, fix claimed, reopened, closed) will be new record kinds on that scope's stream. Its re-tests are ordinary `retest` runs with `bug_ref`, tied to a specific build. Repeated fix → re-test FAIL → fix → re-test PASS cycles are just more builds and more runs.

## CLI

Every command takes `--qa-repo <path>`, prints one JSON object, and exits 0 when `ok: true`, 1 otherwise (`error.code`, `error.message`).

```
init
validate
build add     --id --surfaces a,b --registered-by [--version] [--source] [--related-scope]…
scope create  --scope <kind:id> --created-by [--title]
scope event   --scope --op set|add|retract --field --value <json> --by [--reason]
run open      --type --scope --build --surface --device --executor [--os-runtime] [--plan]… [--bug-ref]
result add    --run --case --result [--notes] [--evidence]… [--bug]… [--supersedes]
run close     --run
run abort     --run --reason
view scope          --scope
view builds         [--scope] [--surface]
view latest-build   --surface [--scope]
view runs           [--scope] [--build]
view case-history   --case [--surface] [--scope]
view latest-result  --case --surface [--scope]
view smoke          --build [--surface]                       (Stage 2)
view execution      --scope [--surface]                       (Stage 2)
view run-cases      --run                                     (Stage 2)
view bug            --bug                                     (Stage 3)
view bugs           [--scope] [--state]                       (Stage 3)
view case-bugs      --case                                    (Stage 3)
build add     … [--fixes bug:<id>]…                           (Stage 3)
bug report    --title --severity --by  (standalone: --step… --expected --actual --surfaces; from execution: --from-run --case)
bug verify    --bug --build --surface --device --executor --outcome reproduced|not_reproducible|blocked
bug retest    --bug --build --surface --device --executor --outcome pass|fail|blocked
bug resolve   --bug --resolution duplicate|wont_fix --reason --by [--reference]
bug render    --bug
knowledge lookup --code-repo (--capability | --path… | --surface)   (read-only; Stage 5)
regression candidates --scope [--code-repo] [--capability] [--path]…   (read-only; Stage 5)
regression decide --scope --required yes|no --reason --by [--code-repo] [--capability] [--candidate]… [--include]… [--exclude "<id>=<why>"]… [--case]… [--target <build>@<surface>]…   (Stage 5)
view regression --scope   (Stage 5)
run open --type regression … --decision RD-<n>   (Stage 5)
view readiness --scope   (read-only; Stage 6)
view signoffs [--scope]   (read-only; Stage 6)
readiness pin --scope --surface --build --reason --by | readiness unpin --scope --surface --reason --by   (Stage 6)
readiness except --scope --item <blocker-id> --kind --reason --approved-by [--build]   (Stage 6)
readiness discharge --scope --debt --result --by   (Stage 6)
readiness signoff --scope --by [--notes] | readiness render --scope   (Stage 6)
handoff resolve --code-repo [--scope] [--feature] [--breakdown] [--handoff]   (read-only; Stage 4)
handoff ingest  --scope --code-repo --by [--feature] [--breakdown] [--handoff] [--override-by --override-reason]   (Stage 4)
plan rows     --plan <qa-repo-relative path>        (read-only; needs no ledger)
suite check   --suite smoke/<surface>/smoke-suite.md (read-only; needs no ledger; Stage 2)
```

`QA_LEDGER_NOW=<ISO>` pins the clock. It exists for deterministic tests and must not be set in normal use.

Tests: `node --test scripts/qa-ledger.test.mjs` (Stage 1 behavior), `node --test scripts/qa-execution.test.mjs` (Stage 2 behavior), `node --test scripts/qa-bugs.test.mjs` (Stage 3 behavior), `node --test scripts/qa-handoff.test.mjs` (Stage 4 behavior), `node --test scripts/qa-regression.test.mjs` (Stage 5 behavior), `node --test scripts/qa-readiness.test.mjs` (Stage 6 behavior) and `node --test scripts/qa-ledger.mutation.test.mjs` (each critical invariant disabled in turn must fail its tests).

Implementation: `scripts/qa-ledger.mjs` is the single CLI entry point and the only place the write boundary (`Store`, in `scripts/lib/qa-ledger/store.mjs`) is constructed. The internal modules under `scripts/lib/qa-ledger/` parse, validate and derive; none of them writes to disk — `store.mjs` is the only module with file writes, including the one derived-view writer.
