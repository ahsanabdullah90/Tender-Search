# Tender Tracker - Pakistan Procurement Watchdog

Autonomous procurement scout and opportunity command center monitoring 18 Pakistani statutory authorities, provincial PPRAs, federal ministries, skill development boards, and international agencies.

## Quick Start (Windows 11)

Requires **Node.js 22+ (LTS)**.

1. Double-click **`Launch Tender Tracker.lnk`** (or **`start-tender-tracker.bat`**) — or run **`npm run desktop`** — to build if needed and launch the silent Windows System Tray host with a dedicated standalone Edge/Chrome window (**Microsoft Edge first**, **Chrome second**).
2. For a foreground terminal session use `start-tender-tracker.bat --console` (or `npm start`), or run `npm install` followed by `npm run dev` for development with Vite hot reloading.
3. Tender Tracker initializes the local SQLite WAL database in `./data/tender_tracker.db` at `http://127.0.0.1:3000`.

## The three screens

- **Inbox**: new tenders to review. Choose *Track this bid* to move one to the Pipeline, or *Pass* to set it aside.
- **Pipeline**: tenders you are working on, as a **Board** (Reviewing, Preparing bid, Submitted, Won) or a **Gantt** timeline. Passed tenders sit under *Passed and archived*.
- **Sources & Keywords**: domains and keywords, portal status, and data tools (export, backups, saved documents, erase).

The theme follows your computer by default. You can switch to Light or Dark in the sidebar.

## Trying it without touching real data

```powershell
npm run seed:sample
```

Then start the app with the environment variable `TENDER_DATA_DIR=data-sample`. In PowerShell:

```powershell
$env:TENDER_DATA_DIR="data-sample"; npm run dev
```

Sample data is kept in `./data-sample/`, separate from `./data/`.

## Architecture & Features

- **Local-First & ISP Trust**: Operates locally on your machine (`C:\Tender_Tracker`) to bypass government datacenter IP blocks.
- **SQLite WAL & Repository Governance**: Zero-config persistence in `./data/tender_tracker.db` with daily rolling backups in `./data/backups/` and strict domain repository encapsulation (`src/server/db/repositories/`).
- **Local-First Document Ingestion & Durable Queue**: Reads digital PDFs (`pdfjs-dist`) and Word `.docx` files (`mammoth`) locally in milliseconds at zero API cost, routes only scanned notices/images to Gemini Vision within configurable per-scan and daily budgets, and retries deferred downloads via `document_ingest_jobs`.
- **3-Tier Hybrid Deduplication & Semantic Matching**: Combines normalized reference numbers, Dice bigram similarity, and 384-dimensional `all-MiniLM-L6-v2` semantic embeddings (with tagged vector spaces) across provincial boards, PPRA, and newspapers.
- **Deadline Provenance & Operator Review Workflow**: Tracks where every closing date came from (`corrigendum_doc`, `primary_doc`, `html_row`, `manual`) and flags ambiguous, earlier-shifted, or cancelled notices (`needs_review`) across both Inbox and Pipeline with one-click **Confirm** and **Pass as cancelled** actions.
- **Human-in-the-Loop (HITL)**: When a portal presents a CAPTCHA or Cloudflare challenge, Tender Tracker prompts you to launch a local browser session to resolve it.
- **Network Health Monitor & Anti-Corruption Safeguards**: Classifies connectivity (`online`, `degraded`, `offline`), gates heavy tasks (deep multi-page scans, upfront PDFs, background document queue, `awaiting_scope` purges) while preserving serial quick scans, enforces 90s TLS socket ceilings and strict stream/atomic-file checks, and surfaces accessible live status + manual recheck controls in the sidebar and tray.
- **Standalone Desktop Window & Windows System Tray**: Launches silently via `Launch Tender Tracker.lnk` and `scripts/tray-app.ps1` into an isolated Edge/Chrome `--app` window (`data/app-profile/`) with tray scan/network controls, closing alerts, and token-guarded SQLite WAL shutdown.
- **UTF-8 BOM CSV Export**: Filter-aware export rendered cleanly for Microsoft Excel on Windows.

## Testing & Quality Assurance

```powershell
# Run full quality gate (TypeScript type-check + all unit/DB/scraper/API/UI suites + builds)
npm run verify

# Run all unit, scraper, API, and UI tests
npm test

# Run tests in watch mode
npm run test:watch

# Run test coverage analysis
npm run test:coverage

# Probe live connectivity for all 18 procurement portals
npm run probe:portals

# Launch standalone desktop window + Windows system tray
npm run desktop

# Refresh Windows Desktop shortcut pointing to C:\Tender_Tracker
npm run shortcut

# Type-check TypeScript
npm run lint

# Build production bundle
npm run build
```

## Documentation

Full architectural and operational documentation is available in the [`docs/`](./docs) directory:

- [01. Overview & Business Context](./docs/01-overview.md)
- [02. Architecture & Technology Stack](./docs/02-architecture-and-stack.md)
- [03. Database Schema & Tables](./docs/03-database-schema.md)
- [04. REST & SSE API Reference](./docs/04-api-reference.md)
- [05. Portals Catalog & Scraping Architecture](./docs/05-portals-and-scraping.md)
- [06. Bid Pipeline & Lifecycle](./docs/06-pipeline-and-workflow.md)
- [07. Operations, Backups & Maintenance](./docs/07-operations-and-backup.md)
- [08. Testing Architecture & Isolation](./docs/08-testing-and-coverage.md)
- [09. Known Bugs & Solutions (B1 to B13)](./docs/09-known-bugs-and-fixes.md)
- [10. Operator Guide for Daily Use](./docs/10-operator-guide.md)
- [11. Configuration & Environment Variables](./docs/11-configuration-and-env.md)
- [12. Architectural Decisions & Changelog](./docs/12-decisions-and-changelog.md)
- [13. Quality Standard & Requirements Register](./docs/13-north-star-quality-standard.md)
- [14. Active Backlog & Next Steps](./docs/14-active-backlog.md)
- [Historical Audits & Completed Plans](./docs/archive/) (Archived investigation logs, audit snapshots, and implementation plans)
