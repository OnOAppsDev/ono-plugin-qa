# QA Test Cases — Excel Export Schema

Contract for the Hebrew/RTL Excel export that `/create-qa-test-plan` and `/sync-qa-test-plan` produce alongside `test-plan.md`, as `test-cases.xlsx`. `qa-test-designer` and `qa-test-plan-syncer` populate an intermediate JSON file in this exact shape, then run `scripts/build-test-cases-xlsx.mjs` against it to produce the `.xlsx` file. Column order is fixed — do not add, remove, or reorder columns. **What goes into each cell is governed by the `qa-test-case-writing` skill** (full navigation path, fixed vocabulary, preconditions in Test Data, verifiable expected results, undefined-behavior policy); this file only covers the shape.

## Column order (A → F)

| Column | Header (English) | Content |
|---|---|---|
| A | Test ID | Always blank. The tester fills these in by hand — never generate or guess a value here. |
| B | Summary | 1–2 sentences, Hebrew: what is tested, not how. |
| C | Action | Hebrew steps, one per line in the same cell. The builder numbers them `1.`, `2.`, … |
| D | Expected Result | Hebrew, third person, future tense, verifiable. |
| E | Test Data/Parameter | Hebrew. Only the required user or a parameter set before the test starts (flag, CMS content, device state); otherwise blank. |
| F | Comments | Hebrew. Blank unless something important isn't covered by the other columns (Figma–spec gap, undefined behavior, hypothetical marker, repeat note). |

## Language

- All content is Hebrew; headers stay in English. English terms with no natural Hebrew equivalent may appear inline, but don't switch languages mid-sentence unnecessarily.
- Translate naturally and idiomatically, the way a native-Hebrew-speaking manual QA tester would phrase it — not a literal translation of the English plan.

## Groups

One sheet. Groups follow `test-plan.md`'s section order, each as a section row:

1. בדיקות פונקציונליות — one group **per screen/flow**, titled `בדיקות פונקציונליות — מסך "X"`, with sub-sections for that screen's popups, drawers and save bar when the plan has them
2. מסכי שגיאה
3. מקרי קצה ובדיקות שליליות (from design/spec)
4. כשלי API (בדיקות היפותטיות)
5. מקרי קצה כלליים (universal)
6. נגישות — always last, and only when the plan has an Accessibility section

Omit a group with no rows — never emit a header with nothing under it.

## Styling (applied by the builder — don't override)

One sheet, right-to-left, Arial. One soft color family per file (blue, green, purple, terracotta or teal, picked from the file's content): column header row frozen in the deepest shade; section rows a lighter shade of the same family; sub-section rows lighter still. Header text is black or white, whichever contrasts better (every level at least 4.5:1). White body, thin light-gray borders, no gridlines, text right/top aligned and wrapped with an indent, row heights sized to the text. Column widths A 11, B 40, C 58, D 62, E 42, F 46.

## Intermediate JSON shape

```json
{
  "sheetName": "מקרי בדיקה",
  "groups": [
    {
      "title": "בדיקות פונקציונליות — מסך \"עגלה\"",
      "rows": [
        {
          "summary": "...",
          "action": ["התחבר לחשבון", "לחץ על ..."],
          "expected": "...",
          "testData": "",
          "comments": ""
        }
      ],
      "subgroups": [
        { "title": "פופאפ \"הסרת פריט\"", "rows": [] }
      ]
    }
  ]
}
```

- `action` is an array of Hebrew steps **without numbers** — the builder adds `1.`, `2.`, … (a number already written is dropped, never doubled).
- `subgroups` is optional; its rows are written after the group's own `rows`.
- `testData` and `comments` are empty strings when not applicable — never omit the keys. Use `\n` inside them for several conditions.
- `summary` and `expected` are single Hebrew strings.

## Visual check

If LibreOffice is installed (`soffice`), render the file (`soffice --headless --convert-to pdf`, then to PNG) and look at it before delivering, to confirm styling and readability. If it isn't installed, say the visual check was skipped.
