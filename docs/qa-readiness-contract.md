# QA Readiness Contract

**Schema: `qa_readiness_schema: 2`** (schema 1 was Stage 6; schema 2 adds the release artifact, bug identity, the freshness token and artifact integrity) · **Implemented in Stage 6** by `scripts/lib/qa-ledger/readiness.mjs`, through `scripts/qa-ledger.mjs readiness …` / `view readiness` / `view signoffs`, and the `/qa-readiness` and `/qa-signoff` commands.

QA readiness is a deterministic verdict for one scope: `feature:<id>`, `bug:<id>` or `release:<id>`. It's computed **only** from records already in the QA ledger (Stages 1–5), plus this stage's explicit pins, exceptions and debt discharges.
- It never reads Project Knowledge, the Dev plugin, a release tool or an external tracker.
- It uses no heuristics and no judgment.
- It's derived on every read and never stored as state.

Release Notes stay Release-owned. QA supplies the verdict, its evidence and a Release Notes Input section; a release tool consumes the artifact read-only (see *Consuming an artifact*).

## Verdict

There are exactly three verdicts:

| Verdict | Condition |
|---|---|
| `READY` | No blocker |
| `READY_WITH_EXCEPTIONS` | There are blockers, and **every** one is covered by an explicit, recorded exception |
| `NOT_READY` | At least one blocker without an exception |

Nothing becomes `READY_WITH_EXCEPTIONS` except through a recorded exception.

## Inputs (all from the ledger)

| Input | Source |
|---|---|
| Required surfaces | Feature: scope `surfaces`. Bug: the bug's affected surfaces. |
| Builds of the scope | Builds related to the scope, used by its runs, or claiming a linked bug's fix |
| Smoke per (build, surface) | Stage 2 smoke status |
| Functional evidence | Stage 2 per-case status per required surface: pass / fail / blocked / not_run / stale / pending / excluded |
| Plans | Scope `plans` and each plan's own `status` |
| Linked bugs | Feature: reported bugs whose `related_scopes` include it. Bug: itself. State and severity come from Stage 3. |
| Regression | The scope's current Stage 5 decision and its per-target status |
| QA debt | Scope `debt` (Stage 4), and Stage 6 `debt_discharges` |
| Pins and exceptions | Stage 6 `candidate_builds` and `exceptions` |

## Candidate builds

For each required surface, the candidate is:
- QA's **explicit pin** (`readiness pin`, with a reason), or else
- the **latest build whose smoke passed** on that surface.

A pin stays explicit until it's removed (`readiness unpin`). Changing the candidate, whether by a pin or by a newly accepted build, changes the fingerprint, so any sign-off goes stale.

## Rules

Each blocker has a stable id. That id is what an exception names.

| Rule | Applies to | Blocker (id) |
|---|---|---|
| **R1 Smoke** | all | A candidate build whose smoke on that surface is not `passed` (`R1:<surface>:<build>`). A smoke override opens the Stage 2 gate but is not acceptance. |
| **R2 Plan** | feature | No plan attached (`R2:no-plan`); a plan not `approved` (`R2:<plan>`) |
| **R3 Functional** | feature | Any case of the scope's plans on a required surface that is not `pass` or `excluded`: fail, blocked, not_run, pending, or **stale** (evidence recorded against a plan row that has since changed). Id `R3:<surface>:<case>`. |
| **R4 Bugs** | all | A linked bug not re-tested and not closed (`R4:<bug>`). **Blocking severities** (`critical`, `major`) must be `closed_verified`, `closed_duplicate` or `closed_not_reproducible`; `closed_wont_fix` is not enough. Any other severity must be closed. |
| **R5 Retests** | all | A bug in `fix_delivered`, awaiting re-test (`R5:<bug>`); a verified bug whose fix build is newer than the candidate on one of its surfaces (`R5:<bug>:<surface>`) |
| **R6 Regression decision** | all | No regression decision (`R6`). "Not required" is a valid decision. |
| **R7 Regression execution** | when required | A selected case not `pass` on a target (`R7:<build>@<surface>:<case>`); a decision whose targets on a surface don't include its candidate (`R7:<surface>:target`) |
| **R8 QA debt** | all | A debt item neither discharged nor excepted (`R8:<debt-id>`). It's discharged only by an effective PASS from a closed run of the scope (`readiness discharge`). |
| **R9 Surface coverage** | all | No required surfaces (`R9:no-surfaces`); no candidate build on a surface (`R9:<surface>:candidate`); regression required with no target on a required surface (`R9:<surface>:regression`) |

Each rule reports `pass`, `blocked`, `excepted` or `not_applicable`.

- **Standalone bug:** R2 and R3 don't apply. A bug needs no plan and no feature.
- **Automation:** there is no automation rule. Automated results are ordinary evidence, and an absent or unused automation suite never blocks.

## Exceptions

An exception, `readiness except`, records:
- `id` (`EX-<n>`);
- `item`: an **exact current blocker id**, else `UNKNOWN_BLOCKER`;
- `kind`: `known_issue` \| `limitation` \| `waived_regression` \| `waived_debt` \| `waiver`;
- `reason` (required);
- `approved_by` (required);
- an optional `build_id`.

The date is the event time. An exception covers only the blocker it names, and, when it names a build, only while that build is the one concerned. Known Issues are the applied `known_issue` exceptions.

## Sign-off

`readiness signoff` records:
- `id` (`SO-<n>`);
- the verdict;
- the **fingerprint**;
- optional `notes`;
- `signed_by`.

The time is the event time. A `NOT_READY` scope can't be signed off (`SIGNOFF_NOT_READY`).

The latest sign-off is `valid` while its fingerprint **and** verdict equal the current ones; otherwise it's `stale`. Earlier sign-offs are `superseded`. Invalidation is automatic; there is no manual step.

## Fingerprint

`sha256` over the sorted list of `(key, hash)` for every source record the verdict read:
- the scope's own events, **except** sign-off events;
- each linked bug's events;
- every consumed run, by its latest record hash, state and end time: the scope's runs, its linked bugs' runs, and smoke runs on the scope's builds and surfaces;
- the builds those touch, plus candidates and fix builds;
- the content fingerprint of every plan it read, including plans referenced by the regression decision.

Generated Markdown is never an input. Records the verdict didn't read (other scopes, unrelated builds) don't move it.

## Release scope

A `release:<id>` scope aggregates its `members` (`feature:` and/or standalone `bug:` scopes):
- member verdicts, each member's identity (Dev feature, QA bug id, external ref) and fingerprint;
- all member blockers (tagged with their member) and applied exceptions and known issues;
- candidate builds per surface, merged across members;
- tested builds (the union).

Members must agree on each surface's candidate. When two members' candidates on a surface differ, the release candidate on that surface is `null` and the release has the blocker `RELEASE:candidate-conflict:<surface>`. A release with no members has `RELEASE:no-members`. Release-level blockers can't be excepted: fix the members (pin or re-test) instead.

| Condition | Release verdict |
|---|---|
| A release-level blocker, any member `NOT_READY`, or no members | `NOT_READY` |
| Else any member `READY_WITH_EXCEPTIONS` | `READY_WITH_EXCEPTIONS` |
| Else | `READY` |

The release fingerprint is `sha256` over the release's own events (sign-offs excluded) and every member's `(scope, fingerprint)`. Any change to any member therefore moves it, and a release sign-off goes stale automatically.

A release scope **can be signed off** and **has a readiness artifact**. Pins, exceptions and debt discharges belong to member scopes (`RELEASE_AGGREGATION_ONLY`).

## Bug identity

A bug has a QA id (`bug:<id>` → `qa_bug_id`) and an optional `external_ref` (the bug report's `external_ref`, or its later `context.set`). Neither is required by QA. A bug artifact carries both keys, with `null` for an absent one; feature and release artifacts carry `null` for both. A release artifact's Members table carries each member's identity.

A consumer matching a release's bug items against artifacts must follow these rules:
- An item names a QA id, an external ref, or both. An item with neither is invalid.
- An item with only a QA id matches the artifact whose `qa_bug_id` equals it.
- An item with only an external ref matches the artifact whose `external_ref` equals it.
- An item with both matches only an artifact where **both** are equal. If the QA id and the external ref resolve to different artifacts, or the artifact has a different or absent `external_ref`, the item is unmatched.
- An item that matches more than one artifact is ambiguous and must fail. It is never resolved by choosing one.

Comparison is exact and case-sensitive.

## Freshness token

The fingerprint proves a sign-off matches the verdict, but only the readiness engine can recompute it. The **freshness token** lets a consumer prove, **without the readiness engine**, that an artifact still reflects the current ledger. It is `sha256` over a *superset* of the records the verdict could read, selected by header rules alone. It never uses timestamps.

For a non-release scope `S`:
1. **Bugs** `B`: `S` itself if it's a bug scope, plus every `bug:` stream with a `bug.reported` record whose `related_scopes` include `S`, or any record with `field: related_scopes` and `value: S`.
2. **Watched streams** `W = {S} ∪ B`.
3. **Direct runs:** runs whose first record's `scope` is in `W`, or whose `bug_ref` is in `B`.
4. **Builds:** the direct runs' `build_id`s, plus every build whose `related_scopes` include `S` or whose `fixes_claimed` intersect `B`.
5. **Runs:** the direct runs, plus every `smoke` run on one of those builds.
6. **Plans:** the paths in `S`'s `plans` adds, plus `<folder>/test-plan.md` for every case `<folder>/<id>` (no `#`) in its `regression_decisions` adds. Each is digested as `sha256` of the file bytes, or `missing`.
7. The token is `sha256(canonical({scope, streams, runs, builds, plans}))`, where:
   - `streams`: for each `w ∈ W`, sorted, `[w, [hash of each record except field: signoffs]]`;
   - `runs`: sorted by run id, `[run_id, [hash of every record]]`;
   - `builds`: sorted, `[id, build record hash | "missing"]`;
   - `plans`: sorted, `[path, digest]`.

For a missing stream, the token is `sha256(canonical({scope, missing: true}))`. For a release, it is `sha256(canonical({scope, stream: [own record hashes except sign-offs], members: [[m, token(m)] for each distinct member, sorted]}))`.

`canonical` is JSON with object keys sorted recursively and no whitespace (the ledger's own record encoding).

Consequences:
- Any append to a watched stream, run or plan moves the token.
- Unrelated scopes, builds, runs, sign-offs and generated Markdown don't.
- The token is deterministic and is not a verdict. A matching token proves the artifact was rendered from exactly the current ledger inputs.

## Consuming an artifact

A consumer (for example, the Dev plugin release gate) that is given an artifact at `<qa-repo>/readiness/<kind>/<id>.md` must:
- read the ledger at `<qa-repo>/qa-ledger/`;
- re-verify each record's `hash` it reads (records are hashed over their canonical form without `hash`);
- recompute the freshness token;
- reject the artifact when the token differs (**outdated**), or when the ledger is missing or corrupt (**unverifiable**).

A schema-1 artifact has no token and is unverifiable.

A consumer therefore makes two separate checks, and both must pass:
1. **Artifact integrity** first, before trusting any content. A mismatch means the artifact was **tampered**. A missing or duplicated field is malformed.
2. **Ledger freshness**, only on an artifact whose integrity holds. The token may differ (outdated) or be unverifiable.

A valid artifact from an older ledger fails freshness, not integrity. An edited artifact fails integrity, whatever the state of the ledger.

## Artifact integrity

The readiness artifact is a derived view and must be tamper-evident. `artifact_integrity` is **required** in every schema-2 artifact. It's the last frontmatter line, and the renderer computes it as follows:
1. Render the complete artifact **without** the `artifact_integrity` line: every frontmatter field, every body section, and the final newline.
2. `artifact_integrity = sha256:<hex>` of those UTF-8 bytes.
3. Insert `artifact_integrity: <value>` as the last line before the closing `---`.

A consumer verifies it this way:
1. Replace every CRLF with LF. This is the only normalization, so line-ending conversion by git is harmless.
2. Require exactly one frontmatter line starting `artifact_integrity:`, whose value is `sha256:<64 hex>`.
3. Remove that line, including its line break.
4. sha256 the remaining UTF-8 bytes.

The hash must equal the stored value. Nothing else is excluded or normalized: any other edit to any byte changes it. That covers any frontmatter field, the verdict, candidate builds, members, blockers, exceptions, known issues, tested builds, QA notes, Release Notes Input, any section, and whitespace.

It's deterministic, the same ledger renders the same bytes and the same hash, and it involves no timestamps and no keys. It proves the file is exactly what the QA helper rendered. It doesn't authenticate who rendered it: the QA repository's history does that.

## Readiness report

`readiness render` (also run by `readiness signoff`) writes `<qa-repo>/readiness/<kind>/<id>.md`. It's derived, deterministic (the same ledger gives the same bytes), and never read back.

**Delimited frontmatter:**
- `qa_readiness_schema`, `scope`, `scope_kind`;
- `dev_feature`, `qa_bug_id`, `external_ref` (each `null` when absent);
- `member_count` (release only);
- `candidate_builds` (a conflicting release surface is `null`);
- `verdict`, `blocker_count` (unexcepted), `exception_count` (applied), `fingerprint`, `freshness_token`;
- `generated_at`: the latest consumed record's time, not the wall clock;
- `signed_off_by`, `signed_off_date`, `signoff_fingerprint`, `signoff_status`;
- `artifact_integrity`: always last (see *Artifact integrity*).

**Body sections:** Blockers, Per-Surface Matrix, Smoke, Functional, Regression, Bugs, Retests, QA Debt, Exceptions, Known Issues, Tested Builds, QA Notes, Release Notes Input.

**Release artifact** (`readiness/release/<id>.md`): the same frontmatter and sections, plus `## Members` (`Scope | Kind | Dev feature | QA bug id | External ref | Verdict | Fingerprint`) before Blockers. Blockers gain a Member column. Exception ids and known-issue items are qualified `<member>#<id>`. Smoke, Functional, Regression and QA Debt refer to the member artifacts. Release Notes Input adds `Features tested`.
