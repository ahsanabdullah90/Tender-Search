# 04. API Reference

All backend routes are mounted under the `/api` prefix. The server responds with `application/json` unless streaming files or Server-Sent Events.

---

## 1. Tenders & Pipeline

### `GET /api/tenders`
Returns a list of all active opportunities.
- **Query Parameters**:
  - `status` *(optional)*: Filter by pipeline status (e.g., `New Opportunity`, `Preparing Bid`).
  - `track` *(optional)*: Filter by matched domain track.
  - `search` *(optional)*: Text query matched against title, organization, reference number, or description.
- **Response**: `200 OK`
  ```json
  [
    {
      "id": "punjab_eproc-10492",
      "canonical_id": "punjab_eproc-10492",
      "reference_no": "IPL-2026-991",
      "title": "Supply and Installation of 500 kW Solar PV System",
      "organization": "Punjab Energy Department",
      "portal_id": "punjab_eproc",
      "portal_name": "Punjab PPRA (eproc.punjab.gov.pk)",
      "direct_url": "http://eproc.punjab.gov.pk/ViewTender.aspx?id=10492",
      "secondary_sources": [],
      "domain_tracks": ["Solar & Clean Energy"],
      "matched_keywords": ["solar", "photovoltaic"],
      "match_score": 92,
      "publish_date": "2026-04-15",
      "closing_date": "2026-05-10T14:00:00+05:00",
      "closing_date_formatted": "10-05-2026 02:00 PM PKT",
      "estimated_value": "PKR 82,000,000",
      "location": "Lahore",
      "description": "Grid-tied solar rooftop installation...",
      "cached_dossiers": [],
      "has_corrigendum": 0,
      "pipeline_status": "New Opportunity",
      "status_notes": "",
      "is_bookmarked": 0,
      "viewed": 0
    }
  ]
  ```

### `GET /api/tenders/:id`
Retrieves a single tender by its unique identifier.
- **Response**: `200 OK` or `404 Not Found`.

### `PATCH /api/tenders/:id/status`
Updates the pipeline status of a tender.
- **Request Body**:
  ```json
  {
    "status": "Under Review",
    "notes": "Reviewed specifications; viable commercial opportunity."
  }
  ```
- **Validation (Bug B8)**: Must be one of the six valid `TENDER_STATUSES`:
  - `New Opportunity`
  - `Under Review`
  - `Preparing Bid`
  - `Submitted`
  - `Won`
  - `Passed`
- **Response**: `200 OK` or `400 Bad Request` (`{"error": "Invalid tender status"}`).

### `PATCH /api/tenders/:id/notes`
Saves operator notes on a specific tender.
- **Request Body**: `{"notes": "Follow up with procurement officer regarding site visit."}`
- **Response**: `200 OK`.

### `PATCH /api/tenders/:id/result-date`
Sets or clears the expected award announcement date.
- **Request Body**: `{"result_expected_date": "2026-06-30"}` (or `null` to clear).
- **Response**: `200 OK`.

### `PATCH /api/tenders/:id/bookmark`
Toggles the starred/bookmarked state.
- **Response**: `200 OK` with updated status: `{"id": "...", "is_bookmarked": 1}`.

### `PATCH /api/tenders/:id/viewed`
Marks the tender as viewed/read.
- **Response**: `200 OK`.

---

## 2. Corrigenda & Amendments

### `GET /api/corrigenda`
Returns all logged amendments and scope revisions.
- **Query Parameters**:
  - `unacknowledged` *(optional, boolean)*: If `true`, returns only unread changes.
- **Response**: `200 OK`
  ```json
  [
    {
      "id": "corr-819",
      "tender_id": "punjab_eproc-10492",
      "tender_title": "Supply and Installation of 500 kW Solar PV System",
      "change_type": "deadline_extension",
      "previous_value": "05-05-2026 02:00 PM PKT",
      "new_value": "15-05-2026 02:00 PM PKT",
      "is_acknowledged": 0,
      "detected_at": "2026-05-02T11:20:00+05:00"
    }
  ]
  ```

### `POST /api/corrigenda/:id/acknowledge`
Acknowledges and clears an amendment alert.
- **Response**: `200 OK` (`{"success": true}`).

---

## 3. Portals, Health & Authentication

### `GET /api/portals`
Returns health metrics, access modes, and configuration for all 18 procurement portals.
- **Response**: `200 OK` array of `PortalHealth` records.

### `GET /api/portals/:id/credentials`
Retrieves saved credentials configuration for a portal (e.g., `tender_services`).
- **Response**: `200 OK`
  ```json
  {
    "username": "operator@company.com",
    "loginUrl": "https://tenderservice.pk/permits/login.php",
    "hasPassword": true
  }
  ```

### `POST /api/portals/:id/credentials`
Submits login credentials, attempts portal authentication, and saves cookies.
- **Request Body**:
  ```json
  {
    "username": "operator@company.com",
    "password": "secretPassword123",
    "loginUrl": "https://tenderservice.pk/permits/login.php"
  }
  ```
- **Response**: `200 OK` (`{"success": true, "message": "Authentication successful"}`) or `401 Unauthorized`.

### `POST /api/portals/:id/launch-hitl`
Launches an interactive, headed Playwright browser window allowing the operator to solve Cloudflare Turnstile or portal bot checks.
- **Response**: `200 OK` (`{"success": true, "message": "Browser session launched"}`).

### `POST /api/portals/:id/verify-hitl`
Validates whether active session cookies exist in `data/sessions/` after HITL completion.
- **Response**: `200 OK` (`{"verified": true, "cookiesCount": 4}`).

---

## 4. Crawling & Scanning

### `POST /api/scan/trigger`
Initiates a crawl.
- **Request Body**:
  - `portal_id` *(optional)*: Scan a single portal rather than all 18.
- **Response**: `200 OK` (`{"message": "Scan started"}`).

### `GET /api/scan/status`
Returns immediate snapshot of crawler status.
- **Response**: `200 OK`
  ```json
  {
    "isScanning": true,
    "currentPortal": "Federal PPRA (EPADS)",
    "progressPercent": 45,
    "completedPortals": 8,
    "totalPortals": 18,
    "newTendersFound": 12,
    "corrigendaFound": 2,
    "lastScanTimestamp": "2026-05-01T10:00:00+05:00"
  }
  ```

### `GET /api/scan/progress`
Server-Sent Events (SSE) connection streaming real-time scan progress events to connected clients.

---

## 5. Domain Tracks & Keywords

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
    "negative_keywords": ["janitorial", "cleaning"]
  }
  ```

### `DELETE /api/tracks/:id`
Deletes a domain track.

---

## 6. Backups & Storage Management

### `GET /api/backups`
Lists all available SQLite backups with filenames, creation timestamps, and byte sizes.

### `POST /api/backups/create`
Generates an immediate SQLite vacuum backup into `data/backups/`.

### `GET /api/storage`
Reports disk usage for dossiers, databases, and passed tenders.

### `POST /api/storage/prune`
Deletes downloaded documents for tenders marked `Passed`, freeing local disk storage.

### `POST /api/data/clear-inbox`
Clears unreviewed opportunities from the inbox without affecting tracked pipeline tenders or bookmarked records (enforced by Bug B12 fix).

### `GET /api/export/csv`
Downloads an export of active pipeline or inbox tenders in CSV format with PKT dates.
