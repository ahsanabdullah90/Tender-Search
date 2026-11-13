# 11. Configuration & Environment Reference

## Environment Variables

Tender Tracker supports the following environment variables (defined in `.env` or set in the operating system shell):

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | `number` | `3000` | Port on which the Express web server listens. |
| `HOST` | `string` | `127.0.0.1` | Network interface to bind. Defaults strictly to loopback for security. |
| `TENDER_DATA_DIR` | `string` | `<repo>/data` | Directory where SQLite database, backups, dossiers, and sessions reside. Set to `data-sample` for demo data. |
| `GEMINI_API_KEY` | `string` | `""` | Google Gemini API key fallback. Can also be set directly in the UI under Sources & Keywords > Data (persisted in SQLite `app_settings`). |
| `NODE_ENV` | `string` | `development` | Runtime mode (`development`, `production`, `test`). |

---

## Application Settings (SQLite `app_settings`)

In addition to environment variables, system-level budgets and operational flags are stored in SQLite and manageable through the UI (**Sources & Keywords > Data**):

| Setting Key | Default | Description |
|---|---|---|
| `gemini_api_key` | `""` | Google AI Studio API key for multimodal document OCR and text cross-checks. |
| `local_ocr_enabled` | `'true'` | Enables/disables offline `tesseract.js` + `@napi-rs/canvas` OCR fallback (`localOcrService.ts`) when Gemini Vision is unconfigured or over budget. |
| `ingest_upfront_time_budget_sec` | `300` | Maximum seconds allowed for upfront document fetching during a portal crawl. |
| `ingest_max_file_mb` | `25` | Maximum allowable document download size in megabytes. |
| `ingest_vision_calls_per_scan` | `20` | Maximum Gemini Vision OCR calls permitted within a single scan run. |
| `ingest_vision_calls_per_day` | `100` | Daily cap on Gemini Vision OCR calls across all scans and background workers. |
| `ingest_ai_text_calls_per_day` | `150` | Daily cap on Gemini text cross-check calls (`C3`). |
| `retention_auto_clean` | `'true'` | Enables/disables automated retention sweeps. |
| `retention_grace_days` | `2` | Days after closing date before unreviewed New Opportunities are auto-expired. |
| `retention_passed_days` | `10` | Days after being marked Passed before non-pipeline tenders are auto-retired. |
| `digest_enabled` | `'false'` | Enables/disables opt-in daily closing digest webhook delivery (`maybeDispatchDailyDigest`). |
| `digest_webhook_url` | `""` | Webhook endpoint URL for the daily digest (validated via `urlSafety.ts`, `SEC-5`). |
| `digest_within_hours` | `48` | Lookahead window in hours for urgent closing alerts (`getAlertsDigest`). |
| `digest_last_sent_pkt` | `null` | PKT calendar date (`YYYY-MM-DD`) when the last daily digest webhook succeeded. |
| `last_full_scan_at` | `null` | ISO timestamp of the last complete scan across all portals (`F5`). |
| `last_deep_scan_at` | `null` | ISO timestamp of the last completed `deep` multi-page scan (`scheduler.ts`). |

---

## Directory Structure

```
C:\Tender_Tracker/
  data/                     # Production data (NEVER touched by tests)
    tender_tracker.db       # Primary SQLite database
    tender_tracker.db-wal   # Write-Ahead Log buffer
    tender_tracker.db-shm   # Shared memory index
    backups/                # Automated (15-day rolling) and manual SQLite snapshots
    dossiers/               # Cached bidding documents (PDFs, images, docs)
    logs/                   # Last 3 session execution logs
    models/                 # Local HuggingFace MiniLM ONNX model cache
    tessdata/               # Offline Tesseract language traineddata cache
    sessions/               # Serialized session cookies from HITL portal sessions
  data-sample/              # Isolated sample data used for preview & demonstration
  dist/                     # Built Vite client bundle (served by Express in production)
  dist-server/              # Compiled server bundle (dist-server/server.mjs)
  public/                   # Brand logos (public/brand/) and favicons
  scripts/                  # Operational scripts (launch.cmd, seed-sample.ts, probe-portals.ts, capture-portal-fixture.ts, create-desktop-shortcut.ps1, install-startup-task.ps1, migrate-dossier-names.ts)
  src/                      # Application source code
    client/                 # React 19 UI application (App, theme, index.css, components/, ui/)
      components/           # UI screens (Inbox, Pipeline, Sources, AppShell, inbox/, pipeline/)
      ui/                   # Design system primitive UI components
    shared/                 # Isomorphic TypeScript domain types (types.ts)
    server/                 # Express backend, db/, routes/, scrapers/, services/
      db/                   # SQLite connection, schema migrations, and repositories/
      routes/               # Modular Express domain routers (tenders, portals, tracks, scan, system)
      scrapers/             # Modular scrapers (htmlFetcher, crawlerDeps, portalParsers, tenderAnalysis, ingestPipeline, healer, crawlerEngine, etc.)
      services/             # Domain services (deduplicator, documentExtractor, dossierManager, ocrService, localOcrService, urlSafety, embeddingService, ingestWorker, retention, scheduler, etc.)
  tests/                    # Full Vitest suite across node & jsdom runners
  docs/                     # Comprehensive architecture and operational documentation
```

---

## Startup Script

Double-clicking **`start-tender-tracker.bat`** (which invokes `scripts/launch.cmd`) handles production startup on Windows 11:
1. Verifies dependencies exist (`npm install` runs automatically if `node_modules` is absent) and builds `dist/` + `dist-server/server.mjs` (`npm run build`) if compiled bundles are missing.
2. Spawns a background browser launch to `http://localhost:3000`.
3. Runs **`npm start`** (`node dist-server/server.mjs --production`) for a fast, standalone server with zero dev-watcher overhead.

For active development with live TypeScript & Vite hot reloading, run **`npm run dev`** directly in PowerShell.
