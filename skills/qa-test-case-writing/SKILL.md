---
name: qa-test-case-writing
description: The QA team's rules for writing manual test cases — full navigation paths, fixed Hebrew vocabulary, preconditions in Test Data, verifiable expected results in plain language, the undefined-behavior policy, hypothetical failure tests, what not to test, required cases per data-rule type, the general edge-case checklist, Figma text comparison and the final review. Invoked by qa-test-designer and qa-test-plan-syncer for every test case they write or rewrite.
---

These rules come from the QA team's own experience executing the plugin's output. A human tester runs every row on a real device, so every row must be reproducible by someone who has never seen the app. When a rule here conflicts with your instinct, the rule wins. They apply to the test cases in `test-plan.md` and, in Hebrew, to every row of `test-cases.xlsx`.

## 1. Before writing

1. **Read the app knowledge file** (`<qa-repo>/app-knowledge.md`, shape in `templates/app-knowledge-template.md`) before writing anything. If it doesn't exist, create it from the template. Reuse its navigation paths word for word, and follow its "What the tester can control" section (§3). Update it as new information arrives (spec, Figma, conversation): add only what a source states, never extrapolate, and record contradictions between sources as QA notes instead of resolving them.
2. **Image-heavy specs (docx/PDF):** text extraction isn't enough — also view the embedded images; UI mockups often live there. When reviewing an existing test case file, read every row and state the total row count you read.
3. **After 2 failed attempts with any approach, stop and propose an alternative.** Never loop.

## 2. Figma

Figma is the source of truth for UI unless the spec says otherwise. Never write UI expectations from the spec alone when Figma is available.

- Workflow: `get_metadata` without a node id → pages → `get_metadata` on the page/section → frames → `get_screenshot` on each frame. Screenshot sub-nodes (a single card) when a full frame renders too small to read.
- Check **every** frame in the relevant section, not only the ones the spec links to — sections often hold error screens, drawers, popups and alternate states the spec never mentions. Frames that exist only in Figma still get test cases (undefined-behavior policy, §5).
- Node ids in the spec may be outdated. If one isn't found, find the frame by name in the section metadata. Never write node ids (old or new) in the test cases — name the frame (`פריים Privacy`); if the change matters, mention it by frame name in the final summary.
- Figma may only resolve nodes on the page currently open; if nodes come back empty or "not found", ask the human to open that page in Figma and retry. If that can't be done now, say so in the final summary — never in the file.
- **Static-text table — build it before writing test cases.** List every fixed text in the feature (screen titles, card titles, labels, buttons, popup/drawer titles and texts, error-screen texts) with the spec text and the Figma text side by side, and compare them **character by character**. Small differences count: a missing or extra yod (`הבטחון` / `הביטחון`), `״` vs `"`, `”` vs `"`, `/` vs `-`, spaces, punctuation. When they differ, Expected Result uses the Figma text and Comments state both. When Figma has a clear typo, Expected Result uses the correct text and Comments state the typo so it isn't copied into the app. The table is a working tool, not part of the output.
- **Figma sample data is illustration only.** Names, phone numbers, ID numbers, emails, addresses and dates in Figma are examples, not a real test user's data. Never copy them into Action, Expected Result or Test Data, and don't compare against them — so they need no comment either.
- Also check: popups/drawers drawn over an old screen or a screen from another flow — note the background isn't part of the design; several frames of the same screen — compare them to each other.
- Every Figma–spec gap (colors, texts, labels, element order, formats, elements present in one and missing in the other) goes into the Comments of the relevant test case **and** into Open Questions, and is listed in the final summary.

## 3. What the tester can and cannot control

Access to backend services **differs per app**. The app knowledge file's "What the tester can control" section records, per app, which services the tester can change (for example Firebase flags/Remote Config/push, Umbraco content), whether each is confirmed, and whether a read-only network logger is available. If it isn't recorded, ask the human once and record the answer there. The tester never has access to anything else — no backend database, no API servers, no proxy/mock tools.

- **Service failures the tester can't cause are still written** — API errors, failed saves, error screens — with the full navigation path and expected behavior, but **without** any "simulate the failure" step and without proxy/mock instructions. They are **hypothetical test cases**, marked in Comments (never in Test Data): `בדיקה היפותטית: רלוונטית רק אם הקריאה X נכשלת בפועל`. If the tester hits the failure for real, they know what should happen; otherwise they skip it.
- **Don't write test cases that need an action in a service the tester can't access** — editing backend data, corrupting or emptying an API response. They can't be executed. (Needing an existing test user with specific data is fine — that's choosing a user, not changing a service.)
- Changes in Firebase or Umbraco are valid — put the exact flag/content change in Test Data. When access to that service isn't confirmed for this app, still write the row and add in Comments: `רלוונטי רק אם יש גישה ל-Firebase` (or `ל-Umbraco`).
- **Never refer to the tester in the third person** anywhere in the file — no `הבודק`, `לבודק`, or the tester's name. Write conditions impersonally: `רלוונטי רק אם יש גישה ל-Firebase`, never `רלוונטי רק אם לבודק יש גישה ל-Firebase`.
- Device-level conditions are always valid: airplane mode, permissions, device language, font size, dark mode, network limiting (Network Link Conditioner on iOS, developer options on Android).
- **The logger is a debugging tool, not something to test.** Never check in the logger that a call was sent (or what it returned) when the result is visible in the app — if the data appears, the call succeeded; if it doesn't, the row that displays it fails and the tester opens the logger themselves. A logger expectation is valid only when the request itself is the behavior under test **and** nothing in the app shows it (e.g. "ביטול" must not send the save request; a double tap on a submit button sends one request, not two). See §5.

## 4. Columns

Order (A is rightmost in the RTL sheet): **A Test ID → B Summary → C Action → D Expected Result → E Test Data/Parameter → F Comments.** In `test-plan.md` the same content lives in `id | screen/flow | steps | expected result | test data | comments`. All Excel content is Hebrew except English terms with no Hebrew equivalent (WebView, Push, Face ID, a call name in a logger expectation); don't switch languages mid-sentence unnecessarily.

- **A — Test ID:** always blank in the Excel file; the tester fills it in.
- **B — Summary:** 1–2 sentences. What is tested, not how: the action or condition **and** its outcome. `הכפתור "עדכון" בכרטיס הכתובת פותח את טופס עדכון הכתובת.`, not just `כפתור "עדכון" בכרטיס הכתובת.` Another example: `ניסיון חוזר ממסך השגיאה טוען את המסך אחרי שהחיבור חוזר.`

## 5. Action, Expected Result, Test Data, Comments

### Action
Numbered steps (`1.`, `2.`, …), one per line in the same cell.

**Full navigation path — mandatory.** There is no step like `הגע למסך X` / "go to screen X". Every test case spells out how to get from logging in to the place where the test happens, then the test steps.

Wrong:
```
1. הגע למסך "מידע אישי"
2. לחץ על "עריכה"
```
Right:
```
1. התחבר לחשבון
2. לחץ על התפריט
3. לחץ על "מידע אישי"
4. לחץ על "עריכה" בשדה "מצב משפחתי"
5. שנה את הפרט X לפרט Y
```

- Hebrew imperative, masculine singular: `התחבר`, `לחץ`, `גלול`, `בחר`, `צפה`, `סגור`, `פתח`, `חזור`, `החלק`.
- **Fixed vocabulary, every time:** first step `התחבר לחשבון`; observation steps `צפה ב…` (no `שים לב ל…`, no other non-action steps); `פופאפ` (not דיאלוג/חלון), `מגירה` (not Bottom Sheet), `סרגל השמירה` (not פס השמירה), `הרקע המוחשך` (not הרקע המוצל), `כפתור החזרה` (in-app) vs `כפתור החזרה של המכשיר` (Android).
- No placeholders (`{X}`, `{שם}`). Describe the element by its visible fixed text (`לחץ על הפס "מידע נוסף"`) or by the Test Data condition (`בכרטיס של איש קשר שיש לו שני מספרי טלפון`) — never by Figma sample data (not `בכרטיס "ישראל ישראלי"`).
- Name every button, card and field exactly as it appears in the UI, in quotes. Never use internal screen numbers ("Screen 14") — describe screens by their visible title.
- Include scrolling when the target is below the fold (`גלול לכרטיס "חשבון בנק"`).
- If the app is reopened mid-test, write the steps after reopening too (`סגור את האפליקציה לגמרי` → `פתח את האפליקציה מחדש` → the navigation path again, without re-login if the session persists).
- Build each navigation path once and reuse it identically in every test case for that screen; store it in the app knowledge file's "Screens & navigation".
- **Preconditions never go in Action**: which user to log in with, feature flags, enabling airplane mode before the test, a permission blocked beforehand — all go in Test Data. Action holds only what the tester does in the app plus the device actions that are part of the scenario (backgrounding, rotating, answering a call, opening device settings from an in-app button, returning).
- When a device change is part of the scenario at a specific moment (e.g. turning the internet back on before tapping "נסה שוב"), write it as a step in Action: `כבה את מצב טיסה`. Test Data holds only the state at the start of the test.

### Expected Result
- Third person, future tense: `האפליקציה תפתח את העמוד`, `האפליקציה תציג...`, `האפליקציה לא תשנה...`. The subject doesn't have to be "האפליקציה" — a short phrasing that starts with the component is fine, as long as it's future tense and exact: `בכרטיס "פרטים אישיים" יוצגו: …`, `המתג "התראות" יהיה כבוי.`
- Concrete and verifiable: exact texts in quotes, exact formats with an example value, exact destination screens.
- **No Figma sample values.** Values from the user's data (names, phones, IDs, emails, addresses, dates, percentages) aren't fixed — describe what is shown and in which format: `האפליקציה תפתח את החייגן עם מספר הטלפון של איש הקשר`, `בשורה "כתובת" תוצג הכתובת בפורמט: רחוב מספר בית, יישוב`. Write an exact value only when it is fixed in the app (UI texts, button labels, a fixed hotline number) or when Test Data fixes it.
- **No vague wording.** Rewrite any of these before delivering:

| Don't write | Write instead |
|---|---|
| `תציג את הערך "ללא הגבלה" ללא שינוי` | Fold it into the test case that shows that component: `שורה "תוקף" עם הטקסט "ללא הגבלה"` |
| `מסך ההגדרות יישאר ללא שינוי` | `תציג את מסך "הגדרות" עם שם המשתמש בכותרת ו-4 כרטיסי הניווט` |
| `תציג את המסך כפי שהיה` | Name the screen and what's on it |
| `הכרטיסים ימשיכו לעבוד כרגיל` / `יוצגו כרגיל` | List the components that are shown |
| `בהתאם לנתונים של המשתמש` | Name each field and which of the user's values it shows (Test Data names the user) |
| `בצורה תקינה`, `בסדר הנכון`, `בפריסה תקינה`, `בכיוון הנכון` | The exact expected rendering with an example value, or "כמו ב-Figma" plus what that means |
| `האפליקציה לא תקרוס` (alone) | The screen and state the user ends up in |
| `תתנהג לפי ההחלטה`, `תעבוד כרגיל`, `בנוחות`, `בניגודיות מספקת` | A measurable criterion (`יחס ניגודיות של לפחות 4.5:1`) |
| `הבחירה תתאים לערך שנשמר בשרת` | Something visible in the app (`בכניסה מחדש למסך תוצג מסומנת האפשרות "במייל"`) |
| `תתעדכן לפי מצב התצוגה של המכשיר` | Each state: `כשהמכשיר בתצוגה כהה, האפליקציה תוצג בתצוגה כהה` |
| `בלי מצב משובש` | The exact screen and the exact selected value |
| `תשבור לשורות או תקצר` / any "X or Y" outcome | One outcome. If undefined, the certain part here and the gap in Comments (policy below) |
| `טקסטים שתואמים בדיוק לעיצוב` | The list of texts to check |

  A specific design reference is fine: `כמו ב-Figma: התווית בעברית מימין והתווית באנגלית משמאל`.
- Don't write a test case whose whole point is a value that "stays as is" — it belongs inside the test case that displays that component.
- Never write untestable expectations (`יש לתעד את התנהגות האפליקציה`, `צפוי שתוצג הודעה או ערך דומה`). "Won't crash" alone is too weak — add the screen and state.
- **Undefined behavior — one fixed policy.**
  - Expected Result holds only what is certain and visible: which screen remains, which components and values are shown, and that the app doesn't crash.
  - Comments hold only `לא מוגדר באיפיון:` + what exactly is undefined. Nothing else — no guess (`צפי סביר:`) and no `לעדכן את התוצאה הצפויה לאחר החלטה`. Never write a guessed behavior anywhere.
  - Write each undefined point once, in the row that tests that behavior itself (e.g. the row that checks a toggle's effect), not in every row that touches the same component.
  - An assumption about what a control or feature does is also undefined behavior — handle it the same way.
  - The same gap is also logged under Open Questions in `test-plan.md`.
- **Expectations checked in the logger:** only per §3 — the request itself is the behavior under test and nothing in the app shows it. Never add a logger check to confirm that data visible on screen was loaded. Visible result first, then the request result, naming the call in the Expected Result itself; nothing about the logger goes in Test Data. Example: `האפליקציה תסגור את סרגל השמירה ותסמן שוב את "ב-SMS". בלוגר לא תופיע קריאת השמירה UpdatePreferences.`
- **One outcome per row.** No multi-stage expectations that check two behaviors (a change and its persistence after restart) — split them. Multi-stage is fine only for one behavior ("loader, then the screen").
- Don't invent behavior the sources don't state. Omission beats a fabricated expectation.
- **Write what the tester sees.** Describe screens, texts and values as they appear in the app. API field names, record types and code values (`phonePrefix`, `phoneType=3`, `gender=1`) don't belong in Expected Result or Test Data — describe the data in plain language (Test Data below). The only exception is the call name in a logger expectation §3 allows.

### Test Data/Parameter
**Strict rule: only the conditions needed to run the test.** Fill it in exactly two cases:
- **A user with specific data or of a specific type is required:** `יוזר להתחברות: משתמש עם 3 ילדים`, `יוזר להתחברות: משתמש עם אופן שליחת הודעות = מייל`, or the user type/role in apps that have several. When it doesn't matter, don't mention a user.
- **A parameter that must be set before the test starts:** an exact Firebase flag / Remote Config value or Umbraco content, or a device setting: `הרשאת התראות חסומה לאפליקציה בהגדרות המכשיר`, `מצב טיסה מופעל`, `מכשיר Android`, `מכשיר ללא חומרה לזיהוי ביומטרי`, `רשת מוגבלת ל-3G (Network Link Conditioner ב-iOS או הגבלת רשת בהגדרות המפתחים ב-Android)`.

Nothing else goes here: hypothetical markers, `חזור על הבדיקה ב…`, Figma–spec gaps and undefined behavior → Comments; logger checks → named in Expected Result; steps and mid-test changes → Action; why the test exists or a restatement of the expected result → nowhere. If neither case applies, leave it empty.
- **No Figma sample data.** Write only what the user must have: `יוזר להתחברות: משתמש עם מספר טלפון נייד, מספר טלפון נוסף ומייל`, not `משתמש בשם ישראל ישראלי עם הטלפון 0541234567`.
- **Plain language, not code.** Write data the way a person would say it: `מין = זכר` (not `gender=1`), `סוג חשבון = עסקי` (not `accountType=2`), `אופן שליחת הודעות = מייל` (not `deliveryOptionId=2`), `משתמש בלי ילדים` (not `אין familyMembers[relation=1]`). Use a technical name only when there is no plain way to describe the condition, and then add its meaning (`סוג טלפון = 3 (נייד)`).
- **Deterministic data:** if the result depends on a starting value, fix it here (`יוזר להתחברות: משתמש עם אופן שליחת הודעות = SMS`) and name the resulting value in Expected Result. No `בחר אפשרות שונה מהמסומנת` — name the option. Prefer explicit example values (`אנשי קשר עם סדר תצוגה 3, 1, 2`). These are values of the test user, never Figma sample data.

### Comments
Only for something important not covered elsewhere:
- Figma–spec discrepancies — state both versions only, not which one is the source of truth.
- Figma typos that must not be copied into the app.
- Undefined behavior — `לא מוגדר באיפיון:` + what is undefined, nothing more (policy above).
- Concrete open questions to clarify before or during testing: `לברר: תוך כמה זמן פג תוקף ה-Session`.
- The hypothetical-failure marker (§3).
- `רלוונטי רק אם יש גישה ל-Firebase` / `ל-Umbraco` when access isn't confirmed for this app (§3).
- Repeat notes `חזור על הבדיקה ב…` (§6).

Write the actual question or fact — never reference documents that aren't in the file ("see open question 17").

Never write, in Comments or anywhere in the file:
- Rules the tester already set or that are in this skill ("Figma is the source of truth", "the expected result follows Figma").
- Figma node ids (`15556:5618`) — name the frame (`פריים Privacy`, `פריים "פרטים" עם המגירה`), and tell same-named frames apart by what's visible in them.
- Notes about your own process or gaps: `עדיין לא הושווה ל-Figma`, `בסריקת הקוד לא נמצא…`, why a check isn't there (`אין כאן אימות בלוגר כי…`), `זו הנחה שטרם אושרה`, a generic `לוודא מול הפיתוח`.
- Guesses (`צפי סביר:`) or `לעדכן את התוצאה הצפויה לאחר החלטה`.
- Any reference to the tester in the third person (§3).

## 6. Quality rules

- **No irrelevant test cases.** Don't write a case that checks something the tester sees anyway in another case — mainly a logger check that the call loading a screen or object was sent (§3). Remove such rows before delivering.
- **No unnecessary duplicates.** Every test case checks something no other one does. Common duplicates: a "navigate to X" case next to the "X structure" case that already opens X the same way; the same format check repeated in the functional, edge-case and accessibility sections; the same layout check repeated per screen.
- **Split vs. repeat — decide by how the result would be reported:**
  - **Separate rows** when each variant needs its own Pass/Fail: each enum value from the server, each user/data condition, each permission state, each platform when behavior differs, each data-loading screen in offline/API-failure tests.
  - **One row + `חזור על הבדיקה ב…`** only when the check is identical and a failure anywhere is the same bug: maximum font size, contrast, Android back / iOS swipe on sub-screens.
  - Never put two data conditions that can't exist for one user in the same row (a user with no children and a user with 8 children → two rows).
  - Never combine "change X" and "X is kept after leaving / restarting" in one row.
- **One structure test case per screen state**, listing everything visible in that state (title, back button, every card/section in order, their fixed texts). Don't split one screen's structure into several rows.
- **One scenario per test case, not one component per test case.** List every component of the scenario and its state in one Expected Result (e.g. a card with three fields → one row naming all three). Split only for a different action, a different data condition that can't be shown in the same pass, or a different outcome.
- Exact UI text, character for character. Formats with examples: dates `DD.MM.YYYY` (`16.09.1967`), phones `0545413456` / `03-7380339`, percentages `90%`.
- Every interactive element gets tested (every button, link, toggle, radio, drawer, popup, close X, back button and its destination). Every data rule gets its own test case: field mapping (only when the result is visible — §6.1), the empty-value fallbacks the spec defines, formatting, conditional display, sorting. Both directions of every condition: shown and hidden, with and without permission, success and failure, zero, one and many items.
- When the human names a range or starting point for a fix, apply it to **all** affected rows from that point on — never narrow it.

### 6.1 What not to test
Every row must be a realistic scenario that can happen in this app. Don't write:
- **Negative input tests for fields the user can't change.** Invalid, empty, too-long or wrong-format input is tested only for fields the spec explicitly says the user can edit. If the spec doesn't say a field is editable, it isn't.
- **Missing or abnormal server data the spec doesn't mention** — empty name, missing case number, a code missing from a lookup table, leading/trailing spaces, different raw formats (`"90 "` vs `"90%"`). Only when the spec says the case is possible or defines how it's shown (e.g. "if empty, show 'אין מידע'"). If the spec is silent, the case is assumed impossible.
- **Long texts and special characters** (very long names, hyphens, apostrophes, quotes) — only when the spec defines something about them (`עד 40 תווים`, truncation with "...").
- **WebView content.** A WebView is tested for three things only: it opens from the app, it is displayed properly on the device (full screen, not on half a screen), and it closes back to the right screen. Not its content, its URL, the session inside it or offline inside it. If the URL matters, put it in Comments. One row per entry point that opens a different WebView (the Summary names what opens), plus one close row with `חזור על הבדיקה ב…` in Comments.
- **Elements the spec puts out of scope** — don't write a test that checks they are not shown.
- **Mapping between two similar fields when the difference isn't visible** — only when they produce a visibly different result (`"ישראל"` vs `"IL"`).
- **Devices missing a capability:** no dialer, no mail app, no browser, no SIM, no biometric hardware.
- **Device matrices:** tablets, small screens, runs on min/latest OS versions, additional RTL device languages (e.g. Arabic). A device language other than the app language (e.g. English) **is** tested.
- **A separate RTL / i18n section** (layout direction, numbers inside Hebrew text, LTR strings inside RTL, bilingual fields).
- **Network edge cases beyond offline:** disconnect mid-load, slow network, offline inside a WebView or when opening an external link. Offline on each data-loading screen + recovery via retry **is** tested.
- **Background / interruptions per open component:** background the app and receive an incoming call once each — not again with every drawer, popup or document viewer open. Returning from an external browser, the share sheet and device settings **is** tested; returning from the dialer or the mail app is not.
- **Server-saved setting extras:** double tap on save, reselecting the original value before saving, backgrounding with an unsaved change, killing the app mid-save.
- **Touch target size.**

### 6.2 Merging rows
- Several fallbacks (`אין מידע`) in the same object (e.g. two fields of the same card) → one row, when one test user can show all of them.
- Hypothetical API failures → one row per screen or action, not per call. Calls that serve the same screen share one row.

## 7. Coverage

Sections, in this order (the `test-plan.md` sections and the Excel groups follow it):

1. **Functional** — one sub-section per screen/flow in navigation order: entry point, structure, every element, every navigation and back destination, every data rule, every popup/drawer/save bar.
2. **Error screens** — every error screen in the sources (including Figma-only ones): structure and every button with its destination.
3. **Edge cases from the spec and design** — the §7.1 table, plus input validation for fields the user can edit, permission revoked mid-session, returning from device settings without granting, double/rapid taps on actions (logout, download/export), leaving with unsaved changes, and long texts only where the spec defines a limit (§6.1).
4. **API failures (hypothetical, §3)** — one row per screen or action (§6.2).
5. **Universal edge cases** — the §7.2 checklist.
6. **Accessibility — always the last section, and only when needed.** Write it when the spec or Figma explicitly calls for accessibility, or when the human confirmed which accessibility tests to include (`/create-qa-test-plan` asks upfront). Otherwise leave the section out. Typical items: screen reader labels for icon-only buttons, reading order, toggles/radios announced with state, focus trapped in popups/drawers and returned on close, floating bars reachable, dynamic/maximum font size, contrast in light and dark mode (at least 4.5:1, WCAG AA).

Undefined behaviors are still test cases (§5). Skip anything that needs a service the tester can't access (§3) and everything in §6.1.

### 7.1 Required cases per data-rule type
For every data rule in the sources (every row of a data-mapping table, every composition/format/display rule), one row each unless §6 says otherwise:

| Rule type | Required cases |
|---|---|
| Composed string (address, full name, "X% …") | all parts present; each optional part missing on its own (no entrance, no apartment, no house number, empty street, PO box); a part in Latin letters inside Hebrew text (e.g. a town abroad). Leading/trailing spaces only per §6.1 |
| Lookup by code (city, country, phone prefix, marital status) | known code (the decoded text is shown, e.g. "ישראל" and not "IL"). A code missing from the table only per §6.1 |
| Field chosen among similar fields (a mobile phone record vs a general phone field) | a user for whom the two values differ — only when the difference is visible on screen (§6.1) |
| Conditional element (icon, button, banner, sub-card) | shown; hidden; invalid or partial data only when the spec defines the rule (e.g. "mail icon only for a valid email" → an email without @) |
| Enum / radio value from the server | each value (separate rows); missing only per §6.1 |
| Number, percentage or date formatting | each raw format the sources mention (one row each); the displayed format with an example value |
| List | 0 items; 1 item; 8+ items; sort order with explicit values (sort values 3, 1, 2; an empty sort value only if the spec defines where it goes) |
| Missing value with a fallback ("אין מידע") | each field with a fallback, with a user missing it (merged per §6.2) |
| Device-permission toggle | granted; denied (popup); granted via "go to settings" and return; return without granting; revoked in device settings while the app is open |
| Locally saved setting (toggle, radio) | default on a fresh install; each change (separate rows); kept after leaving and re-entering the screen; kept after restarting the app; the effect of the setting itself whenever it can be triggered through Firebase or Umbraco (e.g. send a Push to check vibration; add `רלוונטי רק אם יש גישה ל-Firebase` when access isn't confirmed) — if the sources don't define the effect, the certain part in Expected Result and the gap per the undefined-behavior policy (§5) |
| Feature that depends on a device capability (biometrics, dialer, mail app, browser, camera) | capability present but not set up (no enrolled fingerprint/Face ID); present and set up. Not: capability absent (§6.1) |
| Choice that depends on other user data (delivery channel, contact method, payment method) | a user whose data fits the choice; a user who lacks the data it needs ("במייל" for a user without an email); a user whose data doesn't fit it (SMS limited to local numbers for a user with a foreign mobile number). One row per type of conflict, not every combination of option and missing data. If undefined, the undefined-behavior policy (§5) |
| Server-saved setting | change + save success; kept after leaving and re-entering the screen; kept after restarting the app; cancel; cancel, leave and re-enter (the original value is shown); save failure (hypothetical); save offline; leave the screen with an unsaved change |
| Logout | open; confirm; cancel; X; tap on the dark background; failure (hypothetical); double tap on confirm; reopen after logout; Android back after logout; switch to another user (no stale data) |
| External link | opens the right destination (external browser vs in-app, per the sources); return to the app |
| WebView | opens from the app; displayed full screen and properly on the device; closes back to the right screen. Nothing inside it (§6.1) |

### 7.2 General edge-case checklist (mandatory)
Go over every item and report it in the plan's "Edge-Case Checklist Report" as `covered in <id>` or `not relevant because …`. Never skip one silently.

- No internet on each data-loading screen + recovery via "retry"
- Offline per action type the app handles itself: save, download/export
- App to background and back (once)
- Incoming call (once)
- Returning to the app from an external browser, from the share sheet and from device settings — which screen and which state are shown on return
- Session expiry while on a feature screen
- Switching users after logout — no data of the previous user
- Android back: sub-screen, drawer, popup, login screen after logout
- iOS edge-swipe back
- Rotation
- Rapid double taps on actions (logout, download/export)
- Device language other than the app language (e.g. English)
- Screenshots of sensitive data (only if the sources say something about it)

Items listed in §6.1 are left out of this checklist on purpose — don't add them back.

## 8. Final review before delivering

1. **Spelling and sense, especially Hebrew.** Read every cell; fix typos, broken sentences, gender/number agreement and inconsistent terms.
2. Every Action starts with `התחבר לחשבון` and has no "go to screen X" shortcut.
3. No preconditions in Action; every user, data, permission, device condition and service change is in Test Data. Test Data holds nothing else: no comments, logger checks, hypothetical markers or repeat notes.
4. Every Expected Result is future tense, verifiable, free of the §5 vague phrasings, and describes what the tester sees — no Figma sample values and no API field names.
5. One scenario per row; components of a scenario listed together; no unnecessary duplicates and no irrelevant cases.
6. Failure cases are hypothetical (marked in Comments), with no simulation step; nothing needs a service the tester can't access; Firebase/Umbraco rows have `רלוונטי רק אם יש גישה ל-…` when access isn't confirmed for this app. Logger expectations exist only where nothing in the app shows the behavior (§3).
7. Every screen, button, popup, drawer, toggle and back button from the sources is covered; every Figma frame was reviewed.
8. The static-text table was built; every Figma–spec difference is in Comments (both versions only) and in the summary; no Figma node ids anywhere.
9. Fixed vocabulary everywhere; no placeholders; every data-dependent case has deterministic Test Data.
10. Undefined behaviors follow the §5 policy: the certain part in Expected Result, only `לא מוגדר באיפיון: …` in Comments, once per point, no guesses.
11. Nothing from §6.1 was written. Test Data has no Figma sample data and no code values.
12. Accessibility is the last section, and exists only if the sources call for it or the human confirmed which tests to include (§7).
13. No reference to the tester in the third person; Comments contain none of the notes §5 bans.
14. **Coverage map:** every spec bullet, every data-mapping row and every Figma frame maps to the row(s) that test it; every §7.1 rule type has its required cases. List anything not covered, with the reason.
15. The §7.2 checklist is reported item by item.
16. Report the total number of test cases and what is open. The count is not a quality measure — don't present it as one.

## 9. Working with the tester

- Reply in the language the tester writes in. That applies to chat only — it never changes the file's language rules (English headers, Hebrew content).
- Don't make structural decisions they didn't ask for (splitting into sheets, renaming or reordering columns). If something seems useful, offer it in one line after delivering.
- Corrections are precise: apply them exactly and fully.
- When asked to compare work, including your own, be honest: say which is better and why, with concrete examples.
