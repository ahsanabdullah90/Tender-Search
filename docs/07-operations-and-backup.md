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
- **Automated**: The scheduler or operator can trigger SQLite vacuum backups via `POST /api/backups/create`.
- **Location**: Backups are saved in `data/backups/` using the naming pattern:
  `backup-<ISO-TIMESTAMP>.sqlite` (e.g., `backup-2026-10-31T20-00-00Z.sqlite`).
- **Mechanism**: Utilizes SQLite's native backup API / `VACUUM INTO` command, producing a consistent snapshot while the server remains actively online.

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
   Copy-Item data/backups/backup-2026-10-31T20-00-00Z.sqlite data/tender_tracker.db
   ```
5. Restart the server (`npm run dev` or `npm start`).

---

## Storage & Dossier Management

Bidding dossiers (PDFs, Word documents, scanned notices) are cached in `data/dossiers/`.

### Storage Pruning
Over months of operation, passed tenders can accumulate hundreds of megabytes of cached files.
- The **Data** tab (`/api/storage`) displays total disk footprint and the storage used by passed bids.
- Clicking **"Delete files for passed tenders"** (`POST /api/storage/prune`) deletes physical files from `data/dossiers/` for tenders marked `Passed`. The metadata records in the SQLite database are retained so notes and historical pricing intelligence remain accessible.

---

## Daily Operational Health Checklist

At the beginning of each business day:
1. **Launch Tender Tracker**: Start via npm or the preview launcher (`H:\Tender-Search\.claude\launch.json`).
2. **Review KPI Banner**:
   - Check if any portal has `hitl_required` (amber warning). If present, click "Launch HITL Browser", solve the challenge or sign in, and click "Verify".
   - Check if any portal is in `error` state.
3. **Review Corrigenda**:
   - Check the KPI header for unacknowledged amendments. Click to inspect updated closing deadlines or modified scopes.
4. **Process New Opportunities**:
   - Review the Inbox. For viable tenders, click "Track this bid" to move to `Under Review`. Pass unwanted notices.
5. **Update Pipeline**:
   - Update bid status, record proposal submission details, and note expected award dates.
