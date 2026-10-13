---
name: qa-test-case-writing
description: The QA team's rules for writing manual test cases — full navigation paths, fixed Hebrew vocabulary, preconditions in Test Data, verifiable expected results, the undefined-behavior policy, hypothetical failure tests, required cases per data-rule type, the general edge-case checklist, Figma text comparison and the final review. Invoked by qa-test-designer and qa-test-plan-syncer for every test case they write or rewrite.
---

These rules come from the QA team's own experience executing the plugin's output. A human tester runs every row on a real device, so every row must be reproducible by someone who has never seen the app. When a rule here conflicts with your instinct, the rule wins. They apply to the test cases in `test-plan.md` and, in Hebrew, to every row of `test-cases.xlsx`.

## 1. Before writing

1. **Read the app knowledge file** (`<qa-repo>/app-knowledge.md`, shape in `templates/app-knowledge-template.md`) before writing anything. If it doesn't exist, create it from the template. Reuse its navigation paths word for word, and follow its "What the tester can control" section (§3). Update it as new information arrives (spec, Figma, conversation): add only what a source states, never extrapolate, and record contradictions between sources as QA notes instead of resolving them.
2. **Image-heavy specs (docx/PDF):** text extraction isn't enough — also view the embedded images; UI mockups often live there.
3. **After 2 failed attempts with any approach, stop and propose an alternative.** Never loop.

## 2. Figma

Figma is the source of truth for UI unless the spec says otherwise. Never write UI expectations from the spec alone when Figma is available.

- Workflow: `get_metadata` without a node id → pages → `get_metadata` on the page/section → frames → `get_screenshot` on each frame. Screenshot sub-nodes (a single card) when a full frame renders too small to read.
- Check **every** frame in the relevant section, not only the ones the spec links to — sections often hold error screens, drawers, popups and alternate states the spec never mentions. Frames that exist only in Figma still get test cases (undefined-behavior policy, §5).
- Node ids in the spec may be outdated. If one isn't found, find the frame by name in the section metadata and note the new id.
- Figma may only resolve nodes on the page currently open; if nodes come back empty or "not found", ask the human to open that page in Figma and retry. If that can't be done now, mark the related test cases in Comments as not yet compared to Figma.
- **Static-text table — build it before writing test cases.** List every fixed text in the feature (screen titles, card titles, labels, buttons, popup/drawer titles and texts, error-screen texts) with the spec text and the Figma text side by side, and compare them **character by character**. Small differences count: a missing or extra yod (`הבטחון` / `הביטחון`), `״` vs `"`, `”` vs `"`, `/` vs `-`, spaces, punctuation. When they differ, Expected Result uses the Figma text and Comments state both. When Figma has a clear typo, Expected Result uses the correct text and Comments state the typo so it isn't copied into the app. The table is a working tool, not part of the output.
- Also check: sample data that's wrong (phone numbers with the wrong digit count, dates without leading zeros) — say so in Comments so nobody compares against it; popups/drawers drawn over an old screen or a screen from another flow — note the background isn't part of the design; several frames of the same screen — compare them to each other.
- Every Figma–spec gap (colors, texts, labels, element order, formats, elements present in one and missing in the other) goes into the Comments of the relevant test case **and** into Open Questions, and is listed in the final summary.

## 3. What the tester can and cannot control

The app knowledge file's "What the tester can control" section lists the backend services the tester can change (for example Firebase flags/Remote Config/push and Umbraco content) and whether a read-only network logger is available. If the section is empty, ask the human once and record the answer there.

- **Service failures the tester can't cause are still written** — API errors, failed saves, error screens — with the full navigation path and expected behavior, but **without** any "simulate the failure" step and without proxy/mock instructions. They are **hypothetical test cases**, marked in Test Data: `בדיקה היפותטית: רלוונטית רק אם הקריאה X נכשלת בפועל`. If the tester hits the failure for real, they know what should happen; otherwise they skip it.
- **Don't write test cases that need an action in a service the tester can't access** — editing backend data, corrupting or emptying an API response. They can't be executed. (Needing an existing test user with specific data is fine — that's choosing a user, not changing a service.)
- Changes in the services the tester *can* access are valid — put the exact flag/content change in Test Data.
- Device-level conditions are always valid: airplane mode, permissions, device language, font size, dark mode, network limiting (Network Link Conditioner on iOS, developer options on Android).
- **Request-level expectations are valid when a logger is available**: which call is sent, how many times, with which parameters, or that no call is sent. See §5.

## 4. Columns

Order (A is rightmost in the RTL sheet): **A Test ID → B Summary → C Action → D Expected Result → E Test Data/Parameter → F Comments.** In `test-plan.md` the same content lives in `id | screen/flow | steps | expected result | test data | comments`. All Excel content is Hebrew except English terms with no Hebrew equivalent (API field names, WebView, Push, Face ID); don't switch languages mid-sentence unnecessarily.

- **A — Test ID:** always blank in the Excel file; the tester fills it in.
- **B — Summary:** 1–2 sentences. What is tested, not how. Example: `ניסיון חוזר מוצלח ממסך השגיאה.`

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
- No placeholders (`{X}`, `{שם}`). Describe the element by its visible fixed text (`לחץ על הפס "נכות שלא הוכרו"`) or by the Test Data condition (`בכרטיס של איש קשר שיש לו שני מספרי טלפון`).
- Name every button, card and field exactly as it appears in the UI, in quotes. Never use internal screen numbers ("Screen 14") — describe screens by their visible title.
- Include scrolling when the target is below the fold (`גלול לכרטיס "חשבון בנק"`).
- If the app is reopened mid-test, write the steps after reopening too (`סגור את האפליקציה לגמרי` → `פתח את האפליקציה מחדש` → the navigation path again, without re-login if the session persists).
- Build each navigation path once and reuse it identically in every test case for that screen; store it in the app knowledge file's "Screens & navigation".
- **Preconditions never go in Action**: which user to log in with, feature flags, how a failure would happen, enabling airplane mode before the test, a permission blocked beforehand — all go in Test Data. Action holds only what the tester does in the app plus the device actions that are part of the scenario (backgrounding, rotating, answering a call, opening device settings from an in-app button, returning).
- When an environment change must happen mid-test, put it in Test Data with the step number: `לפני שלב 4 יש להחזיר את השירות לפעולה`.

### Expected Result
- Third person, future tense, subject first: `האפליקציה תפתח את העמוד`, `האפליקציה תציג...`, `האפליקציה לא תשנה...`.
- Concrete and verifiable: exact texts in quotes, exact formats with an example value, exact destination screens.
- **No vague wording.** Rewrite any of these before delivering:

| Don't write | Write instead |
|---|---|
| `תציג את הערך "לצמיתות" ללא שינוי` | Fold it into the test case that shows that component: `שורה "בתוקף עד" עם הטקסט "לצמיתות"` |
| `מסך ההגדרות יישאר ללא שינוי` | `תציג את מסך "פרופיל אישי והגדרות" עם שם המשתמש בכותרת ו-6 כרטיסי הניווט` |
| `תציג את המסך כפי שהיה` | Name the screen and what's on it |
| `הכרטיסים ימשיכו לעבוד כרגיל` / `יוצגו כרגיל` | List the components that are shown |
| `בהתאם לנתונים של המשתמש` | Name each field and which of the user's values it shows (Test Data names the user) |
| `בצורה תקינה`, `בסדר הנכון`, `בפריסה תקינה`, `בכיוון הנכון` | The exact expected rendering with an example value, or "כמו ב-Figma" plus what that means |
| `האפליקציה לא תקרוס` (alone) | The screen and state the user ends up in |
| `תתנהג לפי ההחלטה`, `תעבוד כרגיל`, `בנוחות`, `בניגודיות מספקת` | A measurable criterion (`יחס ניגודיות של לפחות 4.5:1`, `אזור לחיצה של לפחות 44x44 נקודות`) |
| `הבחירה תתאים לערך שנשמר בשרת` | Something visible in the app (`בכניסה מחדש למסך תוצג מסומנת האפשרות "במייל"`) |
| `תתעדכן לפי מצב התצוגה של המכשיר` | Each state: `כשהמכשיר בתצוגה כהה, האפליקציה תוצג בתצוגה כהה` |
| `בלי מצב משובש` | The exact screen and the exact selected value |
| `תשבור לשורות או תקצר` / any "X or Y" outcome | One outcome. If undefined, the certain part here and the rest in Comments (policy below) |
| `טקסטים שתואמים בדיוק לעיצוב` | The list of texts to check |

  A specific design reference is fine: `כמו ב-Figma: התווית בעברית מימין והתווית באנגלית משמאל`.
- Don't write a test case whose whole point is a value that "stays as is" — it belongs inside the test case that displays that component.
- Never write untestable expectations (`יש לתעד את התנהגות האפליקציה`, `צפוי שתוצג הודעה או ערך דומה`). "Won't crash" alone is too weak — add the screen and state.
- **Undefined behavior — one fixed policy.** Expected Result holds only what is certain and visible (which screen remains, which components and values are shown, no crash). Comments start with `לא מוגדר באיפיון:` + what exactly is undefined, then `צפי סביר:` + the most likely behavior, then `לעדכן את התוצאה הצפויה לאחר החלטה.` Never put the guess in Expected Result. An assumption about what a control does is also undefined behavior. The same gap is also logged under Open Questions in `test-plan.md`.
- **Request-level expectations:** allowed when the request itself is the behavior under test. Visible result first, then the request result, and `אימות בלוגר: <call name>` in Test Data. Example: `האפליקציה תסגור את סרגל השמירה ותסמן שוב את "בהודעת SMS לנייד (למספר ישראלי בלבד)". בלוגר לא תופיע קריאה ל-UpdateMessageDeliveryOption.`
- **One outcome per row.** No multi-stage expectations that check two behaviors (a change and its persistence after restart) — split them. Multi-stage is fine only for one behavior ("loader, then the screen").
- Don't invent behavior the sources don't state. Omission beats a fabricated expectation.

### Test Data/Parameter
Only for special conditions:
- **Which user** when a specific one is needed: `יוזר להתחברות: משתמש עם 3 ילדים`, `יוזר להתחברות: משתמש עם msgDeliveryOptionId=2`, or the user type/role in apps that have several. When it doesn't matter, don't mention a user.
- Device and permission state: `הרשאת התראות חסומה לאפליקציה בהגדרות המכשיר`, `מכשיר Android`, `מצב טיסה מופעל`.
- `בדיקה היפותטית: …` for failure tests (§3).
- Exact flag / remote-config / CMS-content changes the test depends on.
- Network conditions: `רשת מוגבלת ל-3G (Network Link Conditioner ב-iOS או הגבלת רשת בהגדרות המפתחים ב-Android)`.
- `חזור על הבדיקה ב…` where §6 allows a repeat note.
- `אימות בלוגר: <call name>`.
- **Deterministic data:** if the result depends on a starting value, fix it here and name the resulting value in Expected Result. No `בחר אפשרות שונה מהמסומנת` — name the option. Prefer explicit example values (`אנשי קשר עם displayOrder 3, 1, 2 ואחד בלי ערך`).

### Comments
Only for something important not covered elsewhere: Figma–spec discrepancies (both sides and which is the source of truth), Figma typos, undefined behavior (policy above), dependencies to verify with dev. Write the actual question or fact — never reference documents that aren't in the file ("see open question 17").

## 6. Quality rules

- **No unnecessary duplicates.** Every test case checks something no other one does. Common duplicates: a "navigate to X" case next to the "X structure" case that already opens X the same way; the same format check repeated in functional, edge, RTL and accessibility sections; the same layout check repeated per screen.
- **Split vs. repeat — decide by how the result would be reported:**
  - **Separate rows** when each variant needs its own Pass/Fail: each enum value from the server, each user/data condition, each permission state, each platform when behavior differs, each data-loading screen in offline/API-failure tests.
  - **One row + `חזור על הבדיקה ב…`** only when the check is identical and a failure anywhere is the same bug: RTL layout, maximum font size, contrast, small screen, Android back / iOS swipe on sub-screens.
  - Never put two data conditions that can't exist for one user in the same row.
  - Never combine "change X" and "X is kept after leaving / restarting" in one row.
- **One structure test case per screen state**, listing everything visible in that state (title, back button, every card/section in order, their fixed texts). Don't split one screen's structure into several rows.
- **One scenario per test case, not one component per test case.** List every component of the scenario and its state in one Expected Result (e.g. a card with three fields → one row naming all three). Split only for a different action, a different data condition that can't be shown in the same pass, or a different outcome.
- Exact UI text, character for character. Formats with examples: dates `DD.MM.YYYY` (`16.09.1967`), phones `0545413456` / `03-7380339`, percentages `90%`.
- Every interactive element gets tested (every button, link, toggle, radio, drawer, popup, close X, back button and its destination). Every data rule gets its own test case (field mapping, empty-value fallbacks, trimming, formatting, conditional display, sorting). Both directions of every condition: shown and hidden, with and without permission, success and failure, zero, one and many items.
- When the human names a range or starting point for a fix, apply it to **all** affected rows from that point on — never narrow it.

## 7. Coverage

Sections, in this order (the `test-plan.md` sections and the Excel groups follow it):

1. **Functional** — one sub-section per screen/flow in navigation order: entry point, structure, every element, every navigation and back destination, every data rule, every popup/drawer/save bar.
2. **Error screens** — every error screen in the sources (including Figma-only ones): structure and every button with its destination.
3. **Edge cases from the spec and design** — the §7.1 table, plus long texts, very long names, names with hyphen/apostrophe, permission revoked mid-session, returning from device settings without granting, double/rapid taps on actions, reverting a change, leaving with unsaved changes.
4. **API failures (hypothetical, §3)** — one row per call the feature makes.
5. **Universal edge cases** — the §7.2 checklist.
6. **i18n / RTL** — full RTL layout, device language other than the app language, numbers/symbols inside RTL text, LTR strings (emails, URLs) inside RTL, date formats, bilingual components, mixed-direction content, maximum font size, static texts vs design.
7. **Accessibility** — screen reader labels for icon-only buttons, reading order, toggles/radios announced with state, focus trapped in popups/drawers and returned on close, floating bars reachable, touch targets (at least 44x44pt iOS, 48x48dp Android), dynamic font size, contrast in light and dark mode (at least 4.5:1).

### 7.1 Required cases per data-rule type
For every data rule in the sources (every row of a data-mapping table, every composition/format/display rule), one row each unless §6 says otherwise:

| Rule type | Required cases |
|---|---|
| Composed string (address, full name, "X% …") | all parts present; each optional part missing on its own; leading/trailing spaces |
| Lookup by code (city, country, phone prefix, marital status) | known code; code missing from the lookup table; a value that must come from the code and not from a similar ready-made field |
| Field chosen among similar fields (`phoneType=3` vs `mainPhone`) | a user for whom the two values differ |
| Conditional element (icon, button, banner, sub-card) | shown; hidden; data present but invalid or partial (prefix without number, email without @, only the second phone) |
| Enum / radio value from the server | each value (separate rows); null / missing |
| Number, percentage or date formatting | each raw format the sources mention (one row each); the displayed format with an example value |
| List | 0 items; 1 item; 8+ items; sort order with explicit values (displayOrder 3, 1, 2 and one empty) |
| Missing value with a fallback ("אין מידע") | each field with a fallback, with a user missing it |
| Device-permission toggle | granted; denied (popup); granted via "go to settings" and return; return without granting; revoked in device settings while the app is open |
| Server-saved setting | change + save success; cancel; save failure (hypothetical); save offline; double tap on save; reselect the original value; leave with an unsaved change; background with an unsaved change; kill the app mid-save |
| Logout | open; confirm; cancel; X; tap on the dark background; failure (hypothetical); double tap on confirm; reopen after logout; Android back after logout; switch to another user (no stale data) |
| External link / WebView | opens the right destination (browser vs WebView per the sources); close/return; session carried into a WebView that should have it; offline |

### 7.2 General edge-case checklist (mandatory)
Go over every item and report it in the plan's "Edge-Case Checklist Report" as `covered in <id>` or `not relevant because …`. Never skip one silently.

- No internet on each data-loading screen + recovery via "retry"
- Disconnect mid-load
- Offline per action type: save, download/export, WebView, external link
- Slow network: loader shown, no "אין מידע" / empty-title flash before data arrives
- App to background and back with a drawer open, a popup open, an unsaved change
- Session expiry while on a feature screen
- Switching users after logout — no data of the previous user
- Interruptions: incoming call, notification
- Android back: sub-screen, drawer, popup, login screen after logout
- iOS edge-swipe back
- Rotation
- Rapid double navigation (two different cards; the same card several times)
- Small screen; large screen / tablet
- iOS and Android, min and latest supported OS versions
- Device without dialer / mail app / browser
- Killing the app mid-save
- Device language other than the app language (including another RTL language such as Arabic)
- Screenshots of sensitive data (only if the sources say something about it)

## 8. Final review before delivering

1. **Spelling and sense, especially Hebrew.** Read every cell; fix typos, broken sentences, gender/number agreement and inconsistent terms.
2. Every Action starts with `התחבר לחשבון` and has no "go to screen X" shortcut.
3. No preconditions in Action; every user, data, permission, device condition and service change is in Test Data.
4. Every Expected Result is third person, future tense, verifiable, and free of the §5 vague phrasings.
5. One scenario per row; components of a scenario listed together; no unnecessary duplicates.
6. Failure cases are hypothetical, with no simulation step; nothing needs a service the tester can't access; every request-level expectation has `אימות בלוגר`.
7. Every screen, button, popup, drawer, toggle and back button from the sources is covered; every Figma frame was reviewed.
8. The static-text table was built; every Figma–spec difference is in Comments and in the summary.
9. Fixed vocabulary everywhere; no placeholders; every data-dependent case has deterministic Test Data.
10. Undefined behaviors follow the §5 policy.
11. **Coverage map:** every spec bullet, every data-mapping row and every Figma frame maps to the row(s) that test it; every §7.1 rule type has its required cases. List anything not covered, with the reason.
12. The §7.2 checklist is reported item by item.
13. Report the total number of test cases and what is open. The count is not a quality measure — don't present it as one.

## 9. Working with the tester

- Reply in the language the tester writes in.
- Don't make structural decisions they didn't ask for (splitting into sheets, renaming or reordering columns). If something seems useful, offer it in one line after delivering.
- Corrections are precise: apply them exactly and fully.
- When asked to compare work, including your own, be honest: say which is better and why, with concrete examples.
