# QA Test Cases — Excel Export Schema

Contract for the Hebrew/RTL Excel export that `/create-qa-test-plan` and `/sync-qa-test-plan` produce alongside `test-plan.md`, as `test-cases.xlsx`. `qa-test-designer` and `qa-test-plan-syncer` populate an intermediate JSON file in this exact shape, then run `scripts/build-test-cases-xlsx.mjs` against it to produce the `.xlsx` file. Column order and content rules below are fixed — do not add, remove, or reorder columns.

## Column order (A → F)

| Column | Header (English) | Content rules |
|---|---|---|
| A | Test ID | Always leave blank. The human QA engineer fills these in by hand — never generate or guess a value here. |
| B | Summary | 1–2 sentences max, in Hebrew. Since this schema has no separate screen/flow column, naturally fold the originating screen/flow name into the sentence (e.g. "במסך ההתחברות, ..."). |
| C | Action | Numbered steps in Hebrew, each on its own line **within the same cell** (a literal `\n` between steps, with wrap-text on) — never one run-on line. |
| D | Expected Result | Hebrew, third person (e.g. "האפליקציה תפתח את העמוד"). |
| E | Test Data / Parameter | Hebrew. Leave blank unless a special condition applies (e.g. a Firebase feature flag must be enabled). |
| F | Comments | Hebrew. Leave blank unless something important isn't covered by the other columns. |

## Language and formatting rules

- All test-case **content** is in Hebrew. Column headers stay in English. English terms with no natural Hebrew equivalent may appear inline, but never mix languages mid-sentence unnecessarily.
- Translate naturally and idiomatically, the way a native-Hebrew-speaking manual QA tester would phrase it — not a literal machine translation of the English source material.
- The whole sheet is right-to-left, every data cell is right-aligned, and wrap-text is on so multi-line Action cells render as separate visible lines.
- Rows are grouped in the same order as `test-plan.md`'s sections — Functional Test Cases → Edge Cases & Negative Tests (From Design/Spec) → Edge Cases & Negative Tests (Universal) → i18n/RTL Test Cases → Accessibility Test Cases — each group preceded by one bold, merged section-header row (in Hebrew) that is not itself a data row and has no Test ID.

## Intermediate JSON shape

```json
{
  "sheetName": "מקרי בדיקה",
  "groups": [
    {
      "title": "בדיקות פונקציונליות",
      "rows": [
        {
          "summary": "...",
          "action": ["שלב 1: ...", "שלב 2: ..."],
          "expected": "...",
          "testData": "",
          "comments": ""
        }
      ]
    }
  ]
}
```

- `groups` appears in the section order listed above; omit a group entirely if that section in `test-plan.md` has no rows (don't emit an empty group with just a header).
- `action` is always an array of one or more Hebrew strings — one per numbered step. The build script joins them with newlines into a single wrapped cell.
- `testData` and `comments` are empty strings when not applicable — never omit the keys.
- `summary` and `expected` are single Hebrew strings (no embedded newlines).
