---
description: Register a build delivered to QA for a feature, so smoke and functional results can be recorded against it.
argument-hint: [feature-name] [build-id] [--surfaces=a,b?] [--version=?] [--source=?] [--fixes=bug:<id>?] [--qa-repo=path?]
---

Register the build in `$ARGUMENTS` as delivered to QA for the feature in `$ARGUMENTS`, in the QA ledger (`<qa-repo-path>/qa-ledger/`). Every ledger write goes through the plugin's helper, `node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-ledger.mjs" <command> --qa-repo "<qa-repo-path>" …`, which prints one JSON object — branch on `ok` and `error.code`. Never create or edit files under `qa-ledger/` by hand.

1. Resolve `feature-name` and `build-id` from `$ARGUMENTS`, plus any `--surfaces=`, `--version=`, `--source=` and `--fixes=` given. The feature name may be omitted when the build only carries fixes for standalone bugs.
2. Resolve the QA repo path — see "Resolving the workspace" in `create-qa-test-plan.md`; the same convention applies here. This command only needs the QA repo.
3. Run `init` (idempotent — it creates the ledger on first use and does nothing afterwards).
4. If a feature name was given, slugify it (the same slug as its `<feature-slug>/test-plan.md` folder) and run `view scope --scope feature:<feature-slug>`; if it returns `UNKNOWN_SCOPE`, tell the human the feature has no QA scope yet and, once they confirm, run `scope create --scope feature:<feature-slug> --created-by "<name>"`.
5. Ask the human once, upfront, in a single pause, for whatever is still missing:
   - **Surfaces** this build ships (required) — the same surface ids used in `/set-qa-scope`, e.g. `ios`, `android`, `tvos`, `android-tv`, `web`. One build id may ship several surfaces; separate builds per surface are equally fine.
   - **Version** as delivered (optional). QA does not own version numbers — record exactly what dev/CI delivered, or leave it out. Never invent one.
   - **Source/reference** (optional) — CI link, store/TestFlight track, handoff path. It is stored as a reference and never opened.
   - **Registered by** — their name or handle.
   - **Fix claims** (optional) — bugs Dev says this build fixes, as `bug:<id>`. Record only what Dev actually claimed; never infer a fix from a changelog or commit message.
6. Run `build add --id <build-id> --surfaces <a,b> --registered-by "<name>" [--version "<v>"] [--source "<ref>"] --related-scope feature:<feature-slug> [--fixes bug:<id>]…`.
   - A fix claim never closes a bug — it moves it to `fix_delivered`, and only `/retest-bug` on this build decides. A claim is refused for a bug that isn't reproduced yet (`BUG_NOT_REPRODUCED`), is closed (`BUG_CLOSED`), or affects none of this build's surfaces (`FIX_SURFACE_MISMATCH`).
   - For a fix build of a standalone bug with no feature, leave out `--related-scope`.
   - `DUPLICATE_BUILD` → stop. Builds are immutable: a re-delivered or rebuilt artifact is a **new** build id, never a change to this one.
   - `UNKNOWN_SCOPE` / `INVALID_ID` → explain the error in plain words and ask for a corrected value.
7. Tell the human what was registered (build id, version, surfaces) and that the next step for each surface is smoke: `/record-execution <feature-name> smoke <build-id> <surface>`.
8. Never run `git add`/`commit`/`push` in the QA repo — tell the human to review the new `qa-ledger/` files and commit them manually.
