# Tender Tracker - Pakistan Procurement Watchdog

Autonomous procurement scout and opportunity command center monitoring 16+ Pakistani statutory authorities, provincial PPRAs, federal ministries, skill development boards, and international agencies.

## Quick Start (Windows 11)

1. Double-click **`start-tender-tracker.bat`** (or run `npm install` followed by `npm run dev`).
2. Tender Tracker will initialize the local SQLite WAL database in `./data/tender_tracker.db` and launch the browser at `http://localhost:3000`.

## Architecture & Features

- **Local-First & ISP Trust**: Operates locally on your machine to bypass government datacenter IP blocks.
- **SQLite WAL**: Zero-config persistence in `./data/tender_tracker.db` with daily rolling backups in `./data/backups/`.
- **Deduplication Engine**: Uses Dice bigram similarity and closing-date proximity to detect duplicate notices across provincial boards, PPRA, and newspapers.
- **Human-in-the-Loop (HITL)**: When a portal presents a CAPTCHA or Cloudflare challenge, Tender Tracker prompts you to launch a local browser session to resolve it.
- **Corrigenda Tracking**: Automatically monitors deadline changes and attachment updates.
- **UTF-8 BOM CSV Export**: Filter-aware export rendered cleanly for Microsoft Excel on Windows.
