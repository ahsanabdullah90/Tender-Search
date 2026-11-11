> [!NOTE]
> **HISTORICAL ARTIFACT (CODE FIXES COMPLETE IN v1.5.0)**
> The code changes described in this document were made and verified in v1.5.0 (November 11, 2026) with 525 automated unit and integration tests. Three items are still open and are tracked in `docs/14-active-backlog.md`: the `D4` full-scan check on live data, the `P1-5` PDF benchmark, and the `P1-6` threshold calibration.
> For active system specifications, architecture, and current backlog, consult the canonical documentation in `docs/01` through `docs/14`.


# 17. Fix Checklist (docs/15 and docs/16)

**Created:** 2026-11-11
**Purpose:** one list of what is still to be fixed, in order, with what has already been changed in code.
**State of the work:** Code fixes are in place, 525 tests pass, the production build passes, and live-database cleanup D1–D3 is done. **D4 is still open**: a full scan has not yet finished end to end (see D4).

Legend: `[x]` completed and verified · `[ ]` not started · `[~]` started, part missing (stated).

---

## V. Verify what is already changed (do first)

- [x] **V1.** `npx tsc --noEmit` passes (0 errors).
- [x] **V2.** `npx vitest run --testTimeout=30000` passes (525/525 tests passing across 34 test files).
- [x] **V3.** `npx vite build` passes (clean bundle generated in ~1s).

---

## 1. Already changed in code (needs tests, then V)

| ID | Change | File(s) | Status |
| :-- | :-- | :-- | :-- |
| A11 | `parseDateString` fallback only accepts text with a 4-digit year in 2010 to current+5; `normalizeExtractedDate` rejects implausible years | `dateParser.ts` | Verified |
| A6 | A lone unlabeled date: future → closing date, past/today → publish date | `dateParser.ts` | Verified |
| A7 | All labelled closing dates are read; labels about queries, sale, pre-bid, opening, validity, updated are ignored; latest wins | `dateParser.ts` | Verified |
| A8 | "1100 hrs" / "1430 hours" read as 24-hour times; no auto-expiry during the deadline's own PKT day (`withinDeadlineDay`) | `documentExtractor.ts`, `dateParser.ts` | Verified |
| A9 | Corrigendum and cancellation recognised from the document heading only; table-of-contents lines skipped | `documentExtractor.ts` | Verified |
| C3 | Gemini text calls and unbudgeted Vision calls count against daily budgets (`ingest_ai_text_calls_per_day`, default 150) | `ingestBudget.ts`, `documentExtractor.ts`, `systemRepo.ts` | Verified |
| F3 / C1 | New `referenceNo.ts` (strict validation, one normalisation); `reference_norm` column; reference match needs corroboration unless the reference is long and structured | `referenceNo.ts`, `deduplicator.ts`, `tendersRepo.ts` | Verified |
| A3 | Similarity dedup excludes the tender's own portal; tenders that differ by one or two content words are never merged | `deduplicator.ts`, `tendersRepo.ts` | Verified |
| F7 | Whole-word keyword matching (`containsKeyword`); track matching moved to `trackMatcher.ts` | `trackMatcher.ts`, `crawlerEngine.ts` | Verified |
| A1 / A5 / F4 | A listing already stored (same id) is handled by a re-scan path that never re-stages or deletes it and changes the deadline only through `applyRescannedDeadline` (extension → corrigendum log; earlier day → review flag; same day → no change). `upsertScrapedTender` never overwrites a `ready` row. `deleteStagedTender` only removes new Inbox-stage staging rows | `crawlerEngine.ts`, `tendersRepo.ts` | Verified |
| A4 | Only a reference-number match may change a stored deadline; a similarity match from another portal only records its date on the secondary source | `crawlerEngine.ts`, `deduplicator.ts` | Verified |
| B1 | Own portal never recorded as a secondary source; entries unique by link | `tendersRepo.ts` | Verified |
| F2 | Listings that match no track but have documents are held as `awaiting_scope` (hidden), first two documents queued; the worker releases them if the document text matches a track, otherwise deletes and suppresses them | `crawlerEngine.ts`, `ingestWorker.ts`, `tendersRepo.ts` | Verified |
| B3 | One `applyDocumentResultToTender` (new `documentApply.ts`) used by the worker, Fetch documents and Analyze/Refresh | `documentApply.ts`, `ingestWorker.ts`, `crawlerEngine.ts` | Verified |
| A2 | One undated-ageing limit (`UNDATED_MAX_AGE_DAYS = 90`) in ingest and retention; upload-folder publish dates marked `publish_date_source = 'upload_folder'` and not used for ageing; undated suppressions expire after 120 days; suppressions have a `reason` and are lifted when an auto-expired tender returns with a later future deadline | `tendersRepo.ts`, `crawlerEngine.ts`, `schema.ts` | Verified |
| B8 | A failed or skipped download never counts as "document without text"; no suppression from an unread document | `crawlerEngine.ts` | Verified |
| B2 | Slimming a Passed tender never erases notes; tenders that were ever in the Pipeline keep description, history and corrigenda and are not auto-retired | `tendersRepo.ts` | Verified |
| — | Migration: new columns (`reference_norm`, `publish_date_source`, `deleted_tenders.reason`, `portal_health.last_success_at`, `portal_health.pages_scanned`) and a one-time cleanup `runAuditCleanupOnce` | `schema.ts` | Verified |

---

## 2. Still to fix in code

Order is by risk to data, then coverage.

### 2.1 Gaps left in the changes above

- [x] **G1. Inbox ageing still 60 days.** `InboxScreen.tsx` (`isClosedUntracked`) uses 90 days and ignores upload-folder publish dates (uses `created_at` when `publish_date_source = 'upload_folder'`). Added to `Tender` type.
- [x] **G2. Hidden rows never cleaned up.** `retention.ts` deletes `awaiting_scope` tenders older than 3 days (`getStaleAwaitingScopeTenderIds`, then `deleteTenders(..., 'no-track-match')`). `releaseStaleStagingTenders` excludes `awaiting_scope` rows.
- [x] **G3. Counters.** `ScanStatus` includes `heldForScope`, and Sources screen displays it.
- [x] **G4. Fetch-documents timing.** `fetchDocumentsForTender` reads documents when `newlyFetched > 0`; route tests verified passing.
- [x] **G5. `tryConsumeScanVision` outside a scan** routes on-demand Vision through the daily counter fallback.
- [x] **G6. Dedup test fixtures.** On-the-fly `reference_norm` calculation covers unpopulated fixtures, verified with tests.

### 2.2 Not started

- [x] **A10. Detail-page date enrichment** (`crawlerEngine.ts` `scrapePortal`, undated items): selects the deepest element carrying a "Create Date" label only; never assigns a closing date from a creation date; removes `nav/header/footer/aside` first; calls `crawlerDeps.fetchHtml`.
- [x] **B4. Downloads.** `dossierManager.ts`: reads `Content-Type` and magic bytes; rejects `text/html`; selects extension from magic bytes, then `Content-Type`, then URL (never the label); marks "(Updated)" only when the same URL returns different bytes.
- [x] **B5. Site images as documents.** `collectRowAttachments`: only images inside a link or under an uploads/notice path; skips `/img/`, `/images/` and names containing stamp/seal/badge/watermark/logo; BPPRA, PSDF and GBPPRA `directUrl` does not fall back to an image.
- [x] **C2. Navigation rows.** Drops items whose link is the portal's base or listing URL and that have no date, reference or attachment; drops titles made of newspaper or category names.
- [x] **C4. HTML decoding.** `fetchHtmlWithMetadata`: collects `Buffer` chunks and decodes once using the declared charset (default UTF-8).
- [x] **B6. Source failures visible.**
  - retries a timed-out fetch up to 2 times with backoff (30 s, 2 min), no auto-heal;
  - on `error` sets `last_items_found = 0` and writes `last_success_at` only on success;
  - does not fall back silently when Playwright fails for a `tier: 'playwright'` portal; records the reason;
  - Sources and the Inbox header show "N of M sources checked successfully" and last success time.
- [x] **B7. Startup health check.** `scheduler.ts`: runs `runDailyPortalHealthAdvisement` after the catch-up scan finishes; sets `lastDailyHealthCheck` only after a portal was actually checked.
- [x] **F5. Full-scan clock.** Stores `last_full_scan_at` in `app_settings` when a full scan finishes; `checkAndTriggerCatchUpScan` reads it instead of `MAX(last_scan_at)`.
- [x] **F1. Pagination.** Optional `pagination` field on `PortalDefinition` (`query` | `path` | `postback` | `click`, `maxPages`); `scrapePortal` loops pages, stops on an empty page, a page of only known items, or `maxPages`; `pages_scanned` stored per portal; empty later pages never count towards `consecutive_zero_yields` or trigger auto-heal. Defined for Punjab eproc, Sindh, NDMA, UNGM.
- [x] **F6. Scans only while the app is open.** `scripts/install-startup-task.ps1` (Task Scheduler logon task) and a "last full scan: N hours ago" indicator with a warning above 24 hours.
- [x] **UI:** shows `awaiting_scope` counts in Sources, shows the new AI-text budget in the Data tab (`SourcesScreen.tsx`, `system.routes.ts` `ingest-budgets`).

### 2.3 Tests to add (one per item; the verified examples in docs/16 are the cases)

- [x] `tests/unit/crawler-date.test.ts`: A6, A7, A11 cases; `isPlausibleTenderYear`.
- [x] `tests/unit/document-extractor.test.ts`: A8 ("1100 hrs", "1430 hours", "11:00 AM"), A9 (SBD contents sample not a corrigendum nor a cancellation; real ones detected).
- [x] `tests/unit/deduplicator.test.ts`: F3 table (seven rows return no reference), genuine reference still valid, A3 pairs stay separate, cross-portal duplicate still merges.
- [x] `tests/unit/crawler-match.test.ts`: F7 (`car` vs `care`, `it` vs `audit`, plural, multi-word).
- [x] `tests/scraper/ingest-queue.test.ts`: A1 (undated tender older than 14 days re-scanned keeps stage, notes and dossiers), A5 (earlier date flags, later date logs), F4 (suppressed tender returns with later deadline), F2 (generic title with matching PDF appears after one worker pass; non-matching one does not), B8 (timed-out download on old folder does not suppress).
- [x] `tests/db/db.test.ts`: B1, B2, suppression reasons and expiry, `reference_norm` backfill, cleanup migration.
- [x] `tests/scraper/scheduler.test.ts`: F5, B7.
- [x] `tests/scraper/crawler.test.ts` and portal contracts: A10, B5, C2 (BPPRA and Tender Services fixtures), pagination (F1) with a 3-page fixture.
- [x] `tests/scraper/dossierManager.test.ts`: B4, C4.

---

## 3. Clean the live database

Do after steps V and 2 pass, with the app stopped. A backup already exists; take a second one immediately before. The app runs the first part itself on start (`runAuditCleanupOnce`); the second part is manual and read-only first.

- [x] **D1.** Started and read report from `app_settings` key `migration_audit_fixes_2026_11`. Result:
  - 28 "Also listed on" entries naming the tender's own portal removed;
  - 1 stamp image replaced as `direct_url` (`tender-bppra-e0ca74c11db2e8ad`) and its queued job removed;
  - 1 navigation row removed ("All Newspapers …");
  - item counts of errored portals reset to 0;
  - references normalised (17 live references validated).
- [x] **D2.** Reviewed and resolved live dated rows: 0 Tender Services rows have `deadline_source = 'html_row'`; 11 pipeline rows (9 Passed, 2 Under Review) intact; 7 suppressions updated with `reason = 'legacy'`.
- [x] **D3.** Re-ran read-only checks: 0 closing dates before 2020; 0 self secondary sources; 0 jobs under `/img/`; 0 rows with invalid ingestion_status.
- [~] **D4.** A full scan was started on 2026-11-11 and stopped partway through (during NDMA retries), so `last_full_scan_at` was never written. Afterwards all 11 Pipeline tenders were still present with unchanged stages (9 Passed, 2 Under Review). Notes and dossiers were **not** compared against a pre-scan snapshot: the check script ran before the scan finished because `startCrawlerScan()` was not awaited. **Still to do:** run one complete full scan with `startCrawlerScan(undefined, true)` and compare stage, notes and dossiers before and after.

---

## 4. Documentation to update at the end

- [x] `docs/16-deep-audit-logic-flaws.md`: status column per item (fixed in code & verified by tests) and full resolution summary.
- [x] `docs/15-fundamental-logic-issues.md`: status per F1 to F7 (fixed & verified) and resolution summary.
- [x] `docs/14-pending-issues.md`: replaced pointer paragraph with complete resolution details.
- [x] `docs/03-database-schema.md`: documented `reference_norm`, `publish_date_source`, `deleted_tenders.reason`, `portal_health.last_success_at`, `portal_health.pages_scanned`, `awaiting_scope`, and `app_settings`.
- [x] `docs/06-pipeline-and-workflow.md`: documented ingest order (re-scan path first, hold for scope, dedup rules), slimming rules, suppression rules, and 90-day ageing limit.
- [x] `docs/04-api-reference.md` and `docs/11-configuration-and-env.md`: documented new budget keys (`aiTextCallsPerDay`) and `ingest-budgets` response.
- [x] `docs/12-decisions-and-changelog.md`: documented ADR 10 (same-portal identity, corroborated references, 90-day limit, 120-day undated suppression, hold-for-scope, pagination, retry backoff) and Version 1.5.0 changelog.
- [x] `docs/09-known-bugs-and-fixes.md`, `docs/08-testing-and-coverage.md`, `README.md`: updated test counts to 525 tests and documented resolutions.

---

## Order of work

1. V1-V3 (verify the batch already changed) - **COMPLETE**.
2. G1, G2, G3 (they leave hidden or wrongly aged rows) - **COMPLETE**.
3. A10, B5, C2, B4, C4 (parsing and download correctness) - **COMPLETE**.
4. B6, B7, F5 (source failures and scheduling) - **COMPLETE**.
5. F1 (pagination), F6 - **COMPLETE**.
6. Tests in 2.3, then V again - **COMPLETE**.
7. D1-D3 (database), then section 4 (documentation) - **COMPLETE**. D4 (full scan with before/after Pipeline comparison) - **STILL OPEN**, tracked in `docs/14-active-backlog.md`.

