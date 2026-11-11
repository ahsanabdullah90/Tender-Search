# 12. Architectural Decisions & Changelog

## Architectural Decision Records (ADRs)

### ADR 01: Single-Process Node/Vite Architecture
- **Context**: The application serves a single operator running locally on Windows 11.
- **Decision**: Avoid microservices or separate frontend/backend deployments. Host both Express API endpoints and the Vite development/production server within a single Node.js runtime.
- **Consequences**: Zero deployment complexity, instant local startup, direct access to the filesystem and SQLite database.

### ADR 02: SQLite with Write-Ahead Logging (WAL)
- **Context**: High concurrency during multi-portal scraping requires non-blocking database writes while the UI renders metrics.
- **Decision**: Use `better-sqlite3` with `PRAGMA journal_mode = WAL`.
- **Consequences**: Scraper threads insert and update records concurrently without database locks blocking the UI thread. Backups can be taken live using `VACUUM INTO`.

### ADR 03: Bigram Dice Similarity for Deduplication
- **Context**: The same government tender is frequently published across both Federal PPRA and provincial portals with minor spelling, punctuation, or formatting differences in the title.
- **Decision**: Calculate bigram Dice-coefficient similarity combined with exact reference number matching. If similarity exceeds 0.85, group under a single canonical tender.
- **Consequences**: Clean, unified Inbox with secondary source citations, eliminating duplicate notifications.

### ADR 04: Human-in-the-Loop (HITL) for Bot Protection
- **Context**: Automated solving of Cloudflare Turnstile or CAPTCHAs via third-party APIs introduces recurring costs and latency.
- **Decision**: Surface a one-click HITL browser launcher in the UI. The operator solves the challenge once, and harvested cookies allow headless scanning for weeks.
- **Consequences**: Completely resilient against modern Cloudflare protections with zero monthly API costs.

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
- **Context**: Every tender PDF used to be sent to Gemini Vision (slow, quota-heavy), a single attachment could delete a tender whose listing showed an extended deadline, and background downloads were fire-and-forget (lost on timeouts or restarts). See `docs/13-ingestion-pipeline-plan.md`.
- **Decision**:
  1. **Local text first.** `pdfjs-dist@4.10.38` (first 5 pages) and `mammoth@1.13.0` (`.docx`) read the text layer locally; deadlines are found only next to submission phrases. Gemini Vision is used only for documents with no text layer (scans, clippings, images), within per-scan (20) and per-day (100) budgets. `mammoth@1.9.0` was rejected for a directory-traversal advisory (GHSA-rmjr-87wv-gf87).
  2. **Deadline resolution** (`resolveCanonicalDeadline`): the later valid date wins; on the same day a document's time beats a listing's default 14:00; a corrigendum may move the deadline earlier but the tender is flagged for review (never auto-deleted on that basis); once a corrigendum sets the deadline, the original RFP cannot restore its date. Only an unambiguous document reading (one anchored date, AI agreement, or Vision) may auto-expire a tender.
  3. **Durable queue** (`document_ingest_jobs`, `ingestWorker.ts`): documents not read before insert are retried every 2 minutes with backoff, lease-based crash recovery, and no worker activity during scans.
- **Consequences**: Digital documents cost no Gemini quota; scans no longer block on slow portals; every deadline records where it came from (`deadline_source`, `deadline_confidence`) and the Inbox shows it.
- **Measured on 2026-11-10**: local reading took 100–250 ms per digital PDF on 3 of the 4 real dossiers on disk; the 4th was a scan, correctly routed to Vision. On the Gilgit notice it read the exact time (11:00 a.m.) where the listing had only the date. The planned 20-document Vision-vs-local agreement check could not be run: only 4 documents exist locally.

---

## Changelog

### Version 1.3.0 (November 4, 2026)
- **Self-Healing Scraper & 5-Step Autonomous URL Discovery**:
  - Implemented `healPortalConnection()`, `scoreCandidateTenderLinks()`, `compactHtmlForAiExtraction()`, and `fetchHtmlWithMetadata()` in `src/server/scrapers/crawlerEngine.ts`.
  - Added `extractTenderListFromHtmlWithAI()` and `discoverTenderLinkWithAI()` in `src/server/ocrService.ts`.
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
