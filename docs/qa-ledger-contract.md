# QA Ledger Contract

**Schema version: 1** · **Stage: 1 (foundation)**
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
- Writes happen only under `<qa-repo>/qa-ledger/`. Every path is built from validated segments (no separators, `.` or `..`). The helper never writes through a symlink anywhere between `qa-ledger/` and the target.
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

**Stage 1 enforces structure only:** types, references and terminal state. Workflow rules such as "smoke once per build", smoke gates and bug transitions belong to later stages.

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

## Versioning and compatibility

- `qa_ledger_schema: 1`. The helper refuses any other value (`UNSUPPORTED_SCHEMA`); it does not guess at a newer shape.
- Later stages extend v1 **additively**, with new record kinds, new context fields, and new case namespaces (e.g. smoke suites). A helper that meets a kind or field it does not know reports `UNKNOWN_EVENT_KIND` / `UNKNOWN_FIELD` rather than ignoring it, so an old plugin never extends a ledger it cannot fully read. A breaking change bumps the schema.
- Bug lifecycle events fit the existing model without redesign. A bug *is* a `bug:` scope; its events (reported, reproduced, fix claimed, reopened, closed) will be new record kinds on that scope's stream. Its re-tests are ordinary `retest` runs with `bug_ref`, tied to a specific build. Repeated fix → re-test FAIL → fix → re-test PASS cycles are just more builds and more runs.

## CLI (Stage 1)

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
plan rows     --plan <qa-repo-relative path>        (read-only; needs no ledger)
```

`QA_LEDGER_NOW=<ISO>` pins the clock. It exists for deterministic tests and must not be set in normal use.

Tests: `node --test scripts/qa-ledger.test.mjs` (behavior) and `node --test scripts/qa-ledger.mutation.test.mjs` (each critical invariant disabled in turn must fail its tests).
