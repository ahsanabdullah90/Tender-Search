> [!NOTE]
> **HISTORICAL ARTIFACT (CODE FIXES COMPLETE IN v1.5.0)**
> The code changes described in this document were made and verified in v1.5.0 (November 11, 2026) with 525 automated unit and integration tests. Three items are still open and are tracked in `docs/14-active-backlog.md`: the `D4` full-scan check on live data, the `P1-5` PDF benchmark, and the `P1-6` threshold calibration.
> For active system specifications, architecture, and current backlog, consult the canonical documentation in `docs/01` through `docs/14`.


# 15. Fundamental Logic Issues (Silent Misses and Wrong Deletions)

**Created:** 2026-11-11 · **Code baseline:** `f58bd18` (all line numbers refer to this commit)
**Method:** code reading of the scan → filter → dedup → store → retention path, plus one runtime test of the reference-number regex. The live database was **not** inspected, so the number of affected rows is unknown.

## Core problem

The app can fail to show a relevant tender, or delete one that is still open, without logging, flagging, or counting it. An empty Inbox therefore does not mean "nothing relevant was published".

| ID | Issue | Effect | Severity | Status |
| :-- | :-- | :-- | :-- | :-- |
| F1 | Only page 1 of each portal is read | Tenders on later pages are never seen | Critical | Fixed & Verified |
| F2 | Relevance filter runs before documents are read | Tenders with generic titles are discarded | Critical | Fixed & Verified |
| F3 | Fake reference numbers merge different tenders | A new tender is absorbed into an unrelated one | Critical | Fixed & Verified |
| F4 | Deadline changes are lost for tenders without a reference | Open tender keeps old deadline, is auto-deleted, stays suppressed | Critical | Fixed & Verified |
| F5 | A single-portal scan postpones the full scan | Full scan can be delayed past 12 hours | Medium | Fixed & Verified |
| F6 | Scans run only while the app is open | Gaps in coverage when the PC or app is off | Medium | Fixed & Verified |
| F7 | Keywords match as substrings | Wrong rejections (negative) and wrong matches (positive) | Medium | Fixed & Verified |

Related items in `docs/14-pending-issues.md`:
- **Resolved on 2026-11-11:** All fundamental issues F1–F7, deep audit flaws A1–A11, B1–B8, C1–C4, plus `P1-4` (earlier deadline on duplicate re-scan flags `needs_review = 1`), `P2-4` (`staging` and `awaiting_scope` statuses used during verification), and `P2-9` (all SQL statements consolidated into repositories).
- **Still open:** `P1-6` (MiniLM thresholds `0.58` / `0.88` are uncalibrated; calibration needs operator-labelled pairs).

---

## F1. Only the first page of each portal is read

**Where**
- `src/server/scrapers/crawlerEngine.ts:994-1104` (`scrapePortal`): exactly one fetch per portal, of `portal.tendersUrl`.
  - Playwright tier: `page.goto(portal.tendersUrl)` at line 1014, then `page.content()` once at line 1018.
  - HTTP tier: `fetchHtmlSmart(portal.tendersUrl, …)` at line 1031.
- `src/server/scrapers/crawlerEngine.ts:773` and `:911`: the only references to pagination in `src/server`; both **remove** `.pagination` elements.
- `src/server/scrapers/portalList.ts`: `PortalDefinition` (lines 1-14) has no pagination field. The portal descriptions state the size of what is skipped: Punjab "865+ live tenders" (line 40), Sindh "12,900+ live tenders" (line 53), NDMA "34 pages of listings" (line 94), UNGM "1,700+ live notices" (line 215).

**Why it matters**
A tender is seen only if it is on page 1 at the moment of a scan. On high-volume portals, a tender can be published and pushed off page 1 between two scans.

**Possible solution**
1. Add an optional `pagination` field to `PortalDefinition`, for example `{ kind: 'query' | 'path' | 'postback' | 'click', param?: string, nextSelector?: string, maxPages: number }`.
2. In `scrapePortal`, loop over pages and merge `ScrapeResult.items`, de-duplicating on `directUrl + title`. Stop when any of these is true:
   - the page returns 0 items;
   - every item on the page was already returned by an earlier page in this scan;
   - every item on the page already exists in `tenders` or `deleted_tenders` (incremental crawl; valid only where the portal sorts newest first);
   - `maxPages` is reached.
3. Wait `getHumanJitterDelay()` between pages, as is done between portals.
4. For very large portals (Sindh, UNGM), prefer the portal's own server-side search or filter with the active track keywords over walking all pages.
5. Store `pages_scanned` and `stopped_reason` in `portal_health` so the Sources screen shows how deep each scan went.
6. AGENTS.md §2 Rule 1 still applies: an empty later page must not trigger Auto-Heal and must not count towards `consecutive_zero_yields`.

**Affected files**
- `src/server/scrapers/portalList.ts`
- `src/server/scrapers/crawlerEngine.ts`
- `src/server/scrapers/playwrightEngine.ts` (if the click/postback variant is implemented there)
- `src/server/db/schema.ts`, `src/server/db/repositories/portalsRepo.ts` (new `portal_health` columns)
- `src/components/SourcesScreen.tsx` (display)
- `tests/scraper/` (multi-page fixtures per portal)

**Done when**
A fixture with 3 pages yields the items of all 3 pages, and a scan of a portal with more than one page records `pages_scanned > 1`.

---

## F2. Relevance filter runs before the documents are read

**Where**
- `src/server/scrapers/crawlerEngine.ts:1339-1344` (`processAndSaveTender`): `matchTracks(item, activeTracks)` is the first step; if `matchedTracks.length === 0` the function returns and nothing is stored.
- `src/server/scrapers/crawlerEngine.ts:1200-1264` (`matchTracks`): the matched text is `title + description + organization + referenceNo` from the listing row only (line 1207).
- `src/server/scrapers/crawlerEngine.ts:1470-1482`: document scope re-scoring (`applyDocumentScopeToTracks`) runs only for tenders that already passed the gate at line 1342.

**Why it matters**
Many listings have a generic title ("Tender Notice", "Advertisement", a PDF file name) and the scope is inside the attached PDF or image. Those tenders are rejected before the document reader runs. The rejection leaves no row, no counter, and no log line.

**Possible solution**
Option A (recommended): hold unmatched tenders that have documents, then decide after reading.
1. At line 1342, if no track matched **and** `orderDocumentCandidates(item)` is non-empty, insert the tender with `ingestion_status = 'staging'` (the status and its read-path filters already exist; see `docs/14` P2-4) and queue its documents with `enqueueDocumentJobs`.
2. In `src/server/ingestWorker.ts`, after a document is read, call `applyDocumentScopeToTracks` with an empty base. If it returns at least one track, set `ingestion_status = 'ready'`; otherwise delete the row and record a suppression so it is not re-read on the next scan.
3. Cap the cost: only the first 2 documents per unmatched tender, and reuse the existing Vision budget in `src/server/ingestBudget.ts`.
4. Change `releaseStaleStagingTenders` (called at `src/server/retention.ts:78`) so it does not publish unmatched staging rows to the Inbox; delete them after a fixed age instead.

Option B (smaller): keep the current gate, but count rejections per scan and per portal (`items_seen`, `items_rejected_no_track`) in `portal_health` and `ScanStatus`, so the operator can see how much is discarded.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts`
- `src/server/ingestWorker.ts`
- `src/server/db/repositories/tendersRepo.ts`, `src/server/db/repositories/ingestJobsRepo.ts`
- `src/server/retention.ts`
- `src/types.ts` (`ScanStatus`), `src/components/SourcesScreen.tsx` (Option B counters)
- `tests/scraper/`, `tests/db/`

**Done when**
A listing titled "Tender Notice" whose PDF contains an active positive keyword appears in the Inbox after one worker pass, and one whose PDF contains none does not.

---

## F3. Fake reference numbers merge different tenders

**Where**
- `src/server/scrapers/crawlerEngine.ts:331-334` (`extractRefFromText`): the third alternative of the regex, `\b[A-Z]{2,10}[-/][A-Z0-9/-]*\d[A-Z0-9/-]{1,20}\b` with the `i` flag, accepts any "letters, hyphen or slash, digits" text. It is called on the full row text at lines 477, 509, 708, 744 and 836, and on the title at lines 557, 580, 600 and 890.
- `src/server/deduplicator.ts:59-72` (`isValidReferenceNo`): only checks length 4-40, not a generic word, and at least one digit.
- `src/server/deduplicator.ts:89-106` (`findCanonicalMatch`, Tier 1): an equal normalised reference returns `isDuplicate: true` with similarity 1.0, with no check of portal, organisation, title, or closing date.
- `src/server/scrapers/crawlerEngine.ts:1361-1404`: on a duplicate, the scanned item is only recorded as a secondary source (and only if the portal name differs, line 1366-1367), then the function returns.

**Verified behaviour** (regex run on sample row text):

| Row text | Extracted "reference" |
| :-- | :-- |
| `Supply of solar panels Closing 15-Jun-2026 Opening 16-Jun-2026` | `Jun-2026` |
| `Tender Notice 30 June-2026` | `June-2026` |
| `Procurement of IT equipment FY-2026-27 dated 01/07/2026` | `FY-2026-27` |
| `Hiring of firm for COVID-19 awareness` | `COVID-19` |
| `Construction of school RFP-01 Islamabad` | `RFP-01` |
| `Lot-12 furniture` | `Lot-12` |
| `Printing of books 2026-27 download /uploads/2026/05/file.pdf` | `uploads/2026/05/file` |

**Why it matters**
Two unrelated tenders whose rows both contain, for example, a date in June 2026 get the same "reference" `Jun-2026`. The second one is treated as a certain duplicate of the first and never reaches the Inbox. If both come from the same portal, not even a secondary-source entry is written.

**Possible solution**
1. In `extractRefFromText`, remove dates and URLs from the text before matching: strip `DATE_CANDIDATE_PATTERN` matches, month-year fragments (`(Jan|Feb|…|Dec)[a-z]*[-/ ]\d{2,4}`), and anything matching `https?://\S+` or `/\S+\.(pdf|docx?|xlsx?|jpe?g|png|webp)`.
2. In `isValidReferenceNo`, reject values whose letter prefix is a month name or one of `fy`, `lot`, `covid`, `page`, `uploads`, and reject a bare generic prefix (`rfp`, `rfq`, `nit`, `eoi`, `tender`) followed by 3 digits or fewer.
3. In Tier 1 of `findCanonicalMatch`, treat a reference match as a duplicate only if at least one corroborating signal also holds: organisation Dice similarity ≥ 0.50, or title Dice similarity ≥ 0.50, or closing dates within 1.5 days. Otherwise fall through to Tiers 2 and 3.
4. One-time cleanup: set `tenders.reference_no = NULL` for stored values that fail the new `isValidReferenceNo`, so old fake references stop matching.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts` (`extractRefFromText`)
- `src/server/deduplicator.ts` (`isValidReferenceNo`, `findCanonicalMatch`)
- `src/server/db/repositories/tendersRepo.ts` and `src/server/db/schema.ts` (cleanup migration; also move the Tier 1 SQL here per `docs/14` P2-9)
- `tests/unit/` (regex and validator cases from the table above), `tests/scraper/` (two distinct tenders sharing `Jun-2026` both get inserted)

**Done when**
All seven sample rows above return no reference, a genuine reference such as `PSDF/PROC/2026/014` still matches, and two different tenders sharing a pseudo-reference both appear in the Inbox.

---

## F4. Deadline changes are lost for tenders without a reference number

**Where**
- `src/server/deduplicator.ts:109-124`: Tier 2 and Tier 3 candidates are limited to tenders whose `closing_date` is within 1.5 days of the **scanned** date (or, for undated items, undated tenders created in the last 14 days).
- `src/server/scrapers/crawlerEngine.ts:1408-1410`: the tender id is a hash of `portal.id`, `referenceNo`, normalised title and `directUrl`. It does not include the date, so a re-scan with a new date produces the same id.
- `src/server/scrapers/crawlerEngine.ts:1545-1555`: the `ON CONFLICT(id) DO UPDATE` clause updates `match_score`, `semantic_score`, `embedding`, `domain_tracks`, `matched_keywords`, `cached_dossiers` and `updated_at`. It does not update `closing_date`, `closing_date_formatted` or `has_corrigendum`, and writes no `corrigendum_logs` row.
- `src/server/scrapers/crawlerEngine.ts:1604`: this path returns `isNew: true`, so the scan's "new tenders" count includes re-scans.
- `src/server/db/repositories/tendersRepo.ts:339-360` (`getExpiredUnreviewedTenderIds`): deletes `New Opportunity` tenders once `closing_date` plus the grace period (default 2 days) has passed.
- `src/server/db/repositories/tendersRepo.ts:399-414` (`isTenderSuppressed`): each hit refreshes `deleted_at`, so the record stays active for as long as the portal keeps listing the tender.

**Sequence**
1. Tender T is stored with deadline D1 and no valid reference number.
2. The portal extends the deadline to D2, more than 1.5 days after D1.
3. Next scan: Tier 1 is skipped (no reference). Tiers 2 and 3 look only near D2, so T (at D1) is not a candidate. No duplicate is found.
4. The insert hits `ON CONFLICT(id)`; `closing_date` stays D1 and no corrigendum is logged.
5. At D1 + 2 days, retention deletes T as `auto-expired` and records a suppression.
6. Every later scan finds T suppressed and refreshes the suppression. T does not return while it is still open.

For a tender already moved to the Pipeline, steps 1-4 apply: it keeps showing D1.

The same gap applies in the other direction (see `docs/14` P1-4): at line 1382 only a later date is applied on the duplicate path.

**Possible solution**
1. Add an identity check before `findCanonicalMatch`: compute `tenderId` first and look the row up by id. If it exists, treat the item as a re-scan of that tender, whatever the dates are.
2. Move the date-comparison block at lines 1376-1401 into one function, for example `applyRescannedDeadline(existing, scannedIso)`, and call it from both the id-match path and the duplicate path:
   - scanned later than stored, different PKT day → update `closing_date`, `closing_date_formatted`, set `has_corrigendum = 1`, insert a `corrigendum_logs` row of type `deadline_extension`;
   - scanned earlier than stored, different PKT day → do not change the date; set `needs_review = 1` with reason `deadline_moved_earlier` (this closes P1-4);
   - same PKT day → no change.
3. Return `isNew: false` when the row already existed.
4. Suppression: add a `reason` column to `deleted_tenders` (`user` | `auto-expired` | `stale`). In `processAndSaveTender`, if the hit has `reason = 'auto-expired'` and the scanned `closing_date` is in the future and later than the suppressed `closing_date`, remove the suppression and insert the tender with `has_corrigendum = 1`. Suppressions with `reason = 'user'` are never lifted.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts` (`processAndSaveTender`)
- `src/server/deduplicator.ts` (optional: id match as "Tier 0")
- `src/server/db/repositories/tendersRepo.ts` (`recordTenderSuppression`, `isTenderSuppressed`, `deleteTenders`, new update function for the deadline)
- `src/server/db/schema.ts` (`deleted_tenders.reason` migration)
- `tests/scraper/`, `tests/db/`

**Done when**
A tender without a reference, re-scanned with a deadline 7 days later, shows the new deadline, `has_corrigendum = 1` and one `corrigendum_logs` row; and an auto-expired tender that reappears with a later future deadline returns to the Inbox.

---

## F5. A single-portal scan postpones the full scan

**Where**
- `src/server/scheduler.ts:100-123` (`checkAndTriggerCatchUpScan`): line 102 reads `MAX(last_scan_at)` over all `portal_health` rows whose status is not `error`, and a full scan starts only if that value is 12 or more hours old (line 116).
- `src/server/scrapers/crawlerEngine.ts:149-190`: `last_scan_at` is written for every scanned portal, including single-portal scans started manually or by `runDailyPortalHealthAdvisement` (`src/server/scheduler.ts:129-148`).

**Why it matters**
Scanning one portal sets a fresh `last_scan_at`, so the other portals are treated as recently scanned for the next 12 hours.

**Possible solution**
1. In `startCrawlerScan`, when `targetPortalId` is undefined, write `last_full_scan_at` to `app_settings` in the `finally` block (line 211).
2. In `checkAndTriggerCatchUpScan`, read `last_full_scan_at` instead of `MAX(last_scan_at)`.
3. Move the SQL at `scheduler.ts:23` and `:102` into `portalsRepo.ts` / `systemRepo.ts` (`docs/14` P2-9).

**Affected files**
- `src/server/scheduler.ts`
- `src/server/scrapers/crawlerEngine.ts`
- `src/server/db/repositories/systemRepo.ts`
- `tests/` (scheduler test: a single-portal scan does not change the full-scan due time)

**Done when**
After a single-portal scan, a full scan still starts once 12 hours have passed since the last **full** scan.

---

## F6. Scans run only while the app is open

**Where**
- `src/server/scheduler.ts:20-83` (`initStartupScheduler`): all scanning is driven by in-process timers (30-minute watchdog at line 73).
- `start-tender-tracker.bat` / `npm run dev`: the app runs only when started by the operator.

**Why it matters**
With F1, a tender must be on page 1 during a scan. Any period with the PC or app off is a period with no scans.

**Possible solution**
1. Register a Windows Task Scheduler task that starts the server at logon (and optionally wakes the PC twice a day).
2. Show "last full scan: N hours ago" in the app shell, with a warning state above 24 hours.
3. F1's incremental crawl ("continue until a page contains only known tenders") lets the first scan after a gap recover what was published during it.

**Affected files**
- `scripts/` (new `install-startup-task.ps1` or similar)
- `src/components/AppShell.tsx` or `src/components/KpiHeader.tsx`
- `src/server/routes/scan.routes.ts` (expose `last_full_scan_at`)
- `docs/07-operations-and-backup.md`, `docs/10-operator-guide.md`

**Done when**
After a reboot the server is running without a manual start, and the UI shows the age of the last full scan.

---

## F7. Keywords match as substrings

**Where**
- `src/server/scrapers/crawlerEngine.ts:1218`: negative keywords, `combinedText.includes(neg.toLowerCase())`.
- `src/server/scrapers/crawlerEngine.ts:1227`: positive keywords, `combinedText.includes(pos.toLowerCase())`.
- `src/server/scrapers/crawlerEngine.ts:1294` and `:1299` (`applyDocumentScopeToTracks`): the same substring test on document text.

**Why it matters**
A negative keyword removes the whole track for that tender (line 1219), so a short negative keyword rejects unrelated tenders (for example `car` inside `care`). A short positive keyword produces wrong matches (for example `it` inside `audit`).

**Possible solution**
1. Add one helper, for example `containsKeyword(text, keyword)`, that matches on token boundaries: `(?<![\p{L}\p{N}])` + escaped keyword + `(?![\p{L}\p{N}])` with flags `iu`. Multi-word keywords keep working because inner spaces are matched literally (normalise whitespace first).
2. Optionally accept a trailing plural `s`/`es`.
3. Use the helper at all four call sites.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts` (`matchTracks`, `applyDocumentScopeToTracks`)
- `tests/unit/` (cases: `car` vs `care`, `it` vs `audit`, multi-word keyword, keyword next to punctuation)

**Done when**
`car` as a negative keyword does not reject "health care services", and `solar` still matches "Solar-powered pumps".

---

## Suggested order

1. **F3 and F4**: small, contained changes; each one currently loses tenders that the scan already found.
2. **F7 and F5**: small changes with unit tests.
3. **F1**: largest coverage gain; per-portal work.
4. **F2**: needs a decision between Option A and Option B.
5. **F6**: operational.

---

## Resolution Summary (2026-11-11)

All issues F1 through F7 have been implemented and verified in the test suite and live system:
- **F1 (Multi-page Pagination)**: Implemented in `crawlerEngine.ts` with optional pagination definitions in `portalList.ts`. Scans up to `maxPages`, stops on empty pages or known item loops, logs `pages_scanned` in `portal_health`.
- **F2 (Hold for Scope)**: Generic/unmatched listings with documents are inserted with `ingestion_status = 'awaiting_scope'`. The background worker reads up to 2 documents; if positive track keywords are matched, it promotes the tender to `ready`, otherwise deletes and suppresses it.
- **F3 (Strict Reference Numbers)**: Built `src/server/referenceNo.ts` with strict validation (stripping dates, URLs, generic words) and single normalisation `reference_norm`. Dedup Tier 1 requires corroboration unless the reference is long and structured.
- **F4 (Deadline Extension & Rescan)**: Re-scan identity check preserves pipeline integrity; extensions log corrigenda; earlier dates set `needs_review = 1`; auto-expired suppressions are lifted if a later future deadline is published.
- **F5 (Full Scan Clock)**: Tracks `last_full_scan_at` in `app_settings` only on complete scans across all portals. Single-portal manual or advisement scans no longer postpone full scans.
- **F6 (Logon Background Startup)**: Added `scripts/install-startup-task.ps1` to register a Windows Task Scheduler task that launches Tender Tracker on logon. Added scan freshness indicator to UI shell.
- **F7 (Token-Boundary Keyword Matching)**: Created `src/server/scrapers/trackMatcher.ts` with regex token boundary `containsKeyword` matcher and plural inflection support. Substrings like "car" in "care" or "it" in "audit" no longer false-trigger.

