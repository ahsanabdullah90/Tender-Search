# 03. Database Schema

## Storage Architecture

Tender Tracker uses embedded **SQLite 3** managed via `better-sqlite3`. SQLite was selected for zero-configuration, atomic transactions, blazing read performance, and portable backup capability.

The database file resides at `<DATA_DIR>/tender_tracker.db` alongside its WAL write buffer (`-wal`) and shared memory index (`-shm`).

### Performance Pragmas
Upon connection, `src/server/db/connection.ts` applies:
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```

---

## Entity-Relationship Diagram

```mermaid
erDiagram
    TENDERS ||--o{ CORRIGENDUM_LOGS : "has"
    TENDERS ||--o{ PIPELINE_AUDIT_LOGS : "logs"
    TENDERS ||--o{ DOCUMENT_INGEST_JOBS : "queues"
    PORTAL_HEALTH ||--o{ TENDERS : "discovers"

    TENDERS {
        text id PK
        text canonical_id
        text reference_no
        text reference_norm
        text title
        text organization
        text portal_id FK
        text portal_name
        text direct_url
        text secondary_sources
        text domain_tracks
        text matched_keywords
        integer match_score
        real semantic_score
        blob embedding
        text publish_date
        text publish_date_source
        text closing_date
        text closing_date_formatted
        text estimated_value
        text location
        text description
        text bid_brief
        text cached_dossiers
        text attachment_urls
        text extracted_text
        integer has_corrigendum
        text pipeline_status
        text status_notes
        text result_expected_date
        text passed_at
        text slimmed_at
        integer is_bookmarked
        integer viewed
        text ingestion_status
        text deadline_source
        text deadline_confidence
        text doc_fetch_status
        integer needs_review
        text review_reason
        text created_at
        text updated_at
    }

    DOCUMENT_INGEST_JOBS {
        text id PK
        text tender_id FK
        text url
        text label
        integer priority
        integer attempts
        integer max_attempts
        text status
        text lease_until
        text last_error
        text next_retry_at
        text created_at
    }

    CORRIGENDUM_LOGS {
        text id PK
        text tender_id FK
        text tender_title
        text change_type
        text previous_value
        text new_value
        integer is_acknowledged
        text detected_at
    }

    PIPELINE_AUDIT_LOGS {
        text id PK
        text tender_id FK
        text previous_status
        text new_status
        text notes
        text created_at
    }

    DOMAIN_TRACKS {
        text id PK
        text name
        text positive_keywords
        text negative_keywords
        blob embedding
        integer is_active
    }

    PORTAL_HEALTH {
        text portal_id PK
        text portal_name
        text category
        text tier
        text base_url
        text tenders_url
        text login_url
        text auth_username
        text auth_password
        text session_cookies
        text status
        text last_scan_at
        text last_success_at
        integer last_items_found
        integer consecutive_zero_yields
        integer pages_scanned
        text last_error_message
        text last_error_code
        text access_mode
        text verified_status
    }

    DELETED_TENDERS {
        text id PK
        text canonical_id
        text closing_date
        text reason
        text deleted_at
    }

    PENDING_FILE_PURGES {
        text id PK
        text folder_path
        integer attempts
        text last_error
        text created_at
    }

    APP_SETTINGS {
        text key PK
        text value
    }
```

---

## Table Definitions

### 1. `tenders`
The primary entity representing scraped, matched, and tracked procurement opportunities.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Unique identifier (e.g., `punjab_eproc-12345` or UUID). |
| `canonical_id` | `TEXT` | `NOT NULL` | Identifies duplicate grouping. Points to the parent tender ID. |
| `reference_no` | `TEXT` | `NULL` | Formal tender reference/tender inquiry number. |
| `reference_norm` | `TEXT` | `NULL` | Canonical normalized alphanumeric reference (uppercase, stripped dates/prefixes) for strict Tier-1 deduplication. |
| `title` | `TEXT` | `NOT NULL` | Official tender title / procurement subject. |
| `organization` | `TEXT` | `NOT NULL` | Procuring entity or government department. |
| `portal_id` | `TEXT` | `NOT NULL` | Originating portal identifier. |
| `portal_name` | `TEXT` | `NOT NULL` | Display name of the portal. |
| `direct_url` | `TEXT` | `NOT NULL` | Direct link to the notice on the official website. |
| `secondary_sources` | `TEXT` | `DEFAULT '[]'` | JSON array of `{portalName, directUrl, discoveredAt}`. Excludes tender's own portal. |
| `domain_tracks` | `TEXT` | `DEFAULT '[]'` | JSON array of matched track names. |
| `matched_keywords` | `TEXT` | `DEFAULT '[]'` | JSON array of matched keyword strings. |
| `match_score` | `INTEGER`| `DEFAULT 0` | Relevance score (0 to 100). |
| `publish_date` | `TEXT` | `NULL` | Notice publication date (ISO string or YYYY-MM-DD). |
| `publish_date_source` | `TEXT` | `NULL` | Provenance of publish date: `html_row`, `html_detail`, `document`, or `upload_folder` (upload-folder dates are excluded from 90-day ageing calculations). |
| `closing_date` | `TEXT` | `NULL` | Submission deadline (ISO string with PKT offset `+05:00`). |
| `closing_date_formatted`| `TEXT` | `NOT NULL` | Human-friendly display date in PKT format. |
| `estimated_value` | `TEXT` | `NULL` | Estimated tender budget (e.g., `"PKR 45,000,000"`). |
| `location` | `TEXT` | `NULL` | Work/delivery station (e.g., `"Islamabad"`). |
| `description` | `TEXT` | `DEFAULT ''` | Detailed scope or AI First-Look brief extracted from notice. |
| `bid_brief` | `TEXT` | `NULL` | Optional JSON `BidBrief` (`bidSecurityAmount`, `tenderFee`, `requiredRegistrations`, `requiredExperience`, `deliverablesSummary`, `bidMethod`). |
| `cached_dossiers` | `TEXT` | `DEFAULT '[]'` | JSON array of downloaded bidding document metadata `{label, localPath, originalUrl, mimeType, sha256, sizeBytes, downloadedAt}`. |
| `attachment_urls` | `TEXT` | `DEFAULT '[]'` | JSON array of discovered document URLs persisted at ingest so attachments can be backfilled or re-queued (`P1-1`). |
| `embedding` | `BLOB` | `NULL` | Tagged 384-dimensional float32 vector (`model`-tagged `all-MiniLM-L6-v2` or `fast`-tagged fallback). |
| `semantic_score` | `REAL` | `DEFAULT 0` | Cosine similarity score against the best-matching active domain track. |
| `has_corrigendum` | `INTEGER`| `DEFAULT 0` | Flag (0 or 1) indicating active amendment notice. |
| `pipeline_status` | `TEXT` | `DEFAULT 'New Opportunity'` | Status constrained to `TENDER_STATUSES`. |
| `status_notes` | `TEXT` | `DEFAULT ''` | Operator private notes and reminders. |
| `result_expected_date` | `TEXT` | `NULL` | Target date when bid award results are expected (YYYY-MM-DD). |
| `passed_at` | `TEXT` | `NULL` | Timestamp when the tender was marked `Passed` (drives 2-minute delayed dossier slimming). |
| `slimmed_at` | `TEXT` | `NULL` | Timestamp when cached dossier files for a `Passed` tender were purged from disk. |
| `is_bookmarked` | `INTEGER`| `DEFAULT 0` | Starred tender flag (0 or 1). |
| `viewed` | `INTEGER`| `DEFAULT 0` | Read indicator (0 or 1). |
| `created_at` | `TEXT` | `NOT NULL` | Discovery timestamp. Also the ageing fallback for undated tenders with no `publish_date`. |
| `updated_at` | `TEXT` | `NOT NULL` | Last update or rescrape timestamp. |
| `ingestion_status` | `TEXT` | `DEFAULT 'ready'` | `staging` (mid-ingest; hidden from listings, KPIs and retention), `awaiting_scope` (held generic/unmatched listing awaiting document reading), `ready`, or `failed_verification`. Staging rows older than 60 minutes are released to `ready` by retention; `awaiting_scope` rows older than 3 days are purged. |
| `deadline_source` | `TEXT` | `NULL` | Where `closing_date` came from: `corrigendum_doc`, `primary_doc`, `html_detail`, `html_row`, `manual`. |
| `deadline_confidence` | `TEXT` | `NULL` | `high`, `medium` or `low`. |
| `doc_fetch_status` | `TEXT` | `DEFAULT 'none'` | Derived from `document_ingest_jobs`: `none`, `pending`, `partial`, `complete`, `failed`. |
| `needs_review` | `INTEGER` | `DEFAULT 0` | `1` when the operator must confirm something, e.g. a corrigendum or re-scan moved the deadline earlier, or a notice was cancelled. |
| `review_reason` | `TEXT` | `NULL` | Machine/human-readable reason (`deadline_moved_earlier: ...`, `corrigendum_cancelled`, `uncertain_past_deadline: ...`, `excluded_terms_in_documents: ...`). |

### `document_ingest_jobs`
Durable retry queue for tender document downloads and extraction. Rows are deleted with their tender (`ON DELETE CASCADE`). All access goes through `src/server/db/repositories/ingestJobsRepo.ts`.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | `job-<uuid>` |
| `tender_id` | `TEXT NOT NULL` | `REFERENCES tenders(id) ON DELETE CASCADE` |
| `url` | `TEXT NOT NULL` | `UNIQUE (tender_id, url)`, so queueing the same file twice is a no-op |
| `label` | `TEXT` | Display label |
| `priority` | `INTEGER DEFAULT 50` | Lower runs first: corrigendum 10, RFP/notice 20, other 50 |
| `attempts` / `max_attempts` | `INTEGER` | Attempt counted when a job is claimed; default max 3 |
| `status` | `TEXT DEFAULT 'pending'` | `pending`, `processing`, `done`, `failed` |
| `lease_until` | `TEXT` | Expired leases return to `pending` (or `failed` if out of attempts) |
| `last_error` | `TEXT` | Last failure message |
| `next_retry_at` | `TEXT` | Backoff 2 → 10 → 30 minutes after each failed attempt |
| `created_at` | `TEXT` | |

Indexes:
- `idx_tenders_canonical`: `ON tenders(canonical_id)`
- `idx_tenders_status`: `ON tenders(pipeline_status)`
- `idx_tenders_closing`: `ON tenders(closing_date)`

---

### 2. `corrigendum_logs`
Tracks detected amendments, deadline extensions, and scope changes over time.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Unique log identifier. |
| `tender_id` | `TEXT` | `NOT NULL` | Foreign key referencing `tenders(id)`. |
| `tender_title` | `TEXT` | `NULL` | Title snapshot for quick reference. |
| `change_type` | `TEXT` | `NOT NULL` | `'deadline_extension'`, `'scope_revision'`, or `'attachment_update'`. |
| `previous_value` | `TEXT` | `NULL` | Previous deadline date or scope value. |
| `new_value` | `TEXT` | `NOT NULL` | Newly detected value. |
| `is_acknowledged`| `INTEGER`| `DEFAULT 0` | 0 if unread, 1 once cleared by operator. |
| `detected_at` | `TEXT` | `NOT NULL` | Detection timestamp. |

---

### 3. `pipeline_audit_logs`
Provides an immutable audit trail whenever a tender changes status in the pipeline.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Unique audit log ID. |
| `tender_id` | `TEXT` | `NOT NULL` | Foreign key referencing `tenders(id)`. |
| `previous_status`| `TEXT` | `NULL` | Status before transition. |
| `new_status` | `TEXT` | `NOT NULL` | New status after transition. |
| `notes` | `TEXT` | `NULL` | Optional operator commentary. |
| `created_at` | `TEXT` | `NOT NULL` | Transition timestamp. |

---

### 4. `domain_tracks`
Configurable business domain filters.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Identifier (e.g., `track-solar`). |
| `name` | `TEXT` | `NOT NULL` | Track title (e.g., `"Solar & Clean Energy"`). |
| `positive_keywords`| `TEXT` | `NOT NULL` | JSON array of mandatory match words. |
| `negative_keywords`| `TEXT` | `DEFAULT '[]'` | JSON array of exclusion words. |
| `is_active` | `INTEGER`| `DEFAULT 1` | 1 if actively evaluated during scraping. |

---

### 5. `portal_health`
Maintains operational health, credentials, and scan metrics for each of the 18 portals.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `portal_id` | `TEXT` | `PRIMARY KEY` | Identifier (e.g., `epads`, `punjab_eproc`). |
| `portal_name` | `TEXT` | `NOT NULL` | Human-friendly name. |
| `category` | `TEXT` | `NOT NULL` | `'Regulatory'`, `'Federal/Regional'`, `'Tech & Skills'`, `'Multilateral'`, `'Aggregator'`. |
| `tier` | `TEXT` | `NOT NULL` | `'http'` (Cheerio) or `'playwright'` (Browser). |
| `base_url` | `TEXT` | `NOT NULL` | Primary portal homepage URL. |
| `tenders_url` | `TEXT` | `NOT NULL` | Active tenders page URL. |
| `login_url` | `TEXT` | `NULL` | Login page URL (for portals requiring authentication). |
| `auth_username` | `TEXT` | `NULL` | Operator account username / email. |
| `auth_password` | `TEXT` | `NULL` | Password for portal authentication. |
| `session_cookies`| `TEXT` | `NULL` | Serialized session cookie storage. |
| `status` | `TEXT` | `DEFAULT 'online'` | `'online'`, `'scanning'`, `'hitl_required'`, `'selector_broken'`, `'error'`. |
| `last_scan_at` | `TEXT` | `NULL` | Timestamp of last scan completion. |
| `last_success_at` | `TEXT` | `NULL` | Timestamp of the last scan of this portal that finished without a connection error, verification challenge or login wall, whatever the number of items (`HLT-5` in `docs/13`). |
| `last_items_found` | `INTEGER`| `DEFAULT 0` | Count of tenders discovered on latest crawl. |
| `pages_scanned` | `INTEGER`| `DEFAULT 1` | Number of pagination pages crawled during latest run. |
| `consecutive_zero_yields` | `INTEGER`| `DEFAULT 0` | Counter for consecutive runs yielding 0 items. |
| `last_error_message` | `TEXT` | `NULL` | Error details or failure diagnostics. |
| `last_error_code` | `TEXT` | `NULL` | Structured `ScraperErrorCode` (`TIMEOUT`, `TLS_ERROR`, `CLOUDFLARE_HITL`, `LOGIN_REQUIRED`, `HTTP_4XX_5XX`, `PARSE_EMPTY`, `NETWORK_UNREACHABLE`). |
| `access_mode` | `TEXT` | `DEFAULT 'public'`| `'public'`, `'login_required'`, `'cloudflare'`, `'offline_broken'`. |
| `verified_status`| `TEXT` | `NULL` | Informational status badge for UI. |

---

### 6. `app_settings`
Key-value storage for application configuration managed directly via the UI:
- `gemini_api_key`: Google AI Studio API key.
- `retention_auto_clean` (`true`/`false`), `retention_grace_days` (default `2`), `retention_passed_days` (default `10`).
- `ingest_upfront_time_budget_sec` (default `300`), `ingest_max_file_mb` (default `25`), `ingest_vision_calls_per_scan` (default `20`), `ingest_vision_calls_per_day` (default `100`).
- `ingest_ai_text_calls_per_day` (default `150`): Daily budget cap for Gemini text cross-checks (`C3`).
- `ingest_vision_calls_YYYY-MM-DD`: Daily background Vision counter (counters older than 7 days are automatically pruned by `pruneOldDailyVisionCounters(7)` during the retention cycle).
- `last_full_scan_at`: Timestamp when the last full multi-portal scan completed. Used by `checkAndTriggerCatchUpScan` so single-portal scans never delay the 12-hour full scan clock (`F5`).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `key` | `TEXT` | `PRIMARY KEY` | Setting key (e.g., `'gemini_api_key'`). |
| `value` | `TEXT` | `NULL` | Plaintext value. |

---

### 7. `deleted_tenders` & `pending_file_purges`
- **`deleted_tenders`**: Suppression registry (`id`, `canonical_id`, `closing_date`, `deleted_at`, `reason`) preventing deleted, passed-and-retired, or auto-expired notices from being re-downloaded and re-inserted on subsequent crawls:
  - `reason`: Provenance of deletion (`'user'`, `'auto-expired'`, `'no-track-match'`, `'legacy'`).
  - Suppression expiry & unblocking: Undated suppressions expire after 120 days. Auto-expired suppressions are automatically lifted if a re-scan finds a new future closing date (`F4`). User-initiated deletions are never unblocked.
- **`pending_file_purges`**: Retry queue (`id`, `tender_id`, `target_path`, `reason`, `attempts`, `last_error`, `created_at`) for dossier folders locked by Windows file handles at deletion time (`dossierStore.ts`).

---

### 8. `tenders_fts` (SQLite FTS5 Virtual Table)
External-content full-text search index (`content='tenders'`, `content_rowid='rowid'`, `tokenize='unicode61 remove_diacritics 2'`) indexing `title`, `organization`, `reference_no`, `portal_name`, `description`, and `extracted_text` (text extracted from downloaded digital PDFs, DOCX files, and OCR summaries).
- Maintained automatically on all inserts, deletes, and updates via SQLite triggers (`tenders_fts_ai`, `tenders_fts_ad`, `tenders_fts_au`).
- Queried safely through `buildFts5PrefixQuery` in `src/server/db/repositories/tendersRepo.ts`, with substring and MiniLM semantic similarity fallbacks so punctuation-heavy queries (`C++`, `2026-27`) never fail.
