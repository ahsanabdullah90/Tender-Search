# 13. Quality Standard & Requirements Register

**Last updated:** 2026-11-11 · **Applies to:** v1.5.0

## 1. Purpose and authority

This document is the single list of rules the app must obey. Code is audited against it one requirement at a time.

- **This document states the rules.** Docs `01`–`12` explain how the app works. If one of them disagrees with a requirement here, this document wins and the other doc is the one to fix.
- **One exception:** the 7 healer rules are written in `AGENTS.md §2`. `HEAL-1` to `HEAL-7` below restate them one-to-one, and `AGENTS.md` is the wording of record.
- **Open work lives in [`14-active-backlog.md`](./14-active-backlog.md).** Each backlog item names the requirement IDs it will satisfy.
- **History lives in `docs/archive/`.** The letters in brackets after a requirement (for example `A4`, `F2`) are the audit findings that produced it.

### How to read a requirement

Each row has an ID, one testable sentence, the file that enforces it, the test that names that code, and a status.

| Status | Meaning |
|---|---|
| **Tested** | A test file refers to the enforcing code by name. This is a starting point for the audit, not a pass. |
| **Untested** / **Untested by name** | The rule is stated in the docs and the code exists, but no test refers to it by name. It may be covered indirectly. Where a test file is listed, it is the most likely place for that coverage and has not been confirmed. |
| **Not met** | Checked on 2026-11-11 and the code does not satisfy it. |
| **Unproven live** | Covered by tests, but never confirmed on a real scan or real data. |
| **Decision needed** | The rule cannot be written until the operator chooses. See §6. |
| **Withdrawn** | The operator dropped the requirement. The row stays so the ID is never reused. |

### How to audit against this register

For each requirement, in order: read the enforcing code, read the named test, and record **pass**, **fail** or **unproven** with the file and line as evidence. A requirement passes only if the code does what the sentence says and a test would fail if it stopped.

---

## 2. The three guarantees

Every requirement below exists to protect one of these.

- **G1. No silent misses.** A relevant, open tender on a monitored portal is never dropped without a trace.
- **G2. No silent wrong deletions.** An open tender is never auto-deleted on weak evidence, and an expired tender never sits in the Inbox looking active.
- **G3. No unexplained decisions.** Every deadline, match, merge, rejection and health change records where it came from.

---

## 3. Requirements register

### 3.1 Repository governance (`GOV`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| GOV-1 | The repository root holds only build configuration, launchers and `server.ts`; no loose images, media, dumps or scratch files. | `AGENTS.md §1` | Manual check of root listing | Tested (Pass: `app-icon.ico` removed; shortcut uses `public/favicon.ico`) |
| GOV-2 | `server.ts` contains no API route handlers; it only mounts `/api` and serves the built client. | `server.ts` | `tests/unit/system-governance.test.ts` | Tested |
| GOV-3 | Every REST endpoint and SSE stream lives in `src/server/routes/*.routes.ts` and is registered in `routes/index.ts`. | `src/server/routes/` | `tests/api/routes.test.ts` | Tested |
| GOV-4 | No `db.prepare` call exists outside `src/server/db/`. | `src/server/db/repositories/` | Command in §4 | Tested (0 occurrences) |
| GOV-5 | Schema DDL lives in `db/schema.ts` and the connection in `db/connection.ts`. | `src/server/db/` | `tests/db/db.test.ts` | Tested |
| GOV-6 | Every backend endpoint, repository function and scraper parser has a test under `tests/` that mirrors the `src/` layout. | `AGENTS.md §1` | `tests/` layout check | Tested (Pass: `referenceNo.test.ts`, `trackMatcher.test.ts`, `healer-rules.test.ts`, `rescan-pipeline.test.ts`) |
| GOV-7 | `tsc --noEmit` reports 0 errors. | `npm run lint` | `npm run verify` | Tested |

### 3.2 Self-healing URL healer (`HEAL`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| HEAL-1 | The healer runs only on HTTP 404, 410 or 500, or on a manual operator request; never on a 200 response with 0 items, a TLS reset or a timeout. | `healer.ts` `shouldTriggerAutoHeal` | `tests/scraper/crawler.test.ts` | Tested |
| HEAL-2 | A redirected URL replaces the in-memory URL only after it has produced tenders. | `healer.ts`, `crawlerEngine.ts` | `tests/unit/system-governance.test.ts`, `tests/scraper/crawler.test.ts` | Tested |
| HEAL-3 | A candidate URL must share the portal's hostname or its official parent domain. | `healer.ts` `isAllowedPortalDomain` | `tests/scraper/crawler.test.ts` | Tested |
| HEAL-4 | A specific listing path is never replaced by a bare `/` or a static file. | `healer.ts` `isValidHealedTendersUrl` | `tests/scraper/crawler.test.ts` | Tested |
| HEAL-5 | A healed URL is accepted only with at least 2 items, or 1 item that has a closing date plus a reference or attachment; an empty-table page is never accepted. | `healer.ts` `hasVerifiedTenderYield`, `hasEmptyTenderTableState` | `tests/scraper/crawler.test.ts`, `portal-contracts.test.ts` | Tested |
| HEAL-6 | `base_url` stores a clean URL origin only, with no path or query string. | `healer.ts` `sanitizeBaseOrigin` | `tests/scraper/crawler.test.ts` | Tested |
| HEAL-7 | The defaults in `PORTAL_DEFINITIONS` are never modified, so any portal can be reset to them. | `portalList.ts`, `portals.routes.ts` | `tests/scraper/crawler.test.ts` | Tested |

### 3.3 Fetching and parsing (`SCR`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| SCR-1 | Fixed selectors run first; AI extraction runs only when they return 0 items on a 200 page that has procurement words and is not an explicit empty state. | `crawlerEngine.ts` `scrapePortal`, `portalParsers.ts` `hasProcurementSignals` | `tests/unit/system-governance.test.ts`, `tests/scraper/crawler.test.ts` | Tested |
| SCR-2 | A 0-item scan keeps the portal's URL unchanged and records a warning in `last_error_message`. | `crawlerEngine.ts` | `tests/scraper/crawler.test.ts` | Tested |
| SCR-3 | A Cloudflare challenge or login wall sets the portal to `hitl_required` with the reason recorded. | `crawlerEngine.ts`, `playwrightEngine.ts` | `tests/scraper/playwright.test.ts` | Tested |
| SCR-4 | A portal with a `pagination` setting is read page by page until a page returns 0 items, every item on a page is already known, or `maxPages` is reached. (F1) | `crawlerEngine.ts`, `portalList.ts` | `tests/scraper/crawler.test.ts` (lines 1710–1760), confirmed live via `pages_scanned` | Tested & proven live |
| SCR-5 | Transient timeouts are retried with backoff and never trigger the healer. (B7) | `crawlerEngine.ts` | `tests/scraper/healer-rules.test.ts`, `tests/scraper/crawler.test.ts` | Tested |
| SCR-6 | Navigation rows are not ingested as tenders, and logos or stamps are not collected as tender documents. (C2, B5) | `src/server/scrapers/portalParsers.ts` (`isNavigationRow`, `collectRowAttachments`) | `tests/scraper/crawler.test.ts` | Tested |
| SCR-7 | HTML is decoded from the complete response buffer using the declared charset, defaulting to UTF-8. (C4) | `src/server/scrapers/htmlFetcher.ts` (`fetchHtmlWithMetadata`) | `tests/scraper/dossierManager.test.ts` | Tested |
| SCR-8 | Every reachable portal has an offline contract fixture of 50 KB or less. | `tests/fixtures/portals/` | `tests/scraper/portal-contracts.test.ts` (27/27 passing) | Tested (all 13 reachable portals covered; 3 unreachable/playwright documented in `NOT_COVERED`) |

### 3.4 Tender identity and re-scan safety (`ID`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| ID-1 | A tender's id is computed from portal, reference, normalised title and link, and the existing-row check runs before any duplicate search. (F4) | `ingestPipeline.ts` `computeTenderId`, `processAndSaveTender` | `tests/scraper/rescan-pipeline.test.ts` | Tested |
| ID-2 | A re-scan never switches an existing row to `staging` and never deletes it. (A1) | `ingestPipeline.ts` `applyRescanToExistingTender` | `tests/scraper/rescan-pipeline.test.ts` | Tested (also proven live via `D4`) |
| ID-3 | A re-scan never changes `pipeline_status` or `status_notes`. (A1, A5) | `ingestPipeline.ts` `applyRescanToExistingTender` | `tests/scraper/rescan-pipeline.test.ts` | Tested (also proven live via `D4`) |
| ID-4 | On a re-scan, new document links are added to `attachment_urls` and queued; links already queued are ignored. | `crawlerEngine.ts`, `ingestJobsRepo.ts` | `tests/db/ingestJobsRepo.test.ts` | Tested |

### 3.5 Deduplication (`DED`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| DED-1 | A reference-number match (Tier 1) uses `reference_norm` and needs one supporting signal: organisation similarity ≥ 0.5, title similarity ≥ 0.5, or closing dates within 1.5 days. A reference of 12 or more characters with 2 or more segments needs none. (C1, F3) | `deduplicator.ts` `findCanonicalMatch` | `tests/db/db.test.ts`, `tests/unit/deduplicator.test.ts` | Tested |
| DED-2 | Reference extraction rejects dates, month-year tokens, fiscal years, file paths and generic prefixes such as `Lot-12`. (F3) | `crawlerEngine.ts` `extractRefFromText`, `referenceNo.ts` | `tests/unit/deduplicator.test.ts` | Tested |
| DED-3 | Title and semantic matching (Tiers 2 and 3) only consider tenders from other portals. (A3) | `deduplicator.ts`, `tendersRepo.ts` (`findDedupCandidates`) | `tests/unit/system-governance.test.ts` | Tested |
| DED-4 | Two titles that differ by 1–2 key nouns are never merged. (A3) | `deduplicator.ts` `titlesAreDistinguishable` | `tests/unit/deduplicator.test.ts` | Tested |
| DED-5 | A tender's own portal is never recorded in `secondary_sources`, and entries are unique by `direct_url`. (B1) | `tendersRepo.ts` | `tests/db/db.test.ts` | Tested |
| DED-6 | Vectors from the `model` space and the `fast` space are never compared with each other. | `embeddingService.ts` | `tests/unit/embedding-spaces.test.ts` | Tested |
| DED-7 | The duplicate threshold (0.88) is calibrated on at least 30 labelled pairs with F1 ≥ 0.90 and a false-merge rate of 0%. (P1-6) | `embeddingService.ts`, `deduplicator.ts` | `tests/unit/semantic-calibration.test.ts` | Tested & Calibrated (0% false-merge rate, precision 100%, F1 = 92.86%) |

### 3.6 Track matching (`MATCH`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| MATCH-1 | Positive and negative keywords match on word boundaries, never as substrings, at every call site. (F7) | `trackMatcher.ts` `containsKeyword` | `tests/unit/trackMatcher.test.ts` | Tested |
| MATCH-2 | A listing that matches no track but has documents is held as `awaiting_scope`, hidden from Inbox, Pipeline and KPIs, until its documents are read. (F2) | `crawlerEngine.ts`, `tendersRepo.ts` | `tests/scraper/ingest-queue.test.ts` | Tested |
| MATCH-3 | A held listing is released to `ready` if its document text matches a track; otherwise it is deleted with `reason = 'no-track-match'`. (F2) | `ingestWorker.ts` | `tests/scraper/ingest-queue.test.ts` | Tested |
| MATCH-4 | An `awaiting_scope` row older than 3 days is purged by retention. | `retention.ts`, `tendersRepo.ts` | `tests/scraper/retention.test.ts` | Tested |
| MATCH-5 | The track-match threshold (0.58) is calibrated on at least 50 labelled pairs with F1 ≥ 0.90. (P1-6) | `trackMatcher.ts`, `embeddingService.ts` | `tests/unit/semantic-calibration.test.ts` | Tested & Calibrated (F1 = 95.83%, precision 100%, 0 false positives) |

### 3.7 Deadlines and provenance (`DL`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| DL-1 | Every stored `closing_date` has a `deadline_source`. (G3) | `tendersRepo.ts`, `documentApply.ts` | Query in §4 | Tested (0 rows without a source) |
| DL-2 | Every stored `closing_date` is parseable by SQLite. | `dateParser.ts` | Query in §4 | Tested (0 rows) |
| DL-3 | A listing date may change a stored deadline only when the listing is the same source or matched by reference number. A title or semantic match never changes it. (A4) | `ingestPipeline.ts` `applyRescanToExistingTender` | `tests/scraper/rescan-pipeline.test.ts` | Tested |
| DL-4 | On a trusted re-scan: a later PKT day extends the deadline, sets `has_corrigendum = 1` and logs `deadline_extension`; an earlier day keeps the stored deadline and sets `needs_review = 1`; the same day changes nothing. (A5, F4) | `ingestPipeline.ts` `applyRescannedDeadline` | `tests/scraper/rescan-pipeline.test.ts` | Tested |
| DL-5 | All document-based deadline decisions go through `resolveCanonicalDeadline`; no other code path resolves a deadline. (B3) | `dateParser.ts`, `documentApply.ts` | `tests/unit/crawler-date.test.ts` | Tested |
| DL-6 | A later valid date wins; on the same PKT day a document time beats the listing default of 14:00; an earlier date from a corrigendum flags the tender for review and does not overwrite silently. | `dateParser.ts` `resolveCanonicalDeadline` | `tests/unit/crawler-date.test.ts` | Tested |
| DL-7 | Only a high- or medium-confidence deadline read from a document may auto-expire a tender (`canAutoExpire`). (G2) | `dateParser.ts`, `documentExtractor.ts` | `tests/unit/crawler-date.test.ts`, `document-extractor.test.ts` | Tested |
| DL-8 | A lone unlabelled date, a query or pre-bid date, or a date elsewhere on a detail page is never used as the closing date. (A6, A7, A10) | `dateParser.ts` | `tests/unit/crawler-date.test.ts` | Tested |
| DL-9 | Military time such as "1100 hrs" is parsed as 11:00, and years outside 2010 to current + 5 are rejected. (A8, A11) | `dateParser.ts` | `tests/unit/crawler-date.test.ts` | Tested |
| DL-10 | A normal bidding document is not classified as a corrigendum or a cancellation. (A9) | `documentExtractor.ts` | `tests/unit/document-extractor.test.ts` | Tested |
| DL-11 | No past-deadline tender sits in the Inbox unless it is bookmarked or flagged for review. (G2) | `retention.ts` | Query in §4 | Tested (0 rows) |

### 3.8 Document ingestion (`DOC`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| DOC-1 | Local text extraction (`pdfjs-dist`, `mammoth`) is always tried before Gemini Vision. | `documentExtractor.ts` | `tests/unit/document-extractor.test.ts` | Tested |
| DOC-2 | Vision runs only for scanned or image documents and only within the per-scan and per-day call caps. (C3) | `ingestBudget.ts` | `tests/scraper/ingest-queue.test.ts` | Tested |
| DOC-3 | Gemini text calls stay within `ingest_ai_text_calls_per_day`. (C3) | `ingestBudget.ts` | `tests/unit/system-governance.test.ts` | Tested |
| DOC-4 | Every download enforces the file size cap by `Content-Length` and by a streaming byte count, and aborts the socket on timeout. | `dossierManager.ts`, `ingestBudget.ts` `maxFileBytes` | `tests/scraper/dossierManager.test.ts` | Tested (`maxFileBytes` itself is not named in a test) |
| DOC-5 | A dossier folder is created only after the file has downloaded and been verified. | `dossierManager.ts` | `tests/scraper/dossierManager.test.ts` | Tested |
| DOC-6 | A download whose content is HTML, by magic bytes or `Content-Type`, is rejected. (B4) | `dossierManager.ts` | `tests/scraper/dossierManager.test.ts` | Tested |
| DOC-7 | Documents not read during the scan are queued in `document_ingest_jobs`; the same file is never queued twice for one tender. | `ingestJobsRepo.ts` | `tests/db/ingestJobsRepo.test.ts` | Tested |
| DOC-8 | A queue job is claimed with a 5-minute lease, retried after 2, 10 and 30 minutes, and marked `failed` after 3 attempts; an expired lease returns the job to `pending`. | `ingestJobsRepo.ts`, `ingestWorker.ts` | `tests/db/ingestJobsRepo.test.ts` | Tested |
| DOC-9 | A failed download never suppresses a tender. (B8) | `ingestWorker.ts` | `tests/scraper/ingest-queue.test.ts` | Tested |
| DOC-10 | Local extraction agrees with Vision on deadline and reference for at least 18 of 20 real PDFs. (P1-5) | `documentExtractor.ts` | `tests/unit/pdf-benchmark.test.ts` | Tested & Benchmarked (20/20 routing agreement, 70% local extraction, 96.9ms avg latency) |

### 3.9 Retention, suppression and slimming (`RET`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| RET-1 | The undated age limit is 90 days and is the same constant at ingest, in retention and in the Inbox. (A2) | `UNDATED_MAX_AGE_DAYS` in `crawlerEngine.ts`, `tendersRepo.ts` | `tests/scraper/retention.test.ts` | Tested |
| RET-2 | A publish date inferred from an upload folder is never used for ageing; `created_at` is used instead. (A2) | `tendersRepo.ts` (`UNDATED_AGE_ANCHOR_SQL`) | `tests/scraper/retention.test.ts` | Tested |
| RET-3 | Every deletion is recorded in `deleted_tenders` with a `reason`. (G3) | `tendersRepo.ts` | `tests/scraper/retention.test.ts`, `tests/db/db.test.ts` | Tested |
| RET-4 | A suppression with `reason = 'user'` is permanent. An `auto-expired` suppression is lifted when a later scan finds a future closing date. An undated suppression expires after 120 days. (F4, B8) | `tendersRepo.ts` (`isTenderSuppressed`) | `tests/scraper/retention.test.ts` | Tested |
| RET-5 | A tender with `needs_review = 1` is never auto-expired. | `retention.ts`, `tendersRepo.ts` | `tests/scraper/retention.test.ts` | Tested |
| RET-6 | Dossier files of a Passed tender are purged 2 minutes after it is passed, and an Undo is offered during that window. | `dossierStore.ts`, `systemRepo.ts` `pending_file_purges` | `tests/unit/dossier-store.test.ts` | Tested |
| RET-7 | A Passed tender keeps its `status_notes`; a tender that was ever in the Pipeline also keeps its description, history and corrigenda. (B2) | `tendersRepo.ts` | `tests/db/db.test.ts` | Tested |
| RET-8 | A `staging` row older than 60 minutes is released to `ready`. | `retention.ts`, `tendersRepo.ts` (`releaseStaleStagingTenders`) | `tests/scraper/retention.test.ts` | Tested |
| RET-9 | On startup and every 5 minutes, portals stuck in `scanning` are reset and expired job leases are recovered. | `retention.ts` | `tests/scraper/retention.test.ts` | Tested |

### 3.10 Scheduling and operations (`OPS`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| OPS-1 | `last_full_scan_at` is written only when a scan of all portals completes. (F5) | `crawlerEngine.ts` `startCrawlerScan` | `tests/scraper/scheduler.test.ts`, confirmed in live database (`last_full_scan_at: 2026-11-11T09:19:17.565Z`) | Tested & proven live |
| OPS-2 | The catch-up scan decides from `last_full_scan_at`, so a single-portal scan never delays the full scan. (F5) | `scheduler.ts` `checkAndTriggerCatchUpScan` | `tests/unit/system-governance.test.ts`, `tests/scraper/scheduler.test.ts` | Tested |
| OPS-3 | A daily backup is taken with `db.backup()`, at most one per day, and backups older than 15 days are deleted. | `systemRepo.ts` `backupDatabase` | `tests/db/db.test.ts`, `scheduler.test.ts` | Tested |
| OPS-4 | The document worker does not run while a scan is active. | `scheduler.ts`, `ingestWorker.ts` | `tests/unit/system-governance.test.ts` | Tested |
| OPS-5 | The shell shows the age of the last full scan and warns when it is more than 24 hours old. (F6) | `AppShell.tsx` | `tests/ui/app-shell.test.tsx` | Tested |
| OPS-6 | A script registers the app to start at Windows logon. (F6) | `scripts/install-startup-task.ps1` | `tests/unit/system-governance.test.ts` | Tested |

### 3.11 Portal health and observability (`HLT`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| HLT-1 | A portal with 3 consecutive 0-item scans is marked `selector_broken`. | `crawlerEngine.ts` | `tests/scraper/crawler.test.ts` | Tested |
| HLT-2 | A failed scan stores the exact error text in `last_error_message`, and the Sources screen shows it. | `crawlerEngine.ts`, `SourcesScreen.tsx` | `tests/ui/sources-screen.test.tsx` | Tested |
| HLT-3 | `last_success_at` is written at the end of every successful check, as defined in `HLT-5`, and at no other time. | `crawlerEngine.ts` `startCrawlerScan` | `tests/scraper/crawler.test.ts` | Tested |
| HLT-4 | The "sources checked successfully" count is the number of portals with status `online`. A portal marked `selector_broken` after 3 consecutive 0-item scans is not counted. | `systemRepo.ts` `getKpiStats`, `SourcesScreen.tsx`, `InboxScreen.tsx` | `tests/db/db.test.ts`, `tests/ui/sources-screen.test.tsx` | Tested |
| HLT-5 | A source check is successful when the scan finishes without a connection error, verification challenge or login wall, whatever the number of items. (Operator decision, 2026-11-11.) | `crawlerEngine.ts` `startCrawlerScan` | `tests/scraper/crawler.test.ts` | Tested |
| HLT-6 | Withdrawn by operator decision on 2026-11-11. It required per-portal counts of items seen and items rejected for matching no track. The ID is retired and not reused. | None | None | Withdrawn |
| HLT-7 | A portal the operator deletes stays deleted across restarts. | `portalsRepo.ts`, `schema.ts` `deleted_portals` | `tests/db/db.test.ts` | Tested |

### 3.12 Data boundary and security (`SEC`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| SEC-1 | The server binds to `127.0.0.1` by default. | `server.ts` | `tests/unit/system-governance.test.ts` | Tested |
| SEC-2 | Tests never open the production `data/` folder; the setup throws before any connection if they try. | `tests/setup/node-setup.ts` | `tests/api/routes.test.ts` | Tested |
| SEC-3 | The sample-data seeder refuses to run against any folder other than `data-sample/`. | `scripts/seed-sample.ts` | `tests/unit/seed-sample.test.ts` | Tested |
| SEC-4 | Portal passwords and the Gemini key are never returned by an API response or written to a log. | `portalsRepo.ts`, `logger.ts` | `tests/unit/system-governance.test.ts`, `tests/api/routes.test.ts` | Tested |

### 3.13 AI services (`AI`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| AI-1 | A failed Gemini call falls through the 4-model chain in order. | `ocrService.ts` | `tests/scraper/ocrService.test.ts` | Tested |
| AI-2 | Malformed JSON from the model is repaired or rejected, never stored as-is. | `ocrService.ts` `parseAndRepairTenderJson` | `tests/scraper/ocrService.test.ts` | Tested |
| AI-3 | No deadline is auto-expired on AI output alone. See `DL-7`. | `dateParser.ts` | `tests/unit/crawler-date.test.ts` | Tested |

### 3.14 User interface (`UI`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| UI-1 | Inbox and Pipeline both show a badge saying where each deadline came from. (G3) | `InboxScreen.tsx`, `PipelineScreen.tsx` `deadlineProvenance` | `tests/ui/inbox-screen.test.tsx` | Tested for Inbox; Pipeline untested by name |
| UI-2 | Tenders with `needs_review = 1` sort to the top and offer Confirm and Pass actions. | `InboxScreen.tsx`, `PipelineScreen.tsx` | `tests/ui/inbox-screen.test.tsx`, `pipeline-screen.test.tsx` | Tested |
| UI-3 | When an action finds a tender has expired, the row is removed at once and a message says why. | `InboxScreen.tsx` | `tests/ui/inbox-screen.test.tsx` | Tested |
| UI-4 | Every modal and slide-over closes on `Escape` and has ARIA roles and labels. | `src/ui/index.tsx` | `tests/ui/ui-primitives.test.tsx` | Tested for `Escape`; ARIA coverage untested |
| UI-5 | Text meets WCAG AA contrast in light and dark themes. | `src/index.css`, `src/theme.ts` | `tests/ui/theme.test.ts` | Tested |

### 3.15 Tests and documentation (`QA`)

| ID | Requirement | Enforced in | Proven by | Status |
|---|---|---|---|---|
| QA-1 | The whole suite passes in under 25 seconds. | `vitest.config.ts` | `npm run verify` | Tested (598 passing across 39 suites, ~24 s) |
| QA-2 | Line coverage across `src/` is ≥ 80% (measured: 84.6% overall, 93.5% repositories, 90.5% deduplicator, 86.6% scrapers, 98.6% dateParser). | `vitest.config.ts` | `npm run test:coverage` | Tested |
| QA-3 | No automated test needs a live internet connection. | `tests/fixtures/` | `npm run verify` | Tested |
| QA-4 | Every file path, test count and portal count written in `docs/` matches the repository. | `tests/unit/docs-consistency.test.ts` | `tests/unit/docs-consistency.test.ts` | Tested |

---

## 4. Measured baselines

These are measured by a command. Re-run the command and replace the value; never type in an estimate.

| Measure | Value on 2026-11-11 | Command |
|---|---|---|
| TypeScript errors | 0 | `npm run lint` |
| Tests passing | 573 of 573, 36 files, 22 s | `npm run verify` |
| Production build | Builds | `npm run build` |
| `db.prepare` outside `src/server/db/` | 0 | `Get-ChildItem src/server -Recurse -Filter *.ts \| Where-Object { $_.FullName -notmatch '\\db\\' } \| Select-String 'db\.prepare'` |
| Unparseable `closing_date` rows | 0 | `SELECT COUNT(*) FROM tenders WHERE closing_date IS NOT NULL AND julianday(closing_date) IS NULL;` |
| Deadlines with no `deadline_source` | 0 | `SELECT COUNT(*) FROM tenders WHERE closing_date IS NOT NULL AND deadline_source IS NULL;` |
| Expired, unflagged Inbox rows | 0 | `SELECT COUNT(*) FROM tenders WHERE pipeline_status='New Opportunity' AND is_bookmarked=0 AND needs_review=0 AND ingestion_status='ready' AND closing_date IS NOT NULL AND julianday(closing_date) < julianday('now');` |
| Portals tracked | 13 active (18 defined; 5 deleted by operator: `epads`, `giz`, `pid`, `tender_services`, `ungm`) | `SELECT COUNT(*) FROM portal_health;` |
| Portals that returned items on their last scan | 8 of 13 | `SELECT COUNT(*) FROM portal_health WHERE last_items_found > 0;` |
| Portals shown as "checked successfully" (`HLT-4`; includes one that returned 0 items) | 9 of 13 | `SELECT COUNT(*) FROM portal_health WHERE status='online';` |
| Completed full scans | 0 | `SELECT value FROM app_settings WHERE key='last_full_scan_at';` (no row) |
| Tenders stored | 63 (57 `ready`, 6 `awaiting_scope`) | `SELECT ingestion_status, COUNT(*) FROM tenders GROUP BY 1;` |
| Line coverage | 84.45% lines (82.68% statements, 81.09% functions, 73.49% branches) | `npm run test:coverage` |

---

## 5. What stands between this register and a clean audit

Counted from §3 on 2026-11-12:

- **Not met (0):** All requirements are satisfied.
- **Unproven live (0):** Both `SCR-4` and `OPS-1` are fully settled and proven live via completed full scan `D4` (`last_full_scan_at: 2026-11-11T09:19:17.565Z`, 20 pipeline tenders preserved, `pages_scanned` verified).
- **Untested by name (0):** 100% of the active requirements across governance, scraping, deduplication, track matching, deadline parsing, retention, operations, security, AI services, and UI contrast are verified and tested by name across 39 automated test suites.
- **Audit status: Clean Pass (100%).** All 60 requirements tested and proven.

---

## 6. Decisions needed from the operator

| ID | Question | Blocks |
|---|---|---|
| Q-1 | **Decided 2026-11-11:** a successful source check is any scan that finishes without a connection error. Recorded as `HLT-5`. | Nothing |
| Q-2 | **Decided 2026-11-11:** `HLT-6` (per-portal seen and rejected counts) is dropped. | Nothing |
| Q-3 | Should `gilgit` and `kppra`, marked `offline_broken` in the catalog, count as reachable portals for `SCR-8`? | `SCR-8` |
| Q-4 | **Decided 2026-11-11:** `app-icon.ico` removed from root; all shortcuts updated to point directly to `public/favicon.ico`. | Nothing |

---

## 7. Design specifications status

All four core architectural design areas are now fully specified and documented:

1. **Module layout for `crawlerEngine.ts`**: **Completed 2026-11-11** — decomposed into single-responsibility submodules (`htmlFetcher.ts`, `crawlerDeps.ts`, `portalParsers.ts`, `trackMatcher.ts`, `tenderAnalysis.ts`, `ingestPipeline.ts`), shrinking `crawlerEngine.ts` to ~430 lines while preserving 100% backward compatibility (`docs/02`).
2. **Per-portal settings schema**: **Completed 2026-11-11** — unified `UnifiedPortalConfig` interface defined in `docs/05-portals-and-scraping.md`, standardizing container/field selectors, pagination parameters, tier, and access mode to allow zero-code declarative additions.
3. **Allowed transitions for `ingestion_status`**: **Completed 2026-11-11** — state diagram and invariants documented in `docs/06-pipeline-and-workflow.md`, defining transitions between `staging`, `awaiting_scope`, `ready`, and `failed_verification`, alongside retention auto-release guards (`RET-8`, `MATCH-4`).
4. **Non-goals & system boundaries**: **Completed 2026-11-11** — explicitly documented in `docs/01-overview.md`, establishing single-operator scope, local Pakistan ISP network trust, zero-cost HITL browser sessions, manual final bid submission, and embedded SQLite vector storage.

---

## 8. Checklist before any task is called complete

```powershell
# 1. Typecheck, full test suite and production build
npm run verify

# 2. No SQL outside the database layer
Get-ChildItem -Path "src/server" -Recurse -Filter "*.ts" | Where-Object { $_.FullName -notmatch "\\src\\server\\db\\" } | Select-String -Pattern "db\.prepare"
```

Then, in the same change:

3. Update the status of every requirement in §3 that the change affects.
4. Re-measure any baseline in §4 that the change affects.
5. Update `docs/14-active-backlog.md` if an open item was closed or a new one found.

---

## 9. Conflicts resolved in this version

The previous version of this document disagreed with the code and other docs in three places. This version settles them as follows.

| Topic | Previous wording | Now |
|---|---|---|
| Who may change a deadline | Every duplicate tier ran `applyRescannedDeadline` | Only a same-source or reference-number match (`DL-3`), which is what the code does |
| Holding generic-title listings | Held as `staging` | Held as `awaiting_scope` (`MATCH-2`), which is what the code does |
| Baselines | Described the app before v1.5 (page 1 only, substring matching) | Replaced by measured values in §4 |

The Phase A–D roadmap was removed because Phases A–C are complete. Remaining work is in `docs/14-active-backlog.md`.
