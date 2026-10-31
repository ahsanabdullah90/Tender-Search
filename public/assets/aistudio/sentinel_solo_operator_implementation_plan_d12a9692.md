# AI Agent Build Specification: Sentinel (Solo-Operator Local Edition)

> **AGENT DIRECTIVE:** You are building **Sentinel**, a local-first, full-stack procurement and tender monitoring command center engineered to run on a single operator's personal laptop (Windows/macOS) over a Pakistani residential/office ISP connection. Follow every architectural constraint, database schema definition, and UI rule in this specification strictly. Do not introduce multi-user authentication, remote WebSocket browser streaming (noVNC), or external SMTP email servers.

---

## 1. System Overview & Target Environment

**Sentinel** is an autonomous, human-paced procurement scout and opportunity pipeline manager for 16+ Pakistani statutory authorities (Federal PPRA EPADS, Punjab eProc, Sindh SPPRA, KPPRA, BPPRA), federal/provincial ministries (MOFEPT, FDE, NDMA, PID), skill funds (PSDF, PSDA, Ignite, PSEB), and international development agencies (UNGM, GIZ).

### Core Architectural Pillars (Solo Laptop Optimization)
1. **Local Execution & Native ISP Trust**: Runs locally on `http://localhost:3000`. All outbound requests originate from the operator's genuine Pakistani ISP IP, bypassing `.gov.pk` foreign datacenter geo-blocks.
2. **Hybrid Scraper Engine (Playwright Persistent Context + Fast HTTP)**:
   - **Tier 1 (Playwright Stealth)**: For SPA/JS-heavy and WAF-protected portals (PPRA EPADS, UNGM, Punjab eProc, SPPRA). Uses `playwright-extra` + stealth plugin with persistent disk contexts (`./data/sessions/{portalId}`). Launches sequentially, scrapes, and closes to keep RAM usage low.
   - **Tier 2 (HTTP + Cheerio + Tolerant TLS)**: For static HTML sites (Ignite, PSEB, NDMA, FDE, MOFEPT). Uses custom HTTPS agents (`rejectUnauthorized: false`) to survive expired `.gov.pk` SSL certificates.
3. **Native Local Window HITL Bridge (`headless: false`)**: When a portal triggers a CAPTCHA, Cloudflare Turnstile, or 2FA challenge, Sentinel pauses that portal's queue, triggers an OS desktop notification + Crimson UI alert banner, and provides a **"Launch Local Browser to Verify"** button. Clicking it opens a visible Chrome window (`headless: false`) directly on the user's laptop using the portal's persistent profile (`./data/sessions/{portalId}`). Once the user solves the CAPTCHA and closes/saves, background headless polling resumes automatically.
4. **Local Multi-File Dossier Caching + SHA-256 Hashing**: Every discovered tender notice, RFP PDF, BOQ, or newspaper clipping image is downloaded immediately to `./data/dossiers/{tenderId}/` with a computed `sha256` hash. The UI serves local files first to guarantee offline access and protection against government portal downtime.
5. **Gemini Vision OCR Pipeline**: Scanned newspaper clippings and image-based gazettes (PID, Daily Dawn/Jang ads, BPPRA/FDE image notices) are passed asynchronously to the **Gemini 2.5 Flash API** (`@google/genai`) with structured JSON output to extract reference numbers, issuing authorities, and closing dates without blocking the Node.js event loop.
6. **SQLite Persistence in WAL Mode (`better-sqlite3`)**: Zero-config single-file database at `./data/sentinel.db` with `PRAGMA journal_mode = WAL;`. Daily safe backups use `db.backup('./data/backups/sentinel_YYYYMMDD.db')`.
7. **Startup Catch-Up Scheduler**: Instead of requiring 24/7 server uptime, Sentinel checks `last_scan_at` on boot and every 30 minutes while the laptop is awake. If the last scan was $>12\text{ hours}$ ago (or missed today's PKT window), it automatically initiates a non-blocking background scan.

---

## 2. Directory & File Structure

```text
sentinel/
├── data/
│   ├── sentinel.db                # SQLite WAL database
│   ├── backups/                   # Rolling 14-day safe SQLite backups
│   ├── dossiers/                  # Cached PDFs, BOQs, and scanned images by {tenderId}
│   └── sessions/                  # Playwright persistent browser profiles by {portalId}
├── src/
│   ├── server/
│   │   ├── db.ts                  # better-sqlite3 initialization, schema, WAL & backup logic
│   │   ├── scheduler.ts           # Startup catch-up scheduler & human-jitter queue manager
│   │   ├── deduplicator.ts        # Trigram/Levenshtein (>85%) + date proximity matcher
│   │   ├── ocrService.ts          # Gemini 2.5 Flash Vision structured extraction for image notices
│   │   ├── dossierManager.ts      # File downloader, SHA-256 hash calculator, local static server
│   │   └── scrapers/
│   │       ├── baseScraper.ts     # Shared pacing (4.0s-8.5s jitter), header & error handlers
│   │       ├── playwrightEngine.ts# Persistent context manager & headless:false HITL launcher
│   │       ├── httpEngine.ts      # Cheerio + SSL-tolerant HTTP fetcher
│   │       └── portals/           # 16 portal-specific adapter modules
│   └── client/
│       ├── App.tsx                # High-density SaaS Command Center UI
│       ├── components/
│       │   ├── KpiHeader.tsx      # Metrics strip, Live Scan trigger, HITL & Corrigendum banners
│       │   ├── TrackFilterBar.tsx # Dynamic domain track pills + keyword search
│       │   ├── TenderTable.tsx    # 40px high-density table view with tabular-nums countdowns
│       │   ├── TenderKanban.tsx   # Drag-and-drop status board
│       │   ├── TenderDrawer.tsx   # Slide-over detail drawer, local dossier viewer, notes
│       │   ├── TrackManagerModal.tsx # Add/Edit Domain Tracks & Positive/Negative keywords
│       │   └── PortalHealthModal.tsx # 16-portal status grid + "Launch Local Browser" HITL button
├── server.ts                      # Express API + Vite middleware entry point
├── package.json
└── .env                           # GEMINI_API_KEY
```

---

## 3. Database Schema (`better-sqlite3`)

Initialize `./data/sentinel.db` with the following exact schema and pragmas in `src/server/db.ts`:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- 1. Core Tenders Table
CREATE TABLE IF NOT EXISTS tenders (
  id TEXT PRIMARY KEY,                     -- Deterministic hash: portalId + refNo + normalizedTitle
  canonical_id TEXT NOT NULL,              -- Groups duplicates across PPRA & aggregators
  reference_no TEXT,
  title TEXT NOT NULL,
  organization TEXT NOT NULL,
  portal_id TEXT NOT NULL,
  portal_name TEXT NOT NULL,
  direct_url TEXT NOT NULL,
  secondary_sources TEXT DEFAULT '[]',     -- JSON: [{ portalName, directUrl, discoveredAt }]
  domain_tracks TEXT NOT NULL DEFAULT '[]',-- JSON array of matched track names (supports multi-track overlap)
  matched_keywords TEXT NOT NULL DEFAULT '[]', -- JSON array of matched positive keywords
  match_score INTEGER DEFAULT 0,           -- 0 to 100
  publish_date TEXT,
  closing_date TEXT,                       -- ISO string or NULL if "Not Available"
  closing_date_formatted TEXT,             -- "14 Nov 2026, 02:00 PM PKT" or "Not Available"
  estimated_value TEXT,
  location TEXT,
  description TEXT,
  cached_dossiers TEXT DEFAULT '[]',       -- JSON: [{ label, localPath, originalUrl, mimeType, sha256 }]
  has_corrigendum INTEGER DEFAULT 0,       -- 0 or 1
  pipeline_status TEXT DEFAULT 'New Opportunity', -- 'New Opportunity' | 'Under Review' | 'Preparing Bid' | 'Submitted' | 'Won' | 'Passed'
  status_notes TEXT DEFAULT '',
  is_bookmarked INTEGER DEFAULT 0,
  viewed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenders_canonical ON tenders(canonical_id);
CREATE INDEX IF NOT EXISTS idx_tenders_status ON tenders(pipeline_status);
CREATE INDEX IF NOT EXISTS idx_tenders_closing ON tenders(closing_date);

-- 2. Corrigendum & Delta Alert Logs
CREATE TABLE IF NOT EXISTS corrigendum_logs (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL,
  change_type TEXT NOT NULL,               -- 'deadline_extension' | 'scope_revision' | 'attachment_update'
  previous_value TEXT,
  new_value TEXT,
  is_acknowledged INTEGER DEFAULT 0,       -- 0 = Active Alert Banner, 1 = Dismissed by Operator
  detected_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

-- 3. Solo Status History Log
CREATE TABLE IF NOT EXISTS pipeline_audit_logs (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

-- 4. Dynamic User-Configurable Domain Tracks
CREATE TABLE IF NOT EXISTS domain_tracks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  positive_keywords TEXT NOT NULL,         -- JSON array of strings
  negative_keywords TEXT NOT NULL,         -- JSON array of strings (exclusions)
  is_active INTEGER DEFAULT 1
);

-- 5. Portal Operational Health & Watchdog
CREATE TABLE IF NOT EXISTS portal_health (
  portal_id TEXT PRIMARY KEY,
  portal_name TEXT NOT NULL,
  category TEXT NOT NULL,                  -- 'Regulatory' | 'Federal/Regional' | 'Tech & Skills' | 'Multilateral' | 'Aggregator'
  tier TEXT NOT NULL,                      -- 'playwright' | 'http'
  base_url TEXT NOT NULL,
  tenders_url TEXT NOT NULL,
  status TEXT DEFAULT 'online',            -- 'online' | 'scanning' | 'hitl_required' | 'selector_broken' | 'error'
  last_scan_at TEXT,
  last_items_found INTEGER DEFAULT 0,
  consecutive_zero_yields INTEGER DEFAULT 0,
  last_error_message TEXT
);
```

### Default Seed Data for `domain_tracks`
Pre-populate on first database boot if `domain_tracks` is empty:
1. **Construction & Civil Works**:
   - *Positive*: `["construction", "civil works", "renovation", "rehabilitation", "infrastructure", "masonry", "building repair", "prefabricated"]`
   - *Negative*: `["software", "janitorial"]`
2. **Solar & Clean Energy**:
   - *Positive*: `["solar", "solarization", "pv system", "photovoltaic", "inverter", "net metering", "clean energy", "hybrid solar"]`
   - *Negative*: `["solar geyser repair"]`
3. **Education & Learning**:
   - *Positive*: `["education", "curriculum", "textbooks", "learning material", "school supplies", "classroom", "literacy", "edtech", "teacher training"]`
   - *Negative*: `[]`
4. **Vocational Training (TVET)**:
   - *Positive*: `["tvet", "vocational", "skill development", "technical training", "capacity building", "youth skills", "apprenticeship", "employability"]`
   - *Negative*: `[]`
5. **Stationery & Office Supplies**:
   - *Positive*: `["stationery", "office supplies", "printing", "paper rim", "toner", "cartridge", "office equipment", "consumables"]`
   - *Negative*: `[]`
6. **Media, Documentaries & Communications**:
   - *Positive*: `["documentary", "media production", "video production", "digital communications", "animation", "short film", "advocacy campaign", "awareness campaign", "public relations", "audio visual", "event management"]`
   - *Negative*: `["cctv", "surveillance camera", "security camera"]`

---

## 4. Core Backend Specifications

### A. Human-Paced Scraper Engine & Native HITL Handover
1. **Request Pacing & Headers**:
   - Enforce a strict serial queue per portal (`concurrency = 1`).
   - Inject randomized human reading delay between `4000ms` and `8500ms` (`Math.floor(Math.random() * 4500) + 4000`) between page navigations.
   - Use modern desktop Chrome headers (`Accept-Language: en-US,en;q=0.9,ur;q=0.8`) and maintain contextual `Referer` chains.
2. **Playwright Lifecycle (`src/server/scrapers/playwrightEngine.ts`)**:
   - Use `chromium.launchPersistentContext('./data/sessions/' + portalId, { headless: true, viewport: { width: 1366, height: 768 } })`.
   - Always close the context cleanly in a `finally` block after scraping a portal so Chromium processes never leak memory on the user's laptop.
   - **CAPTCHA / 2FA Detection**: If response status is `403`, or DOM matches `iframe[src*="challenges.cloudflare.com"]`, `#captcha`, `input[name*="captcha"]`, or login redirect:
     - Update `portal_health.status = 'hitl_required'`.
     - Trigger native OS notification using `node-notifier` (or UI audio/visual alert): *"Action Needed: Solve CAPTCHA for {portalName}"*.
     - Expose `POST /api/portals/:portalId/hitl-launch`: When clicked in the UI, launch `chromium.launchPersistentContext('./data/sessions/' + portalId, { headless: false })` and navigate to `tenders_url`. Wait for the user to solve the challenge and close the browser window (or click "Verify Session" in the UI), then mark `status = 'online'` and immediately re-queue that portal.
3. **Selector Drift Watchdog**:
   - If a portal returns `0` total raw tenders on 3 consecutive scans (`consecutive_zero_yields >= 3`), automatically set `portal_health.status = 'selector_broken'` and surface an alert in the UI so silent government website redesigns never go unnoticed.

### B. Local Dossier Caching & SHA-256 Corrigendum Detection
1. When a tender is scraped and matches at least one active domain track (or if the user clicks "Download Dossier" on any tender):
   - Create directory `./data/dossiers/{tenderId}/`.
   - Download all linked PDFs, Word docs, Excel BOQs, or JPG/PNG gazette images using the active session cookies and SSL-tolerant agent.
   - Compute `crypto.createHash('sha256').update(buffer).digest('hex')`.
   - Save metadata to `tenders.cached_dossiers`.
2. **Corrigendum Diffing Engine**:
   - When re-scraping an existing tender:
     - **Deadline Change**: If `new.closing_date !== existing.closing_date`, update `closing_date`, set `has_corrigendum = 1`, and insert a row into `corrigendum_logs` (`change_type: 'deadline_extension'`, `is_acknowledged: 0`).
     - **Silent File Replacement**: If a newly downloaded attachment has a different `sha256` hash than the previously cached file at that label/URL, save the new file alongside the old one (`_v2.pdf`), set `has_corrigendum = 1`, and log `change_type: 'attachment_update'`.

### C. Gemini Vision OCR Pipeline (`src/server/ocrService.ts`)
- Whenever a tender notice attachment is an image (`.jpg`, `.jpeg`, `.png`, `.webp`) or when a portal row lacks an HTML closing date/reference number and provides a scanned newspaper clipping:
  - Send the image buffer to `gemini-2.5-flash` using `@google/genai` with `responseMimeType: "application/json"` and `responseSchema`:
    ```json
    {
      "referenceNo": "string or null",
      "organization": "string",
      "title": "string",
      "closingDateISO": "YYYY-MM-DDTHH:mm:ss or null",
      "closingDateFormatted": "string or 'Not Available'",
      "estimatedValue": "string or null",
      "summaryScope": "string",
      "isCorrigendum": "boolean"
    }
    ```
  - Merge extracted fields into the tender record before keyword scoring.

### D. Fuzzy Trigram Deduplication (`src/server/deduplicator.ts`)
- Government tenders frequently appear on both the originating ministry website (e.g., MOFEPT, FDE), Federal PPRA EPADS, and aggregator boards with slightly different reference numbers.
- Before inserting a new tender, query existing active tenders where `ABS(julianday(closing_date) - julianday(:newClosingDate)) <= 1` (or where both have `closing_date IS NULL` published within 5 days of each other).
- Compute string similarity (Dice's Coefficient / Trigrams) on normalized `organization + " " + title`.
- If similarity $\ge 0.85$:
  - Do **not** create a duplicate row.
  - Append `{ portalName, directUrl, discoveredAt }` to the existing canonical tender's `secondary_sources` JSON array and merge any newly discovered dossier attachments.

### E. Safe SQLite WAL Backup & Catch-Up Scheduler
- **Safe Daily Backup**: On startup (if last backup is $>24\text{h}$ old), execute `await db.backup('./data/backups/sentinel_' + YYYYMMDD + '.db')`. Prune backup files older than 14 days. Never use `fs.copyFileSync` on an active WAL database.
- **Catch-Up Scheduler**: On server start, check `MAX(last_scan_at)` from `portal_health`. If null or $>12\text{ hours}$ ago, automatically start a background scan across all active portals.

---

## 5. REST API Endpoints (`server.ts`)

- `GET /api/tenders`: Returns filtered tenders (`?track=`, `?status=`, `?search=`, `?bookmarked=`, `?corrigendumOnly=`).
- `PATCH /api/tenders/:id/status`: Updates `pipeline_status` and `status_notes`, and records a timestamped entry in `pipeline_audit_logs`.
- `PATCH /api/tenders/:id/bookmark`: Toggles `is_bookmarked`.
- `POST /api/corrigenda/:id/acknowledge`: Sets `is_acknowledged = 1` on a corrigendum alert.
- `GET /api/dossiers/:tenderId/:filename`: Streams the locally cached PDF/image from `./data/dossiers/` with appropriate `Content-Type` headers so it opens natively in the browser tab.
- `POST /api/scan/start`: Triggers an immediate background scan (all portals or specific `portalId`) and streams progress via Server-Sent Events (`GET /api/scan/stream`).
- `POST /api/portals/:portalId/hitl-launch`: Launches the local visible Playwright Chrome window (`headless: false`) for CAPTCHA/2FA resolution.
- `GET /api/tracks` & `PUT /api/tracks`: CRUD operations for dynamic Domain Tracks and positive/negative keyword lists.
- `GET /api/export/csv`: Generates and downloads a UTF-8 BOM CSV file of the current filtered tender view.

---

## 6. Frontend UI & UX Specifications

### Aesthetic & Layout Rules
- **Theme**: High-density SaaS operations console. Deep Slate dark mode (`#0F172A` canvas, `#1E293B` elevated surfaces, `#334155` subtle 1px hairline borders) with a clean toggle for Crisp Light mode (`#F8FAFC` canvas, `#FFFFFF` surfaces, `#E2E8F0` borders).
- **Typography**: `Inter` for UI/titles; `JetBrains Mono` (`font-mono tabular-nums`) for Reference Numbers, Match Scores, and Countdown Timers.
- **Semantic Status Colors**:
  - Emerald (`#16A34A`): Active / Won / Healthy Portal
  - Amber (`#D97706`): Closing $<48\text{h}$ / Corrigendum Alert / Under Review
  - Crimson (`#DC2626`): Closing $<24\text{h}$ / HITL Captcha Required / Selector Broken
  - Blue (`#2563EB`): Preparing Bid / Primary Interactive Controls
  - Slate (`#64748B`): Passed / Deadline `"Not Available"`

### Required Views & Components
1. **Top Command Bar & Alert Strip**:
   - **5 KPI Cards**: *Active Tracked Tenders*, *Closing in $<72\text{h}$*, *In Bid Pipeline (`Under Review` + `Preparing Bid`)*, *Unacknowledged Corrigenda*, *Portal Health (`X/16 Online`)*.
   - **Conditional Action Banners**:
     - If any portal has `status === 'hitl_required'`, display a high-visibility Crimson banner: *"CAPTCHA / Verification Required on [Portal Name]"* with a 1-click **"Open Local Browser to Solve"** button.
     - If any tender in `Under Review` or `Preparing Bid` has an unacknowledged corrigendum (`is_acknowledged === 0`), display an Amber banner showing the exact delta (e.g., *"Deadline extended from 10 Nov to 18 Nov on [Tender Title]"*) with an **"Acknowledge"** button.
2. **Dynamic Domain Track Bar & Controls**:
   - Segmented filter bar dynamically rendered from `domain_tracks` (`All`, `Construction`, `Solar`, `Education`, `TVET`, `Stationery`, `Media & Documentaries`, plus any user-added track).
   - Instant client-side search box (filters by Title, Organization, Reference #).
   - View Switcher (**High-Density Table** vs. **Kanban Pipeline**), **Manage Tracks** modal button, **Export CSV** button, and **Run Live Scan** button (with live portal progress indicator).
3. **High-Density Table View (`TenderTable.tsx`)**:
   - Compact `40px` row height for rapid scanning.
   - Columns: *Bookmark Star*, *Ref # (`font-mono`)*, *Title & Organization (with Corrigendum badge & Secondary Source count tooltip)*, *Matched Track(s) & Keywords (clean `·` separated text)*, *Deadline Countdown (`tabular-nums` or subtle `"Not Available"` badge)*, *Local Dossier Quick-Open Icon*, and *Inline Pipeline Status Select Dropdown*.
4. **Kanban Board View (`TenderKanban.tsx`)**:
   - 6 columns: `New Opportunity`, `Under Review`, `Preparing Bid`, `Submitted`, `Won`, `Passed`.
   - Cards show Organization, Title, Deadline timer, Corrigendum badge, and quick status transition buttons.
5. **Slide-Over Tender Detail Drawer (`TenderDrawer.tsx`)**:
   - Opens when clicking any tender row/card.
   - **Offline-Safe Dossier Viewer**: Lists all locally cached attachments (`cached_dossiers`) with SHA-256 verification badges and **"Open Local PDF / Image"** buttons alongside the original government URL.
   - **Corrigendum Delta Timeline**: Shows any historical deadline extensions or replaced BOQ files.
   - **Solo Operator Notes & Status History**: Auto-saving textarea for bid preparation notes and a chronological log of status changes.

---

## 7. Local Laptop Setup & Launch Script

Ensure `package.json` includes a streamlined setup and start flow so the solo operator can launch Sentinel with a single double-click on their desktop:

```json
{
  "scripts": {
    "setup": "npm install && npx playwright install chromium",
    "dev": "tsx server.ts",
    "start": "NODE_ENV=production tsx server.ts"
  }
}
```
Include a root `start-sentinel.bat` (for Windows) and `start-sentinel.command` (for macOS) that starts the server and automatically opens `http://localhost:3000` in the default system browser.