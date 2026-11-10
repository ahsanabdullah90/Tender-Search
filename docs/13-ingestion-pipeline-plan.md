# Ingestion Pipeline Upgrade — Implementation Plan (Revised)

**Status:** Proposed · **Baseline:** commit `7ace6e2` (audit findings 1–5 fixed) · **Supersedes:** "Industry-Standard Ingestion Pipeline" draft

Goal: move the **Scrape → Document Ingest → Verification → Inbox** pipeline to a state where no expired tender is ever shown as an active opportunity, every deadline has a recorded source, and documents arrive cached, classified, and retryable, without making scans slower than they are now or blowing through the Gemini quota.

---

## 0. Invariants (every phase must preserve these)

| # | Invariant | Enforced by |
|---|-----------|-------------|
| I1 | No row with a **known past deadline** is returned as an active `New Opportunity`. | Rule B6 at ingest, `excludeExpired` on every Inbox read, retention sweep |
| I2 | **The later valid deadline wins.** Only a document classified as a corrigendum may move a deadline earlier, and when it does the tender is **flagged for operator review** (never auto-deleted on that basis alone). | `reconcileDeadline` (`dateParser.ts`), extended in Phase 2 |
| I3 | Only **document-sourced** dates may auto-expire a tender. Listing snippets, titles and AI summaries of snippets may fill in or extend a date, never expire one. | `extractionMethod` / `deadline_source` checks |
| I4 | Unparseable dates are never stored. | `normalizeExtractedDate` |
| I5 | Every deletion (user or auto-expire, any stage) is recorded in `deleted_tenders`. Undated records are kept. Dated ones are kept until closing + 7 days **and** deletion + 90 days, refreshed when the tender is seen again. | `recordTenderSuppression` / `isTenderSuppressed` |
| I6 | Tenders that are **undated and have no documents** are allowed in the Inbox, shown as *No deadline · Portal HTML only*. They are not hidden. They age out 90 days after `COALESCE(publish_date, created_at)`. | Phase 0.3, Phase 4 badge |
| I7 | Bookmarked tenders and tenders past `New Opportunity` are never auto-deleted. | All auto-expire paths |
| I8 | Every new SQL statement lives in a repository under `src/server/db/repositories/` (AGENTS.md §1). | Code review + governance gate |

> These replace the draft's rule that no unverified deadline may ever appear. On the live DB, 28 of 38 Inbox tenders are undated and 34 have no documents; that rule would empty the Inbox.

---

## Phase 0 — Close the remaining gaps (prerequisite)

Small, low-risk fixes that the later phases depend on.

> **Phase 0 status (2026-11-10): complete.** `tsc` 0 errors; `npm run verify` added; 302 server-side and 99 UI tests pass; build succeeds.

### 0.1 Typecheck gate ✅ done
Fix the 6 existing `tsc --noEmit` errors so "0 errors" can be a real gate:
- `src/server/scrapers/crawlerEngine.ts:232` (`string | undefined` passed as `string`)
- `scripts/migrate-dossier-names.ts:24` (`BackupInfo.filename`)
- `tests/scraper/crawler.test.ts`: 4 OCR mocks missing `organization` / `title`

Add a `verify` script that runs `npm run lint` before `vite build`. `npm run build` alone does not type-check.

### 0.2 Inbox shows expired tenders during the grace window (audit finding 6) ✅ done
- **As built:** fixed on the client instead of sending `excludeExpired=true`, because the Inbox has a deliberate *Show closed (n)* toggle and a *Delete now* action that need the closed rows. The bug was that closed tenders were hidden only while at least one open tender existed, so an all-expired Inbox looked active. Now `InboxScreen.tsx` always hides closed, unbookmarked tenders unless the operator turns on *Show closed*. When everything is closed, the empty state says how many are hidden and offers *Show closed*. The server-side `excludeExpired` filter is kept and also ages undated rows from `created_at`.

### 0.3 Stop defaulting `publish_date` to today ✅ done
- `processAndSaveTender` insert (`item.publishDate || new Date().toISOString().slice(0, 10)`): store `NULL` when unknown.
- Retention (`getExpiredUnreviewedTenderIds`) and `excludeExpired`: age undated rows on `COALESCE(publish_date, created_at)`. Without this fallback, undated tenders with a null publish date would **never** age out.
- Check `tenders` has `created_at`; if not, add it in this phase's migration. *(It exists; no migration needed. The Inbox "Newest" sort also falls back to `created_at`.)*

### 0.4 Ghost rows after auto-expire (audit finding 7) ✅ done (kept the inline `InboxScreen` pane; deleted the unused `TenderDetailPane.tsx`)
- `POST /api/tenders/:id/fetch-documents`, `/analyze`, `/refresh`: when the tender was auto-expired, return `200 { success: true, expired: true, id }` instead of a fake `pipeline_status: 'Deleted'` tender or a 404.
- Inbox handlers: on `expired: true`, call `onTenderDeleted(id)` and show "Deadline passed: removed from Inbox".
- Pick **one** detail pane: `InboxScreen.tsx` renders its own; `src/components/inbox/TenderDetailPane.tsx` is unused. Either wire in `TenderDetailPane` and delete the inline copy, or delete `TenderDetailPane.tsx`. Phase 4 badges go into the survivor only.

**Exit criteria:** `tsc` 0 errors; all suites green; new tests for 0.2–0.4.

---

## Phase 1 — Data model, document queue, and repository (foundation)

Comes before the extractor so that extraction results have somewhere to go.

> **Phase 1 status (2026-11-10): complete.** Migration verified twice on a copy of the live DB: 49 tenders `ready`; 16 dated tenders backfilled `html_row`; 4 with documents `complete`; integrity OK. `ingestJobsRepo.ts` added with 14 tests (`tests/db/ingestJobsRepo.test.ts`). Additions beyond the spec: `releaseStaleStagingTenders` (the retention cycle releases rows stuck in `staging` over 60 minutes, so a crash can't hide a tender forever), `requeueFailedJobs` (for the Phase 4 retry button), and `refreshTenderDocFetchStatus`. The retention cycle also calls `releaseExpiredLeases`. Nothing writes `staging` or queues jobs yet; that starts in Phase 3.

### 1.1 Schema migration (`src/server/db/schema.ts`)
Non-breaking `ALTER TABLE tenders ADD COLUMN` (wrapped in try/catch like the existing migrations):

| Column | Type / default | Values |
|---|---|---|
| `ingestion_status` | `TEXT DEFAULT 'ready'` | `staging` · `ready` · `failed_verification` |
| `deadline_source` | `TEXT` | `corrigendum_doc` · `primary_doc` · `html_detail` · `html_row` · `manual` · `NULL` |
| `deadline_confidence` | `TEXT` | `high` · `medium` · `low` |
| `doc_fetch_status` | `TEXT DEFAULT 'none'` | `none` · `pending` · `partial` · `complete` · `failed` |
| `needs_review` | `INTEGER DEFAULT 0` | `1` when the operator must confirm something (e.g. a corrigendum moved the deadline earlier) |
| `review_reason` | `TEXT` | e.g. `deadline_moved_earlier: 15 Dec 2026 → 05 Dec 2026` |

Existing rows: `deadline_source = 'html_row'` where `closing_date IS NOT NULL`, otherwise `NULL`.

New table:

```sql
CREATE TABLE IF NOT EXISTS document_ingest_jobs (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  label TEXT,
  priority INTEGER NOT NULL DEFAULT 50,      -- lower runs first (corrigendum=10, rfp/notice=20, other=50)
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | processing | done | failed
  lease_until TEXT,                          -- crash recovery for 'processing'
  last_error TEXT,
  next_retry_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tender_id, url)
);
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_due ON document_ingest_jobs(status, next_retry_at);
```

`foreign_keys = ON` is already set (`src/server/db/connection.ts`), so the cascade works.

### 1.2 Repository (`src/server/db/repositories/ingestJobsRepo.ts`, new)
- `enqueueDocumentJobs(tenderId, jobs[])`: `INSERT OR IGNORE`, so it's idempotent.
- `claimDueJobs(limit, leaseMinutes)`: atomic; select due rows and set `processing` + `lease_until` in one transaction.
- `completeJob(id)` · `failJob(id, error)`: exponential backoff 2 → 10 → 30 minutes, `failed` after `max_attempts`.
- `releaseExpiredLeases()` · `getJobSummaryForTender(id)`.

Export via `db/index.ts`. **Update AGENTS.md §1** to list `ingestJobsRepo.ts`.

### 1.3 Staging visibility, enforced in every read path
`ingestion_status = 'staging'` rows must be:
- **excluded** from `getAllTenders` (Inbox/Pipeline), `getPortalTenderSummary`, KPI counts, and retention sweeps;
- **included** in `findCanonicalMatch` (dedup) and `isTenderSuppressed` lookups, so a staged tender can't be inserted twice by a parallel scan.

Add a test for each read path.

**Exit criteria:** migration idempotent on a copy of the live DB; `tests/db/ingestJobsRepo.test.ts` covers claim, lease, backoff and cascade.

---

## Phase 2 — Document extractor and deadline resolution

### 2.1 Dependencies
Add, pinned:
- `pdfjs-dist` (or `pdf-parse`): text from the first 5 pages.
- `mammoth`: `.docx` text.

Both run locally, so nothing is sent off-machine. Record the choice in `docs/12-decisions-and-changelog.md`.

### 2.2 `src/server/documentExtractor.ts` (new)

```ts
export interface DocumentExtractionResult extends OcrExtractedData {
  extractionMethod: 'local_text_ai' | 'local_text_regex' | 'gemini_vision';
  confidence: 'high' | 'medium' | 'low';
  docType: DocType;   // dossierStore.inferDocType(label) combined with OCR isCorrigendum
}
export async function extractFromDocument(buf: Buffer, mimeType: string, label: string): Promise<DocumentExtractionResult | null>;
```

Everything this module returns counts as **document-sourced** (I3), because it only ever reads the tender's own files.

> **Gemini is not needed to download documents, and not needed to read most of them.** Downloading is a plain HTTP fetch (`fetchFileBuffer` / `saveTenderDocument`) with no AI involved. Digital PDFs and Word files (most RFPs from PSEB, FDE, PPRA, UNGM) contain real text that is read locally. Gemini is only **required** for documents with no text layer (scanned PDFs, newspaper clippings, JPG/PNG notices), and is otherwise an optional cross-check. The whole pipeline must work, with lower confidence, when no Gemini key is set.

- **Stage 1, local text (no AI).** If the PDF or DOCX yields at least 200 printable characters:
  1. **Anchored regex:** find dates next to submission phrases ("last date (and time) for submission", "closing date", "bids (shall|must) be (submitted|received) (by|before|on or before)", "deadline"). Ignore dates next to "issue", "pre-bid", "validity", "opening". `extractDatesFromText` alone is **not** used on full documents; it was designed for one-line table rows and would pick issue or pre-bid dates.
  2. Reference number and estimated value come from the same text via anchored patterns ("Tender No.", "Ref", "IFB No.", "Estimated cost").
  3. Confidence from regex alone:
     - **`high`**: exactly one distinct submission date found next to a submission phrase (repeats of the same date count once). This **can** auto-expire (I3).
     - **`medium`**: several different submission-anchored dates. The later one is used, with no auto-expire.
     - **`low`**: only unanchored dates found. Fills in a missing date only.
  4. **Optional AI cross-check:** only when confidence is `medium`/`low` **and** a Gemini key is set, send a ~6 KB text digest to `summarizeTenderTextWithAI`. Agreement raises the result to `high`; disagreement keeps the later date as `low`.
- **Stage 2, Gemini Vision (scanned documents and images only).** Under 200 characters of text, or an image file: `extractTenderFromImage`, confidence `medium`. Without a Gemini key, the document is still downloaded and shown in the Inbox, but marked *Scanned: deadline not read*.
- All dates go through `normalizeExtractedDate`.
- **Baseline first:** before switching over, run both Stage 1 and the current Vision path on 20 real PDFs from `data/dossiers/`. Record how often they agree on the deadline, the time each takes, and the Gemini tokens saved, in the changelog. Stage 1 only becomes the default once it matches Vision on at least 18 of the 20.

### 2.3 `resolveCanonicalDeadline(known, signals[])` (`dateParser.ts`)
Extends `reconcileDeadline`; it doesn't replace it.

1. Drop invalid and unparseable signals.
2. If any signal is a **corrigendum document**, its date wins, even if earlier. When it is **earlier** than the known deadline, the result carries `needsReview: true` with a `review_reason`, and the tender stays in the Inbox flagged *Deadline moved earlier: review* (decision 1). If that earlier date is already past, the tender is **not** auto-deleted; it stays flagged until the operator confirms or passes it. A corrigendum that **cancels** the tender is also flagged for review, not deleted automatically.
3. Otherwise the **latest** valid date among document and HTML signals wins (I2).
4. `deadline_source` = source of the winning date. The draft's ranking (corrigendum > primary doc > detail page > listing row) is used **only to break ties** and to pick the badge.
5. An `isExpired` result is acted on only if the winning signal is document-sourced, or the tender has no document and the row date itself is past (existing B6).

### 2.4 URL upload-folder date (`inferPublishDateFromUrl`)
- `/wp-content/uploads/YYYY/MM/` → last day of that month (`YYYY-MM-DD`). A year-only `/YYYY/` → **ignored** (too coarse). Download-Manager URLs (`?wpdmdl=`) have no path date → `null`.
- Used only as a `publish_date` **fallback**, never as a deadline.
- B6b may reject on it only when **no source yields a future deadline** *and* no document could be read. Old uploads are often reused as templates for new notices.

### 2.5 Use document text for track matching (local MiniLM model, no Gemini)
The local `Xenova/all-MiniLM-L6-v2` model (`data/models/`, loaded at startup) compares meanings, not words. Today it only sees the tender's title, organization and a short description. Once 2.2 extracts text locally, feed it the document's **scope of work** too:
- `extractFromDocument` also returns `scopeText`: the first ~1,500 characters of the scope/schedule-of-requirements section (fall back to the first page).
- `buildTenderEmbeddingText` gains an optional `scopeText`. After a document is read, the tender is re-embedded (`embedTextToBlobAsync`) and re-scored against tracks (`matchTracks` → update `domain_tracks`, `semantic_score`). A tender may **gain** tracks this way. It may **lose** a track only if it was matched semantically (never one matched by an exact keyword), and only for tenders still in `New Opportunity`.
- Negative keywords are also checked against `scopeText`, so a tender whose documents reveal an excluded item drops out.
- **Calibrate before relying on it:** thresholds `0.58` (track match) and `0.88` (duplicate) were set for the fast built-in vectors. Measure MiniLM scores on 50 labelled tender/track pairs and 30 known duplicate/non-duplicate pairs from the live DB, then set separate MiniLM thresholds in `embeddingService.ts`. Record the numbers in the changelog.

> **Already fixed (2026-11-10):** stored vectors are now tagged with which engine produced them (MiniLM or the fast built-in approximation), and similarity only compares vectors of the same kind. Previously, edits and track saves stored fast vectors next to MiniLM ones and compared them directly, which could skew track scores and duplicate checks. A background backfill (`embeddingBackfill.ts`, at startup and every 5 minutes) upgrades older vectors to MiniLM.

**Exit criteria:**
- `tests/unit/document-extractor.test.ts` covers text vs. scanned routing, anchored regex picking the submission date over issue, pre-bid and validity dates, and agree/disagree confidence.
- `tests/unit/crawler-date.test.ts` covers `resolveCanonicalDeadline`, including the corrigendum-earlier, extension-later and cancelled cases, plus `inferPublishDateFromUrl`.
- `tests/unit/embedding-spaces.test.ts` covers scope-text re-scoring: a tender gains a track from its document text; a keyword-matched track is never dropped; a negative keyword found only in the document removes the tender from that track.
- Fixtures are small sample PDFs and DOCX files built for testing, never real tender documents.

---

## Phase 3 — Ingest flow, retry worker, and scan budget

### 3.1 Attachment handling (`processAndSaveTender`)
- Deduplicate candidates, cap at 5, and sort by priority: corrigendum/addendum/extension (10) → rfp/bidding/notice/nit (20) → other (50).
- **Upfront (blocking) fetch only when it is needed to decide B6:** the tender is undated *or* `directUrl` is a document. Fetch up to **2** documents with concurrency 2 and a **20-second budget per tender**, then run `extractFromDocument` → `resolveCanonicalDeadline` → B6/B6b/B6c.
- **Everything else** (dated tenders, remaining attachments, timeouts) → `enqueueDocumentJobs`, `doc_fetch_status = 'pending'`. Dated tenders insert as `ready` straight away: the listing date is enough for the Inbox, and documents fill in later.
- Undated tenders whose upfront fetch timed out → insert as `ready` with `doc_fetch_status = 'pending'` (I6), not held back. `staging` is only used while an upfront fetch is in progress, so a parallel scan doesn't insert the same tender again.
- If both an RFP and a corrigendum are present, both are extracted and `resolveCanonicalDeadline` applies the corrigendum rule; an extension writes a `corrigendum_logs` entry.

### 3.2 Scan budget (`startCrawlerScan`)
Items are processed one by one, so cap the **time** each scan spends on documents. Downloads and local text reading cost no Gemini quota, so they are limited by time and size, not by AI calls:
- `ingest_upfront_time_budget_sec` (default 300 s per scan) and `ingest_max_file_mb` (default 25 MB per file). Once the time budget is spent, remaining items skip the upfront fetch and their documents go to the queue (they are still downloaded, just in the background).
- `ingest_vision_calls_per_scan` (default 20) limits **only** Gemini Vision on scanned documents and images. Text-based PDFs/DOCX don't count against it. Over the limit, scanned documents are still downloaded and queued for Vision on the next worker run.
- Report usage in the scan status (SSE) so Sources can show "12 documents moved to background · 4 scanned notices waiting for Vision".

### 3.3 Retry worker (`src/server/scheduler.ts`)
- Every 2 minutes: `releaseExpiredLeases()`, then `claimDueJobs(5, leaseMinutes = 10)`.
- **Skip while a scan is running** (`currentScanStatus.isScanning`) so the worker and the scan don't fetch the same portal at once.
- For each job:
  1. Re-check the tender exists and isn't `Passed`; if it's gone, mark the job done and purge (existing late-download guard).
  2. Download, then `saveTenderDocument`.
  3. `extractFromDocument` → `resolveCanonicalDeadline`.
  4. If expired and I3/I7 allow it → `deleteTenders([id], 'auto-expired')`. If a corrigendum moved the deadline earlier → set `needs_review` and `review_reason` instead (decision 1). If the deadline was extended → `updateTenderFields` plus a corrigendum log.
  - Vision calls made by the worker count against a daily cap (`ingest_vision_calls_per_day`, default 100), so the background never uses more Gemini quota than the operator set.
  5. Update `doc_fetch_status` (`complete` when all jobs are done, `partial` when some failed, `failed` when all failed).
- On startup: `releaseExpiredLeases()` so jobs left `processing` after a crash are retried.
- AGENTS.md §2 still applies: a document fetch failure **never** triggers Auto-Heal.

**Exit criteria:** `tests/scraper/ingest-queue.test.ts` covers: queue on timeout, recovery on retry, auto-expire on a recovered past date, no expire when bookmarked, cascade on delete, lease recovery, worker skipped during a scan, and the per-scan budget sending items to the queue.

---

## Phase 4 — Provenance UI and portal contract tests

### 4.1 Badges (in the single detail pane chosen in 0.4)

| Condition | Badge |
|---|---|
| `deadline_source` in (`corrigendum_doc`, `primary_doc`) and confidence `high` | **Document verified** (emerald) |
| document-sourced, confidence `medium` / `low` | **From document · check** (amber) |
| `html_detail` / `html_row` | **Portal listing** (neutral) |
| `closing_date IS NULL` | **No deadline · Portal HTML only** (neutral) |
| `needs_review = 1` | **Review: deadline moved earlier** (red), shows `review_reason`, with **Confirm** (clears the flag) and **Pass** actions. Flagged tenders sort to the top of the Inbox. |
| `doc_fetch_status = 'pending'` | spinner "Fetching documents…" |
| `doc_fetch_status` in (`failed`, `partial`) | **Retry document fetch** button → re-enqueues failed jobs via `POST /api/tenders/:id/fetch-documents` (handles `expired: true` per 0.4) |

Add `ingestion_status`, `deadline_source`, `deadline_confidence`, `doc_fetch_status`, `needs_review`, `review_reason` to `Tender` in `src/types.ts`. Add `PATCH /api/tenders/:id/review` (`{ action: 'confirm' }` clears the flag) in `tenders.routes.ts`, backed by a `clearTenderReviewFlag` function in `tendersRepo.ts`, with route and repo tests. Fix `formatClosingDate(null)` returning `'Not Available'`, which means the UI's "No deadline stated" text never shows.

### 4.2 Portal contract tests (`tests/scraper/portal-contracts.test.ts`)
- Today there are fixtures for 6 portals (`tests/fixtures/portals/`). Add the other 12 from `PORTAL_DEFINITIONS` by **capturing live HTML once** with `scripts/capture-portal-fixture.ts` and cleaning it: strip names, phone numbers, emails and session tokens; shrink to ≤ 50 KB; and record the capture date in `tests/fixtures/portals/README.md`.
- Freeze the clock with `vi.setSystemTime` so "expired" is the same on every run.
- Per portal, assert:
  1. Parsed item count and the fields of the first item.
  2. Attachments found (up to 5) with file codes from `getPortalFileCode`.
  3. No item with a past deadline survives `processAndSaveTender`.
  4. Old upload folders are rejected only under the B6b condition in 2.4.

**Exit criteria:** `tests/ui/inbox-screen.test.tsx` renders each badge state and the retry flow, including the expired response; the contract suite covers all 18 portals.

---

## Quality gates (each phase)

1. `npm run lint` (`tsc --noEmit`) → **0 errors** (possible only after 0.1).
2. `npx vitest run tests/unit/ tests/scraper/ tests/db/ tests/api/ tests/ui/` → all pass. The Vite-startup route test needs `--testTimeout=30000` on Google Drive.
3. `npm run build` succeeds.
4. Governance: the count of `db.prepare` outside `src/server/db/` must **not increase** (new SQL goes into repositories only, I8).
5. Live-DB check after deploy (read-only): no `New Opportunity` with `julianday(closing_date) < julianday('now')`; no `closing_date` where `julianday()` is NULL; no `document_ingest_jobs` rows stuck in `processing` past their lease.

## Out of scope / follow-ups
- Moving the existing stray SQL calls out of `crawlerEngine.ts`, `dossierStore.ts`, `deduplicator.ts`, `scheduler.ts`, `system.routes.ts` and `retention.ts` into repositories.
- Moving `/api/dossiers/:tenderId/:filename` out of `server.ts` into `routes/` (AGENTS.md §1).
- `Claude outputs/` and `Mocks/` in the repo root (AGENTS.md root hygiene): relocate or ignore.

## Decisions (confirmed by the operator, 2026-11-10)
1. **A corrigendum that moves a deadline earlier** is applied and the tender is **flagged for review**: never auto-deleted on that basis (I2, §2.3, §4.1).
2. **Undated tenders without documents** stay **visible with a badge** (I6).
3. **Documents are downloaded directly, without Gemini.** Digital PDFs/DOCX are read locally. Gemini is required only for scanned documents and images, and is optional as a cross-check (§2.2). Per-scan budgets limit time, file size and Vision calls, not downloads (§3.2).
