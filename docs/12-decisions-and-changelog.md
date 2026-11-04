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

### ADR 05: Google AI Studio Multimodal Extraction & Model Fallback
- **Context**: Bidding documents in Pakistan are frequently published as low-resolution newspaper clipping scans, multi-page PDFs, or unformatted text blocks. Relying on a single model endpoint can encounter transient rate limits or quota variations.
- **Decision**: Integrate Google AI Studio via `@google/genai` using Candidate Model Fallback (`gemini-flash-lite-latest` $\rightarrow$ `gemini-3.8-flash`) with a 15-second timeout and strict JSON schema output. Support setting the API key both via environment variables and through the UI in the SQLite `app_settings` table.
- **Consequences**: Fast, high-accuracy document parsing and structured "First Look" summary briefs with zero single-model dependency.

### ADR 06: Zero-Loss Manual Tender & Dossier Intake
- **Context**: High-value opportunities often arrive via direct channels (WhatsApp, print newspapers, peer referrals) outside monitored web portals.
- **Decision**: Provide an Inbox "Add Tender" modal supporting drag-and-drop notice uploads, AI auto-fill, and manual editing, linking documents into `./data/dossiers/`.
- **Consequences**: Tender Tracker functions as a complete, centralized repository for all opportunities, automated or manual.

---

## Changelog

### Version 1.2.0 (November 2–4, 2026)
- **AI Model Resilience & Timeout Protection**:
  - Implemented candidate model fallback (`gemini-flash-lite-latest` and `gemini-3.8-flash`) in `ocrService.ts` with 15s timeout.
  - Resolved Vite middleware EPERM locking on Windows in test suites.
- **Clean Repository Hygiene**:
  - Removed obsolete generated test images, legacy mockups zip, redundant lockfiles, legacy AI Studio planning docs, and leftover sentinel database files.
  - Authored missing `docs/08-testing-and-coverage.md` and brought all architectural documentation into full alignment with the codebase.
- **On-Demand Tender Refresh**:
  - Added real-time portal re-crawl and AI re-summarization via `POST /api/tenders/:id/refresh` and Inbox UI button (`f75aca0`).
- **Google AI Studio Extraction & Manual Tender Intake**:
  - Added in-app Gemini API key configuration via Sources > Data (`app_settings` SQLite table).
  - Added multimodal image and PDF notice auto-fill extraction (`POST /api/ai/extract-file`).
  - Added manual tender intake modal with automatic track matching (`POST /api/tenders`).
  - Added manual attachment uploads (`POST /api/tenders/:id/attachments`) with inline PDF and image previews (`7bc9d84`).
- **Live Scraper Heuristics & Portal DOM Extractors**:
  - Custom DOM extractors added for NDMA (`.tender-card`), FDE (`h3.package-title`), PSDF (`.inner-advertisement-listing-box`), and PSEB.
  - Expanded date parser to support ordinal suffixes (`15th`), month name formats (`November 15, 2026`), and comma delimiters.
  - Filtered default portal names from track matching to eliminate false-positive matches on skills/education boards (`eb55963`).

### Version 1.1.0 (November 1, 2026)
- **Test Expansion & Hardening**:
  - Expanded test coverage across UI, API, database, and scraper suites to 288 passing tests across 25 suites.
  - Added Playwright browser HITL lifecycle tests, storage pruning tests, and crawler HTTP agent redirect validation (`a683f66`).

### Version 1.0.0 (October 31 – November 1, 2026)
- **Rebranding & Redesign**:
  - Transitioned to **Tender Tracker** with modern three-screen architecture (Inbox, Pipeline, Sources & Keywords).
  - Resolved all 13 legacy bugs (B1 through B13).
  - Implemented SQLite WAL persistence with rolling 14-day backups.
