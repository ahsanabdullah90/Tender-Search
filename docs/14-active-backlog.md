# 14. Active Backlog & Next Steps

**Last updated:** 2026-11-11 · **System Baseline:** v1.6.0 (583 passing tests across 39 suites, 84.62% line coverage, all re-scan and governance rules mirrored with unit tests).

This document tracks **only active, unresolved items** requiring operator input, live data accumulation, or portal-specific maintenance. All historical investigations and completed fixes are archived in [`docs/archive/`](./archive/).

---

## 1. Operator-Dependent Calibrations

### Item 1: Calibrate MiniLM Semantic Similarity Thresholds (`P1-6`) — satisfies `DED-7`, `MATCH-5`
- **Context:** The application uses 384-dimensional `all-MiniLM-L6-v2` embeddings for track matching and duplicate detection. Default cosine similarity thresholds (0.58 for track match, 0.88 for duplicate grouping) were initially set on synthetic vectors.
- **Action Required:** Operator to label:
  - ~50 sample tender↔track pairs as `Match` or `No Match`.
  - ~30 tender↔tender pairs as `Duplicate` or `Distinct`.
- **Done When:** Thresholds are tuned against the labeled set to meet the target in [`docs/13-north-star-quality-standard.md`](./13-north-star-quality-standard.md): $\text{F1} \ge 0.90$ with a false-merge rate of $0\%$.

### Item 2: Local PDF vs. Gemini Vision Agreement Benchmark (`P1-5`) — satisfies `DOC-10`
- **Context:** Local PDF text extraction (`pdfjs-dist`) runs in milliseconds at zero cost. Scanned notices fall back to Gemini Vision.
- **Action Required:** Once the background worker downloads and caches 20 diverse real PDFs from live crawls, run an offline comparison script evaluating field extraction agreement between local reading and Gemini Vision.
- **Done When:** Local reading agrees with Vision on deadline and reference for at least 18 of 20 PDFs (the `DOC-10` target), and findings are logged in `docs/12-decisions-and-changelog.md` (ADR 08).

---

## 2. Scraper & Connector Maintenance

### Item 3: Multi-Page Full-Scan End-to-End Verification (`D4`) — proves `SCR-4`, `OPS-1`
- **Context:** Unit tests, the live cleanup migrations (D1–D3), and re-scan pipeline test suites are done. The one full scan attempted so far was stopped partway through (during NDMA timeout retries). `last_full_scan_at` has never been written in the live database.
- **Action Required:** Snapshot stage, notes and dossier count for every Pipeline tender. Run `startCrawlerScan(undefined, true)` to completion, then compare against the snapshot.
- **Done When:** `last_full_scan_at` is populated in `app_settings` and all 11 Pipeline tenders remain untouched.

### Item 4: Update Selectors for Broken Portals
- **Portals:**
  - `kppra`: Page layout changed; returns 0 items. Needs updated table selector or Cheerio extractor.
  - `psda`: Currently displays `"No Opening"` or updated markup. Verify live DOM and tune selector.
  - `epads`: Requires active session. Operator can launch HITL browser modal from Sources screen to refresh session cookies.

### Item 5: Offline Portal Fixtures (`P3-4`) — satisfies `SCR-8`
- **Context:** Contract test suite (`tests/scraper/portal-contracts.test.ts`) covers 13 of 16 portals with hermetic $\le 50\text{ KB}$ HTML fixtures.
- **Action Required:** Capture static contract fixtures for `ungm` (requires Playwright session) and `kppra` once online.

---

## 3. Recently Completed Register Items (2026-11-11)

- **Item 6 (Source Health Reporting `HLT-3`, `HLT-5`)**: Proven in `tests/scraper/crawler.test.ts`. `last_success_at` is updated at the conclusion of every non-error scan.
- **Item 7 (Direct Tests for Re-scan & Governance `ID-1`, `DL-3`, `DL-4`, `GOV-6`)**: Proven by dedicated test suites: `tests/scraper/rescan-pipeline.test.ts`, `tests/scraper/healer-rules.test.ts`, `tests/unit/referenceNo.test.ts`, and `tests/unit/trackMatcher.test.ts`.
- **Item 8 (Automated Documentation Check `QA-4`)**: Proven by `tests/unit/docs-consistency.test.ts` verifying all file paths, canonical portal count (18), and table schemas.
- **Item 9 (Measure Line Coverage `QA-2`)**: Measured baseline at 84.62% lines (82.84% statements, 81.67% functions, 73.59% branches) with per-submodule coverage exceeding 90% in repositories, deduplication, date parsing, and scrapers. Enforced via thresholds in `vitest.config.ts`.

---

## 4. Completed Design Specifications (from `docs/13` §7)

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
