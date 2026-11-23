# 14. Active Backlog & Next Steps

**Last updated:** 2026-11-22 · **System Baseline:** v1.9.0 (Plans A–F implemented: BidBrief, 48h Closing Alerts & Digest, Two-Speed Pagination, Parallel Portal Workers & `ScraperErrorCode`, Production Runtime Separation, Offline `local_ocr` Fallback, Standalone Desktop Window & System Tray, and Network Health Monitor & Anti-Corruption Safeguards; Master Plan Workstreams A–G and Architectural Milestones #1–#5 completed for 7-Statutory Backbone, Two-Phase Scan Priority, Cross-Portal Dedup, Unidirectional Layers, Runtime Validation/Errors, Versioned SQLite Migrations, and `RuntimeContext` DI).

This document tracks **active operational items and approved non-breaking feature plans**. All historical investigations and completed fixes are archived in [`docs/archive/`](./archive/).

---

## 1. Portal Maintenance & Periodic Connector Monitoring

### Item 1: Connector & Session Monitoring
- **Active Regulatory Coverage (`14/14` online in live DB — full 7-portal statutory backbone active):**
  - `epms_ppra`: Open Federal PPRA EPMS (`https://epms.ppra.gov.pk/public/tenders/active-tenders?status=1`, `tier: 'http'`, `accessMode: 'public'`, 50/page, `quickMaxPages: 4` / `deepMaxPages: 20`), paired with deterministic detail-page `BidBrief`, cancelled-reason/corrigendum-badge/`&#38;` parser guards (`parseEpmsDetailHtml` in `src/server/scrapers/portalParsers.ts`), and folder-aware `/pdf?file=` labels (`dossierManager.ts`). Legacy `epads` is retired in `deleted_portals` while preserving historical tenders.
  - `punjab_eproc`: Primary Punjab provincial source (`https://eproc.punjab.gov.pk/ActiveTenders.aspx`, ASP.NET postback pagination bumped to `quickMaxPages: 3` / `deepMaxPages: 10`), aggregating tenders across Punjab departments and authorities centrally.
  - `bppra`: Upgraded Balochistan BPPRA (`https://bpptwo.vdc.services:5451/Tenders`, `tier: 'playwright'`) with `src/server/scrapers/bppraScraper.ts` for Blazor `Active Tenders` 100/page pagination + `/RFP`, `/PreQualification`, and `/EOI` tabs, `District` location & `Corrigendum` extraction (`portalParsers.ts`), and deterministic `:9446` NIT JSON API `BidBrief` / FTS5 text & automatic BOQ PDF discovery (`tenderAnalysis.ts`).
  - `sppra`: Restored Sindh SPPRA (`https://portalsindh.eprocure.gov.pk/#/`) as the sole active Sindh portal via `src/server/scrapers/sppraApi.ts` (`tier: 'http'`, direct EPADS WSO2 public JSON API + DMS PDF downloads for NIT and PA Published Documents), with Angular `<section class="card">` DOM fallback in `portalParsers.ts` and full unit/contract tests (`tests/unit/sppra-api.test.ts`).
  - `kppra`: Restored Khyber Pakhtunkhwa KPPRA (`https://kp.gov.pk/tenders`) via `src/server/scrapers/kpApi.ts` (`tier: 'http'`, `accessMode: 'public'`, `https://mgn1.kp.gov.pk/api/tenders`, `quickMaxPages: 8` / `deepMaxPages: 15`), mapping `uuid` detail URLs, `media`/`bidding_document`/`corrigenda` PDFs with deadline auto-extension, auction skipping, and KP district location extraction (`tests/scraper/kp-api.test.ts`).
  - `gilgit`: Restored Gilgit-Baltistan PPRA (`https://gbppra.gov.pk/viewall`, `category: 'Regulatory'`, `fileCode: 'GBPPRA'`, `quickMaxPages: 4` / `deepMaxPages: 12`) with hardened `.job-post-item` parsing in `portalParsers.ts` filtering non-biddable `.badge-wrap .badge` statuses, flagging `Corrigendum`/`Addendum`, reading `.text-success`/`.text-danger` dates, and extracting GB district locations (`extractGbLocation`).
  - `ajk_ppra`: Added Azad Jammu & Kashmir PPRA (`https://www.ajkppra.gov.pk/advertisements.php`, `category: 'Regulatory'`, `fileCode: 'AJKPPRA'`) with Section 3g `table.table` parsing, `extractAjkLocation`, inline `Corrigendum` PDF detection, and portal `Referer` headers in `dossierManager.ts` (`tests/scraper/ajk-ppra.test.ts`).
- **Removed / Blocked Portals (`deleted_portals` in live DB; canonical entries retained in `PORTAL_DEFINITIONS` per `HEAL-7`):**
  - `psda`: Individual Punjab authority (`psda.punjab.gov.pk/tenders`) consistently displays `"No Opening"`; Punjab tenders are covered centrally via `punjab_eproc`, so `psda` was archived via `deletePortal`.

---

## 2. Planned Improvements & Active Workstreams (Approved — Ready for Execution)

### Master Plan: 7-Statutory Backbone, Two-Phase Scan Priority & Cross-Portal Dedup

This master plan establishes the complete **7-portal statutory procurement backbone** across all provinces and administrative territories of Pakistan, enforces **Statutory-First scan priority**, and hardens cross-portal deduplication so individual agency websites merge cleanly into statutory tenders with zero duplication.

#### Workstream A: Punjab PPRA (`punjab_eproc`) Hardening
- **Objective:** Fix silent Page 2+ pagination timeouts, handle Addendum and auction rows, infer Punjab locations, and disambiguate generic titles.
- **Tasks:**
  1. `src/server/scrapers/htmlFetcher.ts`: Implement `legacyTlsHosts` memory cache so once a host (e.g. `eproc.punjab.gov.pk`) triggers legacy TLS fallback, subsequent `GET` and `POST` requests immediately use `legacySslTolerantAgent` with proper `Origin` and `Referer` headers. Fixes silent 25–35s IIS 7.5 timeout on `POST` with ~112KB `__VIEWSTATE` (drops Page 1+2 scan from 38s failed down to ~3.4s `200 OK`).
  2. `src/server/scrapers/portalParsers.ts`: Update Section 3e RadGrid parser:
     - Flag both `Corrigendum` and `Addendum` in `isCorrigendum`.
     - Skip `Sales/Auction/Disposal` rows (asset disposal, not procurement).
     - Extract Punjab city/district from Department text (`location: "<City>, Punjab"`, fallback `"Punjab, Pakistan"`).
     - Disambiguate generic `"Tender Notice"` / `"Notice Inviting Tender"` names as `"Tender Notice — <Department>"`.
- **Status:** `COMPLETED (2026-11-22)` — Implemented `legacyTlsHosts` + `POST` `Origin`/`Referer` headers in `src/server/scrapers/htmlFetcher.ts` and RadGrid hardening (`extractPunjabLocation`, `Addendum` flagging, `Sales/Auction/Disposal` filtering, generic title disambiguation) in `src/server/scrapers/portalParsers.ts`; verified with `npm run verify`.

#### Workstream B: Khyber Pakhtunkhwa (`kppra`) Official JSON API Integration
- **Objective:** Restore KP provincial coverage using the live public REST API powering `https://kp.gov.pk/tenders`, replacing the walled legacy domain.
- **Tasks:**
  1. Create new KP API scraper submodule (`kpApi.ts` under `src/server/scrapers/`): Scrape `https://mgn1.kp.gov.pk/api/tenders?domain=&page=<n>&search=` (`quickMaxPages: 8`, `deepMaxPages: 15`), paginating through active listings (88 tenders currently active across KPPRA and KP Portal).
  2. Map structured JSON fields: `uuid` $\rightarrow$ direct detail URL (`https://kp.gov.pk/tender/detail/<uuid>`), `tender_number` $\rightarrow$ `referenceNo`, `department_name` $\rightarrow$ `organization`, `tender_type`, ISO advertisement & closing dates.
  3. PDF & Corrigendum handling: Collect `media.file_path`, `bidding_document.file_path`, and `corrigenda[].corrigendum_document` (verified `200 OK` across `kppra.gov.pk` and `mgn1.kp.gov.pk` storage). When `corrigenda[]` has an extended closing date, auto-extend deadline and flag `isCorrigendum = true`.
  4. Skip `"Auction"` / `"Auction of Toll Tax"` rows; extract KP district location (`"<District>, Khyber Pakhtunkhwa"`).
  5. `src/server/scrapers/portalList.ts` & `crawlerEngine.ts`: Update `kppra` entry from `offline_broken` to `tier: 'http'`, `accessMode: 'public'`, `tendersUrl: 'https://kp.gov.pk/tenders'`, and dispatch to `scrapeKpPortal`.
- **Status:** `COMPLETED (2026-11-22)` — Implemented `src/server/scrapers/kpApi.ts`, wired `kppra` in `portalList.ts` / `crawlerEngine.ts` / `schema.ts`, restored `kppra` in `./data/tender_tracker.db`, added `tests/scraper/kp-api.test.ts`, and verified with `npm run verify`.

#### Workstream C: Gilgit-Baltistan PPRA (`gilgit`) Hardening
- **Objective:** Restore Gilgit-Baltistan statutory coverage by pointing `gilgit` to the live `gbppra.gov.pk/viewall` board.
- **Tasks:**
  1. `src/server/scrapers/portalList.ts`: Update `gilgit` from `offline_broken` (`gilgitbaltistan.gov.pk`) to `baseUrl: 'https://gbppra.gov.pk'`, `tendersUrl: 'https://gbppra.gov.pk/viewall'`, `category: 'Regulatory'`, `fileCode: 'GBPPRA'`, `accessMode: 'public'`, with query pagination (`quickMaxPages: 4`, `deepMaxPages: 12`).
  2. `src/server/scrapers/portalParsers.ts`: Harden Section 3c `.job-post-item` parser:
     - Filter non-biddable cards by checking `.badge-wrap .badge`: skip `Final Evaluation Report`, `Technical Evaluation`, `Financial Evaluation Result`, `Result`, `Cancelled`, `Postponed`, `Auction`, `Work Order / Supply Order`.
     - Flag `Corrigendum` and `Addendum` badges in `isCorrigendum`.
     - Directly parse publish date from `.text-success` and closing date from `.text-danger`.
     - Extract GB district location (`Gilgit`, `Skardu`, `Chilas`, `Nagar`, `Hunza`, `Ghizer`, `Shigar`, `Kharmang`, `Ghanche`, `Astore`) $\rightarrow$ `"<District>, Gilgit-Baltistan"`.
- **Status:** `COMPLETED (2026-11-22)` — Updated `gilgit` in `portalList.ts` / `dossierStore.ts` / `schema.ts`, hardened Section 3c `.job-post-item` parsing + `extractGbLocation` in `portalParsers.ts`, restored `gilgit` in `./data/tender_tracker.db`, added `tests/fixtures/portals/gilgit/page.html`, and verified with `npm run verify`.

#### Workstream D: Azad Jammu & Kashmir PPRA (`ajk_ppra`) Connector
- **Objective:** Add AJK PPRA as the 7th statutory board, completing nationwide statutory coverage.
- **Tasks:**
  1. `src/server/scrapers/portalList.ts`: Register canonical portal `ajk_ppra` (`name: 'AJK PPRA (ajkppra.gov.pk)'`, `baseUrl: 'https://www.ajkppra.gov.pk'`, `tendersUrl: 'https://www.ajkppra.gov.pk/advertisements.php'`, `category: 'Regulatory'`, `fileCode: 'AJKPPRA'`, `tier: 'http'`, `accessMode: 'public'`).
  2. `src/server/scrapers/portalParsers.ts`: Add Section 3g parser for `table.table` active procurement rows:
     - Read Column 0 (`Procurement` + ID, skipping `Sales/Auction/Disposal`), Column 1 (`Procurement Title`), Column 2 (`Publishing Date` `DD-MM-YYYY`), Column 3 (`Closing Date` `DD-MM-YYYY`), Column 4 (`Department`), Column 5 (`Procuring Agency`).
     - In Column 6 (`Download`), extract main `/uploadfiles/tenderdocuments/...pdf` and all inline red `Corrigendum` PDF links (`isCorrigendum: true`).
     - Infer AJK district location (`Muzaffarabad`, `Mirpur`, `Bagh`, `Neelum`, `Rawalakot`, `Sudhanoti`, `Bhimber`, `Kotli`, `Hattian`, `Haveli`) $\rightarrow$ `"<District>, Azad Kashmir"`.
  3. `src/server/services/dossierManager.ts`: Ensure document requests supply portal `Referer` header so Apache ModSecurity serves direct PDF bytes (`200 OK`) instead of HTTP 406 rejections.
- **Status:** `COMPLETED (2026-11-22)` — Registered `ajk_ppra` in `portalList.ts` & `dossierStore.ts`, added Section 3g parser + `extractAjkLocation` in `portalParsers.ts`, added `Referer` headers to `fetchFileBuffer` in `dossierManager.ts`, seeded `ajk_ppra` in `./data/tender_tracker.db` (`14` active portals / 7 statutory boards), added `tests/fixtures/portals/ajk_ppra/page.html` & `tests/scraper/ajk-ppra.test.ts`, and verified with `npm run verify`.

#### Workstream E: Two-Phase Scan Execution & Anti-Duplication Protection
- **Objective:** Ensure Federal and Provincial Statutory Portals take strict priority, and individual agency websites never produce duplicate tender records.
- **Tasks:**
  1. `src/server/scrapers/crawlerEngine.ts`: Implement **Two-Phase Scan Execution**:
     - **Phase 1 (Statutory Backbone):** Run all 7 Federal & Provincial Regulatory portals (`epms_ppra`, `punjab_eproc`, `sppra`, `bppra`, `kppra`, `gilgit`, `ajk_ppra`) first so canonical statutory cards are indexed with definitive dates and references.
     - **Phase 2 (Individual Agencies):** Run remaining active non-statutory portals (`psdf`, `pseb`, `fde`, `mofept`, `peef`).
  2. `src/server/db/repositories/tendersRepo.ts` (`findDedupCandidates`) & `src/server/services/deduplicator.ts`:
     - Fix undated-vs-dated cross-portal deduplication: allow candidates where one notice has a closing date and the other does not yet have an HTML closing date, comparing on high lexical similarity (`Dice >= 0.90` with `orgSim >= 0.50`, or `Dice >= 0.94` when `!titlesAreDistinguishable`).
     - When an individual website scrapes a tender already present from a statutory portal, `applyRescanToExistingTender` records the agency listing under `secondary_sources` ("Also listed on"), queues any new document or corrigendum links, and creates 0 duplicate cards.
  3. Merge existing historical cross-portal duplicate pairs in SQLite (e.g. `psdf` vs `punjab_eproc` `Provision of HR Outsourcing Services` and `Advance Technology Program`).
- **Status:** `COMPLETED (2026-11-22)` — Implemented Two-Phase Scan Execution in `crawlerEngine.ts`, undated-vs-dated cross-portal dedup (`findDedupCandidates`, `findCanonicalMatch`, `ingestPipeline.ts`), merged 4 unbookmarked `New Opportunity` PSDF duplicates onto statutory `punjab_eproc` records in `./data/tender_tracker.db`, added unit/integration tests in `deduplicator.test.ts` and `crawler.test.ts`, and verified with `npm run verify`.

#### Workstream F: Domain Track Organization Watchlist
- **Objective:** Automate discovery of high-value education, PPP, and TVET tenders across all statutory boards.
- **Tasks:**
  1. Configure `track-priority-orgs` ("Priority Education & Skills Organizations") in live SQLite with targets: `PEF`, `Punjab Education Foundation`, `PEIMA`, `Sindh Education Foundation`, `SEF`, `PSDF`, `NAVTTC`, `TEVTA`, `STEVTA`, `KPTEVTA`, `BTEVTA`, `KPITB`, `Elementary & Secondary Education`, `School Education Department`, `BEF`, `NCHD`, `FDE`, `MOFEPT`, `Ignite`, `PSEB`, `HEC`.
  2. Apply the strict negative exclusions (supply, civil construction, solar, gas, uniforms, vehicles, food/catering).
- **Status:** `COMPLETED (2026-11-22)` — Configured `track-priority-orgs` in `./data/tender_tracker.db` with all 21 watch targets and strict exclusions, generated its MiniLM track embedding (`backfillModelEmbeddings`), ran `reScoreTendersAgainstTracks()` (`44` $\rightarrow$ `46` `ready`, `0` demoted, `10` watchlist matches), added unit coverage in `tests/unit/trackMatcher.test.ts`, and verified with `npm run verify`.

#### Workstream G: Governance, Test Coverage & System Synchronization
- **Tasks:**
  1. Add hermetic offline parser contract tests: `tests/scraper/kp-api.test.ts`, `tests/scraper/ajk-ppra.test.ts`, and updated `portal-contracts.test.ts`.
  2. Add cross-portal deduplication tests for dated-vs-undated pairs in `tests/unit/deduplicator.test.ts`.
  3. Synchronize documentation (`docs/02`, `docs/03`, `docs/04`, `docs/05`, `docs/08`, `docs/12`, `docs/14`, `README.md`).
  4. Run `npm run verify` to achieve 0 TypeScript errors, passing test suites, and clean builds.
- **Status:** `COMPLETED (2026-11-22)` — Added offline contract and dedup suites (`tests/scraper/kp-api.test.ts`, `tests/scraper/ajk-ppra.test.ts`, `tests/scraper/portal-contracts.test.ts`, `tests/unit/deduplicator.test.ts`), finished 19-portal audit across `docs/` and `scripts/`, and passed full `npm run verify`.

---

---

## 3. Recently Completed Register Items (2026-11-11 – 2026-11-22)

- **Portal Lifecycle Consistency, Dialog Error UX & Schema Migration `v7` (`2026-11-22`):**
  - Added migration `v7` (`sync_tender_portal_names_and_retire_epads_tenders`, `LATEST_SCHEMA_VERSION = 7` in `src/server/db/schema.ts`), propagated portal renames to `tenders.portal_name`, exposed `is_builtin` on `GET /api/portals`, cancelled pending portal `document_ingest_jobs` on portal delete, and added optional `removeUnreviewedTenders` cleanup on `DELETE /api/portals/:portalId`.
  - Hardened `App.tsx`, `PortalsTab.tsx`, and `InboxScreen.tsx` with scheme-less URL normalization (`normalizeUrlInput`), inline error banners that keep Add/Edit dialogs open on failure, conditional `Reset to default URL` visibility (`is_builtin !== false`), optional unreviewed-tender removal on portal delete, and live Inbox portal pill synchronization (`tests/ui/sources-screen.test.tsx`).

- **Pluggable `PortalAdapter` Registry, Unidirectional Layers & Architectural Milestones #1–#5 (`2026-11-22`):**
  - **Milestone #1 (Resolved)**: Unified portal-specific crawl dispatch, transport/pagination cookie settings, deterministic HTML extractors, and API/HTML detail enrichment behind `src/server/scrapers/adapters/` (`registry.ts`, `types.ts`, `guards.ts`, `genericAdapter.ts`, plus dedicated adapters for all specialized portals/agencies), covered by `tests/scraper/portal-adapters.test.ts`.
  - **Milestone #2 (Resolved)**: Eliminated all cross-layer server imports by introducing `src/server/domain/` (9 pure modules with downward shims), `src/server/services/sppraClient.ts`, and `src/server/runtime/` (`ingestWorker.ts`, `scheduler.ts`), enforced continuously by `GOV-4` in `tests/unit/system-governance.test.ts`.
  - **Milestone #3 (Resolved — API Schema Validation & Uniform Error Envelopes)**: Added zero-dependency schema validation (`v.*`, `validateBody`, `validateQuery`, `getValidatedBody`, `getValidatedQuery` in `src/server/routes/validation.ts`) and standardized HTTP error envelopes (`AppHttpError`, `ApiErrorCode`, `ApiErrorEnvelope`, `sendError`, `errorHandler` in `src/server/routes/httpErrors.ts`, re-exported via `routeUtils.ts`), covered by `tests/unit/route-validation.test.ts`.
  - **Milestone #4 (Resolved — Versioned SQLite Migrations via `PRAGMA user_version`)**: Implemented sequential transactional `runMigrations` (`src/server/db/migrations.ts`) executing `SCHEMA_MIGRATIONS` v1–v6 (`LATEST_SCHEMA_VERSION = 6` in `src/server/db/schema.ts`) with atomic per-migration rollback, forward-version guard, steady-state fast path, non-destructive upgrades for legacy `user_version = 0` DBs/backups, and always-run idempotent track/portal syncs, covered by `tests/db/migrations.test.ts`.
  - **Milestone #5 (Resolved — `ScanStateStore`, Typed Ports & `RuntimeContext` DI)**: Replaced mutable global scan state and `*Deps` hooks with encapsulated `ScanStateStore` (`src/server/scrapers/scanState.ts`), typed `CrawlerPorts` (`src/server/scrapers/crawlerDeps.ts`), `PlaywrightManager` (`src/server/scrapers/playwrightEngine.ts`), `NetworkMonitor` (`src/server/services/networkMonitor.ts`), `SchedulerController` (`src/server/runtime/scheduler.ts`), and `RuntimeContext` (`src/server/runtime/context.ts`), covered by `tests/unit/runtime-context.test.ts`.

- **Full-Repository Codebase Audit & 5-Phase Refactoring (`2026-11-22`):**
  - **Phase 1–2**: Hardened scraper/service error handling and concurrency races, and pruned dead/legacy code across client and server.
  - **Phase 3A–3B**: Extracted `src/shared/documentUtils.ts`, `src/server/services/fileUtils.ts`, `src/server/scrapers/scraperUtils.ts`, `src/client/utils/format.ts`, and `src/client/utils/apiClient.ts`; consolidated modals/popovers/status chips onto shared primitives in `src/client/ui/index.tsx`; hardened `%PORT%`/`$env:PORT`, Edge-first resolution, and cleanup scoping in `start-tender-tracker.bat`, `scripts/launch.cmd`, and `scripts/tray-app.ps1`.
  - **Phase 4**: Broke all 14 circular imports in `src/` cleanly across shared/repository/service/scraper boundaries, typed all Express route handlers (`Request`, `Response`), and added the `GOV-3` zero-circular-import invariant test in `tests/unit/system-governance.test.ts`.
  - **Phase 5**: Decomposed `SourcesScreen.tsx` into `src/client/components/sources/` (`shared.tsx`, `KeywordsTab.tsx`, `PortalsTab.tsx`, `DataTab.tsx`), extracted `detailHelpers.ts` + `DossierSection.tsx` from `Detail.tsx`, extracted `src/server/scrapers/parserHelpers.ts` from `portalParsers.ts`, and extracted `src/server/db/repositories/tenderLifecycleRepo.ts` from `tendersRepo.ts` with full barrel/re-export compatibility and green `npm run verify`.

- **PSDF Title Sanitization & Passive Network Threshold Tuning (`2026-11-21`):**
  - Added `stripLiteralHtmlTags` in `src/server/scrapers/portalParsers.ts` (and `sanitizeScrapedItems`) to strip/reject HTML-encoded `<img>` icon tags from PSDF titles, removed the malformed historical row `tender-psdf-40a989667fde1421` from `./data/tender_tracker.db`, and tuned `PASSIVE_SLOW_HTML_MS` (`22s`) / `PASSIVE_WINDOW_MS` (`2m`) in `src/server/services/networkMonitor.ts` to avoid false slow-network pauses after healthy multi-page scans.

- **Live Sidebar Queue Telemetry & Per-Tender Processing Status (`2026-11-20`):**
  - Extended `DocumentQueueCounts` / `DocumentQueueStatus` (`src/server/db/repositories/ingestJobsRepo.ts`, `src/shared/types.ts`) with distinct tender/listing/active-processing counts (`readyTenders`, `awaitingScopeTenders`, `processing`, `processingTenders`, `activeTenderIds`), added `reconcileStaleTenderDocFetchStatuses()` startup/drain self-healing, and hydrated per-tender job counters (`doc_jobs_pending`, `doc_jobs_processing`, `doc_jobs_done`, `doc_jobs_failed`) in `src/server/db/repositories/tendersRepo.ts`.
  - Connected immediate `claimDueJobs` worker heartbeats and on-demand `getInFlightDocFetchTenderIds()` updates (`ingestWorker.ts`, `tenderAnalysis.ts`, `crawlerEngine.ts`, `scan.routes.ts`) over SSE (`doc_queue_progress` vs `documents_updated`) without extra `/api/tenders` refetch noise on discarded `awaiting_scope` items.
  - Updated `src/client/components/AppShell.tsx`, `TenderRow.tsx`, `Detail.tsx`, `InboxScreen.tsx`, `PipelineScreen.tsx`, and `App.tsx` with the live sidebar breakdown card (files, tenders, active processing, and scope queue) and unified `getTenderDocProcessingState` badges across Inbox & Pipeline rows, cards, detail headers, Saved Documents banners, and Summary empty states.

- **Scanned PDF Rasterization Stability, Gemini Quota Cooldown, Lease Recovery & Tray Self-Healing (`2026-11-20`):**
  - Fixed native `@napi-rs/canvas` + `pdfjs-dist` crash and `CanvasFillRule` error during scanned-PDF fallback in `src/server/services/localOcrService.ts` by binding native `Path2D`/`ImageData`/`DOMMatrix`/`Image` globals on `globalThis`, disabling `OffscreenCanvas`, wrapping 9-arg `ctx.drawImage(CanvasElement, ...)` via PNG-backed `Image`, and isolating per-page renders cleanly.
  - Added per-model `429 RESOURCE_EXHAUSTED` (30m) and `503`/`504` (60s) cooldowns in `src/server/services/ocrService.ts` (`resetModelCooldownsForTests`) and passed `allowAiCrossCheck: false` in `src/server/runtime/ingestWorker.ts` so background document extraction runs purely locally on digital PDFs without burning API quota on transient fallbacks.
  - Added `releaseExpiredLeases()` to `initStartupScheduler()` (`src/server/runtime/scheduler.ts`), bounded automatic crash recovery (up to 3 restarts per 10 minutes) in `scripts/tray-app.ps1`, and stabilized V8 coverage worker concurrency (`maxWorkers: 2` in `vitest.config.ts`).

- **Streamlined Automatic Document Fetching & Queue Prioritization (`2026-11-19`):**
  - Fixed background queue starvation in `src/server/db/repositories/ingestJobsRepo.ts` (`claimDueJobs` now prioritizes bookmarked/tracked `ready` tenders first, then open `ready` Inbox tenders by soonest `closing_date`, ahead of hidden `awaiting_scope` listings; `enqueueDocumentJobs` inspects both `label` and `url` so `/BiddingDocuments/` URLs receive `JOB_PRIORITY.primary`).
  - Added startup queue hygiene (`pruneAlreadyCachedPendingJobs`, `markDocumentJobsDoneForUrls`, `getDocumentQueueCounts`), `DETAIL_DISCOVER_LABEL` / `isDetailPageDiscoveryUrl` auto-discovery for dedicated `epms_ppra` and `fde` detail pages, and `hasTenderExtractedText` (`src/server/db/repositories/tendersRepo.ts`).
  - Eliminated upfront scan stalling on dated direct-PDF rows and duplicate re-scan job enqueueing in `src/server/scrapers/ingestPipeline.ts` (`needsUpfront = !item.closingDate && candidates.length > 0`, filtering already-cached `cached_dossiers` URLs on re-scan).
  - Streamlined `fetchDocumentsForTender` (`src/server/scrapers/tenderAnalysis.ts`) with in-flight deduplication, `!forceRefresh` cache short-circuiting, stored `attachment_urls` downloading ahead of HTML detail checks, `isHtmlContent` rejection, and `document_ingest_jobs`/`doc_fetch_status` reconciliation.
  - Upgraded `src/server/runtime/ingestWorker.ts` (`processDocumentQueue` per-tender-safe concurrency `3` + `drainDocumentQueue` fast Inbox drain) and `src/server/runtime/scheduler.ts` (`crawlerDeps.onScanFinished` post-scan kickoff + 4s startup drain), streaming live `doc_queue_progress` and `documents_updated` SSE events via `src/server/routes/scan.routes.ts`.
  - Updated `src/client/App.tsx`, `src/client/components/AppShell.tsx`, and `src/client/components/inbox/Detail.tsx` (`hasAutoFetchableDocuments`) to auto-fetch on tender open, preserve unsaved notes on same-tender SSE refreshes, render live sidebar queue progress, and reload tenders/KPIs/corrigenda on `documents_updated`.

- **Unified Canonical Dossier Naming & Corrigendum Superscript Date Parsing (`2026-11-19`):**
  - Unified portal downloads (`dossierManager.ts`), on-demand fetches (`tenderAnalysis.ts`), and manual uploads onto `saveTenderDocument` (`src/server/services/dossierStore.ts`) using clean hash-free filenames (`{PORTAL}_{Ref_or_Title}_{DocType}-{N}{-vK}.{ext}`) capped at 100 chars on clean word boundaries.
  - Enhanced `inferDocType` (URL path clues such as `/BiddingDocuments/`, `/BOQManual/`, `/Tenders/` + `Content-Disposition`) and added heading-based `inferDocTypeFromText` + `renameDossierToCanonical` so downloaded PDFs upgrade automatically to accurate `Corrigendum`, `Bidding-Document`, `BOQ`, `RFP`, etc. names on disk and in the UI.
  - Added startup idempotent filename migration (`migrateDossierFilenames`), local PDF/DOCX text reclassification (`reclassifyExistingDossiersFromText`), and `recheckEarlierDeadlineReviewTenders` (`src/server/runtime/scheduler.ts`, `src/server/db/repositories/tendersRepo.ts`), plus superscript-spaced ordinal (`Nov 20 th, 2026`) and leading submission-time (`03:00 PM, on ...`) parsing (`src/server/scrapers/dateParser.ts`, `src/server/services/documentExtractor.ts`).

- **Sidebar Accessibility Hardening, Node 22 Runtime & Repository Hygiene (`2026-11-19`):**
  - Updated `src/client/components/AppShell.tsx` (`bb87903`) per `modern-web-guidance` (`accessibility`, `motion`, `color`) with centralized polite/assertive live regions outside interactive controls, ≥24px Recheck target size, `aria-describedby` scan-button descriptions, shape-distinct network icons, `forced-colors` borders, and `motion-safe` animation gating (`tests/ui/app-shell.test.tsx`).
  - Aligned runtime to Node.js `v22.23.5` (removing legacy `OpenJS.NodeJS.20`), updated `.gitignore` (`data/app-profile/`, `data/**/*.tmp`) and `.env.example`, removed stale untracked artifacts (`coverage/`, `data-sample/`, `docs/archive/claude-outputs/`, `docs/archive/mocks/`), and synchronized governance/architecture/API/operations/testing docs.
- **Network Health Monitor, Heavy/Light Task Gating & Anti-Corruption Safeguards (`2026-11-19`):**
  - Created `src/server/services/networkMonitor.ts` (`online` / `degraded` / `offline` classification via cached multi-endpoint HTTP probes and passive multi-host slow/timeout tracking) with `GET /api/system/network` and `POST /api/system/network/check` in `src/server/routes/system.routes.ts`.
  - Eliminated slow-network data corruption via `90s` TLS agent socket ceilings (`baseScraper.ts`), strict HTTP stream completion & `Content-Length` truncation checks (`htmlFetcher.ts`, `dossierManager.ts`), and atomic `.tmp` rename writes in `dossierManager.ts`.
  - Held heavy tasks (`deep` multi-page scans, upfront PDF fetches, `document_ingest_jobs` queue processing, `awaiting_scope` retention purges) during `degraded`/`offline` states while allowing lightweight `quick`/single-portal HTML scans serially (`effectiveHttpConcurrency = 1`) and refunding transient-error job retries via `deferJob` in `ingestWorker.ts`.
  - Surfaced live sidebar network status (`Healthy` / `Slow` / `Offline`), `pausedReason` banner, **Deep** button hold, manual Recheck trigger (`src/client/App.tsx`, `src/client/components/AppShell.tsx`), and Windows System Tray status / **Recheck Network** (`scripts/tray-app.ps1`).

- **Standalone Desktop Window & Windows System Tray (Option 2, `2026-11-19`):**
  - Added `public/manifest.webmanifest` (`display: "standalone"`) and manifest/theme-color tags in `index.html`.
  - Added token-guarded `POST /api/system/shutdown` in `src/server/routes/system.routes.ts` (`TENDER_SHUTDOWN_TOKEN` + constant-time `X-Shutdown-Token`) and `closeAllConnections` shutdown handling in `server.ts`.
  - Added `scripts/tray-app.ps1` and `scripts/launch-desktop.vbs` featuring single-instance mutex protection, hidden production server orchestration, **Microsoft Edge first / Google Chrome second** isolated `--app` window (`data/app-profile`), tray scan/log/restart/quit controls, `SessionEnding` handling, and deduplicated `<=48h` closing notifications.
  - Updated `scripts/launch.cmd`, `start-tender-tracker.bat`, `scripts/create-desktop-shortcut.ps1`, `scripts/install-startup-task.ps1`, `Launch Tender Tracker.lnk`, and `package.json` (`npm run desktop`), preserving `--console` fallback and full `QA-4`/`OPS-6`/`OPS-8` compliance.

- **`awaiting_scope` Lifecycle Hardening & Live DB Maintenance (`2026-11-16`):**
  - Filtered non-downloadable `.html`/`.aspx`/`.php`/`.jsp` links in `orderDocumentCandidates` (`src/server/scrapers/ingestPipeline.ts`) and `collectRowDocumentUrls` (`src/server/db/repositories/ingestJobsRepo.ts`) via `isDownloadableCandidateUrl` (preserving `/pdf?file=` and `?wpdmdl=` endpoints).
  - Updated `reScoreTendersAgainstTracks` (`src/server/db/repositories/tracksRepo.ts`) to include `extracted_text` via `applyDocumentScopeToTracks` and updated `saveDomainTrack` to keep `minilm` track embeddings intact when `name` and `positive_keywords` are unchanged.
  - Added `finalizeAwaitingScopeAfterJobFailure` in `src/server/runtime/ingestWorker.ts` to advance or finalize `awaiting_scope` tenders when a remaining job permanently fails, and added `graceDays` override support to `runRetentionCycle` (`src/server/services/retention.ts`).
  - Executed live maintenance on `./data/tender_tracker.db`: cleared 74 `.html` queue jobs (re-queuing 14 downloadable PDFs), cleaned 253 stale `awaiting_scope` rows, 11 expired Inbox rows, and 3 aged-out Passed rows, and backfilled `all-MiniLM-L6-v2` embeddings to `179/179` (`100%`) tenders.

- **Plans E & F Non-Breaking Rollout (`2026-11-13`):**
  - **Plan E (#6 — Separate Dev Watch vs. Production Runtime):** Added `esbuild` compiled server bundle (`npm run build:server` -> `dist-server/server.mjs`), updated `npm start` to execute pure Node with `--production`, fixed `PROJECT_ROOT` / `projectRoot` discovery across `src/server/db/connection.ts` and `server.ts`, added `TESSDATA_DIR` (`data/tessdata/`), and updated `scripts/launch.cmd` + `start-tender-tracker.bat` to auto-build if missing and run `npm start` instead of `npm run dev`.
  - **Plan F (#9 — Offline Local OCR Fallback):** Added `src/server/services/localOcrService.ts` (`tesseract.js` + `@napi-rs/canvas` PDF page rasterization capped at 3 pages, serialized OCR worker mutex, clean shutdown termination) and integrated it into Stage 2 of `src/server/services/documentExtractor.ts` as `extractionMethod: 'local_ocr'` whenever Gemini Vision is unconfigured, over budget, or returns `null`. Extracted text feeds SQLite FTS5 and deterministic extractors while keeping `canAutoExpire: false` (`DL-7`/`AI-3`).

- **Plans A–D Non-Breaking Feature Rollout (`2026-11-13`)**:
  - **Plan A (Structured "Go / No-Go" Bid Brief):** Extended Gemini extraction in `src/server/services/ocrService.ts`, `src/server/services/documentExtractor.ts`, `src/server/services/documentApply.ts`, and `src/server/scrapers/tenderAnalysis.ts` with optional `BidBrief` JSON (`bidSecurityAmount`, `tenderFee`, `requiredRegistrations`, `requiredExperience`, `deliverablesSummary`, `bidMethod`) persisted in `tenders.bid_brief` via `src/server/db/repositories/tendersRepo.ts` and rendered as a collapsible card in `src/client/components/inbox/Detail.tsx`.
  - **Plan B (Proactive 48h Closing Alerts & Daily Digest):** Added `getAlertsDigest` & `getDigestSettings`/`updateDigestSettings` in `src/server/db/repositories/systemRepo.ts`, REST endpoints `GET /api/system/digest` + `POST /api/system/digest/settings` in `src/server/routes/system.routes.ts`, opt-in once-per-PKT-day webhook dispatch (`maybeDispatchDailyDigest`) in `src/server/runtime/scheduler.ts`, and an Inbox `"Closing <=48h"` quick-filter toggle in `src/client/components/InboxScreen.tsx`.
  - **Plan C (Two-Speed Pagination + DB Early-Stop):** Added `quickMaxPages` / `deepMaxPages` on paginated portals in `src/server/scrapers/portalList.ts`, `depth` support on `POST /api/scan/start` (`src/server/routes/scan.routes.ts`) and `startCrawlerScan`/`scrapePortal` (`src/server/scrapers/crawlerEngine.ts`), SQLite early-stop on `page >= 2` when all items match known unchanged notices via `getKnownTenderMapForPortal`, and 24h deep-scan selection in `src/server/runtime/scheduler.ts`.
  - **Plan D (Bounded Concurrency Parallel Workers & Typed Error Taxonomy):** Extracted `scanSinglePortal` + `runWithConcurrency` in `src/server/scrapers/crawlerEngine.ts` (HTTP concurrency `3`, Playwright concurrency `1`), added `activePortals` / `scanDepth` tracking on `ScanStatus`, and classified failures via `classifyScraperError` into `portal_health.last_error_code` (`TIMEOUT`, `TLS_ERROR`, `CLOUDFLARE_HITL`, `LOGIN_REQUIRED`, `HTTP_4XX_5XX`, `PARSE_EMPTY`, `NETWORK_UNREACHABLE`).

- **EPADS v2.0 Open Federal Integration (`2026-11-13`) *(Superseded in v1.9.0 by Item 1 `epms_ppra` after `epads.gov.pk` re-enabled WAF blocking)***:
  - Updated `epads` in `portalList.ts` from login-gated `epms.ppra.gov.pk` to open `https://epads.gov.pk/` (`tier: 'http'`, `accessMode: 'public'`, `pagination: { kind: 'query', param: 'page', maxPages: 3 }`).
  - Added deterministic EPADS row extractor in `portalParsers.ts` (extracting untruncated tooltip titles, procuring agency, `P`-prefixed ref no, `Published On:` / `Closing On:` PKT timestamps + `"Xh Ym Left"` countdowns, and corrigendum flags).
  - Updated `parseDateString` (`dateParser.ts`) to strip leading weekdays and convert 12h `AM/PM` times explicitly to `+05:00` PKT.
- **SQLite FTS5 Full-Text & Document Search (`2026-11-13`)**:
  - Added `tenders.extracted_text` and external-content FTS5 virtual table `tenders_fts` (`content='tenders'`, `tokenize='unicode61 remove_diacritics 2'`) with synchronized insert/update/delete triggers in `src/server/db/schema.ts`.
  - Document text extracted via `pdfjs-dist`, `mammoth`, or OCR in `documentExtractor.ts` is saved via `documentApply.ts` -> `appendTenderExtractedText` (`tendersRepo.ts`) and searchable through `buildFts5PrefixQuery` with punctuation/syntax escaping and semantic fallback.
- **Split TypeScript Configs & Dev Auto-Reload (`2026-11-13`)**:
  - Split `tsconfig.json` into `tsconfig.base.json`, `tsconfig.client.json` (DOM/React), and `tsconfig.server.json` (Node-only) with `noUnusedLocals` and `noUnusedParameters` enabled across all projects, plus `tsx watch` dev script (`--ignore data/**`).

- **Item 10 (Full Multi-Page PDF Extraction & Tabular Pre-Anchor Deadlines `DL-7`, `DL-8`, `DOC-1`)**: Completed 2026-11-12.
  - Removed the 5-page PDF truncation limit in `documentExtractor.ts` so all document pages are processed without skipping.
  - Added pre-anchor deadline extraction for tabular notices (e.g. `<Date> by or before <Time>`) and space-tolerant date candidate matching.
  - Added pre-bid meeting notice rejection in `isNonBidEvaluationOrPlanTitle` (`portalParsers.ts`) so informational meetings are not ingested as bid opportunities.
  - Reprocessed local database, auto-expiring past PSDF tenders and removing non-bid meetings (0 expired unflagged inbox rows).
  - Proven by `tests/unit/document-extractor.test.ts`, `tests/scraper/crawler.test.ts`, and full 600-test suite.

- **Item 2 (Calibrate MiniLM Semantic Similarity Thresholds `P1-6`, `DED-7`, `MATCH-5`)**: Completed 2026-11-12.
  - Evaluated on 50 labeled tender↔track pairs (`tests/fixtures/calibration/trackMatchPairs.ts`) across 6 procurement domains and negative cross-domain samples. Achieved **$\text{F1} = 95.83\%$**, **$\text{Precision} = 100.0\%$**, **$\text{Recall} = 92.0\%$**, with **0 False Positives**.
  - Evaluated on 30 labeled duplicate/distinct pairs (`tests/fixtures/calibration/duplicatePairs.ts`). Identified and patched a multi-lot false-merge loophole in `titlesAreDistinguishable` (`deduplicator.ts`). Achieved **False-Merge Rate $= 0.00\%$** (0 false merges) and **$\text{Precision} = 100.0\%$**.
  - Proven by automated test suite in `tests/unit/semantic-calibration.test.ts`.

- **Item 3 (Local PDF vs. Gemini Vision Agreement Benchmark `P1-5`, `DOC-10`)**: Completed 2026-11-12.
  - Benchmarked 20 real cached PDFs from `data/dossiers/`. Measured 70% digital text layer extraction locally (zero API calls) and 30% scanned notice routing to Gemini Vision fallback.
  - Measured local extraction speed: **96.9 ms** average latency per document (exceeds $<500\text{ ms}$ requirement).
  - Proven by automated benchmark suite in `tests/unit/pdf-benchmark.test.ts`.

- **Item 4 (Offline Portal Contract Fixtures `P3-4`, `SCR-8`)**: Completed 2026-11-12.
  - Captured and verified static $\le 50\text{ KB}$ HTML fixtures for all 13 reachable portals under `tests/fixtures/portals/`.
  - Hermetic parser contract test suite `tests/scraper/portal-contracts.test.ts` passes 100% (27/27 tests in <900ms).

- **Item 5 (Multi-Page Full-Scan End-to-End Verification `D4`, `SCR-4`, `OPS-1`)**: Proven live in production database. `last_full_scan_at` stamped (`2026-11-11T09:19:17.565Z`), `pages_scanned` verified across all active portals, and all 20 Pipeline tenders (`Under Review`, `Passed`) preserved with 100% integrity. Direct unit test coverage in `tests/scraper/crawler.test.ts:1710` and `tests/scraper/scheduler.test.ts`. Status updated from Unproven to Proven in `docs/13-north-star-quality-standard.md`.

- **Item 6 (Source Health Reporting `HLT-3`, `HLT-5`)**: Proven in `tests/scraper/crawler.test.ts`. `last_success_at` is updated at the conclusion of every non-error scan.

- **Item 7 (Direct Tests for Re-scan & Governance `ID-1`, `DL-3`, `DL-4`, `GOV-6`)**: Proven by dedicated test suites: `tests/scraper/rescan-pipeline.test.ts`, `tests/scraper/healer-rules.test.ts`, `tests/unit/referenceNo.test.ts`, and `tests/unit/trackMatcher.test.ts`.

- **Item 8 (Automated Documentation Check `QA-4`)**: Proven by `tests/unit/docs-consistency.test.ts` verifying all file paths, canonical portal count (19), and table schemas.

- **Item 9 (Measure Line Coverage `QA-2`)**: Measured baseline at 84.62% lines (82.84% statements, 81.67% functions, 73.59% branches) with per-submodule coverage exceeding 90% in repositories, deduplication, date parsing, and scrapers. Enforced via thresholds in `vitest.config.ts`.

---

## 4. Completed Design Specifications (from `docs/13` §7)

All four design specifications are completed and documented:
- **Crawler Submodule Layout**: Decomposed into `htmlFetcher.ts`, `crawlerDeps.ts`, `portalParsers.ts`, `tenderAnalysis.ts`, `ingestPipeline.ts` (`docs/02`).
- **Portal Configuration Schema (`PortalDefinition` / `PaginationConfig`)**: Canonical two-speed pagination and portal metadata schema documented in `docs/05`.
- **`ingestion_status` Transitions**: Mermaid state diagram and retention invariants documented in `docs/06`.
- **Non-Goals & System Boundaries**: Explicit architectural constraints documented in `docs/01`.

---

## Historical References & Archived Audits
All resolved plans and completed audits have been moved to `docs/archive/` with full historical context:
- `docs/archive/13-ingestion-pipeline-plan.md`: Phases 0–4 ingestion pipeline implementation (Completed Nov 10).
- `docs/archive/15-fundamental-logic-issues.md`: Issues F1–F7 resolution details (Completed Nov 11).
- `docs/archive/16-deep-audit-logic-flaws.md`: Flaws A1–A11, B1–B8, C1–C4 deep audit (Completed Nov 11).
- `docs/archive/17-fix-checklist.md`: 128-point execution checklist (Completed Nov 11).
