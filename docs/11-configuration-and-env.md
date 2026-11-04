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

## Directory Structure

```
Tender-Search/
  data/                     # Production data (NEVER touched by tests)
    tender_tracker.db       # Primary SQLite database
    tender_tracker.db-wal   # Write-Ahead Log buffer
    tender_tracker.db-shm   # Shared memory index
    backups/                # Automated (14-day rolling) and manual SQLite snapshots
    dossiers/               # Cached bidding documents (PDFs, images, docs)
    sessions/               # Serialized session cookies from HITL portal sessions
  data-sample/              # Isolated sample data used for preview & demonstration
  scripts/                  # Operational scripts (seed-sample.ts, probe-portals.ts)
  src/                      # Application source code
    components/             # React 19 UI screens (Inbox, Pipeline, Sources, AppShell)
    server/                 # Express backend, SQLite queries, scrapers, Gemini OCR
    ui/                     # Design system primitive UI components
  tests/                    # Full test suite (25 test suites, node & jsdom runners)
  docs/                     # Comprehensive architecture and operational documentation
```

---

## Startup Script

Double-clicking **`start-tender-tracker.bat`** handles startup on Windows 11:
1. Verifies dependencies exist (`npm install` run automatically if `node_modules` is absent).
2. Spawns background browser opening to `http://localhost:3000`.
3. Runs `npm run dev` to launch Express and Vite with live hot reloading.
