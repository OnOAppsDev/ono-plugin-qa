---
name: qa-test-planning
description: Methodology for authoring a QA test plan from Figma and/or spec/LLD documentation, before dev's implementation is done. Used by /create-qa-test-plan via the qa-test-designer agent and the qa-test-plan template.
---

## Methodology

1. **Require at least one real grounding source before doing anything else.** Figma and a spec/LLD doc are both asked for up front; either may be explicitly marked not applicable with a stated reason (e.g. "no UI, no Figma"), but if neither a Figma link nor a spec/LLD doc nor any other QA-supplied doc exists, stop and ask the human — there is nothing to ground test cases in otherwise. Never invent screens or flows from just a feature name.
2. **Enumerate frames and states via the `figma` MCP server** when a Figma link exists. Use `get_metadata` to see the file/page/frame structure, `get_design_context` to pull component and content detail, and `get_screenshot` for anything ambiguous. Include loading/empty/error/success/permission/validation variants as distinct states, not just the "happy path" frame.
3. **Read the spec/LLD** when one exists, for functional requirements and business logic Figma doesn't show (validation rules, edge-case behavior, backend constraints). Ground visual/interaction detail in Figma and functional/business-logic detail in the spec. If the two sources describe the same thing differently, don't silently pick one — log it under Open Questions.
4. **Derive functional test cases per screen/flow**, naming the actual button/label text and layout from the design where one exists, or the behavior described in the spec where it doesn't.
5. **Derive edge cases in two buckets**: source-derived (an explicit error/empty state shown in Figma or described in the spec) and universal (network loss, backgrounding, interruption, permission denial, rotation — always worth testing regardless of what's designed or specified).
6. **Write i18n/RTL and accessibility checks as scenario-level test steps in plain language** — no standard IDs, no reference to `ono-mobile-dev-plugin`'s `standards/` docs.
7. **Log anything the sources leave ambiguous** (an undesigned error state, an unclear interaction, a Figma/spec conflict) as an open question for a designer/PM/dev to resolve — never silently guess.
8. **Record every source actually consulted** — Figma link, spec/LLD path/link, and anything else QA supplied — into the "Input Sources" table, including explicit `N/A — <reason>` rows for any category that doesn't apply. This is what `/sync-qa-test-plan` later re-checks when sources change.
9. **Populate `templates/qa-test-plan-template.md` in full**, including "Screens & Flows Covered" with enough detail (frame names/links or spec section references) that `/check-qa-coverage` can later match it against the dev handoff's "Screens & Flows Touched".
10. **Export the same test cases to a Hebrew/RTL Excel file** per `templates/qa-test-cases-xlsx-schema.md`: take the Functional, Edge Cases (From Design/Spec and Universal), i18n/RTL, and Accessibility test cases just authored, translate each into natural, idiomatic Hebrew (not a literal machine translation) as the schema's Test ID/Summary/Action/Expected Result/Test Data/Comments columns, write them to a temporary JSON file in the schema's shape, and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/build-test-cases-xlsx.mjs" <input.json> <output.xlsx>` to produce `test-cases.xlsx`.

## Unchanged constraints

- Never read the code repo, dev's implementation plan, or dev's QA handoff doc — that coupling belongs entirely to Phase 2 (`/check-qa-coverage`). Phase 1 stays independent of dev's progress, whether grounded in Figma, a spec/LLD, or both.
