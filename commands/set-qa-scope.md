---
description: Configure a feature's QA execution scope — required surfaces, devices/runtimes per surface, the approved test plan, and per-surface exclusions.
argument-hint: [feature-name] [--qa-repo=path?]
---

Configure the QA execution scope for the feature in `$ARGUMENTS`: which surfaces QA must cover, on which devices/runtimes, against which approved test plan, and which cases do not apply on a given surface. Every value is entered or confirmed by the QA engineer — this command never infers surfaces, devices or exclusions from the code repo, Figma, a spec, or any other source.

All ledger writes go through `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" <command> --qa-repo "<qa-repo-path>" …` (one JSON object per call — branch on `ok` and `error.code`). Never edit `qa-ledger/` by hand.

1. Resolve `feature-name` from `$ARGUMENTS` and slugify it.
2. Resolve the QA repo path — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here. This command only needs the QA repo.
3. Run `init`. If `view scope --scope feature:<feature-slug>` returns `UNKNOWN_SCOPE`, create it after the human confirms: `scope create --scope feature:<feature-slug> --created-by "<name>"`.
4. Show the human the scope's current context from `view scope` (surfaces, devices, plans, exclusions) so an update starts from what is already recorded.
5. Check the plan: run `plan rows --plan <feature-slug>/test-plan.md`. If it doesn't exist, stop and point to `/create-qa-test-plan`. If its `status` isn't `approved`, stop and point to `/approve-qa-test-plan` — functional execution only ever runs against an approved plan.
6. Ask the human once, upfront, in a single pause:
   - **Required surfaces** — e.g. `ios`, `android`, `tvos`, `android-tv`, `web`. A surface not listed is not required for this feature.
   - **Devices/runtimes per required surface** — e.g. `ios: iPhone 16 / iOS 18.4`, `tvos: Apple TV 4K / tvOS 18`. At least one per required surface; functional runs are only accepted on a declared device.
   - **Exclusions** (optional) — a test-plan case that does not apply on one surface, with the reason (e.g. `EC-U1` on `tvos`: "tvOS has no user-facing network toggle"). Cases are named by their plan id; never exclude a case on your own judgment.
7. Write the answers — each call appends one event; earlier values stay in history:
   - `scope event --scope feature:<feature-slug> --op set --field surfaces --value '["ios","android","tvos"]' --by "<name>"`
   - `scope event … --op set --field devices --value '[{"surface":"ios","device":"iPhone 16","os_runtime":"iOS 18.4"}, …]' --by "<name>"`
   - `scope event … --op add --field plans --value '"<feature-slug>/test-plan.md"' --by "<name>"` — skip if the plan is already attached (`DUPLICATE_VALUE`).
   - For each exclusion: `scope event … --op add --field exclusions --value '{"case_key":"<feature-slug>/<id>","surface":"<surface>","reason":"<reason>"}' --by "<name>"`. To lift one: `--op retract --field exclusions --value '"<feature-slug>/<id>@<surface>"' --reason "<why>"`.
   - `SURFACE_NOT_IN_SCOPE` / `UNKNOWN_CASE` → the exclusion names a surface that isn't required or a case id the plan doesn't have; ask again rather than guessing.
8. Show the result with `view execution --scope feature:<feature-slug>` — one block per surface with its devices, latest build, smoke status and case summary.
9. Never run `git add`/`commit`/`push` in the QA repo — tell the human to review and commit manually.
