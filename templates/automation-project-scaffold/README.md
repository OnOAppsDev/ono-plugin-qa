# QA Automation

Generated and maintained by `ono-plugin-qa`'s `/generate-automation-scripts` — one spec per feature under `tests/`, one page object per screen under `pages/`, named after the test case `id`s in that feature's `test-plan.md`.

## Setup (once)

```bash
cd automation
npm install
```

Edit `wdio.conf.js`'s `capabilities` block: set a real `deviceName`/`platformVersion` (a running emulator or connected device) and the built app's path.

## Run

```bash
npm test
```

## Adding more tests

Don't hand-edit the generated spec files directly for new coverage — update the feature's `test-plan.md` first (via `/sync-qa-test-plan` if sources changed, or by adding cases through the normal QA process) and re-run `/generate-automation-scripts <feature-slug>` so the plan and the automation stay traceable to each other.
