# QA Project Knowledge consumer rules

**Contract:** [`docs/repo-knowledge-contract.md`](repo-knowledge-contract.md). It's vendored verbatim from `ono-plugin-project-inspector` (`origin/main` `6fa811d`, identical below the title to the Dev Plugin's copy).

**Reader:** `scripts/vendor/read-repo-knowledge.ts`, vendored verbatim from `ono-mobile-dev-plugin` (`origin/main` `9472f43`; sha256 `beae2fd7…aebf`).

**Consumer module:** `scripts/lib/qa-ledger/knowledge.mjs`. It's the only QA component that runs the reader, and the only one that sees the manifest.

The contract names "`ono-mobile-dev-plugin` (and future Ono plugins)" as consumers. This plugin is one of those future plugins, and consumes the contract unchanged. When the Inspector changes the contract, or the Dev Plugin changes its reader, re-vendor both files in the same release. There is no QA-specific Project Knowledge schema.

## What Project Knowledge is for in QA

It's **context**. It is used to:
- confirm a capability by deterministic identity (id, exact name, or a source path);
- surface context;
- suggest a capability's **direct** neighbours as **regression candidates**, each with the relationship and its re-checked evidence;
- find existing QA coverage for those neighbours.

It **never**:
- authors or changes a test-plan case;
- replaces Spec + Design;
- decides PASS/FAIL or whether a bug reproduces;
- decides regression scope, or silently adds anything to execution;
- looks past the first degree, builds a graph, or scores or ranks candidates.

## Planning isolation

`/create-qa-test-plan`, `qa-test-planning`, `qa-test-designer`, `/sync-qa-test-plan`, `qa-test-plan-sync` and `qa-test-plan-syncer` never consume Project Knowledge. Test-plan authoring stays Spec + Design → QA scenarios.

A capability bound later (Stage 4's Dev handoff, or `/plan-regression`) is identity on the ledger scope. It never changes the authored scenario set. `scripts/qa-regression.test.mjs` checks that none of those files references Project Knowledge, the reader or the ledger.

## Semantics kept from the ecosystem

**Categories.** The reader decides `trusted` / `verifyOnUse` / `deriveLive` per category, from the manifest's freshness and source drift. This plugin adds no second freshness mechanism.

**Stricter evidence rule.** QA always runs the reader with `--verify`, so every relationship's evidence is re-checked against the current source before it's shown, even when the category is `trusted`. A relationship whose evidence no longer holds (`invalid`) is **dropped** from the candidates and listed separately, for QA to reason about manually. It's never presented as current context.

**Current source wins.**

**No knowledge is never an error.** A missing, stale, unparseable or too-new manifest, a `deriveLive` category, or a Node that can't run the reader all mean one thing: regression is planned manually (`--candidate`). The Feature and Bug lifecycles never depend on Project Knowledge.

## Capability identity

- **Feature scope:** the capability bound by Stage 4 (from the Dev Feature Analysis) is used as-is. It's looked up by exact id only, never re-matched by name or similarity.
- **Standalone bug:** QA binds one explicitly (`scope event --field capability`) after an exact lookup (`knowledge lookup --capability <id or exact name>` / `--path`).
- **Several matches:** reported as `ambiguous`, and QA picks. `regression decide` refuses an ambiguous capability (`CAPABILITY_AMBIGUOUS`).
- **No match:** manual planning.

## Existing QA coverage (no new index)

Existing coverage for a capability is derived from what the ledger already holds:
- QA scopes whose `capability` (or `dev_handoff.capability`) is that capability;
- their plans' cases, or a bug scope's own `bug:<id>#R1`;
- generated automation under `automation/tests/<feature-slug>/`;
- the capability's Project Knowledge `tests` evidence, shown as code-repo test evidence and never turned into QA cases.

Nothing is invented. An unknown result says so (`known: false`).
