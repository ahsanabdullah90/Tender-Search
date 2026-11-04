# 08. Testing Architecture & Coverage

## Test Tooling & Philosophy

Tender Tracker uses **Vitest v4** with V8 code coverage. The test suite maintains 288 tests across 25 suites organized into two isolated execution projects:
1. **`node` Project**: Tests pure TypeScript utilities, database operations, scraper extraction pipelines, Google AI/Gemini fallback logic, Express API routes, and schedulers in a Node.js runtime environment.
2. **`jsdom` Project**: Tests React 19 UI components, user interactions, theme switching, modal dialogs, inline previews, and slide-overs in a simulated DOM environment using `@testing-library/react`.

---

## Directory Layout

```
tests/
  setup/
    test-env.ts           # Test environment initialization
    node-setup.ts         # Temp directory database isolation & safety assertions
    jsdom-setup.ts        # JSDOM matchMedia mock & automatic afterEach(cleanup)
  unit/                   # Pure function tests (dates, deduplication, keywords, theme)
  db/                     # SQLite database queries, triggers, and audit logging
  scraper/                # Offline crawler engine, Playwright, auth, and Gemini OCR tests
  api/                    # Supertest HTTP integration tests against createApp()
  ui/                     # React Testing Library component tests
  fixtures/portals/       # Saved static HTML fixtures from real portals
```

---

## Safety & Isolation Guards

1. **`TENDER_DATA_DIR` Isolation**:
   Every database integration test generates an ephemeral temporary directory (e.g., `AppData/Local/Temp/tt-suite-temp-*`).
2. **Production Guard**:
   `tests/setup/node-setup.ts` validates that `TENDER_DATA_DIR` is set and does **not** resolve to the repository's production `data/` directory. If a test accidentally references `data/`, an immediate exception is thrown before any SQLite connection opens.
3. **Hermetic Offline Testing**:
   Scraper tests run against local static HTML fixtures in `tests/fixtures/portals/` or ephemeral local HTTP servers (`http://127.0.0.1:<port>`). No live internet connections are permitted in automated test runs.

---

## Running Tests & Coverage

```powershell
# Run all unit, scraper, API, and UI tests (288 passing tests)
npm test

# Run tests in watch mode during development
npm run test:watch

# Run tests with V8 coverage analysis
npm run test:coverage

# Run TypeScript type check
npm run lint

# Build production client bundle
npm run build

# Probe live connectivity against all 18 government procurement portals
npm run probe:portals
```
