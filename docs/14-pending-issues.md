# 14. Pending Issues & Next-Run Backlog

**Last updated:** 2026-11-11 · **Code baseline:** `df1311a` (ingestion pipeline Phases 0–4 complete)
**Sources:** pipeline audit (2026-11-10), `docs/13-ingestion-pipeline-plan.md` (status and deviations), embedding fix (`48332e0`).

Each item gives **where** it is, **why it matters**, a **suggested fix**, and **done when** (how to verify). Priorities: **P1** = can show wrong or stale data to the operator, or blocks a gate; **P2** = correctness or governance debt; **P3** = cleanup.

---

## Before anything else (post-deploy checks)

These were not run because the app has not been restarted since `df1311a`.

- [ ] **D1. Restart the app and check the migration and worker on the live database.** After restart, run read-only:
  - `SELECT ingestion_status, deadline_source, doc_fetch_status, needs_review, COUNT(*) FROM tenders GROUP BY 1,2,3,4;`
  - No `New Opportunity` with `julianday(closing_date) < julianday('now')` and `needs_review = 0` (older than the 2-day grace).
  - No `closing_date` where `julianday(closing_date) IS NULL`.
  - No `document_ingest_jobs` rows in `processing` with `lease_until` in the past.
  - The session log shows `[Embedding Engine] Backfilled MiniLM vectors` and, after the first scan, `[IngestWorker]` lines.
- [ ] **D2. Push.** Commits `6fc2e3d..df1311a` are local only; `origin/main` is behind.

---

## P1: data the operator sees

- [ ] **P1-1. Existing tenders never get their documents read.** The worker only processes queued jobs, and the 49 tenders already in the database (28 undated) were inserted before the queue existed. Attachment URLs are not stored on `tenders`, so they can't be re-queued from the row.
  - *Fix:* one-time backfill. For each `New Opportunity` whose `direct_url` is a document (`isDirectDocumentUrl`), `enqueueDocumentJobs`. For the rest, rely on the next scan, or add an `attachment_urls` column filled at ingest so re-queueing is possible later.
  - *Done when:* undated tenders with document links show `doc_fetch_status` other than `none` after one worker pass.
- [ ] **P1-2. Parser gaps: `psda`, `giz`, `pid` return 0 tenders over HTTP.** Recorded as "known parser gap" tests in `tests/scraper/portal-contracts.test.ts`.
  - *Fix:* inspect each live page. They may need the Playwright tier, a different listing URL, or new selectors. Follow AGENTS.md §2: do **not** auto-heal on 200-OK zero-yield pages.
  - *Done when:* re-captured with `npx tsx scripts/capture-portal-fixture.ts <id>` and the gap test becomes a full contract.
- [ ] **P1-3. Pipeline screen ignores review flags and deadline-source badges.** `PipelineScreen.tsx` has no `needs_review` / `deadline_source` / `doc_fetch_status` handling. A tender moved to *Under Review* that a corrigendum later flags won't show the flag there.
  - *Fix:* reuse `deadlineProvenance` / `humanReviewReason` from `InboxScreen.tsx` (move them to `src/ui` or a shared helper).
- [ ] **P1-4. A re-scan listing that moves a deadline earlier is ignored.** In the duplicate path of `processAndSaveTender`, only *later* scanned dates update an existing tender (audit finding 8). A genuine earlier date from the listing is dropped silently.
  - *Fix:* when a re-scan shows an earlier date, set `needs_review` with `deadline_moved_earlier` (same rule as corrigenda) instead of ignoring it.

## P1: validation not yet possible

- [ ] **P1-5. Local reading vs Gemini Vision agreement (plan §2.2).** Planned on 20 real PDFs, but only 4 documents exist locally. Local reading is on by default.
  - *Fix:* once more documents are cached (after P1-1 and a few scans), run both readers on 20 PDFs. Record agreement, timing and tokens in `docs/12` ADR 08.
  - *Done when:* agreement on 18 of 20, or the anchor patterns in `documentExtractor.ts` are adjusted.
- [ ] **P1-6. MiniLM thresholds are uncalibrated (plan §2.5).** `0.58` (track match) and `0.88` (duplicate) were set for the fast built-in vectors, but now apply to MiniLM too. MiniLM scores similar-but-different titles from the same organisation highly, so the 0.88 duplicate threshold could merge two distinct tenders (the second never reaches the Inbox).
  - *Needs from the operator:* about 50 tender↔track pairs marked match / no-match, and about 30 tender pairs marked same / different.
  - *Fix:* separate MiniLM thresholds in `embeddingService.ts`, chosen from those pairs.

## P2: correctness and robustness

- [ ] **P2-1. Timed-out upfront downloads keep running.** `withTimeout` in `crawlerEngine.ts` stops waiting but doesn't cancel the download. If the tender is then rejected, the file can land in an orphan folder; `reconcileDossiers` removes it after 60 minutes.
  - *Fix:* pass an `AbortSignal` through `downloadAndCacheDossier` / `fetchFileBuffer`.
- [ ] **P2-2. `fetchDocumentsForTender` calls `fetchFileBuffer` directly** (`crawlerEngine.ts:1811`, listing branch) instead of `crawlerDeps.fetchFileBuffer`, so tests can't stub it.
- [ ] **P2-3. File-size limit is checked after download.** A 500 MB file is fully downloaded before the 25 MB limit is applied.
  - *Fix:* check `Content-Length` and cap bytes while streaming in `fetchFileBuffer`.
- [ ] **P2-4. `staging` status is unused by ingest** (deviation in plan §3.1). The read-path filters and stale-staging recovery exist, but nothing sets `staging`. Either use it (e.g. for Phase 3 re-reads of existing tenders) or remove it to avoid dead code.
- [ ] **P2-5. A cancelling corrigendum only flags.** A tender whose corrigendum says it was cancelled stays in the Inbox flagged. Consider a one-click "Pass as cancelled" in the review banner.
- [ ] **P2-6. Unanchored document dates are ignored** (deviation in plan §2.2). A document with text but no "last date / closing date…" phrase gives no deadline. Check during P1-5 whether real notices use phrasings the anchors miss, and add them.
- [ ] **P2-7. Daily Vision counters pile up** in `app_settings` (`ingest_vision_calls_YYYY-MM-DD`, one row per day). Delete keys older than 7 days in the retention cycle.
- [ ] **P2-8. No UI for ingest budgets.** `ingest_upfront_time_budget_sec`, `ingest_max_file_mb`, `ingest_vision_calls_per_scan` and `ingest_vision_calls_per_day` can only be changed in `app_settings`. Add them to Sources → Data.

## P2: governance (AGENTS.md)

- [ ] **P2-9. 24 SQL statements outside the repositories:** `crawlerEngine.ts` 10, `dossierStore.ts` 8, `deduplicator.ts` 3, `scheduler.ts` 2, `retention.ts` 1. Move them into `src/server/db/repositories/`.
  - *Done when:* the governance count (`db.prepare` outside `src/server/db/`) is 0.
- [ ] **P2-10. Route in `server.ts`:** `GET /api/dossiers/:tenderId/:filename` (`server.ts:29`) belongs in `src/server/routes/` (e.g. `system.routes.ts`). Keep its path-traversal guard and add a route test.
- [ ] **P2-11. Root clutter:** `Claude outputs/` and `Mocks/` are untracked in the repo root (AGENTS.md §1). Move them to `docs/archive/` or outside the repo, or add them to `.gitignore`.

## P3: cleanup and test quality

- [ ] **P3-1. `formatClosingDate(null)` returns `'Not Available'`** (`dateParser.ts:170`). The Inbox now checks `closing_date` directly, but other callers (CSV export, copy-summary) still print "Not Available".
- [ ] **P3-2. Fixture privacy:** names without an honorific (Mr., Engr., Dr.…) are not removed by `scripts/capture-portal-fixture.ts`. Review the 11 captured `tests/fixtures/portals/*/page.html` by hand before the repo is shared.
- [ ] **P3-3. `psdf` fixture is 109 KB** (target 50 KB). Lower `MAX_ROWS` for that portal or trim per listing.
- [ ] **P3-4. No fixtures for `ungm`** (needs Playwright) or for `kppra`/`gilgit` (offline). Add a Playwright capture path when those portals are worked on.
- [ ] **P3-5. FDE contract covers listings only.** Its Download-Manager documents sit on detail pages, which the contract test doesn't exercise. Add a detail-page fixture.
- [ ] **P3-6. Slow tests on Google Drive.** The Vite-startup route test needs `--testTimeout=30000` (used by `npm run verify`), and the UI suite sometimes fails to start workers under load. Plain `npm test` can show false timeouts.

## Environment notes (not bugs, but they cost time)

- **`npm install` inside the Google Drive folder writes 0-byte files** (seen 2026-11-10 with `pdfjs-dist` and `mammoth`). Workaround used: install into a local temp folder and copy the packages into `node_modules` (robocopy). Long-term fix: keep `node_modules` (or the whole repo) outside Google Drive.
- The worktree setup can't link `node_modules` (Drive doesn't support junctions); tests run in a worktree resolve the parent checkout's `node_modules`.
