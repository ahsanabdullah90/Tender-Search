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
- **Automated**: The scheduler creates daily rolling backups (`tender_tracker_YYYYMMDD.db`) and automatically prunes backups older than 14 days.
- **Manual**: Triggered on-demand via **Sources & Keywords > Data > Back up now** (`POST /api/backups`), creating snapshots named `tender_tracker_<timestamp>_manual.db`.
- **Location**: Backups reside safely in `./data/backups/`.
- **Mechanism**: Utilizes SQLite's atomic `VACUUM INTO` command, producing a zero-downtime, fully consistent point-in-time copy.

### Manual Backup Restoration
To restore from a backup:
1. Stop the application server:
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
5. Restart the server (`start-tender-tracker.bat` or `npm run dev`).

---

## Storage & Dossier Management

Bidding dossiers (PDFs, Word documents, scanned notices) are cached in `data/dossiers/<tenderId>/`.

### Storage Pruning
Over months of operation, passed tenders can accumulate hundreds of megabytes of cached files.
- The **Data** tab (`/api/storage`) displays total disk footprint and the storage used by passed bids.
- Clicking **"Delete files for passed tenders"** (`POST /api/dossiers/prune-passed`) deletes physical files from `data/dossiers/` for tenders marked `Passed`. The metadata records in the SQLite database are retained so notes and historical pricing intelligence remain accessible.

---

## Daily Operational Health Checklist

At the beginning of each business day:
1. **Launch Tender Tracker**: Double-click `start-tender-tracker.bat` or launch via npm (`npm run dev`).
2. **Review KPI Banner**:
   - Check if any portal has `hitl_required` (amber warning). If present, click "Launch HITL Browser", solve the challenge or sign in, and click "I've finished".
   - Check if any portal is in `error` state.
3. **Review Corrigenda**:
   - Check the KPI header for unacknowledged amendments. Click to inspect updated closing deadlines or modified scopes.
4. **Process New Opportunities**:
   - Review the Inbox. For viable tenders, click "Track this bid" to move to `Under Review`. Pass unwanted notices.
   - For paper clippings or outside leads, click **"Add Tender"** to create a manual notice or upload an image/PDF with AI auto-extraction.
5. **Update Pipeline**:
   - Update bid status, record proposal submission details, and note expected award dates.
