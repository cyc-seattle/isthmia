# Camp Roster Generator

## Context

Camp staff need printable **sign-in / sign-out rosters** for each week of camp. Today someone
built a manual Google Sheets workbook (`17N2Pg-…`) where you paste a Clubspot export into a
"Raw Data" tab and formulas fan campers out onto per-class tabs. It works but is slow and
fiddly — the export/paste dance takes 90+ minutes.

We want a script that pulls straight from Clubspot and generates a **fresh roster spreadsheet**
in the shared "Rosters" folder for a given **camp + week (session)**. Each roster has two tabs:

- **Public** — sign-in/sign-out form: name, calculated age, blank daily check-in/sign-out boxes,
  emergency contact, and a blank Notes column.
- **Medical** — name, age, allergies, medical details, medication, last tetanus shot, emergency
  contact.

Instead of DOB we show **calculated age**. Scope confirmed with the user: one roster = **whole
camp + one week**, all classes combined onto the two tabs (with a `Class` column to distinguish
groups). Delivery is an **on-demand CLI command first**; a follow-up issue will track wiring it
into the recurring Cloud Run job.

## Data model (Clubspot)

- `Camp` → has many `CampClass` (Guppies, Youth Beginner…) and `CampSession` (weeks).
- A `Registration` (`campObject`) has `participantsArray` (the campers) and `sessionJoinObjects`
  (`RegistrationCampSession`), each joining one `campSessionObject` + one `campClassObject`.
- Camper fields live on `Participant` (`packages/clubspot-sdk/src/types.ts:194`): `firstName`,
  `lastName`, `DOB`, `medical`, `medical_allergies`, `medical_meds`, `medical_tetanus`,
  `emergencyContact`, `emergencyMobile`, guardian fields.

Reuse `queryCampEntries(camp)` (`packages/clubspot-sdk/src/queries.ts`) — it already returns
confirmed registrations with `participantsArray` and the session/class join includes we need.
The row-building loop in `packages/admin-functions/src/participants.ts:132` is the reference
pattern (iterate registrations → participants → sessionJoinObjects).

## Approach

### 1. gsuite: create a spreadsheet in a (shared-drive) folder

`SpreadsheetClient` (`packages/gsuite/src/spreadsheet.ts:235`) can only _load_ existing sheets.
Add a `createSpreadsheet(title, folderId)` method that uses the Drive API to create the file
directly in the folder, then returns it loaded as our `Spreadsheet`:

- Use `google.drive({ version: "v3", auth })` with `files.create`:
  `{ requestBody: { name: title, mimeType: "application/vnd.google-apps.spreadsheet",
parents: [folderId] }, fields: "id", supportsAllDrives: true }`.
- The "Rosters" folder is inside a **shared drive**, so every Drive call MUST pass
  `supportsAllDrives: true`.
- Then `loadSpreadsheet(id)` to return a ready `Spreadsheet`.

Wrap the Drive call in `safeCall` (`packages/gsuite/src/common.ts`) for the rate-limit/backoff
behavior used everywhere else.

Add a small `Spreadsheet` helper to add a worksheet and delete the default `Sheet1` (a freshly
created spreadsheet always has one). `getOrCreateWorksheet` (`spreadsheet.ts:207`) + the `Table`
abstraction already handle headers and row writes.

### 2. admin-functions: roster generation logic

New file `packages/admin-functions/src/roster.ts` — a `RosterGenerator` class (NOT a `Report`
subclass; rosters create new files and aren't interval-based):

Inputs: `campId`, session selector (id or name), `folderId`, `auth`.

Steps:

1. Load `Camp` by id (`new LoggedQuery(Camp).get(campId)`).
2. Load the camp's `CampSession`s (like `sessions.ts:58`) to resolve the session selector →
   session object. Match by **id first, then case-insensitive name**. If no match, throw an
   error that lists the available session names (good CLI UX). Read the session `startDate` /
   `endDate`.
3. Query confirmed entries: `queryCampEntries(camp).limit(1000).find()`.
4. Build rows: for each registration → each participant → each `sessionJoinObject` whose
   `campSessionObject.id === session.id`. Skip cancelled (`registration.archived`) and waitlist
   (`join.waitlist`). Emit one row per (participant × class) so a camper in two classes that
   week shows up under each `Class`. Prefer `participant.firstName/lastName` (the child),
   falling back to registration name.
5. **Age** = whole years from `participant.DOB` to the session `startDate`, via luxon
   `DateTime.fromJSDate(start).diff(DateTime.fromJSDate(dob), "years")` floored. (Age "at camp"
   is more correct than age-as-of-today for a roster generated weeks early.)
6. Create the spreadsheet via the new gsuite method, named e.g.
   `"<Camp> — <Session> — Roster"`, write both tabs, delete the default sheet, log the URL.

**Public tab** columns (sorted by Class, Last Name, First Name):
`Class, First Name, Last Name, Age, Mon In, Mon Out, Tue In, Tue Out, Wed In, Wed Out, Thu In,
Thu Out, Fri In, Fri Out, Emergency Contact, Emergency Mobile, Notes` — daily columns labeled
with the actual dates derived from the session start (e.g. `Mon 6/29 In`); box + Notes cells
left blank for staff to fill.

**Medical tab** columns (same sort):
`Class, First Name, Last Name, Age, Allergies, Medical Details, Medication, Last Tetanus Shot,
Emergency Contact, Emergency Mobile`.

Row writes reuse `Worksheet.getTable()` → `Table.addRow()` → `Table.save()`
(`spreadsheet.ts:97,146`).

### 3. CLI command

Add a `roster` subcommand in `packages/admin-functions/src/main.ts` (Clubspot auth is already
wired in the `preAction` hook):

```
admin-scripts roster --camp <campId> --session <name-or-id> [--folder <id>]
```

- `--folder` defaults to the "Rosters" folder id `1Iu6x4t0bFE_Yt0MMV21fvEOQpt_xocEU`
  (overridable via `ROSTER_FOLDER_ID` env).
- Add the Drive scope to the `GoogleAuth` at `main.ts:11`: append
  `"https://www.googleapis.com/auth/drive"` to `scopes`.
- Construct `RosterGenerator` with the shared `auth` and call `generate()`.

### 4. Follow-up issue (per the user's request)

After the CLI works, file a GitHub issue (via the `capture` skill) to track adding a recurring /
config-sheet-driven job that regenerates rosters automatically. Note there that the `Report`
framework updates an _existing_ sheet+tab and will need adapting to create new files.

## Files

- `packages/gsuite/src/spreadsheet.ts` — add `SpreadsheetClient.createSpreadsheet(title, folderId)`
  (Drive API + `supportsAllDrives`) and a create-worksheet/delete-default helper on `Spreadsheet`.
- `packages/admin-functions/src/roster.ts` — **new**, `RosterGenerator`.
- `packages/admin-functions/src/main.ts` — new `roster` subcommand + Drive scope.
- (test) `packages/admin-functions/test/roster.test.ts` — **new**, see below.

## Permissions / gotchas

- Whichever identity runs the CLI (your ADC account, or an impersonated service account per
  CLAUDE.md) must have **write access to the shared "Rosters" folder**. Files created by a
  service account are owned by it but inherit the folder's sharing, which is why we place them
  in the folder rather than My Drive. If runs use `report-runner@`, that SA needs to be a member
  of the shared drive.
- Every Drive API call needs `supportsAllDrives: true` because the folder is in a shared drive.
- Rich formatting from the old workbook (landscape print area, real checkbox data-validation,
  red-highlighting non-empty medical fields, borders) is **out of scope for v1** — the
  `google-spreadsheet` lib doesn't expose conditional formatting; it would need raw Sheets API
  `batchUpdate`. Note as a possible enhancement in the follow-up issue. v1 delivers correct data
  - the two-tab structure + daily box columns.

## Verification

1. `just build` and `just test` — unit test for `RosterGenerator` row-building using mocked
   Parse objects (follow the mock-the-SDK-boundary pattern in
   `packages/gsuite/test/spreadsheet.test.ts`): assert age math, class fan-out, waitlist/
   cancelled exclusion, and the exact Public/Medical header sets. This keeps coverage without
   hitting live APIs.
2. End-to-end (manual, real credentials): authenticate ADC (`gcloud auth application-default
login`) with an account that can write the Rosters folder, set `CLUBSPOT_EMAIL/PASSWORD`, and
   run `admin-scripts roster --camp <realCampId> --session "<week>"`. Confirm a new spreadsheet
   appears in the Rosters folder with correct Public + Medical tabs, ages, and daily columns.
3. `just ci` before opening the PR.
