# 10. Operator Guide

## Daily Workflow for Ahsan Abdullah

This guide outlines the day-to-day routine for managing and tracking tenders using **Tender Tracker**.

---

### 1. Starting the Application

From Windows PowerShell:
```powershell
cd H:\Tender-Search\Tender-Search
npm run dev
```
Or use the launch configuration configured in `.claude/launch.json` (`tender-sample` or `tender-sample-prod`).

Open your browser to: `http://localhost:3000` (or the configured `PORT`).

---

### 2. Monitoring Morning Alerts & KPIs

When you open Tender Tracker:
1. **Human Verification Banner**:
   If an amber alert appears at the top stating that a portal requires verification (e.g., Cloudflare challenge or login session expired):
   - Click **"Launch HITL Browser"**.
   - A browser window opens directly to the portal.
   - Complete the Cloudflare verification or log in.
   - Click **"Verify & Save Session"**.
2. **Corrigenda Counter**:
   - Check the **Corrigenda** metric in the top KPI bar.
   - If greater than 0, tenders you are tracking have received deadline extensions or amendments.
   - Click the alert to inspect the modified dates.

---

### 3. Reviewing the Inbox

The **Inbox** holds newly discovered opportunities that matched your domain keywords:
- **Filtering**: Use the search bar or domain filter pills (e.g., *Solar & Clean Energy*, *Construction*) to focus on specific categories.
- **Track this bid**: Moves the tender out of the Inbox and into your active **Pipeline** under `Under Review`.
- **Pass**: Archives the notice if it is not commercially viable.
- **Star (Bookmark)**: Pins high-priority opportunities so you never lose sight of them.

---

### 4. Working the Pipeline (Board & Gantt)

Switch to the **Pipeline** tab to manage active pursuits:
- **Kanban Board**: Drag or click tenders to advance through the stages:
  `Under Review` $\rightarrow$ `Preparing Bid` $\rightarrow$ `Submitted` $\rightarrow$ `Won`.
- **Gantt View**: Switch between **Board** and **Gantt** tabs to view submission deadlines and expected award result milestones over a 5-week timeline.
- **Tender Slide-over**: Click any card to open the detail panel:
  - Add private notes (pricing notes, team reminders).
  - Set **Result Expected Date**.
  - Download or view cached tender dossiers and attachments.

---

### 5. Managing Keywords & Portals

Navigate to **Sources & Keywords**:
1. **Keywords Subtab**:
   - Add new domain tracks or customize positive and negative match terms.
   - Example: Add `inverter` or `photovoltaic` to *Solar & Clean Energy*; add `cleaning` or `janitorial` to the Ignore list.
2. **Portals Subtab**:
   - Check the operational health and last scan yields of all 18 portals.
   - Enter your login credentials for **Tender Services Pakistan** (`https://tenderservice.pk/permits/login.php`).
3. **Data Subtab**:
   - Create on-demand database backups.
   - Prune cached documents for passed tenders to free up hard drive space.
   - Clear unreviewed opportunities from the Inbox safely without affecting active pipeline bids.
