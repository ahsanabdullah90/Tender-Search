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

---

## Changelog

### Version 1.0.0 (October 31 – November 1, 2026)
- **Rebranding**: Completed transition from legacy working name to **Tender Tracker** across the entire UI, codebase, and documentation.
- **Refactoring (Phase 0)**:
  - Extracted `parsePortalHtml()` from `crawlerEngine.ts` to enable hermetic offline unit testing.
  - Exported `createApp()` and `startServer()` in `server.ts` to allow Supertest API integration without premature port binding.
  - Extracted and unified `TENDER_STATUSES` constant across client, server, and schema.
- **Bug Fixes (Phases 1–6)**:
  - Resolved all 13 known bugs (B1 through B13) with test-first methodology.
  - Implemented Playwright graceful fallback (B1), scan awaiting (B2), startup watchdog for stuck portals (B3), Cloudflare challenge detection (B4), zero-yield diagnostics (B5), expired opportunity filter (B6), multi-date disambiguation (B7), strict status validation (B8), sessions directory configuration (B9), and Clear Inbox warning copy (B12).
- **Test Infrastructure**:
  - Implemented dual Vitest projects (`node` and `jsdom`).
  - Added 25 test suites containing 197 passing tests covering unit functions, SQLite repositories, scraper pipelines, Supertest API routes, and React components.
  - Implemented strict safety guard preventing tests from touching the production `data/` directory.
- **Documentation**:
  - Authored comprehensive documentation in `docs/` (`01-overview.md` through `12-decisions-and-changelog.md`).
  - Archived earlier redesign notes to [`docs/archive/REDESIGN-HANDOVER.md`](archive/REDESIGN-HANDOVER.md).
  - Updated root `README.md`.
