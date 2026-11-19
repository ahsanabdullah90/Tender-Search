# 11. Configuration & Environment Reference

## Environment Variables

Tender Tracker supports the following environment variables (defined in `.env` or set in the operating system shell):

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | `number` | `3000` | Port on which the Express web server listens. |
| `HOST` | `string` | `127.0.0.1` | Network interface to bind. Defaults strictly to loopback for security. |
| `TENDER_DATA_DIR` | `string` | `<repo>/data` | Directory where SQLite database, backups, dossiers, and sessions reside. Set to `data-sample` for demo data. |
| `GEMINI_API_KEY` | `string` | `""` | Google Gemini API key fallback. Can also be set directly in the UI under Sources & Keywords > Data (persisted in SQLite `app_settings`). |
| `TENDER_SHUTDOWN_TOKEN` | `string` | `""` | Optional per-session secret injected by the desktop tray host to authorize `POST /api/system/shutdown`. When unset, the shutdown endpoint stays disabled (`403`). |
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
    app-profile/            # Isolated Edge/Chrome profile for standalone desktop app window
  data-sample/              # Isolated sample data used for preview & demonstration
  dist/                     # Built Vite client bundle (served by Express in production)
  dist-server/              # Compiled server bundle (dist-server/server.mjs)
  public/                   # Brand logos (public/brand/), favicons, and web app manifest (public/manifest.webmanifest)
  scripts/                  # Operational scripts (launch.cmd, tray-app.ps1, launch-desktop.vbs, seed-sample.ts, probe-portals.ts, capture-portal-fixture.ts, create-desktop-shortcut.ps1, install-startup-task.ps1, migrate-dossier-names.ts)
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

## Startup Scripts & Desktop Tray Host

Double-clicking **`Launch Tender Tracker.lnk`**, **`start-tender-tracker.bat`**, or running **`npm run desktop`** executes the standalone Windows desktop experience:
1. Verifies dependencies exist (`node_modules/` installs on fresh clones) and builds `dist/` + `dist-server/server.mjs` (`npm run build`) if compiled bundles are missing.
2. Launches `scripts/launch-desktop.vbs` via `wscript.exe` (zero console-window flash), which starts `scripts/tray-app.ps1`.
3. `scripts/tray-app.ps1` acquires a single-instance mutex (`Local\TenderTrackerTrayHost_3000`), injects a per-session `TENDER_SHUTDOWN_TOKEN`, spawns `node dist-server/server.mjs --production` hidden, shows a Windows System Tray icon (with scan actions, status polling, log/data shortcuts, deduplicated closing alerts, and clean `/api/system/shutdown` exit), and opens a standalone frameless `--app` window using **Microsoft Edge first** and **Google Chrome second** with an isolated `data/app-profile` directory.
4. Pass `--minimized` (used by `scripts/install-startup-task.ps1` at Windows logon) to start quietly in the tray without opening a window, or pass `--console` to `start-tender-tracker.bat` / `scripts/launch.cmd` for foreground terminal execution via `npm start`.

For active development with live TypeScript & Vite hot reloading, run **`npm run dev`** directly in PowerShell.
