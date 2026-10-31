# Tender Tracker - Pakistan Procurement Watchdog

Autonomous procurement scout and opportunity command center monitoring 18 Pakistani statutory authorities, provincial PPRAs, federal ministries, skill development boards, and international agencies.

## Quick Start (Windows 11)

1. Double-click **`start-tender-tracker.bat`** (or run `npm install` followed by `npm run dev`).
2. Tender Tracker will initialize the local SQLite WAL database in `./data/tender_tracker.db` and launch the browser at `http://localhost:3000`.

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

- **Local-First & ISP Trust**: Operates locally on your machine to bypass government datacenter IP blocks.
- **SQLite WAL**: Zero-config persistence in `./data/tender_tracker.db` with daily rolling backups in `./data/backups/`.
- **Deduplication Engine**: Uses Dice bigram similarity and closing-date proximity to detect duplicate notices across provincial boards, PPRA, and newspapers.
- **Human-in-the-Loop (HITL)**: When a portal presents a CAPTCHA or Cloudflare challenge, Tender Tracker prompts you to launch a local browser session to resolve it.
- **Corrigenda Tracking**: Automatically monitors deadline changes and attachment updates.
- **UTF-8 BOM CSV Export**: Filter-aware export rendered cleanly for Microsoft Excel on Windows.

## Testing & Quality Assurance

```powershell
# Run all unit, scraper, API, and UI tests
npm test

# Run tests in watch mode
npm run test:watch

# Run test coverage analysis
npm run test:coverage

# Probe live connectivity for all 18 procurement portals
npm run probe:portals

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
