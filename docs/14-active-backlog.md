# 14. Active Backlog & Next Steps

**Last updated:** 2026-11-12 · **System Baseline:** v1.6.0 (576 passing tests across 38 streamlined suites, 84.6% line coverage, 0 uncalibrated requirements, 0 unproven live items).

This document tracks **only active, unresolved items** requiring operator input, live data accumulation, or portal-specific maintenance. All historical investigations and completed fixes are archived in [`docs/archive/`](./archive/).

---

## 1. Portal Maintenance & Periodic Connector Monitoring

### Item 1: Connector & Session Monitoring
- **Portals:**
  - `kppra`: KP government portal migrated to EPADS (`kp.eprocure.gov.pk`), catalog access mode set to `offline_broken` to prevent spurious timeouts until an automated or HITL connector is scheduled.
  - `psda`: Punjab Skills Development Authority portal is reachable; currently exhibits `"No Opening"` / empty table state when no RFPs are active.
  - `epads`: Federal EPADS requires active authenticated sessions. Operator can launch the HITL browser modal from the Sources screen to refresh session cookies.

---

## 2. Recently Completed Register Items (2026-11-11 / 2026-11-12)

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
