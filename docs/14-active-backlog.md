# 14. Active Backlog & Next Steps

**Last updated:** 2026-11-13 · **System Baseline:** v1.9.0 (Plans A–F implemented: BidBrief, 48h Closing Alerts & Digest, Two-Speed Pagination, Parallel Portal Workers & `ScraperErrorCode`, Production Runtime Separation, and Offline `local_ocr` Fallback).

This document tracks **active operational items and approved non-breaking feature plans**. All historical investigations and completed fixes are archived in [`docs/archive/`](./archive/).

---

## 1. Portal Maintenance & Periodic Connector Monitoring

### Item 1: Connector & Session Monitoring
- **Active Regulatory Coverage (`10/10` online in live DB):**
  - `epads`: Open Federal EPADS v2.0 (`https://epads.gov.pk/`, `tier: 'http'`, `accessMode: 'public'`, 100 opportunities/page, `quickMaxPages: 3` / `deepMaxPages: 10`). Optional authenticated cookie support (`loginUrl: https://epads.gov.pk/login`) remains intact for operator downloads if needed.
  - `punjab_eproc`: Primary Punjab provincial source (`https://eproc.punjab.gov.pk/ActiveTenders.aspx`, ASP.NET postback pagination bumped to `quickMaxPages: 3` / `deepMaxPages: 10`), aggregating tenders across Punjab departments and authorities centrally.
- **Removed / Blocked Portals (`deleted_portals` in live DB; canonical entries retained in `PORTAL_DEFINITIONS` per `HEAL-7`):**
  - `kppra`: KP government portal migrated to EPADS (`kp.eprocure.gov.pk`), access-walled / timing out (`offline_broken`); archived out of active scans via `deletePortal`.
  - `sppra`: Sindh SPPRA (`portalsindh.eprocure.gov.pk`) returns a FortiWeb WAF block (`Attack ID: 20000051`) / HTTP timeout; archived out of active scans via `deletePortal`.
  - `psda`: Individual Punjab authority (`psda.punjab.gov.pk/tenders`) consistently displays `"No Opening"`; Punjab tenders are covered centrally via `punjab_eproc`, so `psda` was archived via `deletePortal`.
  - `gilgit`: `gilgitbaltistan.gov.pk` lacks a dedicated public tenders board (`offline_broken`); archived via `deletePortal`.

---

## 2. Planned Improvements (All Current Roadmap Plans A–F Completed)

All approved non-breaking improvement plans are implemented and moved to the Completed Register below.

---

## 3. Recently Completed Register Items (2026-11-11 – 2026-11-13)

- **Plans E & F Non-Breaking Rollout (`2026-11-13`):**
  - **Plan E (#6 — Separate Dev Watch vs. Production Runtime):** Added `esbuild` compiled server bundle (`npm run build:server` -> `dist-server/server.mjs`), updated `npm start` to execute pure Node with `--production`, fixed `PROJECT_ROOT` / `projectRoot` discovery across `src/server/db/connection.ts` and `server.ts`, added `TESSDATA_DIR` (`data/tessdata/`), and updated `scripts/launch.cmd` + `start-tender-tracker.bat` to auto-build if missing and run `npm start` instead of `npm run dev`.
  - **Plan F (#9 — Offline Local OCR Fallback):** Added `src/server/services/localOcrService.ts` (`tesseract.js` + `@napi-rs/canvas` PDF page rasterization capped at 3 pages, serialized OCR worker mutex, clean shutdown termination) and integrated it into Stage 2 of `src/server/services/documentExtractor.ts` as `extractionMethod: 'local_ocr'` whenever Gemini Vision is unconfigured, over budget, or returns `null`. Extracted text feeds SQLite FTS5 and deterministic extractors while keeping `canAutoExpire: false` (`DL-7`/`AI-3`).

- **Plans A–D Non-Breaking Feature Rollout (`2026-11-13`)**:
  - **Plan A (Structured "Go / No-Go" Bid Brief):** Extended Gemini extraction in `src/server/services/ocrService.ts`, `src/server/services/documentExtractor.ts`, `src/server/services/documentApply.ts`, and `src/server/scrapers/tenderAnalysis.ts` with optional `BidBrief` JSON (`bidSecurityAmount`, `tenderFee`, `requiredRegistrations`, `requiredExperience`, `deliverablesSummary`, `bidMethod`) persisted in `tenders.bid_brief` via `src/server/db/repositories/tendersRepo.ts` and rendered as a collapsible card in `src/client/components/inbox/Detail.tsx`.
  - **Plan B (Proactive 48h Closing Alerts & Daily Digest):** Added `getAlertsDigest` & `getDigestSettings`/`updateDigestSettings` in `src/server/db/repositories/systemRepo.ts`, REST endpoints `GET /api/system/digest` + `POST /api/system/digest/settings` in `src/server/routes/system.routes.ts`, opt-in once-per-PKT-day webhook dispatch (`maybeDispatchDailyDigest`) in `src/server/services/scheduler.ts`, and an Inbox `"Closing <=48h"` quick-filter toggle in `src/client/components/InboxScreen.tsx`.
  - **Plan C (Two-Speed Pagination + DB Early-Stop):** Added `quickMaxPages` / `deepMaxPages` on paginated portals in `src/server/scrapers/portalList.ts`, `depth` support on `POST /api/scan/start` (`src/server/routes/scan.routes.ts`) and `startCrawlerScan`/`scrapePortal` (`src/server/scrapers/crawlerEngine.ts`), SQLite early-stop on `page >= 2` when all items match known unchanged notices via `getKnownTenderMapForPortal`, and 24h deep-scan selection in `src/server/services/scheduler.ts`.
  - **Plan D (Bounded Concurrency Parallel Workers & Typed Error Taxonomy):** Extracted `scanSinglePortal` + `runWithConcurrency` in `src/server/scrapers/crawlerEngine.ts` (HTTP concurrency `3`, Playwright concurrency `1`), added `activePortals` / `scanDepth` tracking on `ScanStatus`, and classified failures via `classifyScraperError` into `portal_health.last_error_code` (`TIMEOUT`, `TLS_ERROR`, `CLOUDFLARE_HITL`, `LOGIN_REQUIRED`, `HTTP_4XX_5XX`, `PARSE_EMPTY`, `NETWORK_UNREACHABLE`).

- **EPADS v2.0 Open Federal Integration (`2026-11-13`)**:
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

- **Item 8 (Automated Documentation Check `QA-4`)**: Proven by `tests/unit/docs-consistency.test.ts` verifying all file paths, canonical portal count (18), and table schemas.

- **Item 9 (Measure Line Coverage `QA-2`)**: Measured baseline at 84.62% lines (82.84% statements, 81.67% functions, 73.59% branches) with per-submodule coverage exceeding 90% in repositories, deduplication, date parsing, and scrapers. Enforced via thresholds in `vitest.config.ts`.

---

## 3. Completed Design Specifications (from `docs/13` §7)

All four design specifications are completed and documented:
- **Crawler Submodule Layout**: Decomposed into `htmlFetcher.ts`, `crawlerDeps.ts`, `portalParsers.ts`, `tenderAnalysis.ts`, `ingestPipeline.ts` (`docs/02`).
- **Unified Portal Schema (`UnifiedPortalConfig`)**: Declarative selector & pagination configuration schema documented in `docs/05`.
- **`ingestion_status` Transitions**: Mermaid state diagram and retention invariants documented in `docs/06`.
- **Non-Goals & System Boundaries**: Explicit architectural constraints documented in `docs/01`.

---

## Historical References & Archived Audits
All resolved plans and completed audits have been moved to `docs/archive/` with full historical context:
- `docs/archive/13-ingestion-pipeline-plan.md`: Phases 0–4 ingestion pipeline implementation (Completed Nov 10).
- `docs/archive/15-fundamental-logic-issues.md`: Issues F1–F7 resolution details (Completed Nov 11).
- `docs/archive/16-deep-audit-logic-flaws.md`: Flaws A1–A11, B1–B8, C1–C4 deep audit (Completed Nov 11).
- `docs/archive/17-fix-checklist.md`: 128-point execution checklist (Completed Nov 11).
