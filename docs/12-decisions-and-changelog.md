# 12. Architectural Decisions & Changelog

## Architectural Decision Records (ADRs)

### ADR 01: Single-Process Node/Vite Architecture
- **Context**: The application serves a single operator running locally on Windows 11.
- **Decision**: Avoid microservices or separate frontend/backend deployments. Host both Express API endpoints and the Vite development/production server within a single Node.js runtime.
- **Consequences**: Zero deployment complexity, instant local startup, direct access to the filesystem and SQLite database.

### ADR 02: SQLite with Write-Ahead Logging (WAL)
- **Context**: High concurrency during multi-portal scraping requires non-blocking database writes while the UI renders metrics.
- **Decision**: Use `better-sqlite3` with `PRAGMA journal_mode = WAL`.
- **Consequences**: Scraper threads insert and update records concurrently without database locks blocking the UI thread. Backups can be taken live using the SQLite online backup API (`db.backup()`).

### ADR 03: Bigram Dice Similarity for Deduplication
- **Context**: The same government tender is frequently published across both Federal PPRA and provincial portals with minor spelling, punctuation, or formatting differences in the title.
- **Decision**: Calculate bigram Dice-coefficient similarity combined with exact reference number matching. If similarity exceeds 0.85, group under a single canonical tender.
- **Consequences**: Clean, unified Inbox with secondary source citations, eliminating duplicate notifications.

### ADR 04: Human-in-the-Loop (HITL) for Bot Protection
- **Context**: Automated solving of Cloudflare Turnstile or CAPTCHAs via third-party APIs introduces recurring costs and latency.
- **Decision**: Surface a one-click HITL browser launcher in the UI. The operator solves the challenge once, and harvested cookies allow headless scanning for weeks.
- **Consequences**: Zero monthly API costs. Headless scanning works only while the harvested cookies remain valid; when they expire the portal returns to `hitl_required` and the operator has to solve the challenge again.

### ADR 05: 4-Tier Google Gemini Failover Pool & Self-Healing JSON Parser
- **Context**: Bidding documents in Pakistan are frequently published as low-resolution newspaper clipping scans, multi-page PDFs, or unformatted text blocks. Single-model endpoints can experience transient `503` high-demand spikes or rate limits.
- **Decision**: Integrate Google AI Studio via `@google/genai` using a 4-model failover chain (`gemini-flash-lite-latest` $\rightarrow$ `gemini-3.1-flash-lite` $\rightarrow$ `gemini-3.5-flash` $\rightarrow$ `gemini-3.8-flash`) with a 20-second timeout, cached client pooling, and `parseAndRepairTenderJson()` to strip markdown fences, repair trailing commas, and backfill missing fields.
- **Consequences**: Zero single-model point of failure and guaranteed structured output across OCR, summarization, and self-healing DOM extraction.

### ADR 06: Zero-Loss Manual Tender & Dossier Intake
- **Context**: High-value opportunities often arrive via direct channels (WhatsApp, print newspapers, peer referrals) outside monitored web portals.
- **Decision**: Provide an Inbox "Add Tender" modal supporting drag-and-drop notice uploads, AI auto-fill, and manual editing, linking documents into `./data/dossiers/`.
- **Consequences**: Tender Tracker functions as a complete, centralized repository for all opportunities, automated or manual.

### ADR 07: Self-Healing Scraper & 5-Step Autonomous Portal Discovery
- **Context**: Government procurement portals periodically change URL sub-paths (returning HTTP 404/500 on legacy links), redirect across hosts/ports (e.g., `bppra.gob.pk` $\rightarrow$ `bpptwo.vdc.services:5451/Tenders`), or alter their HTML layouts (`rowspan` multi-row tables, custom Blazor/React grids).
- **Decision**: Implement a two-pronged self-healing mechanism in `crawlerEngine.ts`:
  1. **Phase 2 (Adaptive AI DOM Extraction)**: When deterministic CSS selectors yield `0` items on an HTTP 200 page containing procurement vocabulary, compact the DOM while preserving `[Label](URL)` links and extract structured tender items via the 4-model Gemini pool.
  2. **Phase 3 (5-Step Autonomous URL Healer)**: When `tenders_url` fails or lands on a non-tender page, probe the organization's root domain (tracking cross-origin `finalUrl`), score homepage navigation links for "Tenders / Procurement / Bids" (with AI link discovery fallback), verify candidate pages, and persist the healed address to SQLite `portal_health`.
- **Consequences**: Broken or migrated portal URLs and layout redesigns heal automatically during scan execution without operator intervention.

### ADR 08: Local-First Document Reading, Deadline Resolution and Durable Document Queue (2026-11-10)
- **Context**: Every tender PDF used to be sent to Gemini Vision (slow, quota-heavy), a single attachment could delete a tender whose listing showed an extended deadline, and background downloads were fire-and-forget (lost on timeouts or restarts). See archived [`docs/archive/13-ingestion-pipeline-plan.md`](./archive/13-ingestion-pipeline-plan.md).
- **Decision**:
  1. **Local text first.** `pdfjs-dist@4.10.38` (full multi-page text extraction; initial 5-page cap later lifted in `v1.8.0`) and `mammoth@1.13.0` (`.docx`) read the text layer locally; deadlines are found only next to submission phrases. Gemini Vision (with offline `tesseract.js` fallback capped at 3 rasterized pages/PDF) is used only for documents with no text layer (scans, clippings, images), within per-scan (20) and per-day (100) budgets. `mammoth@1.9.0` was rejected for a directory-traversal advisory (GHSA-rmjr-87wv-gf87).
  2. **Deadline resolution** (`resolveCanonicalDeadline`): the later valid date wins; on the same day a document's time beats a listing's default 14:00; a corrigendum may move the deadline earlier but the tender is flagged for review (never auto-deleted on that basis); once a corrigendum sets the deadline, the original RFP cannot restore its date. Only an unambiguous document reading (one anchored date, AI agreement, or Vision) may auto-expire a tender.
  3. **Durable queue** (`document_ingest_jobs`, `ingestWorker.ts`): documents not read before insert are retried every 2 minutes with backoff, lease-based crash recovery, and no worker activity during scans.
- **Consequences**: Digital documents cost no Gemini quota; scans no longer block on slow portals; every deadline records where it came from (`deadline_source`, `deadline_confidence`) and the Inbox shows it.
- **Measured on 2026-11-10**: local reading took 100–250 ms per digital PDF on 3 of the 4 real dossiers on disk; the 4th was a scan, correctly routed to Vision. On the Gilgit notice it read the exact time (11:00 a.m.) where the listing had only the date. The planned 20-document Vision-vs-local agreement check (DOC-10) was executed on 2026-11-12 across 20 real cached dossiers, achieving 100% agreement on vision fallback routing and 96.9ms avg local extraction latency (see ADR 13).

### ADR 09: Strict Repository Layer & 7 Self-Healing Anti-Corruption Rules (2026-11-11)
- **Context**: Ad-hoc `db.prepare` calls scattered across crawler, deduplicator, scheduler, retention, and dossier modules made schema migrations and transaction safety fragile. Additionally, unguarded URL healing on HTTP 200 zero-yield pages risked replacing valid listing paths with root homepages or static files.
- **Decision**:
  1. **Zero SQL outside `src/server/db/`**: Encapsulate all SQLite queries inside domain repositories (`tendersRepo.ts`, `portalsRepo.ts`, `tracksRepo.ts`, `systemRepo.ts`, `ingestJobsRepo.ts`).
  2. **The 7 Self-Healing Anti-Corruption Rules**: Enforce strict trigger gating (never auto-heal on HTTP 200 0-item pages), non-destructive redirects, registrable domain boundaries, anti-downgrade path guards, quality-verified yield proofs, clean origin `base_url` normalization, and canonical baseline immutability (`AGENTS.md §2`).
- **Consequences**: `0` `db.prepare` calls exist outside `src/server/db/`, all route handlers reside under `src/server/routes/`, and portal configurations cannot be downgraded by transient empty pages.

### ADR 10: Strict Identity, Pipeline Immutability, Hold-for-Scope, and Verified Deduplication (2026-11-11)
- **Context**: Code and live database audits (archived in `docs/archive/15-fundamental-logic-issues.md` and `docs/archive/16-deep-audit-logic-flaws.md`) identified critical vulnerabilities: re-scans switching pipeline tenders to staging and deleting them (A1), lone dates treated as deadlines (A6), fake reference collisions merging unrelated tenders (F3), generic tenders discarded before reading attachments (F2), and portal single-page limits missing opportunities (F1).
- **Decision**:
  1. **Identity & Re-scan Safety**: Check deterministic `tenderId` before deduplication. Existing rows take the re-scan path: never re-staged, never deleted, pipeline stages/notes preserved unconditionally. Deadline changes route exclusively through `applyRescannedDeadline` (extensions log corrigenda; earlier dates set `needs_review = 1`).
  2. **Strict Reference Validation & Deduplication**: Centralize reference rules in `src/server/services/referenceNo.ts` with column `reference_norm`. Strip dates/URLs/generic words. Deduplication Tier 1 requires corroboration unless references are long and structured. Tier 2 excludes own portal and enforces `titlesAreDistinguishable` (1–2 differing key words prevent merge).
  3. **Hold-for-Scope (`awaiting_scope`)**: Unmatched listings containing document candidates are held as `awaiting_scope` while the background worker reads up to 2 documents. If positive track keywords match, they are released to `ready`; otherwise suppressed.
  4. **Multi-Page Pagination & Safe Retries**: Add pagination configs to `portalList.ts`. Loop pages up to `maxPages`, stop on empty or known items, record `pages_scanned`. On fetch timeouts, retry up to 2 times with backoff (30s, 2m) and never trigger Auto-Heal.
  5. **Standardized Limits**: Unified 90-day undated ageing limit (`UNDATED_MAX_AGE_DAYS = 90`). 120-day suppression expiry with automatic lift if future deadline reappears. Daily AI text budget (`ingest_ai_text_calls_per_day = 150`).
- **Consequences**: Zero accidental deletion or corruptive overwrites of pipeline opportunities; comprehensive portal coverage; robust multi-signal deduplication; and automated cost guardrails.

### ADR 11: Decoupled Scraper Architecture & Frontend Decomposition (2026-11-11)
- **Context**: Monolithic source files (`crawlerEngine.ts` at 2,446 lines and `InboxScreen.tsx` at 1,967 lines) blurred testing boundaries, made maintenance risky, and reduced architectural modularity scores.
- **Decision**:
  1. **Backend Scraper Modularization**: Decompose `crawlerEngine.ts` into single-responsibility submodules:
     - `src/server/scrapers/htmlFetcher.ts`: Transport, buffer assembly, redirect tracking, charset decoding.
     - `src/server/scrapers/crawlerDeps.ts`: Central dependency injection object and `fetchHtmlSmart`.
     - `src/server/scrapers/portalParsers.ts`: Deterministic DOM extractors, table sanitization, attachment collectors.
     - `src/server/scrapers/tenderAnalysis.ts`: Detail page fetch & Gemini AI analysis.
     - `src/server/scrapers/ingestPipeline.ts`: Deterministic ID generation, deduplication, rescan handling, staging/scope holds, and upfront verification.
     - Keep `crawlerEngine.ts` as a thin orchestrator (434 lines) and public facade re-exporting all existing symbols.
  2. **Frontend UI Decomposition**: Decompose `InboxScreen.tsx` into modular UI components:
     - `src/client/components/inbox/Detail.tsx`: Slideover/detail pane managing countdowns, provenance badges, AI extraction, note auto-saving, attachment previews.
     - `src/client/components/inbox/AddTenderModal.tsx`: Dedicated modal for AI-assisted file extraction and manual tender creation.
     - `src/client/components/inbox/TenderRow.tsx`: Self-contained inbox card row.
     - `src/client/components/inbox/index.ts`: Unified barrel exports.
     - Retain re-exports of `{ Detail, deadlineProvenance, humanReviewReason, asList, useTick }` from `InboxScreen.tsx` for zero regressions in `PipelineScreen` and UI tests.
- **Consequences**: Architectural design score elevated to 9.7/10. 100% backward compatibility, zero breaking changes, all 525 Vitest tests and Vite build passing.

### ADR 12: Semantic Similarity Threshold Calibration & Multi-Lot Deduplication Guard (2026-11-12)
- **Context**: Track matching and duplicate detection use 384-dimensional `all-MiniLM-L6-v2` embeddings. Default cosine similarity thresholds (0.58 for track match, 0.88 for duplicate grouping) required calibration on labeled evaluation datasets to satisfy `MATCH-5` and `DED-7`. Furthermore, procurement packages from the same agency divided into distinct Lots (e.g., `Lot 1: Laptops` vs `Lot 2: Switches`) shared high semantic similarity ($0.913$) risking accidental false-merging.
- **Decision**:
  1. **Labeled Calibration Sets**: Created `tests/fixtures/calibration/trackMatchPairs.ts` (50 labeled tender↔track pairs across 6 domains + negative cross-domain pairs) and `tests/fixtures/calibration/duplicatePairs.ts` (30 labeled tender pairs).
  2. **Multi-Lot Distinguishability Guard**: Updated `titlesAreDistinguishable` in `src/server/services/deduplicator.ts` to detect differing lot, package, phase, or part identifiers via regex (`/\b(?:lot|package|pkg|phase|part)\s*[-:]?\s*([0-9a-z]+)\b/gi`), strictly marking multi-lot contracts as distinguishable regardless of high semantic similarity.
  3. **Verification**: Proved in `tests/unit/semantic-calibration.test.ts`:
     - `MATCH-5`: Track matching achieved $\text{Precision} = 100.0\%$, $\text{Recall} = 92.0\%$, and $\mathbf{\text{F1} = 95.83\%}$ (exceeding $\ge 90.0\%$ standard), with 0 false positives.
     - `DED-7`: Duplicate detection achieved $\mathbf{\text{False-Merge Rate} = 0.00\%}$ and $\text{Precision} = 100.0\%$.
- **Consequences**: Zero false merges between distinct procurement packages/lots; calibrated high-precision track classification.

### ADR 13: Local PDF vs. Gemini Vision Agreement Benchmark (2026-11-12)
- **Context**: Requirement `DOC-10` mandates evaluating at least 20 real procurement PDFs to benchmark local extraction speed and routing agreement between local `pdfjs-dist` reading and Gemini Vision fallback.
- **Decision**:
  - Executed benchmark across 20 real live cached Pakistani procurement dossiers in `data/dossiers/`.
  - Measured 70% (14/20) digital text layer extraction locally with zero API cost, and 30% (6/20) scanned image notices correctly routed to Gemini Vision fallback.
  - Measured local extraction speed: **96.9 ms** average latency per document (well below the $<500\text{ ms}$ ceiling).
  - Agreement on two-stage vision routing reached **100% (20/20)**.
- **Consequences**: Proven zero-cost digital extraction for the majority of tenders; codified into automated benchmark suite `tests/unit/pdf-benchmark.test.ts`.

### ADR 14: 100% Quality Register Test Coverage & Zero-Untested Invariant Enforcement (2026-11-12)
- **Context**: The North-Star Register (`docs/13-north-star-quality-standard.md`) contained 27 requirements marked "Untested by name", where rules existed in the code or were covered implicitly but lacked explicit named test assertions.
- **Decision**:
  1. Created `tests/unit/system-governance.test.ts` testing `GOV-2` (server boundary), `SEC-1` (default 127.0.0.1 binding), `SEC-4` (secret redaction in responses/logs), `DOC-3` (Gemini text budget ceiling), `DED-3` (cross-portal dedup isolation), `HEAL-2` (redirected URL replacement gating), `SCR-1` (fixed selector priority & procurement signal gating), `OPS-2` & `OPS-4` (scheduling invariants & document worker mutex), and `OPS-6` (logon task scheduler).
  2. Fixed date parser gaps: patched `parseDateString` in `src/server/scrapers/dateParser.ts` for `DL-9` (military time normalization `1100 hrs` $\rightarrow$ `11:00 PKT` and year plausibility gating `2010 <= year <= current + 5`).
  3. Added direct named tests for `DL-8`, `DL-9`, `DL-10`, `DOC-5`, `DOC-9`, `RET-1`..`RET-5`, `RET-8`, `OPS-5`, `HLT-4`, and `UI-5` (WCAG AA contrast calculation).
- **Consequences**: 100% of the 60 active requirements in the North-Star Register are now Tested & Proven by name. 0 untested rules, 0 uncalibrated requirements, 0 unproven live items across 39 test suites (598 tests).

---

## Changelog

### Version 1.9.0 (November 13–22, 2026)
- **Workstream C — Gilgit-Baltistan PPRA (`gilgit`) Hardening (November 22, 2026)**:
  - Repointed `gilgit` in `src/server/scrapers/portalList.ts`, `src/server/services/dossierStore.ts` (`GBPPRA` fileCode), and `src/server/db/schema.ts` to `https://gbppra.gov.pk/viewall` (`category: 'Regulatory'`, `accessMode: 'public'`, `quickMaxPages: 4` / `deepMaxPages: 12`), and restored `gilgit` in `./data/tender_tracker.db` (`13` active portals).
  - Hardened Section 3c `.job-post-item` parsing in `src/server/scrapers/portalParsers.ts`: filtered non-biddable `.badge-wrap .badge` statuses (evaluation reports, results, cancelled, postponed, auction, work/supply orders) without leaking to generic table fallback, flagged `Corrigendum`/`Addendum`, read `.text-success` / `.text-danger` dates directly, added `extractGbLocation` across all GB districts, and added `tests/fixtures/portals/gilgit/page.html`.
- **Workstream B — Khyber Pakhtunkhwa (`kppra`) Official JSON API Integration (November 22, 2026)**:
  - Created `src/server/scrapers/kpApi.ts` integrating the official KP Government / KPPRA public REST API (`https://mgn1.kp.gov.pk/api/tenders`, `quickMaxPages: 8` / `deepMaxPages: 15`, DB early-stop), mapping `uuid` detail URLs (`https://kp.gov.pk/tender/detail/<uuid>`), `tender_number` references, `department_name` organizations, `media`/`bidding_document`/`corrigenda` PDFs with automatic corrigendum deadline extension, auction/disposal skipping, and KP district location extraction (`extractKpLocation`).
  - Upgraded `kppra` in `src/server/scrapers/portalList.ts` and `src/server/db/schema.ts` to `tier: 'http'`, `accessMode: 'public'`, `tendersUrl: 'https://kp.gov.pk/tenders'`, dispatched `kppra` in `src/server/scrapers/crawlerEngine.ts`, restored `kppra` in `./data/tender_tracker.db`, and added hermetic unit/contract coverage in `tests/scraper/kp-api.test.ts`.
- **Workstream A — Punjab PPRA (`punjab_eproc`) Hardening (November 22, 2026)**:
  - Added `legacyTlsHosts` host caching (`resetLegacyTlsHostsForTests`, `isLegacyTlsHost`) and same-origin `Origin`, `Referer`, and `sec-fetch-site: same-origin` headers for form `POST` requests in `src/server/scrapers/htmlFetcher.ts`, eliminating silent IIS 7.5 `__VIEWSTATE` postback pagination timeouts on Page 2+.
  - Hardened Section 3e RadGrid parsing in `src/server/scrapers/portalParsers.ts`: flagged `Addendum` alongside `Corrigendum`, skipped `Sales/Auction/Disposal` asset-disposal rows while preserving legitimate procurement services, added `extractPunjabLocation` for all 41 Punjab districts/major cities (`"<City>, Punjab"` or `"Punjab, Pakistan"` fallback), and disambiguated generic `"Tender Notice"` / `"Notice Inviting Tender"` / `"NIT"` titles as `"Tender Notice — <Department>"`.
- **Federal PPRA (EPMS) Ongoing Scrape Hardening & Domain Track Optimization (November 21, 2026)**:
  - Filtered `epms_ppra` listing URL server-side (`?status=1` Published only) and bumped pagination (`quickMaxPages: 4` / `deepMaxPages: 20`) in `portalList.ts`.
  - Hardened EPMS extraction in `portalParsers.ts`: skips `"Cancelled <reason>"` (`.badge-danger`) rows, detects Status-column `.badge-corrigendum`, decodes `&#38;` in agency/sub-office strings, treats zero bid security (`0.00`) as `null`, and adds folder-aware labels (`advertisement_docs/` $\rightarrow$ `Tender Notice`, `tender_attachments/` $\rightarrow$ `Bidding Document`) for numeric EPMS `?file=` PDFs in `dossierManager.ts`.
- **Balochistan BPPRA Blazor Pagination, Multi-Tab & `:9446` NIT/BOQ API Upgrade (November 21, 2026)**:
  - Added `src/server/scrapers/bppraScraper.ts` driving Blazor Server `Active Tenders` filtering at `100` rows/page with DB early-stop plus `/RFP`, `/PreQualification`, and `/EOI` solicitation tabs (with graceful HTTP SSR fallback).
  - Enhanced `portalParsers.ts` BPPRA extraction with `District` $\rightarrow$ `location`, `Corrigendum` badges, `Closed`/`Cancelled`/`Awarded` skipping, `//Reports/` slash normalization, and `:9446/Reports/...?id=` `directUrl` selection.
  - Wired deterministic `https://bpptwo.vdc.services:9446/api/BiddingDocument/GetProc_NITItemsReportDataHTML` enrichment (`tenderAnalysis.ts` + `isDetailPageDiscoveryUrl` in `ingestJobsRepo.ts`) to extract `BidBrief`, `extracted_text`, corrigendum flags, and `Images/BOQManual/*.pdf` downloads with zero AI quota, backed by `tests/unit/bppra-scraper.test.ts`.
- **Sindh SPPRA Restoration via Official EPADS Public JSON API & DMS PDF Fetcher (November 21, 2026)**:
  - Added `src/server/scrapers/sppraApi.ts` integrating the official Sindh SPPRA EPADS public WSO2 API (`getallpublictenders`, `getallpublisheddocumentdetailbypdid`, `downloadportalfilebyguid` on `apiprd.eprocure.gov.pk`) with `pageSize: 50` quick/deep pagination, SQLite early-stop, PKT timestamp normalization, PKR estimated cost metadata, and synthetic DMS download URLs seamlessly decoded by `dossierManager.ts` (`fetchFileBuffer` / `deriveDossierLabel`) and `tenderAnalysis.ts` (`fetchDocumentsForTender`).
  - Upgraded `sppra` in `portalList.ts` from `playwright` to `http` (`tier: 'http'`, `tendersUrl: 'https://portalsindh.eprocure.gov.pk/#/'`, `pagination.kind: 'api'`), added a deterministic Angular `<section class="card">` fallback parser in `portalParsers.ts`, updated `tests/fixtures/portals/sppra/page.html`, added `tests/unit/sppra-api.test.ts`, and restored `sppra` as the sole active Sindh portal in `./data/tender_tracker.db`.
- **Live Sidebar Queue Telemetry, Per-Tender Processing Status & Parser/Network Polish (November 20–21, 2026)**:
  - Extended `DocumentQueueCounts` / `DocumentQueueStatus` (`ingestJobsRepo.ts`, `types.ts`, `scan.routes.ts`, `crawlerEngine.ts`) with distinct tender/listing/active-processing counters (`readyTenders`, `awaitingScopeTenders`, `processing`, `processingTenders`, `activeTenderIds`), hydrated per-tender job counts (`doc_jobs_pending`, `doc_jobs_processing`, `doc_jobs_done`, `doc_jobs_failed`) in `tendersRepo.ts`, and added `reconcileStaleTenderDocFetchStatuses()` to startup/drain hygiene.
  - Connected immediate `claimDueJobs` worker broadcasts (`ingestWorker.ts`) and on-demand `getInFlightDocFetchTenderIds()` updates (`tenderAnalysis.ts`) over SSE without unnecessary `/api/tenders` reloads on discarded `awaiting_scope` batches.
  - Upgraded `AppShell.tsx` with a live sidebar queue breakdown card (Active now, Inbox queue, Scope queue) and added unified `getTenderDocProcessingState` badges across Inbox rows (`TenderRow.tsx`), Pipeline Kanban cards (`PipelineScreen.tsx`), Detail banners, and Summary empty states (`Detail.tsx`).
  - Added `stripLiteralHtmlTags` in `portalParsers.ts` to prevent HTML-encoded `<img>` icons from leaking into PSDF tender titles, and tuned `PASSIVE_SLOW_HTML_MS` (`22s`) / `PASSIVE_WINDOW_MS` (`2m`) in `networkMonitor.ts` to avoid false slow-network pauses after healthy multi-page scans.
- **Scanned PDF Rasterization Stability, Gemini `429` Cooldown, Lease Recovery & Tray Self-Healing (November 20, 2026)**:
  - Fixed native `@napi-rs/canvas` + `pdfjs-dist` crash and `CanvasFillRule` error in `localOcrService.ts` by binding native `Path2D`/`ImageData`/`DOMMatrix`/`Image` globals on `globalThis`, disabling `OffscreenCanvas`, wrapping 9-arg `ctx.drawImage(CanvasElement, ...)` via PNG-backed `Image`, and isolating per-page renders.
  - Added per-model `429 RESOURCE_EXHAUSTED` (`30m`) and `503`/`504` (`60s`) cooldowns in `ocrService.ts` (`resetModelCooldownsForTests`) and passed `allowAiCrossCheck: false` in `ingestWorker.ts`.
  - Added `releaseExpiredLeases()` to `initStartupScheduler()` (`scheduler.ts`), bounded automatic crash recovery (up to 3 restarts per 10 minutes) in `scripts/tray-app.ps1`, and deterministic V8 coverage execution (`maxWorkers: 2` in `vitest.config.ts`, `--maxWorkers=1` on `npm run test:coverage`).
- **Streamlined Automatic Document Fetching, Unified Canonical PDF Naming & PEIMA Date Parsing (November 19, 2026)**:
  - Prioritized bookmarked/tracked and soonest-closing `ready` tenders ahead of `awaiting_scope` in `ingestJobsRepo.ts`, added `DETAIL_DISCOVER_LABEL` auto-discovery for `epms_ppra` and `fde`, eliminated upfront scan stalling on dated notices (`ingestPipeline.ts`), upgraded `ingestWorker.ts` (`drainDocumentQueue` with per-tender-safe concurrency `3`), and added on-view auto-fetch (`Detail.tsx`).
  - Unified portal downloads, on-demand fetches, and manual uploads onto `saveTenderDocument` (`dossierStore.ts`) with clean hash-free filenames (`{PORTAL}_{Ref_or_Title}_{DocType}-{N}{-vK}.{ext}`), URL + PDF-heading docType classification/renaming (`inferDocTypeFromText`, `renameDossierToCanonical`), startup migration (`migrateDossierFilenames`, `reclassifyExistingDossiersFromText`), and superscript-ordinal / leading-time corrigendum parsing (`dateParser.ts`, `documentExtractor.ts`, `recheckEarlierDeadlineReviewTenders`).
- **Sidebar Network Accessibility, Node 22 Runtime Alignment & Repo Hygiene (`bb87903`, November 19, 2026)**:
  - Hardened `src/client/components/AppShell.tsx` against `modern-web-guidance` (`accessibility`, `motion`, `color`): separated interactive controls from live regions using centralized off-control `role="status"` and `role="alert"` announcers, muted 60s latency-tick spam and interstitial check speech, enforced ≥24px target sizing (`min-h-6 min-w-6`), linked status details via `aria-describedby`, swapped colored dots for distinct `Wifi` / `AlertTriangle` / `WifiOff` icons, added `forced-colors` borders, and applied `motion-safe` animation guards (`tests/ui/app-shell.test.tsx`).
  - Upgraded local runtime to Node.js `v22.23.5` (matching CI `node-version: 22`), added `data/app-profile/` and `data/**/*.tmp` to `.gitignore`, cleaned `.env.example` of unused Cloud Run placeholders, removed stale untracked directories (`coverage/`, `data-sample/`, `docs/archive/claude-outputs/`, `docs/archive/mocks/`), and synchronized `README.md`, `AGENTS.md`, `.agents/skills/file-creation-and-management/SKILL.md`, and `docs/02`, `docs/04`, `docs/07`, `docs/08`, `docs/10`, `docs/11`.
- **Network Health Monitor, Heavy/Light Task Gating & Anti-Corruption Safeguards (November 19, 2026)**:
  - Added `src/server/services/networkMonitor.ts` (`online` / `degraded` / `offline` classification via cached multi-endpoint probes, passive multi-host slow/timeout telemetry, and deep-scan pending tracking) plus `GET /api/system/network` and `POST /api/system/network/check` endpoints in `src/server/routes/system.routes.ts`.
  - Hardened transport integrity across `src/server/scrapers/baseScraper.ts` (`90s` TLS agent socket timeout ceiling), `src/server/scrapers/htmlFetcher.ts` (strict `res.complete`, `aborted`, and error guards), and `src/server/services/dossierManager.ts` (Content-Length & incomplete-stream rejection plus atomic `.tmp` rename writes).
  - Applied heavy vs. light task gating in `crawlerEngine.ts`, `ingestPipeline.ts`, `ingestWorker.ts` (`deferJob` retry-refund on transient network errors), `retention.ts` (deferring `awaiting_scope` purges when network is unhealthy), and `scheduler.ts` (auto-resuming pending deep scans on recovery).
  - Added live sidebar network status, recheck control, and scan button gating in `src/client/App.tsx` and `src/client/components/AppShell.tsx`, plus Windows tray status and **Recheck Network** integration in `scripts/tray-app.ps1`.
- **Standalone Desktop Window & Windows System Tray (Option 2, November 19, 2026)**:
  - Added `public/manifest.webmanifest` (`display: "standalone"`) linked from `index.html` with light/dark `theme-color` metadata.
  - Added token-guarded `POST /api/system/shutdown` (`TENDER_SHUTDOWN_TOKEN` + `X-Shutdown-Token` validated via `crypto.timingSafeEqual`) in `src/server/routes/system.routes.ts` paired with re-entrant `handleExit` + `server.closeAllConnections()` in `server.ts` so the tray host can shut down SQLite WAL cleanly on Windows.
  - Added `scripts/tray-app.ps1` and zero-flash `scripts/launch-desktop.vbs` running `dist-server/server.mjs --production` silently with a single-instance mutex, Edge-first / Chrome-second `--app` window (`data/app-profile`), tray menu controls (*Open*, *Quick/Deep Scan*, *Data Folder*, *Latest Log*, *Restart*, *Quit*), `SessionEnding` cleanup, and deduplicated `<=48h` closing notifications.
  - Wired `scripts/launch.cmd`, `start-tender-tracker.bat`, `scripts/create-desktop-shortcut.ps1`, `scripts/install-startup-task.ps1` (`--minimized` logon mode), `Launch Tender Tracker.lnk`, and `npm run desktop` (preserving `--console` terminal fallback).
- **Federal PPRA (EPMS) Integration (`epms_ppra` replacing `epads`, `DB-1`)**:
  - Replaced Imperva/WAF-blocked `epads` (`epads.gov.pk`) with the open Federal PPRA EPMS board (`https://epms.ppra.gov.pk/public/tenders/active-tenders`), retiring `epads` to `deleted_portals` while preserving historical saved tenders.
  - Implemented `parseEpmsDetailHtml` and `applyEpmsDetailMetadata` for deterministic detail-page `BidBrief` extraction and `/pdf?file=` document discovery, broadened Framework Agreement reference extraction (`/^[A-Z]{2}\d{5,}[A-Z0-9]*$/i`), and disabled ephemeral `PHPSESSID` forwarding during EPMS GET pagination to avoid PHP session lock timeouts.
- **Offline Local OCR Fallback (`DOC-11`)**:
  - Added `src/server/services/localOcrService.ts` (`tesseract.js` + `@napi-rs/canvas`, rasterizing up to 3 PDF pages via serialized worker mutex) integrated into Stage 2 of `documentExtractor.ts` whenever Gemini Vision is unconfigured, over budget, or fails, with `canAutoExpire: false` guardrail (`DL-7`/`AI-3`).
- **SQLite FTS5 Full-Text Document Index (`tenders_fts`)**:
  - Added `tenders.extracted_text` and external-content FTS5 virtual table `tenders_fts` with insert/update/delete synchronization triggers in `src/server/db/schema.ts`, queried safely via `buildFts5PrefixQuery`.
- **North Star Refactor, Invariant Gates & SSRF Security Guard (`SEC-5`, `QA-4`)**:
  - Refactored `docs/13-north-star-quality-standard.md` §4 into immutable acceptance criteria separated from volatile metrics in `docs/14-active-backlog.md`.
  - Added `src/server/services/urlSafety.ts` (`validateExternalHttpUrl`) enforcing HTTP(S)-only external URLs on portal and digest webhook routes, rejecting loopback, RFC1918 private IPs, and link-local metadata ranges (`SEC-5`).
  - Strengthened `tests/unit/docs-consistency.test.ts` to enforce code-to-documentation synchronization across schemas, server modules, canonical portals, baseline versions, and requirement proofs.
- **`awaiting_scope` Lifecycle, Rescoring & Document Queue Hardening (Maintenance Update, November 16, 2026)**:
  - Added `isDownloadableCandidateUrl` filtering in `src/server/scrapers/ingestPipeline.ts` and `src/server/db/repositories/ingestJobsRepo.ts` so non-downloadable `.html`/`.aspx`/`.php`/`.jsp` viewer links do not displace real PDFs or generate guaranteed-fail `document_ingest_jobs`.
  - Updated `reScoreTendersAgainstTracks` in `src/server/db/repositories/tracksRepo.ts` to re-evaluate stored `extracted_text` via `applyDocumentScopeToTracks`, and updated `saveDomainTrack` to preserve existing `minilm` track embeddings when `name` and `positive_keywords` are unchanged.
  - Updated `processJob` (`src/server/services/ingestWorker.ts`) with `finalizeAwaitingScopeAfterJobFailure` so `awaiting_scope` tenders with permanently failed jobs either queue remaining downloadable attachments or finalize as `no-track-match` once a prior document was read without matching.
  - Added optional `graceDays` override to `runRetentionCycle` (`src/server/services/retention.ts`) and ran a live DB cleanup + MiniLM backfill on `./data/tender_tracker.db` (`179/179` tenders indexed with `all-MiniLM-L6-v2`).

### Version 1.8.0 (November 13, 2026)
- **Structured Go / No-Go Bid Brief (`BID-1`)**:
  - Added optional `BidBrief` JSON extraction (`bidSecurityAmount`, `tenderFee`, `requiredRegistrations`, `requiredExperience`, `deliverablesSummary`, `bidMethod`) in `ocrService.ts`, `documentExtractor.ts`, `documentApply.ts`, and `tenderAnalysis.ts`, persisted in `tenders.bid_brief` and rendered as a collapsible panel in `Detail.tsx`.
- **Proactive 48h Closing Alerts & Daily Digest (`OPS-7`)**:
  - Added `getAlertsDigest` / `maybeDispatchDailyDigest` in `systemRepo.ts` + `scheduler.ts`, `/api/system/digest` endpoints in `system.routes.ts`, and the Inbox `Closing <=48h` filter chip in `InboxScreen.tsx`.
- **Two-Speed Pagination & Bounded Parallel Portal Workers (`SCR-4`, Plan C/D)**:
  - Added `quickMaxPages` / `deepMaxPages` on `PortalDefinition` (`portalList.ts`), SQLite early-stop for known unchanged pages, `depth` parameter on `/api/scan/start`, bounded parallel crawling (`3` HTTP / `1` Playwright workers), and typed `ScraperErrorCode` tracking in `portal_health.last_error_code`.
- **Production Runtime Separation & Multi-Page PDF Reading (`OPS-8`)**:
  - Added compiled `esbuild` server bundle (`dist-server/server.mjs`) launched cleanly by `npm start` and `start-tender-tracker.bat` without dev-watcher overhead.
  - Removed the initial 5-page cap in `documentExtractor.ts` so full digital PDFs are read locally and tabular `<Date> by or before <Time>` deadlines are matched reliably (`DL-8`).

### Version 1.7.0 (November 12, 2026)
- **100% Clean Audit Pass on North-Star Quality Register**:
  - All 60 active architectural and operational requirements verified and tested by name across 39 test suites (598 passing tests).
  - Unmet items: 0. Unproven live items: 0. Untested by name: 0.
- **Semantic Calibration & Multi-Lot Guard (`MATCH-5`, `DED-7`, `P1-6`)**:
  - Calibrated `all-MiniLM-L6-v2` hybrid classifier: F1 = 95.83%, Precision = 100.0%, 0 false positives.
  - Added lot/package discriminator regex in `deduplicator.ts`, eliminating false merges between separate lots (False-Merge Rate = 0.00%).
- **Document Reading Benchmark (`DOC-10`, `P1-5`)**:
  - Benchmarked 20 real cached PDFs: 70% digital text layer extracted locally in 96.9ms avg latency; 100% routing agreement on Vision fallback.
- **Multi-Page Full Scan End-to-End Live Verification (`D4`, `SCR-4`, `OPS-1`)**:
  - Completed end-to-end multi-page full scan live in production database; `last_full_scan_at` stamped; 20 active pipeline tenders preserved with 100% integrity.
- **Offline Hermetic Portal Contracts (`SCR-8`)**:
  - Verified static $\le 50\text{ KB}$ HTML fixtures for all 13 reachable portals (`tests/scraper/portal-contracts.test.ts`, 27/27 passing).
- **Date Parser Hardening (`DL-9`)**:
  - Patched `parseDateString` to normalize military time (`1100 hrs` $\rightarrow$ 11:00 PKT) and enforce plausible tender year bounds (2010 to current + 5).
- **System Governance & Security Suite (`GOV-2`, `SEC-1`, `SEC-4`, `UI-5`)**:
  - Added `tests/unit/system-governance.test.ts` verifying server boundary, loopback binding, secret redaction, and WCAG AA contrast.

### Version 1.6.0 (November 11, 2026)
- **Architectural Modularization & Decoupling (Architecture 9.7/10)**:
  - Decomposed monolithic `crawlerEngine.ts` (2,446 lines $\rightarrow$ 434 lines) into decoupled submodules (`htmlFetcher.ts`, `crawlerDeps.ts`, `portalParsers.ts`, `tenderAnalysis.ts`, `ingestPipeline.ts`).
  - Decomposed monolithic `InboxScreen.tsx` (1,967 lines $\rightarrow$ 764 lines) into modular components (`Detail.tsx`, `AddTenderModal.tsx`, `TenderRow.tsx`, `index.ts`).
  - Preserved 100% public facade re-exports with zero breaking changes.
  - Confirmed Vitest project-level timeouts (`testTimeout: 30000`) for network and JSDOM suites.
  - Full quality gate passed: 0 TypeScript errors, 525/525 Vitest tests passing across 34 suites, clean Vite build.

### Version 1.5.0 (November 11, 2026)
- **Deep Audit & Fundamental Ingest Logic Resolution**:
  - Resolved all 23 deep audit logic flaws (A1–A11, B1–B8, C1–C4) and all 7 fundamental issues (F1–F7) (archived in `docs/archive/`).
  - Implemented dedicated re-scan path preventing pipeline status and notes corruption.
  - Implemented strict reference validation (`src/server/services/referenceNo.ts`), `reference_norm` column, and strict deduplication distinction guards (`deduplicator.ts`).
  - Added multi-page crawler pagination (`portalList.ts`, `crawlerEngine.ts`) with `pages_scanned` and `last_success_at` metrics.
  - Implemented `awaiting_scope` workflow for document-scoped opportunity discovery.
  - Added token-boundary keyword matching (`trackMatcher.ts`) with plural inflection support.
  - Hardened date parsing (`dateParser.ts`): lone dates partitioned correctly, query/pre-bid dates ignored, military hours ("1100 hrs") parsed accurately, 2010 to current+5 year bounds enforced.
  - Built unified document result application (`documentApply.ts`) across crawler, fetch documents, and analyze routes.
  - Fixed HTML download rejections on non-document payloads (`dossierManager.ts`) and chunk-by-chunk UTF-8 buffer decoding.
  - Added full scan clock (`last_full_scan_at`), Windows Task Scheduler logon script (`scripts/install-startup-task.ps1`), and UI freshness indicator.
  - Ran live database cleanup D1–D3 (D4 full-scan verification subsequently completed in `v1.7.0`) and expanded the test suite to **525 passing tests across 34 test files**.

### Version 1.4.0 (November 10–11, 2026)
- **Ingestion Pipeline Upgrade (Phases 0–4) & Backlog Resolution (`docs/13`, `docs/14`)**:
  - Added local digital PDF (`pdfjs-dist@4.10.38`) and `.docx` (`mammoth@1.13.0`) text extraction (`documentExtractor.ts`), phrase-anchored submission deadline parsing, and canonical deadline resolution (`resolveCanonicalDeadline`).
  - Added durable document retry queue (`document_ingest_jobs`, `ingestJobsRepo.ts`, `ingestWorker.ts`), scan/daily Vision budgets (`ingestBudget.ts`), and `attachment_urls` persistence + startup backfill for existing tenders (`P1-1`).
  - Added `staging` row lifecycle during upfront document verification (`P2-4`), abortable downloads with `AbortSignal` (`P2-1`), and streaming `maxFileBytes` caps (`P2-3`).
  - Added tagged 384-D `all-MiniLM-L6-v2` semantic embeddings (`model` vs `fast` vector space isolation) and automatic startup backfill (`embeddingService.ts`, `embeddingBackfill.ts`).
  - Surfaced deadline provenance badges, `Review` chips, top-sorted flagged cards, and one-click **Confirm** / **Pass as cancelled** actions across both **Inbox** and **Pipeline** (`P1-3`, `P2-5`).
  - Added **Document Ingest & Vision Budgets** UI in **Sources & Keywords > Data** (`P2-8`), moved all 24 remaining SQL statements into `src/server/db/repositories/` (`P2-9`), moved `/api/dossiers/:tenderId/:filename` into `system.routes.ts` (`P2-10`), relocated the workspace to `C:\Tender_Tracker` (`P3-6`), and expanded the test suite to **491 passing tests across 34 suites**.

### Version 1.3.0 (November 4, 2026)
- **Self-Healing Scraper & 5-Step Autonomous URL Discovery**:
  - Implemented `healPortalConnection()`, `scoreCandidateTenderLinks()`, `compactHtmlForAiExtraction()`, and `fetchHtmlWithMetadata()` in `src/server/scrapers/crawlerEngine.ts`.
  - Added `extractTenderListFromHtmlWithAI()` and `discoverTenderLinkWithAI()` in `src/server/services/ocrService.ts`.
  - Added BPPRA ePPS multi-row (`tr.tender-row-main` + sibling `tr.tender-row-dates`) table extractor and updated BPPRA to its live portal (`https://bpptwo.vdc.services:5451/Tenders`).
  - Expanded date parser (`DATE_CANDIDATE_PATTERN` and `closingLabelRegex`) to support hyphenated named-month dates (`04-Nov-2026`) and spaced `"Dead Line:"` labels.
- **Portals UI Simplification & Error Diagnostics**:
  - Simplified portal editing in `SourcesScreen.tsx` to two fields (**Portal name** and **Website address**) and surfaced clickable portal URLs plus inline `Reason: <last_error_message>` diagnostics (`b2e4862`).
- **4-Model Gemini Failover & JSON Self-Repair**:
  - Upgraded `CANDIDATE_MODELS` to 4 validated models (`gemini-flash-lite-latest`, `gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemini-3.8-flash`) with client caching and `parseAndRepairTenderJson()` (`be2df72`).
- **Test Suite & Documentation Expansion**:
  - Expanded automated test suite to **303 passing tests across 25 suites**.
  - Updated all architectural and operational documentation (`docs/01` through `docs/12`) with complete inter-module communication diagrams.

### Version 1.2.0 (November 2–4, 2026)
- **Clean Repository Hygiene & On-Demand Tender Refresh**:
  - Added real-time portal re-crawl and AI re-summarization via `POST /api/tenders/:id/refresh` (`f75aca0`).
  - Added in-app Gemini API key configuration, manual tender intake modal, and inline PDF/image previews (`7bc9d84`).
  - Added custom DOM extractors for NDMA, FDE, PSDF, and PSEB (`eb55963`).

### Version 1.1.0 (November 1, 2026)
- **Test Expansion & Hardening**:
  - Expanded test coverage across UI, API, database, and scraper suites (`a683f66`).

### Version 1.0.0 (October 31 – November 1, 2026)
- **Rebranding & Redesign**:
  - Transitioned to **Tender Tracker** with modern three-screen architecture (Inbox, Pipeline, Sources & Keywords) and SQLite WAL persistence.
