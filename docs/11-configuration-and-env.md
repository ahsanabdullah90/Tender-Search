# 11. Configuration & Environment Reference

## Environment Variables

Tender Tracker supports the following environment variables (defined in `.env` or set in the operating system shell):

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | `number` | `3000` | Port on which the Express web server listens. |
| `HOST` | `string` | `127.0.0.1` | Network interface to bind. Defaults strictly to loopback for security. |
| `TENDER_DATA_DIR` | `string` | `<repo>/data` | Directory where SQLite database, backups, dossiers, and sessions reside. Set to `data-sample` for demo data. |
| `GEMINI_API_KEY` | `string` | `""` | Google Gemini API key required for Vision OCR analysis of scanned PDF corrigenda notices. |
| `NODE_ENV` | `string` | `development` | Runtime mode (`development`, `production`, `test`). |

---

## Directory Structure

```
Tender-Search/
  data/                     # Production data (NEVER touched by tests)
    tender_tracker.db       # Primary SQLite database
    tender_tracker.db-wal   # Write-Ahead Log buffer
    tender_tracker.db-shm   # Shared memory index
    backups/                # Automated and manual SQLite backup snapshots
    dossiers/               # Cached bidding documents (PDFs, docs)
    sessions/               # Serialized cookies from HITL portal sessions
  data-sample/              # Sample data used for preview & demonstration
  scripts/                  # Operational scripts (seed-sample.ts, probe-portals.ts)
  src/                      # Application source code
    components/             # React 19 UI components
    server/                 # Express backend, SQLite queries, scrapers, OCR
    ui/                     # Design system primitive UI components
  tests/                    # Full test suite (node & jsdom projects)
  docs/                     # Comprehensive architecture and operational documentation
```

---

## Launcher Configurations (`.claude/launch.json`)

Two predefined launcher configurations are available for development and preview:

1. **`tender-sample`**:
   Runs the development server using isolated sample data:
   ```json
   {
     "name": "tender-sample",
     "type": "node",
     "request": "launch",
     "runtimeExecutable": "npm",
     "runtimeArgs": ["run", "dev"],
     "env": {
       "TENDER_DATA_DIR": "data-sample",
       "PORT": "3000"
     }
   }
   ```

2. **`tender-sample-prod`**:
   Runs the built production client bundle against sample data.
