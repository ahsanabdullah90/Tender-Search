# 10. Operator Guide

## Daily Workflow for Ahsan Abdullah

This guide outlines the day-to-day routine for managing and tracking tenders using **Tender Tracker**.

---

### 1. Starting the Application

On Windows 11:
- Double-click **`start-tender-tracker.bat`** in the project directory, or run from PowerShell:
  ```powershell
  npm run dev
  ```
- The local SQLite WAL database initializes in `./data/tender_tracker.db` and launches the browser at `http://localhost:3000`.

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

---

### 4. Reviewing the Inbox

The **Inbox** holds newly discovered opportunities that matched your domain keywords:
- **Filtering**: Use the search bar or the **Filters** popover (domain tracks, bookmarked, amended, sort by closing soonest / newest).
- **Track this bid**: Moves the tender out of the Inbox and into your active **Pipeline** under `Under Review`.
- **Pass**: Archives the notice if it is not commercially viable.
- **Star (Bookmark)**: Pins high-priority opportunities so you never lose sight of them.
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
2. **Portals Subtab**:
   - Check the operational health, clickable website URL, and last scan yields of all 18 portals.
   - **Self-Healing Recovery**: If a portal moves its tenders sub-page or changes its HTML layout, the scraper automatically runs the 5-step discovery process during the scan and updates the portal URL.
   - **Explicit Diagnostics**: If a portal cannot be reached even after self-healing, the exact failure reason (`Reason: <error>`) is displayed in red below its URL.
   - **Streamlined Editing**: Click **"Edit"** on any portal to update its **Portal name** and **Website address** in a clean two-field dialog.
   - **Portal Login**: Enter your login credentials for **Tender Services Pakistan** (`https://tenderservice.pk/permits/login.php`).
3. **Data Subtab**:
   - **CSV Export**: Export all bids, unreviewed inbox items, or active pipeline pursuits formatted with UTF-8 BOM for Microsoft Excel.
   - **Backups**: Create on-demand database snapshots.
   - **Pruning**: Delete cached documents for passed tenders to free up hard drive space without losing tender history.
   - **Clear Inbox**: Safely removes unreviewed opportunities from the Inbox while strictly preserving active pipeline bids and starred bookmarks.
