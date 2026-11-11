# 09. Known Bugs & Solutions (B1 to B13)

This document catalogs the 13 architectural and operational defects identified in the legacy codebase and details the test-first solutions implemented.

---

### Bug B1: Playwright Headless Fallback in Scraper
- **Symptom**: Portals designated as `tier: 'playwright'` (such as Sindh SPPRA) crashed if Playwright dependencies were uninstalled or headless browser contexts failed to launch.
- **Root Cause**: Unhandled rejection when spawning browser processes in `scrapePortal()`.
- **Solution**: Implemented a try/catch wrapper around the Playwright context in `crawlerEngine.ts` and `htmlFetcher.ts`. If browser launch fails, it logs a warning and gracefully falls back to the tolerant HTTP agent with Cheerio, preventing scan termination.
- **Test File**: `tests/scraper/crawler.test.ts`.

---

### Bug B2: Scan Completion Awaiting for Health Probes
- **Symptom**: Daily health check routines triggered scans asynchronously without awaiting completion, causing race conditions in reporting status to the operator.
- **Root Cause**: `startCrawlerScan()` returned `void` immediately after spawning the background crawler loop.
- **Solution**: Added optional `awaitCompletion: boolean` parameter to `startCrawlerScan(targetPortalId?, awaitCompletion?)`. When `true`, it returns a Promise that resolves only once all designated portals have completed scanning.
- **Test File**: `tests/scraper/crawler.test.ts`.

---

### Bug B3: Startup Watchdog for Stuck "Scanning" Portals
- **Symptom**: If the server process was terminated during an active scan, portals remained permanently stuck with `status = 'scanning'`, preventing subsequent crawls.
- **Root Cause**: No startup recovery logic reset transient execution states.
- **Solution**: Added an automatic startup check in `scheduler.ts` (`initStartupScheduler()`). On startup, any portal with `status = 'scanning'` is immediately reset to `status = 'error'` with `last_error_message = 'Previous scan was interrupted'`.
- **Test File**: `tests/scraper/scheduler.test.ts`.

---

### Bug B4: Cloudflare Turnstile Challenge Detection
- **Symptom**: When government portals enabled Cloudflare Turnstile or bot protection, HTTP scrapers received 403 Forbidden and logged unhandled parsing errors.
- **Root Cause**: The scraper treated Cloudflare challenge HTML as malformed tender pages.
- **Solution**: Added heuristic challenge detection in `crawlerEngine.ts`. If HTTP 403/503 is returned and the body contains Cloudflare markers (`cf-browser-verification`, `Turnstile`), the portal status is set to `hitl_required` with `verified_status = 'Challenge detected'`, surfacing a one-click HITL browser launcher in the UI.
- **Test File**: `tests/scraper/crawler.test.ts`.

---

### Bug B5: Zero-Yield Diagnostics and Login Redirection Detection
- **Symptom**: When a portal changed its DOM structure or redirected to a login wall, the scraper silently reported 0 items without notifying the operator.
- **Root Cause**: An empty array was treated as a successful crawl (`status: 'online'`).
- **Solution**: When a crawl yields 0 items:
  1. The crawler checks if the returned HTML contains a login form (`isLoginRequired`), setting `status = 'hitl_required'`.
  2. Increments `consecutive_zero_yields` and updates `last_error_message = 'No listings found on the last scan'`.
- **Test File**: `tests/scraper/crawler.test.ts`.

---

### Bug B6: Ingestion of Already-Expired Opportunities
- **Symptom**: Legacy tenders published weeks prior with deadlines already in the past were saved to the Inbox.
- **Root Cause**: Date validation occurred only during rendering rather than during database insertion.
- **Solution**: Added closing date temporal check in `crawlerEngine.ts`: if a tender's parsed closing date is in the past (`closeDate.getTime() < Date.now()`), the crawler skips persisting it as a new opportunity.
- **Test File**: `tests/scraper/crawler.test.ts`.

---

### Bug B7: Ambiguous Date Extraction on Multi-Date Notices
- **Symptom**: On notices displaying both "Publish Date", "Pre-Bid Meeting Date", and "Submission Deadline", the parser occasionally selected the earlier pre-bid meeting date as the closing date.
- **Root Cause**: Regex greedily matched the first chronological date string found in the text.
- **Solution**: Implemented `extractDatesFromText()` in `src/server/scrapers/portalParsers.ts` (re-exported by `crawlerEngine.ts`). It prioritizes explicit label markers (e.g., `"Submission Deadline:"`, `"Closing Date:"`, `"Last Date:"`). If multiple unlabeled dates exist, it selects the latest chronological date for the deadline.
- **Test File**: `tests/unit/crawler-date.test.ts` & `tests/scraper/crawler.test.ts`.

---

### Bug B8: Strict Tender Status Validation
- **Symptom**: Invalid status values could be injected into `PATCH /api/tenders/:id/status`, corrupting pipeline metrics.
- **Root Cause**: No whitelist validation against `TENDER_STATUSES`.
- **Solution**: In `src/server/routes/tenders.routes.ts`, the endpoint strictly validates `req.body.status` against `TENDER_STATUSES`. Returns HTTP 400 Bad Request if an unrecognized status is received.
- **Test File**: `tests/api/routes.test.ts`.

---

### Bug B9: Hardcoded Sessions Directory in Browser Engine
- **Symptom**: `playwrightEngine.ts` and `portalAuth.ts` hardcoded session paths to `data\sessions`, violating environment isolation during tests.
- **Root Cause**: Bypassed `SESSIONS_DIR` exported from `db.ts`.
- **Solution**: Refactored both modules to import `SESSIONS_DIR` dynamically configured via `TENDER_DATA_DIR`.
- **Test File**: `tests/scraper/playwright.test.ts` & `tests/scraper/portalAuth.test.ts`.

---

### Bug B10: SSL Verification Tolerant Agent Architecture
- **Symptom**: Municipal portals with expired or incomplete SSL certificate chains failed with network exceptions.
- **Root Cause**: Default Node `fetch` rejected unverified SSL certificates.
- **Solution**: Encapsulated tolerant HTTPS agent (`rejectUnauthorized: false`) in `fetchHtmlWithTolerantAgent` inside `src/server/scrapers/htmlFetcher.ts` (re-exported by `crawlerEngine.ts`) with explicit masqueraded headers.
- **Test File**: `tests/unit/base-scraper.test.ts`.

---

### Bug B11: Host Binding Security Configuration
- **Symptom**: Server defaulted to binding on all network interfaces (`0.0.0.0`), exposing internal management APIs to local network devices.
- **Root Cause**: `app.listen(PORT)` without explicit host argument.
- **Solution**: Exported `startServer()` in `server.ts` with `host: process.env.HOST || '127.0.0.1'`.
- **Test File**: `tests/api/routes.test.ts`.

---

### Bug B12: Clear Inbox Safety Confirmation Copy
- **Symptom**: The Clear Inbox modal warning text caused operator anxiety by ambiguously implying all pipeline data might be erased.
- **Root Cause**: Imprecise confirmation text in `SourcesScreen.tsx`.
- **Solution**: Rewrote confirmation copy to clearly state:
  *"Removes unreviewed opportunities from the inbox. Active bid pursuits, bookmarks, and pipeline records are preserved."*
- **Test File**: `tests/ui/sources-screen.test.tsx`.

---

### Bug B13: Sub-Minute Time Synchronization
- **Symptom**: In-memory countdown clocks on tender deadlines lagged or jumped when client timers drifted.
- **Root Cause**: Inconsistent tick intervals in React state.
- **Solution**: Unified time interval hook `useTick(60_000)` in `src/components/inbox/Detail.tsx` (re-exported by `InboxScreen.tsx`) and `PipelineScreen.tsx`, driving synchronized deadline rendering across all open cards.
- **Test File**: `tests/ui/inbox-screen.test.tsx`.

---

## Ingestion Pipeline & Backlog Fixes (2026-11-10 to 2026-11-11)

Following the initial B1–B13 fixes, a comprehensive audit of the **Scrape $\rightarrow$ Document Ingest $\rightarrow$ Verification $\rightarrow$ Inbox** pipeline was completed (archived in [`docs/archive/13-ingestion-pipeline-plan.md`](./archive/13-ingestion-pipeline-plan.md)):

- **B6b & B6c (Stale Undated Archive Notices)**: Undated notices with explicit publish dates older than 90 days, unreadable upload-folder dates older than 90 days, or titles/URLs referencing only prior calendar years are rejected at ingest and recorded in `deleted_tenders`.
- **Canonical Deadline Reconciliation (`resolveCanonicalDeadline`)**: Later valid deadlines win; same-day document times beat a listing's default 14:00 PKT; corrigenda or re-scans that move a deadline to an earlier calendar day flag the tender (`needs_review = 1`) rather than silently overwriting or deleting it.
- **Tagged Embedding Vector Spaces (`embeddingService.ts`)**: 384-D `all-MiniLM-L6-v2` embeddings (`model` tag) and fallback keyword vectors (`fast` tag) are never compared across spaces; `backfillModelEmbeddings()` upgrades legacy/fast vectors on startup.
- **Abortable & Size-Capped Downloads (`dossierManager.ts`)**: Upfront downloads pass an `AbortSignal` on timeout, check `Content-Length` + streaming byte caps against `maxFileBytes()`, and defer directory creation until download succeeds so failed downloads never leave empty folders.
- **Legacy Attachment Backfill (`ingestJobsRepo.ts`)**: Added `attachment_urls` persistence on `tenders` and `backfillExistingTenderDocumentJobs()` on startup so existing undated/direct-document tenders have their attachments queued automatically.

---

## Deep Ingest & Deduplication Flaws (2026-11-11, `docs/archive/15` & `docs/archive/16`)

All 23 deep logic flaws (A1–A11, B1–B8, C1–C4) and 7 fundamental issues (F1–F7) were addressed in code, verified with unit and integration tests (525 tests in Vitest), and validated against the live database (details archived in [`docs/archive/15-fundamental-logic-issues.md`](./archive/15-fundamental-logic-issues.md) and [`docs/archive/16-deep-audit-logic-flaws.md`](./archive/16-deep-audit-logic-flaws.md)):
- **A1, A5, A4 (Re-scan & Pipeline Safety)**: Isolated re-scan path preventing overwriting or staging existing rows. Pipeline rows retain stages, notes, and dossiers across re-scans. Deadlines update only via `applyRescannedDeadline`.
- **A6–A11 (Date & Time Parsing)**: Lone dates partitioned correctly; query/pre-bid dates ignored; military hours ("1100 hrs") parsed accurately; table-of-contents corrigendum false-positives eliminated; year bounds strictly enforced (2010 to current+5).
- **A3, B1, C1, F3, F7 (Deduplication & Matching)**: Strict `referenceNo.ts` normalisation and validation (`reference_norm`). Similarity dedup excludes tender's own portal. `titlesAreDistinguishable` prevents merging distinct tenders differing by 1-2 key words. Token-boundary matching via `containsKeyword` in `trackMatcher.ts`.
- **A2, B8 (Retention & Suppression Safety)**: Unified 90-day undated ageing limit (`UNDATED_MAX_AGE_DAYS = 90`). Upload-folder dates tagged `publish_date_source = 'upload_folder'` and excluded from ageing. Undated suppressions expire after 120 days and lift if future deadline reappears. Failed downloads never trigger suppression.
- **B2 (Slimming Safety)**: Slimming Passed tenders retains `status_notes`; tenders ever in the pipeline (`pipeline_audit_logs`) preserve description and history.
- **B4, B5, C2, C4 (Scraping & Download Robustness)**: Downloads inspect magic bytes and Content-Type, rejecting HTML payloads. Navigation rows dropped. Image logos/stamps ignored in `collectRowAttachments`. HTML decoded from full Buffer chunks using declared/default UTF-8 charset.
- **B6, B7, F1, F5 (Sources Reliability & Scheduler)**: Multi-page crawler pagination with safety bounds. Retry on transient timeouts with exponential backoff (no auto-heal). Catch-up scan waits for full completion before running daily advisement. `last_full_scan_at` tracked in `app_settings`.
- **F2 (Hold for Scope)**: Generic/unmatched listings with documents held as `awaiting_scope` until worker reads documents; matching ones released to `ready`.
- **C3 (AI Budget Guardrails)**: All Gemini text and Vision calls bounded by `ingest_ai_text_calls_per_day` (default 150) and daily Vision budget.
