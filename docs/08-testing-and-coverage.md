# 08. Testing Architecture & Coverage

## Test Tooling & Philosophy

Tender Tracker uses **Vitest v4** with V8 code coverage (`QA-1`–`QA-4` in [`13-north-star-quality-standard.md`](./13-north-star-quality-standard.md); `node` runner < 30s, full `npm run verify` gate < 60s, ≥ 80% line coverage across `src/`) organized into two isolated execution projects:
1. **`node` Project**: Tests pure TypeScript utilities, network health monitoring & transient-error gating (`networkMonitor.ts`), Pakistani date parsing & deadline reconciliation, local PDF/DOCX extraction (`documentExtractor.ts`), offline `tesseract.js` fallback (`localOcrService.ts`), external URL SSRF safety (`urlSafety.ts`), durable document queue & worker (`ingestJobsRepo.ts`, `ingestWorker.ts`), 3-tier deduplication & 384-D `all-MiniLM-L6-v2` tagged vector spaces, strict reference validation (`referenceNo.ts`), token-boundary matching (`trackMatcher.ts`), modular scrapers (`htmlFetcher.ts`, `portalParsers.ts`, `sppraApi.ts`, `bppraScraper.ts`, `tenderAnalysis.ts`, `ingestPipeline.ts`, and orchestrator `crawlerEngine.ts`), portal contract tests (`portal-contracts.test.ts`), `bppra-scraper.test.ts`, 7-rule guarded URL healer (`healer.ts`), 4-model Google Gemini failover & JSON repair logic, Express API routes, retention/reconciliation, automated doc-to-code sync (`docs-consistency.test.ts`), and schedulers.
2. **`jsdom` Project**: Tests React 19 UI components (`AppShell`, `InboxScreen`, `Detail`, `AddTenderModal`, `TenderRow`, `PipelineScreen`, `SourcesScreen`, `App`), sidebar network status indicator & scan gating, centralized polite/assertive live regions (`role="status"` / `role="alert"`), `aria-describedby` associations, ≥24px target sizing, `motion-safe` reduced-motion guards, Forced Colors Mode borders, deadline provenance badges, Go/No-Go `BidBrief` panels, review banners (`Confirm` / `Pass as cancelled`), ingest budget & digest controls, modal dialogs (`aria-modal`, `aria-labelledby`), inline previews, and slide-overs using `@testing-library/react`.

---

## Directory Layout

```
tests/
  setup/
    test-env.ts           # Test environment initialization
    node-setup.ts         # Temp directory database isolation & safety assertions
    jsdom-setup.ts        # JSDOM matchMedia mock & automatic afterEach(cleanup)
  unit/                   # Pure function tests (dates, networkMonitor, document extractor, deduplication, embeddings, keywords, theme, urlSafety, docs-consistency)
  db/                     # SQLite repositories, durable document_ingest_jobs queue, triggers, and audit logging
  scraper/                # Offline crawler engine, portal-contracts, ingest-queue, URL healer, Playwright, auth, and Gemini OCR tests
  api/                    # Supertest HTTP integration tests against createApp()
  ui/                     # React Testing Library component tests
  fixtures/
    portals/              # Sanitized static HTML fixtures (<= 50 KB each) + expected.json contracts
    documents/            # Programmatic synthetic PDF and .docx builders (buildFixtures.ts)
    calibration/          # Labeled evaluation datasets (trackMatchPairs.ts, duplicatePairs.ts)
```

---

## Safety & Isolation Guards

1. **`TENDER_DATA_DIR` Isolation**:
   Every database integration test generates an ephemeral temporary directory (e.g., `AppData/Local/Temp/tt-suite-temp-*`).
2. **Production Guard**:
   `tests/setup/node-setup.ts` validates that `TENDER_DATA_DIR` is set and does **not** resolve to the repository's production `data/` directory. If a test accidentally references `data/`, an immediate exception is thrown before any SQLite connection opens.
3. **Hermetic Offline Testing & 50 KB Fixture Cap**:
   Scraper and contract tests run against local static HTML fixtures in `tests/fixtures/portals/` (each verified $\le 50\text{ KB}$ and scrubbed of personal contact details) or programmatic PDF/DOCX buffers in `tests/fixtures/documents/buildFixtures.ts`. No live internet connections are required in automated test runs.

---

## Running Tests & Coverage

```powershell
# Run full quality gate: TypeScript typecheck, all Vitest suites, and production client/server builds
npm run verify

# Run all unit, db, scraper, API, and UI tests
npm test

# Run tests in watch mode during development
npm run test:watch

# Run tests with V8 coverage analysis
npm run test:coverage

# Run TypeScript type check
npm run lint

# Build production client and server bundles
npm run build

# Probe live connectivity against all 18 government procurement portals
npm run probe:portals
```
