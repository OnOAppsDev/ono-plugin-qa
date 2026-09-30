# QA Readiness Contract

**Schema: `qa_readiness_schema: 1`** · **Implemented in Stage 6** by `scripts/lib/qa-ledger/readiness.mjs`, through `scripts/qa-ledger.mjs readiness …` / `view readiness` / `view signoffs`, and the `/qa-readiness` and `/qa-signoff` commands.

QA readiness is a deterministic verdict for one scope: `feature:<id>`, `bug:<id>` or `release:<id>`. It's computed **only** from records already in the QA ledger (Stages 1–5), plus this stage's explicit pins, exceptions and debt discharges.
- It never reads Project Knowledge, the Dev plugin, a release tool or an external tracker.
- It uses no heuristics and no judgment.
- It's derived on every read and never stored as state.

Release integration is not part of this stage. Release Notes stay Release-owned; QA supplies the verdict, its evidence, and a Release Notes Input section.

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

A `release:<id>` scope only aggregates its `members`:
- member verdicts;
- all member blockers (tagged with their member) and applied exceptions;
- tested builds.

| Condition | Release verdict |
|---|---|
| Any member `NOT_READY`, or no members | `NOT_READY` |
| Else any member `READY_WITH_EXCEPTIONS` | `READY_WITH_EXCEPTIONS` |
| Else | `READY` |

Pins, exceptions, sign-offs and the readiness report belong to member scopes (`RELEASE_AGGREGATION_ONLY`). There is no release artifact in this stage.

## Readiness report

`readiness render` (also run by `readiness signoff`) writes `<qa-repo>/readiness/<kind>/<id>.md`. It's derived, deterministic (the same ledger gives the same bytes), and never read back.

**Delimited frontmatter:**
- `qa_readiness_schema`, `scope`, `scope_kind`, `candidate_builds`;
- `verdict`, `blocker_count` (unexcepted), `exception_count` (applied), `fingerprint`;
- `generated_at`: the latest consumed record's time, not the wall clock;
- `signed_off_by`, `signed_off_date`, `signoff_fingerprint`, `signoff_status`.

**Body sections:** Blockers, Per-Surface Matrix, Smoke, Functional, Regression, Bugs, Retests, QA Debt, Exceptions, Known Issues, Tested Builds, QA Notes, Release Notes Input.
