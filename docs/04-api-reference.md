# 04. API Reference

All backend routes are mounted under the `/api` prefix via `src/server/routes/index.ts` and organized into five domain route controllers under `src/server/routes/`:
- `tenders.routes.ts`
- `portals.routes.ts`
- `tracks.routes.ts`
- `scan.routes.ts`
- `system.routes.ts`

The server responds with `application/json` unless streaming files or Server-Sent Events.

---

## 1. Tenders & Pipeline Management

### `GET /api/tenders`
Returns a list of all active opportunities.
- **Query Parameters**:
  - `status` *(optional)*: Filter by pipeline status (`New Opportunity`, `Under Review`, `Preparing Bid`, `Submitted`, `Won`, `Passed`).
  - `track` *(optional)*: Filter by matched domain track.
  - `portal` / `portalId` *(optional)*: Filter by originating portal identifier (`epms_ppra`, `punjab_eproc`, etc.).
  - `search` *(optional)*: FTS5 prefix + semantic fallback text query matched against title, organization, reference number, description, and extracted PDF/DOCX text (`extracted_text`).
  - `bookmarkedOnly` *(optional, `true`\|`false`)*: Filter starred items.
  - `corrigendumOnly` *(optional, `true`\|`false`)*: Filter tenders with active unacknowledged amendments.
  - `unreadOnly` *(optional, `true`\|`false`)*: Filter unviewed opportunities.
  - `excludeExpired` *(optional, `true`\|`false`)*: Exclude tenders whose closing deadline is already in the past. *(Note: Inbox's `Closing <=48h` filter evaluates `closing_date` client-side alongside `GET /api/system/digest?hours=48`.)*
- **Response**: `200 OK` array of tender objects (including parsed `bid_brief` when structured Go/No-Go brief fields are available, plus live per-tender queue job counts `doc_jobs_pending`, `doc_jobs_processing`, `doc_jobs_done`, `doc_jobs_failed`).

### `GET /api/tenders/portal-summary`
Returns grouped non-expired active tender counts per portal (`getPortalTenderSummary()`).
- **Response**: `200 OK` array of `{ portal_id, portal_name, count }`.

### `GET /api/tenders/:id`
Retrieves a single tender by its unique identifier.
- **Response**: `200 OK` or `404 Not Found`.

### `DELETE /api/tenders/:id`
Deletes a single tender record and adds it to `deleted_tenders` with `reason = 'user'` so future crawls do not re-import it.
- **Response**: `200 OK` (`{"success": true, "deleted": 1, "id": "..."}`) or `404 Not Found`.

### `POST /api/tenders`
Creates a manual tender entry with automatic domain track matching and optional file attachment.
- **Request Body**:
  ```json
  {
    "title": "Supply of IT Equipment",
    "organization": "National University of Technology",
    "reference_no": "NUTECH-2026-IT",
    "portal_name": "Newspaper Notice",
    "direct_url": "https://example.com/notice",
    "closing_date": "2026-11-20 14:00",
    "estimated_value": "PKR 15,000,000",
    "location": "Islamabad",
    "description": "Procurement of laptops, switches, and interactive displays.",
    "fileBase64": "data:image/jpeg;base64,...",
    "filename": "clipping.jpeg",
    "mimeType": "image/jpeg"
  }
  ```
- **Response**: `201 Created` (`{"success": true, "tender": {...}}`).

### `PATCH /api/tenders/:id`
Updates editable fields on a tender record.
- **Request Body**:
  ```json
  {
    "title": "Updated Tender Title",
    "organization": "Updated Org",
    "reference_no": "REF-001",
    "closing_date": "2026-12-01",
    "estimated_value": "PKR 25,000,000",
    "location": "Lahore",
    "description": "Updated scope details."
  }
  ```
- **Response**: `200 OK` (`{"success": true, "tender": {...}}`).

### `PATCH /api/tenders/:id/status`
Updates the pipeline status of a tender.
- **Request Body**:
  ```json
  {
    "status": "Under Review",
    "notes": "Reviewed specifications; viable commercial opportunity."
  }
  ```
- **Validation**: Must be one of the six valid `TENDER_STATUSES`:
  - `New Opportunity`
  - `Under Review`
  - `Preparing Bid`
  - `Submitted`
  - `Won`
  - `Passed`
- **Response**: `200 OK` or `400 Bad Request`.

### `PATCH /api/tenders/:id/notes`
Saves operator notes on a specific tender.
- **Request Body**: `{"notes": "Follow up with procurement officer."}`
- **Response**: `200 OK`.

### `PATCH /api/tenders/:id/result-date`
Sets or clears the expected award announcement date.
- **Request Body**: `{"date": "2026-06-30"}` (or `null` to clear).
- **Response**: `200 OK`.

### `PATCH /api/tenders/:id/bookmark`
Toggles the starred/bookmarked state.
- **Response**: `200 OK` with updated status.

### `PATCH /api/tenders/:id/viewed`
Marks the tender as viewed/read.
- **Response**: `200 OK`.

### `POST /api/tenders/:id/refresh`
Re-fetches the live portal page in real-time, extracts updated text, detects new attachments, and runs AI re-summarization if Gemini is configured.
- **Response**: `200 OK` (`{"success": true, "tender": {...}, "message": "..."}`). If the documents show the deadline has passed and the tender was auto-expired: `200 OK` (`{"success": true, "expired": true, "id": "...", "message": "..."}`); the Inbox removes the row. `404` only for an unknown tender.

### `POST /api/tenders/:id/analyze`
Triggers on-demand analysis of the tender's cached documents (read locally first; Gemini Vision only for scans and images) or text.
- **Response**: `200 OK` (`{"success": true, "tender": {...}}`), the same `expired: true` response as `/refresh`, or `400 Bad Request` if the API key is not configured.

### `POST /api/tenders/:id/fetch-documents`
Downloads the tender's documents from known `attachment_urls` and/or its portal detail page, reconciles matching `document_ingest_jobs` (`status = 'done'`) and `doc_fetch_status`, and reads the downloaded files.
- **Request Body** *(optional)*:
  - `forceRefresh` *(boolean, default `true`)*: When `false`, short-circuits immediately if `cached_dossiers` is already non-empty (reconciling pending queue jobs) and deduplicates concurrent in-flight requests for the same tender (`Detail.tsx` auto-fetch on view uses `forceRefresh: false`; clicking **Fetch Documents** forces a fresh portal check).
- **Response**: `200 OK` (`{"success": true, "tender": {...}, "dossiers": [...], "newlyFetched": n}`) or `{"success": true, "expired": true, "id": "..."}` when the documents show the deadline has passed.

### `PATCH /api/tenders/:id/review`
Confirms a tender flagged for review (`needs_review = 1`, e.g. a corrigendum moved the deadline earlier). Clears the flag.
- **Body**: `{"action": "confirm"}`.
- **Response**: `200 OK` (`{"success": true, "tender": {...}}`), `400` for any other action, `404` for an unknown tender.

### `POST /api/tenders/:id/retry-documents`
Re-queues the tender's failed document downloads (fresh attempts) and runs the background worker.
- **Response**: `200 OK` (`{"success": true, "requeued": n, "tender": {...}, "message": "..."}`).

### `POST /api/tenders/:id/attachments`
Uploads a manual file attachment (PDF, image, document) to an existing tender and optionally runs AI OCR extraction.
- **Request Body**:
  ```json
  {
    "filename": "newspaper_advert.png",
    "mimeType": "image/png",
    "base64Data": "data:image/png;base64,...",
    "label": "Tender Notice Clipping",
    "runAi": true
  }
  ```
- **Response**: `200 OK` (`{"success": true, "tender": {...}, "attachment": {...}, "aiExtracted": true}`).

### `POST /api/tenders/clear`
Clears unreviewed inbox opportunities or performs a full wipe.
- **Request Body**:
  ```json
  {
    "unreviewedOnly": true
  }
  ```
  - When `unreviewedOnly: true`: Deletes unreviewed `New Opportunity` items; active pipeline stages and bookmarked records are preserved.
  - When `unreviewedOnly: false`: Deletes all tenders.
- **Response**: `200 OK` with confirmation message.

### `GET /api/export/csv`
Downloads a CSV export formatted with UTF-8 BOM for Microsoft Excel.
- **Query Parameters**:
  - `scope` *(optional)*: `'inbox'` (unreviewed), `'pipeline'` (active bids in work), or omit for all.
  - `track`, `status`, `search`, `bookmarkedOnly`, `corrigendumOnly`.
- **Response**: `200 OK` with `Content-Type: text/csv; charset=utf-8`.

---

## 2. Google AI Studio (Gemini API) Integration

### `GET /api/ai/status`
Returns the current Gemini configuration state, masked API key, and active model.
- **Response**: `200 OK`
  ```json
  {
    "configured": true,
    "maskedKey": "AIza••••1234",
    "model": "Gemini Flash (Multi-Model Failover)"
  }
  ```

### `POST /api/ai/config`
Saves or clears the Google AI Studio API key in the `app_settings` SQLite table.
- **Request Body**: `{"apiKey": "AIzaSy..."}` (or `""` / `null` to clear).
- **Response**: `200 OK` (`{"success": true, "configured": true, "maskedKey": "..."}`).

### `POST /api/ai/extract-file`
Extracts structured tender fields (organization, title, reference number, closing date, scope summary, corrigendum flag) from an uploaded image or PDF document.
- **Request Body**:
  ```json
  {
    "base64Data": "data:image/jpeg;base64,...",
    "mimeType": "image/jpeg"
  }
  ```
- **Response**: `200 OK` (`{"success": true, "extracted": {...}}`) or `422 Unprocessable Entity`.

---

## 3. Corrigenda & Amendments

### `GET /api/corrigenda`
Returns all logged amendments and scope revisions.
- **Query Parameters**:
  - `unacknowledged` *(optional, boolean)*: If `true`, returns only unread changes.
- **Response**: `200 OK` array of `CorrigendumLog` records.

### `POST /api/corrigenda/:id/acknowledge`
Acknowledges and clears an amendment alert.
- **Response**: `200 OK` (`{"success": true}`).

---

## 4. Portals, Health & Authentication

### `GET /api/portals`
Returns health metrics, access modes, and configuration for all active procurement portals.
- **Response**: `200 OK` array of `PortalHealth` records.

### `POST /api/portals`
Adds a new custom procurement portal to SQLite. URLs are validated by `validateExternalHttpUrl` (`urlSafety.ts`, `SEC-5`), rejecting non-`http:`/`https:` schemes, embedded credentials, loopback (`localhost`, `127.0.0.1`), RFC1918 private IPs, and link-local/metadata ranges (`400 Bad Request`).
- **Request Body**:
  ```json
  {
    "portal_name": "Punjab Municipal Development Fund",
    "tenders_url": "https://pmdfc.punjab.gov.pk/tenders",
    "base_url": "https://pmdfc.punjab.gov.pk",
    "category": "Regulatory",
    "tier": "http",
    "access_mode": "public"
  }
  ```
- **Response**: `201 Created` (`{"success": true, "portal": {...}}`) or `400 Bad Request`.

### `DELETE /api/portals/:portalId`
Deletes a procurement portal from active monitoring and records it in `deleted_portals` so it is not re-seeded.
- **Response**: `200 OK` (`{"success": true, "portal_id": "...", "message": "..."}`).

### `PUT /api/portals/:portalId`
Updates portal settings (name, website URL, base URL, tier, access mode). Enforces strict origin normalization on `base_url` and `SEC-5` external URL safety (`validateExternalHttpUrl`).
- **Request Body**:
  ```json
  {
    "portal_name": "Updated Portal Name",
    "tenders_url": "https://example.gov.pk/tenders",
    "base_url": "https://example.gov.pk"
  }
  ```
- **Response**: `200 OK` (`{"success": true, "message": "Portal updated successfully"}`) or `400 Bad Request`.

### `POST /api/portals/:portalId/reset-default`
Resets a modified portal's URL, access mode, and tier back to canonical baseline values in `PORTAL_DEFINITIONS`.
- **Response**: `200 OK` (`{"success": true, "message": "Reset ... to official default URL"}`).

### `POST /api/portals/:portalId/heal`
Triggers operator-requested autonomous URL healing (`healPortalConnection`) on a portal to rediscover its tenders page.
- **Response**: `200 OK` (`{"success": true, "baseUrl": "...", "tendersUrl": "...", "itemsFound": n}`).

### `GET /api/portals/:id/credentials`
Retrieves saved credentials metadata for a portal (e.g., `tender_services`).
- **Response**: `200 OK` (`{"username": "...", "loginUrl": "...", "hasPassword": true}`).

### `POST /api/portals/:id/credentials`
Submits credentials and attempts immediate portal authentication.
- **Request Body**:
  ```json
  {
    "username": "operator@company.com",
    "password": "secretPassword123",
    "loginUrl": "https://tenderservice.pk/permits/login.php"
  }
  ```
- **Response**: `200 OK` or `401 Unauthorized`.

### `POST /api/portals/:id/hitl-launch`
Launches an interactive, headed Playwright browser window allowing the operator to solve Cloudflare Turnstile or portal bot checks.
- **Response**: `200 OK` (`{"success": true, "message": "Browser session launched"}`).

### `POST /api/portals/:id/hitl-verify`
Validates whether active session cookies exist in `data/sessions/` after HITL completion and marks the portal online.
- **Response**: `200 OK` (`{"success": true}`).

---

## 5. Crawling & Scanning

### `POST /api/scan/start`
Initiates a crawl across all portals or a targeted portal. Multi-portal scans run HTTP portals concurrently (pool of 3) and Playwright portals sequentially (pool of 1).
- **Request Body**:
  - `portalId` *(optional)*: Scan a single portal rather than all active portals.
  - `depth` *(optional, `'quick' | 'deep'`, default `'quick'`)*: Controls pagination budgets (`quickMaxPages` with DB early-stop vs `deepMaxPages`).
- **Response**: `200 OK` snapshot of initial scan status (`activePortals`, `scanDepth`, `currentPortal`, etc.).

### `GET /api/scan/status`
Returns immediate snapshot of crawler status.
- **Response**: `200 OK`
  ```json
  {
    "isScanning": true,
    "currentPortal": "Federal PPRA (EPMS)",
    "activePortals": ["Federal PPRA (EPMS)", "Punjab PPRA (eproc.punjab.gov.pk)"],
    "scanDepth": "quick",
    "progressPercent": 45,
    "completedPortals": 8,
    "totalPortals": 18,
    "newTendersFound": 12,
    "corrigendaFound": 2,
    "heldForScope": 3,
    "lastScanTimestamp": "2026-11-13T09:00:00+05:00",
    "lastFullScanTimestamp": "2026-11-13T08:00:00+05:00",
    "pausedReason": null,
    "docQueue": {
      "isFetching": true,
      "readyPending": 14,
      "readyTenders": 9,
      "awaitingScopePending": 120,
      "awaitingScopeTenders": 65,
      "totalPending": 134,
      "processing": 2,
      "processingTenders": 2,
      "activeTenderIds": ["tender-punjab_eproc-abc123", "tender-epms_ppra-def456"],
      "completedInRun": 8,
      "lastUpdatedAt": "2026-11-19T14:40:00.000Z"
    }
  }
  ```
  - `pausedReason` *(optional `string | null`)*: Explains why a requested scan was paused or deferred (for example, offline or slow network connectivity).
  - `docQueue` *(optional `DocumentQueueStatus`)*: Live background document queue telemetry (`isFetching`, `readyPending` / `readyTenders`, `awaitingScopePending` / `awaitingScopeTenders`, `totalPending`, active `processing` / `processingTenders`, `activeTenderIds`, `completedInRun`, and `lastUpdatedAt`).

### `GET /api/scan/progress` & `GET /api/scan/stream`
Server-Sent Events (SSE) connection streaming real-time scan and background document queue telemetry to connected clients.
- Event envelope: `data: {"type": "<eventType>", "status": {...}}` where `<eventType>` is:
  - `"scan_progress"`: Crawler scan progress updates and scan start/completion transitions.
  - `"doc_queue_progress"`: Live `docQueue` counter updates while `drainDocumentQueue()` is running.
  - `"documents_updated"`: Emitted after a worker batch completes or expires tenders so connected clients reload tenders, KPIs, and corrigenda immediately.

---

## 6. Domain Tracks & Keywords

### `GET /api/tracks`
Returns all business domain tracking rules.

### `POST /api/tracks`
Creates or updates a domain track.
- **Request Body**:
  ```json
  {
    "id": "track-solar",
    "name": "Solar & Clean Energy",
    "positive_keywords": ["solar", "photovoltaic", "inverter", "net metering"],
    "negative_keywords": ["solar geyser repair"]
  }
  ```

### `GET /api/kpis`
Returns live operational KPI summary counts (`totalTracked`, `closingSoon`, `inPipeline`, `unackCorrigenda`, `totalPortals`, `onlinePortals`, `hitlRequiredCount`) via `getKpiStats()`.

### `DELETE /api/tracks/:id`
Deletes a domain track.

---

## 7. Storage, Dossiers & Backups

### `GET /api/storage`
Reports disk usage for dossiers, databases, passed tenders, Gemini AI status, session logs, automated retention status, and current document ingest budgets (`ingest_budgets`).

### `GET /api/system/ingest-budgets` & `POST /api/system/ingest-budgets`
Reads or updates the document ingestion and Gemini Vision / text cost caps (`upfrontTimeBudgetSec`, `maxFileMb`, `visionCallsPerScan`, `visionCallsPerDay`, `aiTextCallsPerDay`) persisted in `app_settings`. Responses also include today's usage counters (`dailyVisionUsed`, `dailyAiTextUsed`).

### `GET /api/system/retention`, `POST /api/system/retention/run`, & `POST /api/system/retention/settings`
Inspects retention status, triggers an immediate retention and cleanup sweep (`?dryRun=true` optional), or updates `autoClean`, `graceDays`, and `passedDays`.

### `POST /api/dossiers/prune-passed` & `POST /api/system/dossiers/reconcile`
`prune-passed` deletes downloaded documents for tenders marked `Passed`. `reconcile` audits `data/dossiers/` against `cached_dossiers` in SQLite, removing orphan folders and pruning missing file references.

### `GET /api/dossiers/:tenderId/:filename`
Serves a cached local bidding document from `src/server/routes/system.routes.ts` with strict path-traversal protection (`!filePath.startsWith(resolvedRoot + path.sep)`). Pass `?download=true` to force an attachment download.

### `GET /api/system/embedding-status`
Returns the local `all-MiniLM-L6-v2` semantic embedding engine status and counts of total, indexed, and model-space-indexed tenders.

### `GET /api/system/logs` & `GET /api/system/logs/:filename`
Lists the last 3 retained session execution logs or retrieves/downloads (`?download=true`) a specific log file.

### `GET /api/backups` & `POST /api/backups`
Lists all available SQLite backups with filenames, creation timestamps, and byte sizes, or generates an immediate SQLite online backup (`db.backup()`) in `data/backups/`.

### `GET /api/system/digest` & `POST /api/system/digest/settings`
- `GET /api/system/digest` *(alias `/api/digest`, optional `?hours=48`)*: Returns the proactive alert summary (`closingSoon`, `closingSoonCount`, `unacknowledgedCorrigendaCount`, `newMatchesLast24hCount`) plus current `settings` (`enabled`, `webhookUrl`, `withinHours`, `lastSentDatePkt`).
- `POST /api/system/digest/settings` *(alias `/api/digest/settings`)*: Updates opt-in daily digest webhook configuration (`enabled`, `webhookUrl`, `withinHours`) in `app_settings`. Non-empty `webhookUrl` values must pass `validateExternalHttpUrl` (`urlSafety.ts`, `SEC-5`, returning `400 Bad Request` on invalid or private/loopback targets).

### `POST /api/system/shutdown`
Token-guarded graceful shutdown endpoint used by the standalone Windows system tray host (`TENDER_SHUTDOWN_TOKEN`).
- **Headers**: `X-Shutdown-Token: <token>` (compared in constant time via `crypto.timingSafeEqual`).
- **Responses**:
  - `200 OK`: Flushes HTTP response (`Connection: close`), stops the scheduler, terminates local OCR worker, truncates/checkpoints SQLite WAL, closes the database cleanly, and exits.
  - `403 Forbidden`: Returned when `TENDER_SHUTDOWN_TOKEN` is unset (disabled by default in standard `npm run dev` / `npm start` runs) or when the header token is missing/invalid.
  - `503 Service Unavailable`: Returned if no shutdown handler is registered.

### `GET /api/system/network` & `POST /api/system/network/check`
Reports current network connectivity health (`online`, `degraded`, `offline`), measured probe latency, whether heavy network tasks are paused (`heavyTasksPaused`), and deferred queue/scan counts (`deferredHeavyTasks`).
- `GET /api/system/network`: Returns cached status (refreshed automatically every 45s).
- `POST /api/system/network/check`: Forces an immediate re-probe across lightweight connectivity endpoints.
