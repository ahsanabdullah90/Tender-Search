# Tender Tracker Redesign: Handover

Last updated: Sat 31 Oct 2026, 20:07 (Asia/Karachi)
For: the next agent picking up this work.

Read sections 1 to 4 before touching code. The rest is reference.

---

## 1. What this is

- **App:** "Tender Tracker – Pakistan Procurement Watchdog". A solo-operator tool that scrapes about 18 Pakistani procurement portals, tags tenders against domain keywords, and tracks bids through a pipeline.
- **Owner / user:** Ahsan Abdullah (sole user). Windows PC, time zone Asia/Karachi. Prefers plain-English updates. Asked for screenshots after each phase.
- **Local project folder:** `C:\Users\Ahsan Abdullah\Desktop\Tender-Search`
- **Stack:** React 19, Tailwind 4, Vite 8 (frontend). Express + better-sqlite3 (WAL) + tsx (backend). Cheerio and Playwright scrapers. lucide-react icons. SSE at `/api/scan/stream`.
- **Why the redesign:** the owner said the UI is cluttered, not modern and not clean. About 540px of chrome sits before any content, the same UI is duplicated in several places, type is tiny, and there is too much colour.

---

## 2. Where things stand

Branch: **`redesign`** (created from `fix/sentinel-review-remediation`, HEAD `bf04d6e`).

**Nothing is committed yet.** All work is uncommitted on `redesign`. Commit only when the owner asks.

| Phase | Scope | Status |
|---|---|---|
| 0 | Safety: branch, DB backup, sample data, type-check | **Done** |
| 1 | Foundations: tokens, fonts, theme, shared parts, sidebar shell | **Done** (verified in browser) |
| 2 | Inbox screen | **Done** (see below) |
| 3 | Pipeline: Board, Gantt, slide-over, `result_expected_date` | **Done** (see below) |
| 4 | Sources & Keywords (Keywords / Portals / Data) + API additions | **Done** (see below) |
| 5 | Cleanup, localStorage migration, remove `sentinel` files | **Done** (see below) |

### Phase 0 (done)
- Branch `redesign` created.
- Backup of the real DB and sentinel leftovers: `C:\Users\Ahsan Abdullah\Desktop\Tender-Search-backup-20261031\` (contains `tender_tracker.db`, `-wal`, `-shm`, and copies of `sentinel.db*`).
- `scripts/seed-sample.ts`: writes 20 sample tenders across every stage and 18 portals across every status into `data-sample/`. Never touches `data/`. The script refuses to run if `DATA_DIR` does not point at `data-sample`.
- `package.json`: added `"seed:sample": "tsx scripts/seed-sample.ts"`.
- `.gitignore`: added `data-sample/`.
- `src/server/db.ts`: `DATA_DIR` honours a `TENDER_DATA_DIR` environment variable. Without it, behaviour is unchanged (`data/`).

### Phase 1 (done)
- `src/index.css`: design tokens as CSS variables. Light values on `:root`, dark on `:root.dark`. Exposed to Tailwind via `@theme` as `bg-bg`, `bg-surface`, `bg-surface-2`, `border-line`, `text-ink`, `text-ink-muted`, `bg-accent`, `bg-accent-soft`, `text-accent-ink`, `text-danger`, `bg-danger-soft`, `text-warn`, `bg-warn-soft`, `text-ok`, `bg-ok-soft`, `bg-chip`. Base text is 14px.
- Fonts bundled via `@fontsource-variable/plus-jakarta-sans` and `@fontsource-variable/jetbrains-mono` (both added to `package.json`).
- `src/theme.ts`: three-state theme. `System` is the default and follows the OS live. `Light` and `Dark` are overrides. Saved in localStorage key **`tt_theme`**. Adds/removes the `dark` class on `<html>`.
- `src/ui/index.tsx`: shared parts `Button`, `Chip`, `Panel`, `Tabs`, `DeadlineChip`, `EmptyState`, `Dialog`, `SlideOver`, `Popover`.
- `src/components/AppShell.tsx`: sidebar with Inbox, Pipeline, Sources & Keywords; sync status; Scan now; theme switch (System / Light / Dark).
- `src/components/KpiHeader.tsx`: slimmed to alert banners and the KPI strip. The old top bar (tabs, scan, theme) is gone.
- `src/App.tsx`: theme state now comes from `src/theme.ts`. Root wrapped in `<AppShell>`. Sidebar sections map onto the old views for now: Inbox = split view, Pipeline = kanban, Sources = management tab.
- Verified: `npm run lint` passes. In the in-app browser on sample data: light and dark both work, switch persists, Inbox / Pipeline / Sources open without errors.

### Phase 2 (done)
- New `src/components/InboxScreen.tsx`: triage list (left) and detail panel (right). Default sort is "Closing soonest"; tenders with no closing date go in a "No deadline stated" group at the end. Filters (domain, bookmarked, amended, sort) are in a popover. Detail panel has **Track this bid** (→ `Under Review`), **Pass** (→ `Passed`), bookmark, per-second countdown, amendment "Got it" (acknowledge), notes, saved documents. After Track/Pass, selection moves to the next tender. Empty state included.
- `App.tsx`: new `inboxMode` (Inbox section) forces the `New Opportunity` status filter; `handleUpdateStatus` now re-fetches the list; portal defaults fixed from 17 to 18. `SplitPaneWorkspace` is no longer used (delete in Phase 5, with `TenderFeedItem` and `PersistentDossier`).
- Verified on sample data in light and dark: Track removes the tender from the list (12 → 11) and selects the next one. `npm run lint` passes.
- Environment note: `better-sqlite3` had to be rebuilt (`npm rebuild better-sqlite3`) because it was built for an older Node than the installed v24. Only `node_modules` changed.
- Dev tip: the preview launcher reads `H:\Tender-Search\.claude\launch.json` (outside the git repo), config name `tender-sample`.
- Not yet done: the KPI strip and alert banners still sit above the Inbox in the old layout (planned restyle), and Inbox-Empty has not been compared against the mockup pixel by pixel.

### Phase 3 (done)
- New `src/components/PipelineScreen.tsx`: Board (Reviewing, Preparing bid, Submitted, Won; cards have a deadline progress bar) and Gantt (5 weeks from this week's Monday, today line, diamond = closing date, bar = start to expected result, "Result date not set" when empty, "No deadline stated" group). "Passed and archived (N)" toggles a list with Reopen. Clicking a card opens a `SlideOver` with the shared `Detail` (exported from `InboxScreen.tsx`; has stage buttons, Pass and the result date field).
- `result_expected_date`: guarded `ALTER TABLE` in `db.ts`, `updateTenderResultDate`, `PATCH /api/tenders/:id/result-date` (body `{ date }`, null clears), optional field in `types.ts`.
- `App.tsx`: `pipelineMode` fetches all stages with no Inbox filters; `TenderDrawer` is no longer rendered.
- Verified on sample data: Board, Gantt, slide-over, and saving a result date (confirmed in the API). Dark mode was checked on the Inbox only, not on the Pipeline. `npm run lint` passes.
- Not done: the optional "Result date not set" cue on Submitted Board cards (still waiting on the owner's answer). Submitted cards show a "Closed" chip once the deadline passes.
- Safe to delete in Phase 5: `TenderDrawer`, `TenderKanban`, `TenderTable`, `TrackFilterBar`, and the unreachable branch in `App.tsx` that used them.

### Phase 4 (done)
- New `src/components/SourcesScreen.tsx` with tabs **Keywords | Portals | Data**.
  - Keywords: add / edit / delete domains in dialogs (words to look for, Ignore list). No match counts.
  - Portals: "N of M portals are working", rows sorted problems first. Status: Needs verification (`hitl_required`), Offline (`selector_broken` / `error` / `offline_broken`), Working. Actions: Verify now (opens the browser, then "I've finished"), Retry, Edit (name and addresses, plus Login details via the existing `PortalCredentialsModal`). No Add portal button.
  - Data: Export (scope select), Backups (list and Back up now), Saved documents (size and delete for passed tenders, with confirm), Danger zone (Clear Inbox; Erase all data needs typing CLEAR).
- Backend (`server.ts`, `db.ts`): `GET/POST /api/backups`, `GET /api/storage`, `POST /api/dossiers/prune-passed`, and `scope` (`all` / `inbox` / `pipeline`) on `/api/export/csv`. Manual backups are named `*_manual.db` and are pruned by the same 14-day rule as daily ones.
- `App.tsx`: now only three screens. The old table/kanban branch, `TrackFilterBar`, `TrackManagerModal`, `PortalHealthModal` and `SettingsWorkspace` are no longer rendered. Leftover unused state and handlers (`isTrackModalOpen`, `handleExportCsv`, `selectedStatus`, etc.) can go in Phase 5.
- Verified on sample data: tabs, Back up now (1 to 2 backups), export row counts by scope (20 / 12 / 7), Erase button disabled until CLEAR is typed, adding a domain saves. Not checked: dark mode on Sources, Verify now on a real portal, prune with real files (sample has none). `npm run lint` passes.
- Known quirk: `server.ts` and `dossierManager.ts` hard-code `data/dossiers` and ignore `TENDER_DATA_DIR`, while the new storage and prune code uses the DOSSIERS_DIR from `db.ts`. They match when the env var is unset (the real app). Fix in Phase 5 for consistency.
- "Clear Inbox" uses the existing `unreviewedOnly` clear, which also removes unbookmarked Passed tenders. The dialog says so only loosely ("tenders you have not acted on"); consider rewording.

### Phase 5 (done)
- Deleted: `TenderDrawer`, `TenderTable`, `TenderKanban`, `TrackFilterBar`, `TrackManagerModal`, `PortalHealthModal`, `SettingsWorkspace`, `SplitPaneWorkspace`, `TenderFeedItem`, `PersistentDossier`, `LiveCountdown`. `src/components` now holds `AppShell`, `InboxScreen`, `PipelineScreen`, `SourcesScreen`, `KpiHeader`, `PortalCredentialsModal`.
- `App.tsx`: one `section` state (`inbox` / `pipeline` / `sources`), saved under `tt_section`. On first load it carries over the old `tender_tracker_currentView` (kanban means Pipeline), then removes `tender_tracker_currentView`, `tender_tracker_sortBy`, `tender_tracker_isDark` and any `sentinel_*` keys. Dead state and handlers removed. Clicking an amendment banner now opens that tender in the right screen (`focusId`). The Sources link in alert banners uses `onOpenSources`.
- Documents folder is now consistent: `server.ts`, `dossierManager.ts` and `crawlerEngine.ts` all use `DOSSIERS_DIR` from `db.ts` (honours `TENDER_DATA_DIR`).
- Sentinel files: fresh backup made at `C:\Users\Ahsan Abdullah\Desktop\Tender-Search-backup-phase5-20261031\` (all of `data\` plus `backups\`, sizes verified), then `data\sentinel.db`, `-wal`, `-shm` were deleted. They were the same size and timestamps as `tender_tracker.db`, so they looked like leftover copies. `tender_tracker.db` was not touched.
- `README.md` and `.env.example` updated (18 portals, three screens, sample data, `TENDER_DATA_DIR`).
- Verified on sample data: migration, all three screens, banner link, dark mode on Portals. `npm run lint` passes.
- Still open: nothing is committed (owner has not asked). Whether to add the optional "Result date not set" cue on Board cards. Wording of the Clear Inbox warning. Restore from backup remains deferred. Vite build (`npm run build`) was not run.

**Known Phase 1 leftovers (expected, fixed in later phases):**
- Pipeline (kanban) still opens the old `TenderDrawer` over the board.
- Inbox, Pipeline and Sources still use the old `slate-*` classes. They look acceptable in both themes but are not restyled.
- KPI strip and banners still use the old layout.
- `App.tsx` defaults `totalPortals` / `onlinePortals` to 17. The real count is **18**.

---

## 3. Decisions (agreed with the owner)

### Screen map
- **Inbox:** tenders to review. DB status `New Opportunity`.
- **Pipeline:** tenders the owner is working on. Two views: **Board** and **Gantt**. Board is the existing Kanban, kept on purpose so the owner can see timelines.
- **Sources & Keywords:** one page, three tabs: **Keywords | Portals | Data**.
- No "Deadlines" item in the sidebar.
- Old components to delete at the end: `TenderDrawer`, `TenderTable`. Modals `TrackManagerModal` and `PortalHealthModal` get merged into Sources & Keywords.

### Behaviour
- **Track this bid** moves a tender to Pipeline, status `Under Review`.
- **Pass** sets status `Passed`.
- Pipeline Board columns: Reviewing, Preparing bid, Submitted, Won. Plus a "Passed and archived (N)" link.
- Theme: light and dark, with a switch. Default follows the computer.
- Keywords: drop the "matches this month" counts.
- Add portal stays code-only (no UI button).
- Restore from backup is **deferred**. Not in the first release.
- Old `sentinel` database files are removed at the **end of Phase 5**, after one last backup.

### Data change
- Add an **optional** `result_expected_date` field to tenders (for Gantt and the "Result date not set" cue). Optional, so tenders without it still work.

### Gantt
- 5-week axis (sample: 26 Oct to 30 Nov). Today line. Bars by stage. Diamond markers for closing dates.
- Gantt bar start = `publish_date`, falling back to `created_at`.
- Tenders without a result date show "Result date not set" and no bar.
- Tenders with no closing date go into a "No deadline stated" group.

### Design foundations
- One blue accent: `#2447C7` light, `#7C9CFF` dark.
- Red = under 24 hours to close. Amber = amended / warning. Green = working / won.
- Two surface levels. Light and dark are token values, not separate components.
- Base text 14px, minimum 12px. Fonts: Plus Jakarta Sans (UI) and JetBrains Mono (numbers, refs).
- List countdowns re-render once a minute. Detail panel countdown re-renders every second.
- "Close this week" = next 7 days, computed on the client.
- `getKpiStats` keeps its 72-hour `closingSoon` count.
- "Acknowledge corrigendum" stays in the detail panel.

---

## 4. Build order and next steps

### Phase 2: Inbox
- Triage list, sorted by urgency by default. Filter by domain, bookmarked, corrigenda. Filters go in a popover.
- Detail panel: stage buttons, **Track** (→ Under Review), **Pass** (→ Passed), bookmark, notes, corrigendum acknowledge.
- Group: "No deadline stated" for tenders with no closing date.
- Empty state (see `Inbox-Empty` mockup).
- Clear Inbox action lives in Sources > Data (Phase 4), not here.

### Phase 3: Pipeline
- Board view: 4 columns with deadline bars. "Passed and archived (N)" link.
- Gantt view: as described in section 3.
- Replace the old drawer with a slide-over detail panel (`SlideOver` already exists in `src/ui`).
- Add `result_expected_date`: DB column (via `ALTER TABLE` guarded by try/catch like the existing ones in `db.ts`), PATCH support, type in `src/types.ts`, optional date field in the detail panel.
- Optional, not yet requested: "Result date not set" cue on submitted cards on the Board.

### Phase 4: Sources & Keywords
- **Keywords:** list of domains with positive words and an "Ignore" list. Add / edit / delete domains. Existing `/api/tracks` endpoints.
- **Portals:** list with status chips (Needs verification / Offline / Working), last checked, and action (Verify now / Retry / Edit). Summary line "12 of 18 portals are working". Existing `/api/portals*` endpoints.
- **Data:** the mockup has these sections:
  - Export to Excel (scope select: Everything / Inbox only / Pipeline only). Existing `/api/export/csv`; add a `scope` parameter.
  - Backups: list plus "Back up now". Needs new endpoints.
  - Saved documents: size summary plus "Delete files for passed tenders". Needs new endpoints.
  - Danger zone: "Clear Inbox" (existing `/api/tenders/clear` with `unreviewedOnly`), "Erase all data" (type CLEAR to confirm).

**Backend additions needed for Phase 4 (from the plan):**

| Endpoint / change | Purpose |
|---|---|
| `GET /api/backups` | List backups (name, date, size) |
| `POST /api/backups` | Back up now |
| `GET /api/storage` | Saved-document size and tender count |
| `POST /api/dossiers/prune-passed` | Delete saved documents for passed tenders |
| `scope` option on `GET /api/export/csv` | Everything / inbox / pipeline |
| `result_expected_date` on tenders | From Phase 3 |

Restore is **not** part of this list.

### Phase 5: Cleanup
- Delete `TenderDrawer`, `TenderTable`, `TrackManagerModal`, `PortalHealthModal`, `SettingsWorkspace` and any other replaced components.
- Migrate localStorage keys. Current keys used by the app: `tender_tracker_currentView` (set in `App.tsx`) and the old `tender_tracker_isDark` (no longer read; the theme now uses `tt_theme`). Check for any leftover `sentinel_*` keys in the browser and migrate or clear them.
- Update `README.md` and `.env.example` if anything changed.
- **Remove sentinel files**: `data\sentinel.db`, `sentinel.db-wal`, `sentinel.db-shm`. Only after one last backup. The backup folder from Phase 0 already exists; make a fresh one at this point.

---

## 5. Mockups

- **Live canvas (best view):** https://claude.ai/artifact/2UTZtcnepWhCxcp9pgppU3
- **Plan document:** https://claude.ai/artifact/B4iUEpnhnkLxN2iEYjTkZo (Docs artifact, doc id `51802caa-6a5f-48ea-87e3-a675a8dbee4a`)
- **Downloadable sources:** `Tender-Tracker-Mockups.zip` (10 `.dc.html` boards + `canvas.json` + README). These need the canvas's runtime to view.

Boards on the canvas:

| Board | Notes |
|---|---|
| Inbox light and dark | `Main.dc.html` (light), `Inbox-Dark.dc.html` |
| Pipeline Board light and dark | 4 columns, "Passed and archived (14)" link |
| Gantt light and dark | 5-week axis, today line, "Result date not set" on Furniture row |
| Sources: Keywords, Portals, Data | Light only |
| Inbox empty | Light only |

Mockups were removed or changed to match the plan: the Add portal button, "matches this month" counts, and the Restore link. Dark versions of Sources and the empty state were offered but not made. The owner has not asked for them.

All sample data is labelled "Sample data for design review".

---

## 6. How to run things

```powershell
cd "C:\Users\Ahsan Abdullah\Desktop\Tender-Search"

npm run lint                     # type-check (tsc --noEmit). Must pass.
npm run seed:sample              # rebuild the sample DB in data-sample\ (safe, repeatable)

$env:TENDER_DATA_DIR="data-sample"; npm run dev   # run the app on sample data
npm run dev                                         # run on the REAL data (only if asked)
```

App runs at `http://localhost:3000`.

**Startup behaviour to know about:**
- On start, the scheduler runs a catch-up scan if the last successful portal scan is 12 or more hours old. The sample DB sets the last scan to 3 hours ago so this does not fire.
- A daily health check re-tests portals marked offline. These hit real sites, but only write to whichever DB is active.
- Some portals need a human (CAPTCHA). The app may open a browser for those.

---

## 7. Rules for the next agent

1. **Do not touch the real data.** `data\tender_tracker.db` and `data\sentinel.db*` are the owner's. Develop against `data-sample\` with `TENDER_DATA_DIR`. Never run `clearAllTenders` or any erase route against the real DB.
2. **Do not commit or push unless asked.** When committing, use the attribution lines from the session instructions.
3. **Do not delete the `sentinel` files until Phase 5**, and only after a fresh backup.
4. **Keep the agreed decisions** (section 3). Ask the owner before changing any of them.
5. **Write files as UTF-8 without BOM.** PowerShell's `Set-Content` adds a BOM that breaks `tsx` JSON parsing (this happened in Phase 0). Use `[System.IO.File]::WriteAllText` with `UTF8Encoding($false)`, or the file-write tool.
6. **Run `npm run lint` after each phase.**
7. **Show the owner screenshots after each phase**, in both light and dark.
8. **Keep updates short and plain.** The owner said earlier they were confused by the looks, so explain changes in ordinary language.
9. **Portal count is 18.** Fix the hard-coded 17 in `App.tsx` defaults during Phase 2 or 4.

---

## 8. Reference: key files

| File | What it is |
|---|---|
| `src/App.tsx` | Main app: data fetching, state, SSE, handlers. Still the old layout; to be reshaped per screen. |
| `src/components/AppShell.tsx` | Sidebar shell (Phase 1, new) |
| `src/components/KpiHeader.tsx` | Alert banners + KPI strip (slimmed in Phase 1) |
| `src/components/TenderKanban.tsx`, `TenderTable.tsx`, `TenderDrawer.tsx`, `SplitPaneWorkspace.tsx`, `TenderFeedItem.tsx`, `PersistentDossier.tsx` | Old Tenders screens. Replaced in Phases 2 and 3. |
| `src/components/SettingsWorkspace.tsx`, `TrackManagerModal.tsx`, `PortalHealthModal.tsx` | Old Settings. Replaced in Phase 4. |
| `src/components/LiveCountdown.tsx` | Countdown timer (reuse for the per-second detail countdown) |
| `src/index.css` | Design tokens (Phase 1) |
| `src/theme.ts` | Theme preference and dark-class handling (Phase 1) |
| `src/ui/index.tsx` | Shared UI parts (Phase 1) |
| `src/types.ts` | `Tender`, `DomainTrack`, `PortalHealth`, `CorrigendumLog`, `ScanStatus`. Add `result_expected_date` in Phase 3. |
| `src/server/server.ts` (root `server.ts`) | Express routes |
| `src/server/db.ts` | Schema, migrations (`ALTER TABLE` in try/catch), backups, `clearAllTenders` |
| `src/server/scheduler.ts` | Catch-up scan, 30-min watchdog, daily backup, daily health check |
| `scripts/seed-sample.ts` | Sample data (Phase 0, new) |

DB tables: `tenders`, `corrigendum_logs`, `pipeline_audit_logs`, `domain_tracks`, `portal_health`.

Status values in the DB (unchanged): `New Opportunity`, `Under Review`, `Preparing Bid`, `Submitted`, `Won`, `Passed`. Only the UI labels change.

`getKpiStats` counts `closingSoon` within 72 hours.

`clearAllTenders(unreviewedOnly)` deletes New Opportunity and Passed tenders that are not bookmarked, plus their corrigendum and audit logs. With `unreviewedOnly = false` it wipes everything.

---

## 9. Open items

- Confirm with the owner whether to add the optional "Result date not set" cue on Board cards (offered, not requested).
- Confirm whether dark mockups are wanted for Sources and the empty state.
- Restore from backup: deferred. Revisit only if the owner asks.
- Fonts are now bundled, so the earlier risk (fonts need internet) is closed.
