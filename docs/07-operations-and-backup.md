# 07. Operations, Backups & Maintenance

## Production Data Protection Principles

The production operational environment contains Ahsan Abdullah's private bids, historical awards, and notes. The application enforces three iron rules:

1. **Strict Data Folder Boundary**:
   The live database lives in `data/tender_tracker.db`. Automated tests and seed scripts **never** access or mutate files in `data/`.
2. **Atomic Write-Ahead Logging (WAL)**:
   SQLite WAL ensures database integrity even during power outages or unexpected process terminations.
3. **No Irreversible Deletions Without Safe Confirmation**:
   The "Clear Inbox" routine purges only unreviewed `New Opportunity` items; active pipeline stages (`Under Review`, `Preparing Bid`, `Submitted`, `Won`) and starred bookmarks are strictly retained.

---

## Automated & Manual Database Backups

### Backup Creation
- **Automated**: The scheduler creates daily rolling backups (`tender_tracker_YYYYMMDD.db`) and automatically prunes backups older than 15 days.
- **Manual**: Triggered on-demand via **Sources & Keywords > Data > Back up now** (`POST /api/backups`), creating snapshots named `tender_tracker_<timestamp>_manual.db`.
- **Location**: Backups reside safely in `./data/backups/`.
- **Mechanism**: Uses the SQLite online backup API through `better-sqlite3` (`db.backup()` in `src/server/db/repositories/systemRepo.ts`). It copies the database while the app keeps running and produces a consistent copy.

### Manual Backup Restoration
To restore from a backup:
1. Stop the application cleanly so SQLite WAL checkpoints and closes:
   - **Desktop Tray Host:** Right-click the Tender Tracker tray icon and select **Quit Tender Tracker** (triggers graceful `/api/system/shutdown`).
   - **Console Fallback:** Press `Ctrl+C` in the terminal or terminate Node:
     ```powershell
     Get-Process -Name node | Stop-Process
     ```
2. Navigate to the `data/` directory.
3. Rename the current database:
   ```powershell
   Rename-Item tender_tracker.db tender_tracker.db.bak
   Remove-Item tender_tracker.db-wal, tender_tracker.db-shm -ErrorAction SilentlyContinue
   ```
4. Copy the chosen snapshot from `data/backups/`:
   ```powershell
   Copy-Item data/backups/tender_tracker_20261102.db data/tender_tracker.db
   ```
5. Restart the server (`start-tender-tracker.bat` / `npm start`, or `npm run dev` during development).

---

## Storage & Dossier Management

Bidding dossiers (PDFs, Word documents, scanned notices) are cached in `data/dossiers/<tenderId>/`.

### Storage Pruning, Automated Retention & Dossier Reconciliation
Over months of operation, passed and expired tenders can accumulate cached files.
- **Automated Retention Cycle (`src/server/services/retention.ts`)**: Runs every 5 minutes in the background (when enabled in **Sources & Keywords > Data**):
  1. **Passed Tender Slimming**: Purges cached dossier files from disk 2 minutes after a tender is marked `Passed`, while retaining the SQLite record for 10 days post-closing so Undo and historical notes keep working.
  2. **Expired Unreviewed Cleanup**: Auto-expires unreviewed, unbookmarked, unflagged `New Opportunity` rows after the configurable grace period (default 2 days past closing) and records them in `deleted_tenders`.
  3. **Aged-Out Undated Cleanup**: Retires undated, unreviewed notices 90 days after `COALESCE(publish_date, created_at)`.
  4. **Pending File Purges & Counter Cleanup**: Retries locked Windows file deletions (`pending_file_purges`) and prunes `ingest_vision_calls_YYYY-MM-DD` counters older than 7 days.
- **On-Demand Dossier Reconciliation (`POST /api/system/dossiers/reconcile`)**: Audits `data/dossiers/` against `cached_dossiers` in SQLite, removing orphan folders older than 60 minutes and pruning missing file references.
- **Document Ingest & Vision Budgets (`Sources & Keywords > Data`)**: Allows the operator to view daily Gemini Vision usage and adjust `upfrontTimeBudgetSec` (default 300s), `maxFileMb` (default 25 MB), `visionCallsPerScan` (default 20), and `visionCallsPerDay` (default 100).

---

## Daily Operational Health Checklist

At the beginning of each business day:
1. **Launch Tender Tracker**: Double-click **`Launch Tender Tracker.lnk`** (or **`start-tender-tracker.bat`** / **`npm run desktop`**) for the standalone window and system tray host, or run `npm run dev` during development.
2. **Check Network Status (Sidebar Footer)**:
   - Confirm the indicator shows **`Healthy`** (`Slow` pauses deep scans and background document queues while keeping quick scans available; `Offline` pauses all network tasks cleanly). Click **Recheck** if you just switched connections.
3. **Review KPI Banner**:
   - Check if any portal has `hitl_required` (amber warning). If present, click "Launch HITL Browser", solve the challenge or sign in, and click "I've finished".
   - Check if any portal is in `error` state.
4. **Review Corrigenda**:
   - Check the KPI header for unacknowledged amendments. Click to inspect updated closing deadlines or modified scopes.
5. **Process New Opportunities**:
   - Review the Inbox. For viable tenders, click "Track this bid" to move to `Under Review`. Pass unwanted notices.
   - For paper clippings or outside leads, click **"Add Tender"** to create a manual notice or upload an image/PDF with AI auto-extraction.
6. **Update Pipeline**:
   - Update bid status, record proposal submission details, and note expected award dates.
