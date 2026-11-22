# 10. Operator Guide

## Daily Workflow for Ahsan Abdullah

This guide outlines the day-to-day routine for managing and tracking tenders using **Tender Tracker**.

---

### 1. Starting the Application

On Windows 11:
- **Standalone Desktop App & System Tray (Recommended):** Double-click **`Launch Tender Tracker.lnk`**, your Desktop shortcut (create or refresh via `npm run shortcut`), **`start-tender-tracker.bat`**, or run **`npm run desktop`**.
  - Builds missing bundles if needed, starts the production server silently in the background (zero console window), and opens Tender Tracker in a dedicated frameless window (**Microsoft Edge first**, **Google Chrome fallback**) using an isolated `data/app-profile` directory.
  - Closing the app window leaves background scans and document ingestion running in the **Windows System Tray** icon:
    - **Double-click tray icon:** Re-open / focus the standalone Tender Tracker window.
    - **Right-click menu:** *Open Tender Tracker*, *Open in Default Browser*, *Run Quick Scan*, *Run Deep Scan*, *Recheck Network*, live status & network health summary, *Open Data Folder*, *Open Latest Log*, *Restart Server*, and *Quit Tender Tracker* (triggers token-guarded graceful shutdown with SQLite WAL flush).
    - **Desktop alerts:** Shows deduplicated Windows balloon notifications when tenders are closing within `<=48h`, have unacknowledged corrigenda, or when scans are paused/held due to offline or slow connectivity.
- **Foreground Console Fallback:** Run `start-tender-tracker.bat --console`, `scripts/launch.cmd --console`, or `npm start` to run the production server in a visible terminal window.
- **Optional Logon Auto-Start:** Run `scripts/install-startup-task.ps1` to launch quietly in the system tray (`--minimized`) at Windows logon without opening a window.
- **Development Mode (Hot Reload):** Run **`npm run dev`** in PowerShell.
- The local SQLite WAL database initializes in `./data/tender_tracker.db` on `http://127.0.0.1:3000`.

---

### 2. Configuring Google AI Studio (Gemini)

To enable automatic First-Look summaries, image/PDF OCR notice extraction, and Self-Healing AI DOM extraction:
1. Navigate to **Sources & Keywords > Data**.
2. Under **Google AI Studio (Gemini API)**:
   - Paste your Gemini API key.
   - Click **"Save Key"**.
3. Status will display as `Connected (••••) · Gemini Flash`.
4. The key is stored securely in your local `app_settings` SQLite table and powers the 4-model failover chain (`gemini-flash-lite-latest` $\rightarrow$ `gemini-3.1-flash-lite` $\rightarrow$ `gemini-3.5-flash` $\rightarrow$ `gemini-3.8-flash`).

---

### 3. Monitoring Morning Alerts & KPIs

When you open Tender Tracker:
1. **Human Verification (HITL) Banner**:
   If an amber alert appears at the top stating that a portal requires verification (e.g., Cloudflare challenge or session expiration):
   - Click **"Launch HITL Browser"**.
   - A browser window opens directly to the portal.
   - Complete the Cloudflare verification or log in.
   - Click **"I've finished"** to save harvested cookies and resume automated passes.
2. **Corrigenda Counter**:
   - Check the **Corrigenda** metric in the top KPI bar.
   - If greater than 0, tenders you are tracking have received deadline extensions or amendments.
   - Click the alert or filter by **Amended** to inspect modified closing dates.
3. **Network Status Indicator (Sidebar Footer)**:
   - Displays shape-distinct status icons alongside labels (`Healthy`, `Slow`, `Offline`), supports Windows High Contrast (Forced Colors) borders, links status details directly to disabled **Scan now** / **Deep** buttons via assistive descriptions, and announces connectivity transitions or scan pauses cleanly without 60s background poll chatter:
   - **`Healthy`**: Normal high-speed mode; both quick and deep scans as well as background PDF downloads run automatically.
   - **`Slow`**: Heavy tasks (**Deep** multi-page scans, upfront PDF downloads, and the background document queue) are automatically held until connectivity recovers to protect data integrity. Lightweight **Quick Scans** (**Scan now** / single-portal refreshes) still run serially with extended timeouts, and all local browsing/editing/searching continues unaffected. Deferred deep scans and document jobs resume automatically once connectivity returns to **Healthy**.
   - **`Offline`**: All network scans and document downloads pause cleanly without corrupting portal health or partial files; local Inbox/Pipeline review, search, notes, and backups remain available.
   - Click the inline **Recheck** button next to the indicator (or **Recheck Network** in the tray menu) to probe connectivity immediately after switching networks.

---

### 4. Reviewing the Inbox & Provenance Badges

The **Inbox** holds newly discovered opportunities that matched your domain keywords:
- **Deadline Provenance Badges**: Below the closing date, a badge shows where the deadline came from (`Verified from corrigendum`, `Verified from tender document`, `Portal listing date`, `No deadline · Portal HTML only`, or `Fetching documents in the background…`).
- **Operator Review Banner (`Review: ...`)**: Tenders flagged because a corrigendum or re-scan moved the deadline earlier, cancelled the notice, or suggested an uncertain past deadline appear at the top of the list with a red **Review** chip:
  - Click **Confirm** to clear the review flag and keep the tender.
  - Click **Pass** (or **Pass as cancelled** on cancelled notices) to move it to Passed.
- **Automatic Document Fetching & Live Processing Status**:
  - **Live Sidebar Queue Card**: Whenever documents are processing or queued (including unmatched background listings awaiting scope extraction), the sidebar displays exact live counts for **Active now** (tenders & files currently processing), **Inbox queue** (files & tenders), and **Scope queue** (files & listings).
  - **Per-Tender Processing Status**: Each tender card and detail panel (`Saved documents` & `Summary`) explicitly distinguishes **Actively processing**, **Queued in background (`N` file(s))**, **Processed (`N` saved)**, **Download failed (`Retry docs`)**, and **Portal listing only (no files provided)** so you never confuse a queued/processing tender with an empty portal notice.
  - **Immediate Post-Scan Download**: As soon as a portal scan finishes (and 4 seconds after app startup), the background worker immediately downloads bidding documents and notices automatically—prioritizing starred/tracked tenders first, then Inbox tenders closing soonest, ahead of unmatched background listings—and pushes live progress to the sidebar (`Downloading Inbox docs (N left)`).
  - **Instant Auto-Fetch on Open**: If you click into an open tender whose documents have not yet been reached by the background queue (`0` saved documents), Tender Tracker automatically pulls its stored attachment links or detail page (`epms_ppra`, `fde`, `punjab_eproc`) right away and displays them inline under **Saved documents** with **Preview PDF** / **Download** buttons—no need to open the portal in a browser to download files manually.
  - **Clean Document Naming**: Saved and downloaded files automatically use a standardized, human-readable filename format (`{PORTAL}_{Ref_or_Title}_{DocType}-{N}.{ext}`, e.g. `PPPRA_PEIMA-North-Zone_Bidding-Document-1.pdf`, `..._Corrigendum-1.pdf`), inferred from portal URLs and PDF headings (`Bidding-Document`, `Corrigendum`, `Tender-Notice`, `RFP`, `BOQ`, `TOR`, `Drawings`, `Clarification`).
  - **Manual Refresh / Retry**: Click **"Fetch Documents"** in the detail header to force a live re-check of the portal page at any time, or **"Retry document fetch"** if any download previously failed (`Could not fetch all documents`).
- **Filtering**: Use the FTS5-powered search bar (matches titles, agencies, references, and extracted PDF/DOCX text), the **`Closing <=48h`** quick-filter chip for urgent deadlines, or the **Filters** popover (domain tracks, bookmarked, amended, sort by closing soonest / newest).
- **Go / No-Go Bid Brief**: Open the collapsible **Bid Brief** card inside the tender detail panel to inspect bid security, tender fee, required registrations/experience, bid method, and deliverables extracted from EPMS detail pages or tender PDFs (`BID-1`).
- **Track this bid**: Moves the tender out of the Inbox and into your active **Pipeline** under `Under Review`.
- **Pass**: Archives the notice if it is not commercially viable (with an instant **Undo** toast).
- **Star (Bookmark)**: Pins high-priority opportunities so you never lose sight of them (bookmarked tenders are never auto-expired).
- **Refresh from Portal**: Click the refresh button in the detail view to re-crawl the live portal page in real-time and regenerate the AI summary.
- **Inline Editing**: Click **"Edit details"** to update title, reference number, deadline, budget, or scope directly in the app.

---

### 5. Adding Manual Tenders & Uploading Documents

For newspaper clippings, direct WhatsApp leads, or PDF tenders from external sources:
1. In the Inbox, click **"Add Tender"**.
2. **Auto-Fill from File / Clipping**:
   - Click **"Choose clipping / PDF notice to auto-fill"** and select a JPEG, PNG, or PDF.
   - Google AI Studio automatically parses the document, extracting title, procuring organization, reference number, deadline, estimated value, and scope.
3. Review and adjust any pre-filled fields.
4. Click **"Save Tender"**. The tender is immediately tracked in your Inbox and the uploaded document is cached in `./data/dossiers/`.

---

### 6. Working the Pipeline (Board & Gantt)

Switch to the **Pipeline** tab to manage active pursuits:
- **Kanban Board**: Drag or click tenders to advance through the stages:
  `Under Review` $\rightarrow$ `Preparing Bid` $\rightarrow$ `Submitted` $\rightarrow$ `Won`.
- **Deadline Progress Bars**: Visual indicator of time remaining before the bid closing deadline. Turns into a red danger bar within 24 hours of closing.
- **Gantt View**: Switch between **Board** and **Gantt** tabs to view submission deadlines (diamonds) and expected award result milestones (bars) over a 5-week timeline.
- **Tender Slide-over**: Click any card to open the detail panel:
  - Add private notes (pricing notes, team reminders).
  - Set **Result Expected Date**.
  - Preview attached PDFs and notice images directly inline or download them.

---

### 7. Managing Keywords, Portals & Data

Navigate to **Sources & Keywords**:
1. **Keywords Subtab**:
   - Add new domain tracks or customize positive and negative match terms.
   - Example: Add `inverter` or `photovoltaic` to *Solar & Clean Energy*; add `cleaning` or `janitorial` to the Ignore list.
   - **Organization Watchlist (`track-priority-orgs`)**: Tracks priority education, PPP, and TVET bodies (such as `PEF`, `PEIMA`, `SEF`, `PSDF`, `NAVTTC`, `TEVTA`s, `KPITB`, `BEF`, `NCHD`, `FDE`, `MOFEPT`, `Ignite`, `PSEB`, `HEC`) across all statutory portals while pairing strict negative exclusions for supply, civil works, solar, gas, uniforms, vehicles, and catering.
2. **Portals Subtab**:
   - Check the operational health, clickable website URL, and last scan yields of all 19 portals.
   - **Self-Healing Recovery**: If a portal moves its tenders sub-page or changes its HTML layout, the scraper automatically runs the 5-step discovery process during the scan and updates the portal URL.
   - **Explicit Diagnostics**: If a portal cannot be reached even after self-healing, the exact failure reason (`Reason: <error>`) is displayed in red below its URL.
   - **Streamlined Editing**: Click **"Edit"** on any portal to update its **Portal name** and **Website address** in a clean two-field dialog.
   - **Portal Login**: Enter your login credentials for **Tender Services Pakistan** (`https://tenderservice.pk/permits/login.php`).
3. **Data Subtab**:
   - **Document Ingest, Offline OCR & Vision Budgets**: View today's Gemini Vision usage, toggle offline `local_ocr` fallback (`local_ocr_enabled`), and configure the upfront scan time budget (seconds), maximum file size (MB), and Vision/text call caps per scan and per day.
   - **Daily Closing Digest Webhook**: Opt-in daily alert webhook (`digest_enabled`, `digest_webhook_url`, `digest_within_hours` default 48h) dispatching once per PKT day for urgent closings and unacknowledged corrigenda.
   - **CSV Export**: Export all bids, unreviewed inbox items, or active pipeline pursuits formatted with UTF-8 BOM for Microsoft Excel.
   - **Backups**: Create on-demand database snapshots (`data/backups/`).
   - **Saved Documents & Automated Retention**: Delete cached documents for passed tenders, run on-demand disk-to-DB file reconciliation (`Reconcile files on disk`), or configure automated background retention cleanup.
   - **Clear Inbox**: Safely removes unreviewed opportunities from the Inbox while strictly preserving active pipeline bids and starred bookmarks.
