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

```
npm run seed:sample
```

Then start the app with the environment variable `TENDER_DATA_DIR=data-sample`. In PowerShell:

```
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
