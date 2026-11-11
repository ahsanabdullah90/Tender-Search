> [!NOTE]
> **HISTORICAL ARTIFACT (CODE FIXES COMPLETE IN v1.5.0)**
> The code changes described in this document were made and verified in v1.5.0 (November 11, 2026) with 525 automated unit and integration tests. Three items are still open and are tracked in `docs/14-active-backlog.md`: the `D4` full-scan check on live data, the `P1-5` PDF benchmark, and the `P1-6` threshold calibration.
> For active system specifications, architecture, and current backlog, consult the canonical documentation in `docs/01` through `docs/14`.


# 16. Deep Audit: Logic Flaws in Ingest, Deadlines, Dedup and Retention

**Created:** 2026-11-11
**Code baseline:** working tree of 2026-11-11 (uncommitted changes on top of `f58bd18`). All line numbers refer to that tree.
**Scope:** scan → parse → match → dedup → store → document worker → retention → Inbox display. Read after `docs/14` and `docs/15`.

## How this was verified

| Method | What it covers |
| :-- | :-- |
| Code reading | Every item below cites file and line. |
| Runtime scripts | Run against the project's own modules with a sandbox `TENDER_DATA_DIR`. Results are quoted under **Verified** in each item. |
| Live database (read-only) | `data/tender_tracker.db` was opened with `readonly: true`; nothing was written. Results are quoted under **Live data**. |
| Test suite | `npx vitest run`: 34 files, 491 tests, all passing. None of the flaws below is caught by an existing test. |

## Live data snapshot (2026-11-11)

- 49 tenders: 38 `New Opportunity`, 2 `Under Review`, 9 `Passed`. 33 of 49 (67%) have no closing date.
- 27 of 49 (55%) come from one aggregator (`tender_services`).
- Last full scan (2026-11-10): only 7 of 16 portals produced items. 5 failed with timeouts (`punjab_eproc`, `ungm`, `peef`, `gilgit`, `ignite`), 2 are `selector_broken` (`kppra`, `psda`), `sppra` returned 0, `epads` needs login.
- 28 of 49 tenders list their **own** portal under "Also listed on" (see B1).
- 0 `corrigendum_logs` rows and 0 `needs_review` flags exist, so deadline-change handling has never run on live data.
- 7 document jobs are queued and never processed (attempts = 0).
- 7 suppression records, all with `closing_date = NULL`, so all are permanent (see A2 and B8).

## Summary

| ID | Issue | Effect | Severity | Status |
| :-- | :-- | :-- | :-- | :-- |
| A1 | A re-scan can switch an existing tender to `staging` and then delete it | Tenders vanish from Inbox **and Pipeline**; documents re-downloaded every scan | Critical | Fixed in code & verified by tests |
| A2 | Retention and the Inbox contradict the ingest rules for undated tenders | Accepted tenders are hidden on arrival and deleted within minutes, then suppressed permanently | Critical | Fixed in code & verified by tests |
| A3 | Title-similarity dedup merges different tenders from the same portal | Second tender never shown | Critical | Fixed in code & verified by tests |
| A4 | Duplicate path copies one tender's deadline onto another | Wrong deadline and false corrigendum | Critical | Fixed in code & verified by tests |
| A5 | Re-scan upsert silently overwrites `closing_date` in both directions | Verified deadlines replaced, moved earlier with no flag | Critical | Fixed in code & verified by tests |
| A6 | A lone unlabeled date in a listing row becomes the closing date | Publication date used as deadline; tender suppressed or expired | Critical | Fixed in code & verified by tests |
| A7 | Leftmost closing-type label wins in listing rows | "Submission of queries" date used as deadline | High | Fixed in code & verified by tests |
| A8 | Military time ("1100 hrs") read as 00:00 | Deadline 11 hours early; can auto-expire on the last morning | High | Fixed in code & verified by tests |
| A9 | Normal bidding documents detected as corrigendum and as cancellation | Deadline locked to wrong source; false "cancelled" flag | High | Fixed in code & verified by tests |
| A10 | Detail-page date enrichment reads the whole page | Any date on the page (footer, news) becomes the deadline | High | Fixed in code & verified by tests |
| A11 | `parseDateString` turns non-dates ("12", "Lot 3") into year-2001 dates | Past deadline, silent suppression | High | Fixed in code & verified by tests |
| B1 | Own portal recorded as a secondary source | 57% of rows mislabelled; real same-portal merges leave no trace | High | Fixed in code & verified by tests |
| B2 | Passed tenders are wiped after 2 minutes | Notes, documents and corrigenda lost; contradicts `docs/06` | High | Fixed in code & verified by tests |
| B3 | Four different deadline-resolution code paths | Analyze/Refresh ignore corrigendum and provenance rules | High | Fixed in code & verified by tests |
| B4 | Downloads ignore `Content-Type`; extension taken from label | Images never OCR'd; HTML error pages sent to Vision; false "(Updated)" files | Medium | Fixed in code & verified by tests |
| B5 | Logos and stamps collected as tender documents | Stamp image is the tender's link and is sent to Vision | Medium | Fixed in code & verified by tests |
| B6 | Portal coverage collapses silently | 9 of 16 portals produced nothing; stale counts shown | High | Fixed in code & verified by tests |
| B7 | Startup daily health check is a no-op | Offline portals are never re-checked when a catch-up scan starts | Medium | Fixed in code & verified by tests |
| B8 | A transient download failure suppresses a tender permanently | Tender never comes back | Medium | Fixed in code & verified by tests |
| C1 | Reference-number matching is inconsistent and too broad | Misses real matches and spans Passed/staging rows | Medium | Fixed in code & verified by tests |
| C2 | Navigation rows ingested as tenders | Junk row scores 80, top of "score" sort | Medium | Fixed in code & verified by tests |
| C3 | Gemini calls outside any budget | Cost and quota exhaustion | Low | Fixed in code & verified by tests |
| C4 | HTML decoded chunk-by-chunk as UTF-8 | Corrupted non-ASCII text | Low | Fixed in code & verified by tests |

`docs/15` status: F1 through F7 are all fixed in code and verified by unit/integration tests and live database audit. Total test suite expanded to 525 passing tests across 34 test files.

---

## A1. A re-scan can switch an existing tender to `staging` and then delete it

**Where**
- `src/server/scrapers/crawlerEngine.ts:1471-1506`: when the item has no closing date (or its link is a document) and has document candidates, `upsertScrapedTender` is called with `ingestion_status: 'staging'`, `doc_fetch_status: 'pending'` and `cached_dossiers: []`. No check is made for an existing row with the same `tenderId`.
- `src/server/db/repositories/tendersRepo.ts:750-783` (`ON CONFLICT(id) DO UPDATE`): `ingestion_status = excluded.ingestion_status` (line 777) and `doc_fetch_status = excluded.doc_fetch_status` (line 780) overwrite the existing row. `pipeline_status` is kept, so this applies to `Under Review`, `Preparing Bid`, `Submitted` and `Won` rows too.
- `src/server/db/repositories/tendersRepo.ts:818-820` (`deleteStagedTender`): `DELETE FROM tenders WHERE id = ? AND ingestion_status = 'staging'`. After the line above, that matches the existing row.
- Called on rejection at `crawlerEngine.ts:1562` (B6), `:1587` (B6b) and `:1597` (B6c).
- `src/server/db/repositories/tendersRepo.ts:650-655` (`findDedupCandidates`): undated tenders are only dedup candidates for 14 days after `created_at`. After that, a re-scan of the same undated tender is not matched as a duplicate and reaches the code above.
- `NOT_STAGING_SQL` (`tendersRepo.ts:18`) hides `staging` rows from Inbox, Pipeline and KPIs while the upfront fetch runs.

**Failure scenario**
1. Undated tender T with a PDF link is ingested on day 0 and moved to `Under Review`.
2. On day 15, a scan lists T again. Dedup does not consider it (more than 14 days old), so the item takes the insert path with the same `tenderId`.
3. The staging upsert switches T to `ingestion_status = 'staging'`; T disappears from the Pipeline during the fetch.
4. If B6b or B6c rejects the item, `deleteStagedTender` deletes T, including its notes and pipeline stage, and records a suppression.
   - B6c is triggered by the year change: from 1 January 2027, a title mentioning "2026" only "references prior years" (`crawlerEngine.ts:1596`).
   - B6b is triggered when the upload folder is over 90 days old and no document text was read (see B8 for why that is true whenever downloads fail).
5. If not rejected, the final upsert (`:1611-1643`) sets `cached_dossiers` to only the documents fetched in this pass (`tendersRepo.ts:768-771`). Documents the worker fetched earlier and files the operator uploaded drop out of the list.

Even without deletion, every scan re-downloads and re-reads up to 2 documents per undated tender older than 14 days, spending scan time and the Vision budget.

**Possible solution**
1. Before the dedup call (`crawlerEngine.ts:1371`), compute `tenderId` and load the row with `getTenderById`. If it exists, treat the item as a re-scan of that row: append nothing, apply deadline changes through one function (see A5), queue new attachments, and return `isNew: false`. Never run the staging or upfront path for an existing row.
2. In `upsertScrapedTender`, never lower an existing row to `staging`: use `ingestion_status = CASE WHEN tenders.ingestion_status = 'ready' THEN 'ready' ELSE excluded.ingestion_status END`.
3. Make `deleteStagedTender` delete only rows inserted by the current call: add `AND pipeline_status = 'New Opportunity' AND created_at >= ?` (the call's start time), or track "inserted by me" in a local variable.
4. Merge `cached_dossiers` by `sha256` instead of replacing the list.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts` (`processAndSaveTender`)
- `src/server/db/repositories/tendersRepo.ts` (`upsertScrapedTender`, `deleteStagedTender`)
- `tests/scraper/` (new: re-scan of an `Under Review` undated tender older than 14 days keeps the row, its stage and its dossiers; re-scan with B6c triggered does not delete it)

**Done when**
A re-scan never changes `ingestion_status`, `pipeline_status` or the dossier list of an existing row, and no code path can delete a row whose `pipeline_status` is not `New Opportunity`.

---

## A2. Retention and the Inbox contradict the ingest rules for undated tenders

**Where**
- Ingest rule B6b, `crawlerEngine.ts:1578-1593`: an undated tender whose publish date is only inferred from an upload folder (`/uploads/2026/07/`) and is over 90 days old is **kept** if a document could be read ("old uploads are often reused as templates for new notices"). The inferred date is stored as `publish_date` (`:1628`).
- Retention, `tendersRepo.ts:354-355` (`getExpiredUnreviewedTenderIds`): deletes undated `New Opportunity` rows when `COALESCE(publish_date, created_at)` is over 90 days old. Runs every 5 minutes (`scheduler.ts:44-54`).
- Inbox, `src/components/InboxScreen.tsx:1134-1135` (`isClosedUntracked`): hides undated rows when `publish_date || created_at` is over **60** days old.
- `deleteTenders(..., 'auto-expired')` records a suppression with the row's `closing_date`, which is `NULL` (`tendersRepo.ts:272-276`). `cleanExpiredDeletedTenderRecords` never removes undated suppressions (`closing_date IS NOT NULL` condition).

**Failure scenario**
- Inferred publish date 61-90 days old: the tender is inserted but hidden in the Inbox immediately ("Show closed" must be on to see it).
- Inferred publish date over 90 days old with a readable document: B6b accepts it, the next retention cycle (within 5 minutes) deletes it, and the suppression is permanent. The B6b exception never takes effect.
- `inferPublishDateFromUrl` returns the **last** day of the folder month (`dateParser.ts:378-386`), so this is an upper bound, yet it is used as if it were the real publish date.

**Live data**: all 7 suppression records have `closing_date = NULL` (permanent).

**Possible solution**
1. Store the inferred date separately (`publish_date_inferred` column, or `publish_date_source = 'upload_folder'`), and do not use it for ageing in retention or in `isClosedUntracked`; use `created_at` for undated rows whose publish date is only inferred.
2. Use one ageing constant shared by B6b, retention and the Inbox (for example `UNDATED_MAX_AGE_DAYS = 90` exported from one module and returned by `/api/settings`).
3. Give undated suppressions an expiry (for example 120 days after `deleted_at`), so they cannot be permanent.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts`, `src/server/scrapers/dateParser.ts`
- `src/server/db/repositories/tendersRepo.ts` (`getExpiredUnreviewedTenderIds`, `cleanExpiredDeletedTenderRecords`, `isTenderSuppressed`)
- `src/server/db/schema.ts` (new column)
- `src/components/InboxScreen.tsx` (`isClosedUntracked`)
- `tests/db/`, `tests/ui/`

**Done when**
A tender accepted by B6b is visible in the Inbox and still present after one retention cycle, and an undated suppression expires.

---

## A3. Title-similarity dedup merges different tenders from the same portal

**Where**
- `src/server/deduplicator.ts:108-125` (Tier 2): compares `organization + ' ' + title` with Dice bigram similarity, threshold 0.85.
- For most parsers `organization` is the portal name (for example `crawlerEngine.ts` sets `organization: portal.name` in the NDMA, FDE, PSDF, UNGM and generic branches). Two rows from the same portal therefore share a long identical prefix, which inflates the score.
- `src/server/deduplicator.ts:127-140` (Tier 3): `orgSim >= 0.50` is always true for the same portal, so only the 0.88 semantic threshold separates two tenders (P1-6, uncalibrated).
- Candidates (`tendersRepo.ts:641-656`): any tender closing within ±1.5 days, or any undated tender from the last 14 days. Both are common within one portal (same-day deadlines, undated PDF lists).
- Candidates include `Passed`, slimmed and `staging` rows.

**Verified** (Dice on `"Punjab Skills Development Fund (PSDF) " + title`):

| Title A | Title B | Score |
| :-- | :-- | :-- |
| Supply of Laptops | Supply of Printers | 0.857 |
| Hiring of Training Providers for Graphic Design | Hiring of Training Providers for Web Design | 0.925 |
| Procurement of Furniture for Lahore Office | Procurement of Furniture for Multan Office | 0.909 |

All three pairs are distinct tenders and all exceed 0.85.

**Failure scenario**
PSDF lists "Supply of Laptops" and "Supply of Printers", both undated (or both closing the same day). The second is treated as a duplicate of the first. Because both come from the same portal, `appendSecondarySource` writes nothing (B1), so the second tender leaves no trace anywhere.

**Possible solution**
1. Compare titles only (normalised), not `organization + title`. Compare organisations separately as a gate.
2. For two items from the **same portal**, never merge on similarity: within one portal, identity is `directUrl` (or reference number). Similarity dedup is only for cross-portal duplicates.
3. Require a distinguishing-token check: if the two titles differ in a content word that is not a stop word (laptops vs printers, Lahore vs Multan), do not merge, whatever the score.
4. Exclude `Passed` and `staging` rows from the candidate set, or merge into them only with an exact reference match.

**Affected files**
- `src/server/deduplicator.ts`
- `src/server/db/repositories/tendersRepo.ts` (`findDedupCandidates`)
- `tests/unit/` (the three pairs above stay separate; a true cross-portal duplicate still merges)

**Done when**
The three pairs above are inserted as separate tenders, and the same tender listed on PSDF and on Tender Services is merged.

---

## A4. Duplicate path copies one tender's deadline onto another

**Where**
- `src/server/scrapers/crawlerEngine.ts:1415-1426`: whenever dedup reports a duplicate and the scanned date is later than the stored date, `applyDuplicateDeadlineExtension` sets the existing tender's `closing_date`, sets `has_corrigendum = 1` and writes a `deadline_extension` corrigendum log.
- `src/server/db/repositories/tendersRepo.ts:685-708`: no check of `deadline_source`, of which portal reported the date, or of match confidence. `deadline_source` and `deadline_confidence` are not updated.

**Failure scenario**
- With a false merge (A3, or F3's fake references such as `Jun-2026`), tender A's deadline is replaced by unrelated tender B's later deadline, and the operator sees a corrigendum that never existed.
- With a true merge, a secondary listing (for example an aggregator showing the bid opening date, or a stale copy) overrides a deadline the primary tender document set (`deadline_source = 'corrigendum_doc'`). This bypasses the rule in `resolveCanonicalDeadline` that only a newer corrigendum can change a corrigendum-set deadline (`dateParser.ts:332-335`).

**Possible solution**
1. Route every deadline change through `resolveCanonicalDeadline` with the scanned date as an `html_row` signal and the stored `deadline_source` as the known source, then apply its result (extension → log; earlier → review flag; corrigendum-locked → no change).
2. Apply a listing date to an existing tender only when the listing comes from the tender's own portal, or when the match is an exact reference or URL match; for similarity matches, record the other date in `secondary_sources` instead.
3. Update `deadline_source` / `deadline_confidence` whenever `closing_date` changes.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts`, `src/server/db/repositories/tendersRepo.ts`, `src/server/scrapers/dateParser.ts`
- `tests/scraper/` (a cross-portal similarity duplicate with a later date does not change a `corrigendum_doc` deadline)

**Done when**
`closing_date` on an existing row is written in exactly one function, and that function applies the same rules as `resolveCanonicalDeadline`.

---

## A5. Re-scan upsert silently overwrites `closing_date` in both directions

**Where**
- `src/server/db/repositories/tendersRepo.ts:753-757`: `closing_date = COALESCE(excluded.closing_date, tenders.closing_date)` and the matching `closing_date_formatted`.
- `:778-779`: `deadline_source` and `deadline_confidence` take the new value (`html_row`) whenever one is given.
- Reached whenever an existing row is re-scanned through the insert path: F4 (date moved more than 1.5 days), A1 (undated after 14 days, then dated), or after a false-negative dedup.

**Failure scenario**
- Listing date moves later: the deadline changes, but no `corrigendum_logs` row is written and `has_corrigendum` is unchanged, so the operator is not told.
- Listing date moves earlier (or the listing parser picks a different date, see A6/A7): the deadline moves earlier with no `needs_review` flag. This contradicts `docs/14` P1-4 and `docs/06` §3, which say an earlier deadline is flagged and the old one kept. If the new date is past, retention deletes the tender 2 days later.
- A deadline read from a corrigendum document (`deadline_source = 'corrigendum_doc'`) is replaced by a listing date and relabelled `html_row`.

Also, `processAndSaveTender` returns `isNew: true` on this path (`crawlerEngine.ts:1656`), and `hasCorrigendum` ignores `resolved.isExtension`, so scan counters are wrong.

**Possible solution**
1. Remove `closing_date`, `closing_date_formatted`, `deadline_source` and `deadline_confidence` from the `ON CONFLICT` update. Deadlines of existing rows change only through the single function described in A4.
2. Implement A1 step 1 (existing-row lookup first) so the upsert is only ever an insert of a new row.
3. Return `isNew: false` for an existing row and `hasCorrigendum: true` when an extension was logged.

**Affected files**
- `src/server/db/repositories/tendersRepo.ts`, `src/server/scrapers/crawlerEngine.ts`
- `tests/scraper/` (re-scan with an earlier listing date keeps the stored date and sets `needs_review`; re-scan with a later date logs a corrigendum)

**Done when**
No re-scan can change `closing_date` without either a corrigendum log or a review flag.

---

## A6. A lone unlabeled date in a listing row becomes the closing date

**Where**
- `src/server/scrapers/dateParser.ts:419-424` (`extractDatesFromText`): when exactly one date is found and no "closing/submission/…" label precedes it, it is returned as `closingDate`.
- Used by every parser branch in `crawlerEngine.ts` (`parsePortalHtml`, lines 432-923).

**Verified**

| Row text (end) | Result |
| :-- | :-- |
| `… hybrid solar system Jang November 01, 2026 Details` | `closingDate: 2026-11-01` |
| `… removal of snow Thenews November 05 2026 Details` | `closingDate: 2026-11-05` |
| `… Jang November 01,2026 Details` (no space after comma) | no date (missed only by accident of formatting) |

The dates above are the newspaper **publication** date on Tender Services, the largest live source (55% of tenders).

**Failure scenario**
A notice published today with a single unlabeled date gets that date as its deadline. If the scan runs after 14:00 PKT that day (the default time), B6 at ingest (`crawlerEngine.ts:1557-1568`) sees a past deadline with no document signal, so `canAutoExpire` is true: the tender is suppressed and never shown. Otherwise it appears with a deadline of "today" and retention deletes it 2 days later, while bids are still open.

**Possible solution**
1. A single unlabeled date is a **publish** date candidate, not a closing date: return `{ publishDate: date, closingDate: null }`. Only treat it as closing if it is labelled, or if it is in a column whose header says closing/last date.
2. For table layouts, read the header row (`thead th`) once and map columns by header text (closing / last date / due → closing; published / issue / advertised → publish), instead of guessing from row text.
3. Add a per-portal `dateHints` field in `PortalDefinition` (for example `tender_services: { singleDate: 'publish' }`).

**Affected files**
- `src/server/scrapers/dateParser.ts`, `src/server/scrapers/crawlerEngine.ts`, `src/server/scrapers/portalList.ts`
- `tests/unit/` (cases in the table), `tests/scraper/portal-contracts.test.ts` (Tender Services fixture: no closing dates from publication dates)

**Done when**
A row whose only date is a publication date is stored as undated with that `publish_date`.

---

## A7. Leftmost closing-type label wins in listing rows

**Where**
- `src/server/scrapers/dateParser.ts:395` and `:398`: `closingLabelRegex` matches the first of `closing|submission|dead line|due|last` followed by a date within ~20 characters; the first match in the row wins and the function returns immediately (`:404-406`).
- The document extractor has a context filter for this (`NON_SUBMISSION_CONTEXT`, `documentExtractor.ts:158`); the listing parser does not.

**Verified**
`Submission of queries: 01-12-2026 Closing date: 20-12-2026` → `closingDate: 2026-12-01` (should be 2026-12-20).

**Failure scenario**
Rows that list a queries/clarification deadline, a pre-bid date or a sale-of-documents date before the closing date get the earlier date as the deadline. The tender shows the wrong deadline and is auto-deleted after that date + 2 days.

**Possible solution**
1. Collect **all** labelled matches, drop those whose label text contains `quer|clarif|pre[- ]?bid|sale|purchase|issue|opening|validity|meeting`, and take the latest remaining labelled date.
2. Reuse the anchor lists from `documentExtractor.ts` (`SUBMISSION_ANCHOR`, `NON_SUBMISSION_CONTEXT`) by moving them into `dateParser.ts` and importing them in both places.

**Affected files**
- `src/server/scrapers/dateParser.ts`, `src/server/documentExtractor.ts`
- `tests/unit/`

**Done when**
The verified example returns 2026-12-20.

---

## A8. Military time ("1100 hrs") read as 00:00

**Where**
- `src/server/documentExtractor.ts:161` (`TIME_RE`): `(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|hrs|hours)`. On "1100 hrs" the regex cannot match "11" (followed by "00", not a separator), so it matches "00 hrs": hour 0.
- `:163-179` (`combineDateAndTime`) then sets the deadline to 00:00 PKT that day.
- `dateParser.ts:345-348`: on the same PKT day, a document time beats the listing time, so the wrong 00:00 replaces a correct listing time.

**Verified**

| Document text | Result (UTC) | PKT |
| :-- | :-- | :-- |
| `on or before 15-12-2026 at 1100 hrs` | `2026-12-14T19:00:00Z` | 15 Dec 00:00 (should be 11:00) |
| `15-12-2026 at 1430 hrs` | `2026-12-15T09:00:00Z` | 14:00 default ("30 hrs" rejected; should be 14:30) |
| `15-12-2026 at 11:00 AM` | `2026-12-15T06:00:00Z` | 11:00 (correct) |

**Failure scenario**
"HHMM hrs" is a common format in Pakistani notices. The deadline is shown 11 hours early. On the deadline day, any scan or worker pass after midnight sees the deadline as past; because a single anchored date gives `confidence: 'high'` and `canAutoExpire: true` (`documentExtractor.ts:398`), the tender is deleted on its last morning while bids are still being accepted.

**Possible solution**
1. Add a 4-digit alternative first: `\b([01]\d|2[0-3])([0-5]\d)\s*(?:hrs|hours|h)\b` → hour and minute from the two pairs.
2. Require a word boundary before the hour in the existing pattern: `(?<!\d)(\d{1,2})`.
3. Never auto-expire before the end of the PKT calendar day of a deadline whose time came from a regex (time is less reliable than the date).

**Affected files**
- `src/server/documentExtractor.ts`, `src/server/scrapers/dateParser.ts`
- `tests/unit/` (the three cases above, plus "1700 hours", "11.00 a.m.")

**Done when**
"1100 hrs" gives 11:00 PKT and "1430 hrs" gives 14:30 PKT.

---

## A9. Normal bidding documents detected as corrigendum and as cancellation

**Where**
- `src/server/documentExtractor.ts:240-244` (`detectCorrigendum`): the words `amendment` or `addendum` anywhere in the first 800 characters mark the whole document as a corrigendum.
- `:246-248` (`detectCancellation`): `(tender|bid|…)` within 80 characters of `is|has been … withdrawn|cancelled`.
- `:395`: `isCancellation = docType === 'corrigendum' && detectCancellation(text)`.

**Verified** on a typical Standard Bidding Document opening:
`STANDARD BIDDING DOCUMENT Table of Contents 1. Instructions to Bidders 8. Amendment of Bidding Documents 23. Bid Security: … forfeited if the bid is withdrawn …`
→ corrigendum detected: **true**; cancellation detected: **true**.

**Failure scenario**
- The original bidding document becomes a `corrigendum_doc` signal. In `resolveCanonicalDeadline` (`dateParser.ts:336-341`) a corrigendum's date wins even if earlier, and once stored, only another corrigendum can change it (`:332-335`). A later genuine extension on the listing is then handled only by the duplicate path (A4).
- The tender is flagged `corrigendum_cancelled`, and the review banner shows a red **Pass as cancelled** button (`InboxScreen.tsx`, P2-5) for a tender that is open.

**Possible solution**
1. Detect a corrigendum from the **title/heading** only: the first non-empty line(s), or the first 200 characters, must start with or contain `corrigendum|addendum|amendment no|extension in (closing|due|last) date`. Ignore table-of-contents lines (a line ending in a page number, or containing "Table of Contents").
2. Detect cancellation only in corrigendum documents identified by step 1, and require the subject to be the tender itself: `(this|the above|subject|captioned)\s+(tender|bid|procurement|nit|rfp)\s+(is|has been)\s+(hereby\s+)?(cancel+ed|withdrawn)`. Never match `if the bid is withdrawn`.
3. Use the URL/label (`documentJobPriority`, `inferDocType`) as a second signal and require both to agree before treating a document as a corrigendum.

**Affected files**
- `src/server/documentExtractor.ts`
- `tests/unit/` (SBD table-of-contents sample → not corrigendum, not cancelled; real corrigendum and real cancellation notices → detected)

**Done when**
The verified sample is classified as a primary document with no cancellation.

---

## A10. Detail-page date enrichment reads the whole page

**Where**
- `src/server/scrapers/crawlerEngine.ts:1099-1121` (`scrapePortal`, undated-item enrichment): line 1105 selects `'.date-box, [class*="date"], [class*="meta"], *:contains("Create Date"), *:contains("Creation Date")'` and takes `.text()` of all matches.
- In Cheerio, `*:contains("Create Date")` matches every ancestor of the text, including `<html>` and `<body>`, so the text of the entire page is passed to `extractDatesFromText`, which (with no closing label) takes the **latest** date on the page as the closing date.
- This fetch also uses `fetchHtmlWithTolerantAgent` directly instead of `crawlerDeps.fetchHtml`, so tests cannot stub it.

**Verified**
Page with `<nav>News 02-01-2027</nav> … <span>Create Date: 01-11-2026</span> … <footer>Updated 30-12-2026</footer>`: matched tags `html, body, div, span`; result `closingDate: 2027-01-02` (taken from the navigation bar).

**Failure scenario**
FDE/WPDM-style undated items get a deadline from a news ticker, a footer, another tender's date or a "last updated" stamp. A future date keeps a closed tender in the Inbox; a past date gets it suppressed.

**Possible solution**
1. Use the deepest match only: select elements whose own text contains the label (`$('*').filter((_, e) => $(e).children().length === 0 && /Create Date|Creation Date/.test($(e).text()))`), then read the sibling/next value.
2. Never assign a closing date from a "Create Date"/"Creation Date" label; these are publish dates. Assign closing only from closing-type labels inside the main content (`main, article, .wpdm-*`), with `nav, header, footer, aside` removed first.
3. Call `crawlerDeps.fetchHtml`.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts`
- `tests/scraper/portal-contracts.test.ts` (`fde_detail` fixture: no date taken from outside the package box)

**Done when**
The verified page yields `publishDate: 2026-11-01` and no closing date.

---

## A11. `parseDateString` turns non-dates into year-2001 dates

**Where**
- `src/server/scrapers/dateParser.ts:157-163`: if no pattern matched and the text contains a digit, `new Date(str)` is used. V8 parses many short strings as dates in 2001.
- Called directly on raw cell text, not only on pattern matches: `crawlerEngine.ts:468-469` (NDMA labelled cells), `:861` (`td:nth-child(4), td:nth-child(3)` joined text) and `:865`.

**Verified**

| Input | Result |
| :-- | :-- |
| `"12"` | `2001-11-30T19:00:00Z` |
| `"Lot 3"` | `2001-02-28T19:00:00Z` |
| `"Jun 15"` | `2001-06-14T19:00:00Z` |
| `"15 June"` | `2001-06-14T19:00:00Z` |

**Failure scenario**
A table row whose date cells use a format the patterns miss (for example "15 June" without a year), and whose 3rd/4th cell holds a serial number or lot number, gets a 2001 closing date. B6 rejects it as past and records a suppression. The row is gone with no log entry.

**Possible solution**
1. Remove the `new Date(str)` fallback, or accept its result only if the input contains a 4-digit year and the year is between 2020 and current year + 3.
2. Reject any parsed date outside that window in `normalizeExtractedDate` as well (protects AI/OCR output too).

**Affected files**
- `src/server/scrapers/dateParser.ts`
- `tests/unit/` (the four inputs above return `null`)

**Done when**
The four inputs above return `null`.

---

## B1. Own portal recorded as a secondary source

**Where**
- `src/server/scrapers/crawlerEngine.ts:1385-1389`: on every duplicate match, `appendSecondarySource` is called with the scanning portal.
- `src/server/db/repositories/tendersRepo.ts:666-674`: only checks the existing `secondary_sources` list, not the tender's own `portal_name`.
- A tender matched against itself on its next scan (the normal case) therefore gets its own portal added.
- Displayed as **Also listed on** (`src/components/InboxScreen.tsx:1009-1017`).

**Live data**: 28 of 49 tenders list their own portal under "Also listed on".

**Effect**
The "Also listed on" section is wrong for most tenders. Also, because the own portal is now in the list, a genuinely different tender from the same portal that is wrongly merged (A3) is skipped by the "already present" check, so it leaves no record at all.

**Possible solution**
1. In `appendSecondarySource`, return early when `source.portalName === row.portal_name` (select `portal_name` too).
2. Deduplicate entries by `directUrl`, not by portal name, so two different notices on the same secondary portal are both kept.
3. One-time cleanup: remove entries whose `portalName` equals the row's `portal_name`.

**Affected files**
- `src/server/db/repositories/tendersRepo.ts`, `src/server/db/schema.ts` (cleanup migration)
- `tests/db/`

**Done when**
The live query `json_extract(s.value,'$.portalName') = t.portal_name` returns 0.

---

## B2. Passed tenders are wiped after 2 minutes

**Where**
- `src/server/retention.ts:84-92` and `tendersRepo.ts:327-338`: tenders with `pipeline_status = 'Passed'` are slimmed 2 minutes after `passed_at`.
- `tendersRepo.ts:293-322` (`slimPassedTenders`): deletes corrigendum logs and pipeline audit logs, and sets `cached_dossiers = '[]'`, `description = ''`, `status_notes = ''`, `matched_keywords = '[]'`, `estimated_value = NULL`, `location = NULL`; then deletes the files.
- `tendersRepo.ts:362-371`: the slim record is deleted 10 days after its closing date / pass date.

**Contradiction**
`docs/06-pipeline-and-workflow.md` says Passed records are "preserved with notes for historical intelligence" and shows `Passed → Under Review` ("Operator reopens archived bid"). After 2 minutes, a reopened tender has no notes, no documents, no description and no audit history. `Submitted → Passed` (lost bid) erases the bid notes.

**Possible solution**
1. Slim only tenders passed straight from the Inbox (`New Opportunity → Passed`); keep notes and audit logs for tenders that were ever in the Pipeline.
2. Never clear `status_notes`; purge only files.
3. Make the undo window a setting and show it in the Pass confirmation, or update `docs/06` to describe the actual behaviour.

**Affected files**
- `src/server/db/repositories/tendersRepo.ts`, `src/server/retention.ts`
- `src/components/pipeline/PassConfirmModal.tsx` (wording)
- `docs/06-pipeline-and-workflow.md`
- `tests/db/`

**Done when**
A tender passed from `Submitted` still has its notes after a retention cycle.

---

## B3. Four different deadline-resolution code paths

**Where**

| Path | Function | Rule used |
| :-- | :-- | :-- |
| Scan ingest | `processAndSaveTender` (`crawlerEngine.ts:1524`) | `resolveCanonicalDeadline` (corrigendum rule, review flags, provenance) |
| Background worker | `applyDocumentResultToTender` (`ingestWorker.ts:146-226`) | `resolveCanonicalDeadline` |
| Fetch documents (button) | `fetchDocumentsForTender` (`crawlerEngine.ts:1925`) | `reconcileDeadline` (later wins only) |
| Analyze / Refresh (buttons) | `analyzeTenderById` (`crawlerEngine.ts:2093-2123`) | `reconcileDeadline` (later wins only) |

**Effects of the two `reconcileDeadline` paths**
- A real corrigendum that moves the deadline earlier is ignored (later wins), with no review flag.
- `deadline_source` / `deadline_confidence` are not updated, so the provenance badge stays "Portal listing date" after a document-derived change.
- `analyzeTenderById` overwrites `reference_no` and `description` unconditionally (`:2094-2095`), replacing a correct reference or text with Gemini output.
- Gemini calls here have no budget (see C3).

**Possible solution**
Move "apply a document result to a tender" into one exported function (the worker's `applyDocumentResultToTender` is the closest) and call it from all four paths. Only fill `reference_no` / `description` when empty, as the worker does.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts`, `src/server/ingestWorker.ts`
- `tests/scraper/` (Analyze with a corrigendum moving the date earlier sets `needs_review`)

**Done when**
`reconcileDeadline` has no callers outside tests, or is removed.

---

## B4. Downloads ignore `Content-Type`; extension taken from label

**Where**
- `src/server/dossierManager.ts:92-97`: the filename is the label with unsafe characters replaced; an extension is added only if the label contains no `.`. Labels built from titles (`${item.title.slice(0, 30)}_Doc`, `crawlerEngine.ts:1649`) often contain dots ("P.C.", "Rs.", "No."), so no real extension is added.
- `:289-301` (`getMimeType`): MIME type comes from that filename's extension; unknown → `application/octet-stream`.
- `:236-270` (`fetchFileBuffer`): the response `Content-Type` is never read; an HTML error or login page returned with status 200 is saved as a document.
- `:113-126`: a second, different document with the same label is saved as `_v2_<timestamp>` and labelled "(Updated)", as if the portal had amended it.

**Failure scenario**
- An image notice saved without an image extension gets `octet-stream`. `extractFromDocument` (`documentExtractor.ts:301-304`) treats it as non-visual and returns an empty result without calling Vision, so the deadline is never read.
- An HTML page saved as `.pdf` gets `application/pdf`: pdf.js fails, then the page is sent to Gemini Vision as a PDF, spending budget and failing.
- Two different attachments of one tender appear as "Document" and "Document (Updated)".

**Possible solution**
1. Read `Content-Type` and `Content-Disposition` in `fetchFileBuffer` and return them with the buffer. Reject `text/html` responses as "not a document".
2. Choose the extension from (in order) magic bytes (`%PDF-`, `PK` + `word/`, JPEG/PNG signatures), `Content-Type`, then the URL; never from the label.
3. Mark "(Updated)" only when the same **URL** returns different bytes.

**Affected files**
- `src/server/dossierManager.ts`, `src/server/dossierStore.ts` (if it shares naming)
- `tests/scraper/dossierManager.test.ts`

**Done when**
A JPEG served from a URL without an extension is stored as `image/jpeg`, and an HTML 200 response is rejected.

---

## B5. Logos and stamps collected as tender documents

**Where**
- `src/server/scrapers/crawlerEngine.ts:397-427` (`collectRowAttachments`, exclusion list at line 419): any `<img>` in a row whose `src` does not contain `logo|icon|avatar|spinner|zoom-onhover|banner|flag|placeholder|download-icon` is treated as a notice image.
- BPPRA branch (`crawlerEngine.ts:658`): `directUrl = attachmentUrls[0] || portal.tendersUrl`, so the first image becomes the tender's link. The same pattern is used at lines 603 (PSDF boxes) and 725 (GBPPRA cards).

**Live data**: tender `tender-bppra-e0ca74c11db2e8ad` ("Provision two Buses for Govt: Girls Inter College…") has `direct_url = https://bpptwo.vdc.services:5451/img/E-Procurement-stamp.png`, and that image is queued as a document job.

**Effect**
"Open on portal" opens a stamp image; the worker will send the stamp to Gemini Vision; the BOQ PDF is used as the link for other BPPRA rows instead of the notice.

**Possible solution**
1. Only collect images that are inside a link (`a[href] > img`) or whose `src` is under an uploads/notice path; skip images under `/img/`, `/images/` site-chrome folders and those used on more than one row of the same page.
2. For BPPRA, use the row's notice/detail link as `directUrl` and keep documents in `attachmentUrls`.
3. Add `stamp|seal|badge|watermark` to the exclusion list.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts`
- `tests/scraper/portal-contracts.test.ts` (BPPRA fixture: no `/img/` URLs in attachments or `directUrl`)

**Done when**
No live or fixture tender has an image under `/img/` as `direct_url` or attachment.

---

## B6. Portal coverage collapses silently

**Where**
- `src/server/scrapers/crawlerEngine.ts:1049-1070` (`scrapePortal`): one fetch attempt per scan; a timeout throws and the portal is marked `error` (`:212-219`). There is no retry, and (correctly, per AGENTS.md §2 Rule 1) no auto-heal on timeouts.
- `:202-210` / `:214-219`: on `error`, `last_items_found` is not reset, so the Sources screen keeps showing the count from an older successful scan.
- A Playwright failure is swallowed (`:1019-1047`) and the portal silently falls back to plain HTTP, which returns no rows for JavaScript-rendered portals.

**Live data** (last full scan, 2026-11-10)

| Outcome | Portals |
| :-- | :-- |
| Produced items | `bppra`, `fde`, `mofept`, `ndma`, `psdf`, `pseb`, `tender_services` |
| Timeout (`ETIMEDOUT`) | `punjab_eproc` (described as "Top provincial source"), `ungm`, `peef`, `gilgit`, `ignite` |
| 0 items | `sppra` (2 scans in a row), `kppra` and `psda` (`selector_broken`, 7 in a row) |
| Login needed | `epads` |

Errored portals still show `last_items_found` of 5, 3, 2, 1.

**Possible solution**
1. Retry a timed-out fetch once or twice with backoff (for example 30 s, then 2 min) within the scan, without auto-heal.
2. On `error`, set `last_items_found = 0` and record `last_success_at` separately, so the Sources screen shows "last success N hours ago".
3. Log and surface Playwright launch failures (`playwright_status` on the portal), and do not fall back silently for portals marked `tier: 'playwright'`.
4. Add a scan summary to the Inbox header: "N of M sources checked successfully", with a warning when below a threshold.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts`, `src/server/db/repositories/portalsRepo.ts`, `src/server/db/schema.ts`
- `src/components/SourcesScreen.tsx`, `src/components/KpiHeader.tsx`
- `tests/scraper/`

**Done when**
A portal that times out once and then responds is scanned successfully in the same run, and an errored portal shows 0 items found plus its last success time.

---

## B7. Startup daily health check is a no-op

**Where**
- `src/server/scheduler.ts:66`: `checkAndTriggerCatchUpScan()` starts a full scan (not awaited). `startCrawlerScan` sets `isScanning = true` synchronously, before its first `await`.
- `:69`: `runDailyPortalHealthAdvisement()` immediately calls `startCrawlerScan(portal.id, true)` for each problem portal (`:129-148`). Each call returns at once because a scan is running (`crawlerEngine.ts:128-130`); nothing is checked.
- `:130`: `lastDailyHealthCheck = Date.now()` is set anyway, so the next attempt is 24 hours later, and it fails the same way if a scan is running then.

**Effect**
Portals marked `offline_broken` (excluded from full scans) are effectively never re-checked, so a restored portal is not noticed.

**Possible solution**
1. Run the health check after the catch-up scan finishes (await it, or queue the portals to run once `isScanning` becomes false).
2. Set `lastDailyHealthCheck` only after at least one portal was actually checked.
3. Better: include `offline_broken` portals in one full scan per day instead of a separate mechanism.

**Affected files**
- `src/server/scheduler.ts`
- `tests/` (scheduler: health check runs after a catch-up scan)

**Done when**
After startup with a catch-up scan, each `offline_broken` portal has a `last_scan_at` from that day.

---

## B8. A transient download failure suppresses a tender permanently

**Where**
- `src/server/scrapers/crawlerEngine.ts:1584-1585` (B6b): `stale` is true when the inferred upload-folder date is over 90 days old **and** `upfront.extractions.every(e => e.result.textChars === 0 && !e.result.closingDateISO)`.
- When all downloads fail or time out, `upfront.extractions` is empty, and `[].every(...)` is `true`. When the scan's upfront time budget is spent (`runUpfront = false`), it is also empty.
- `:1590`: `recordTenderSuppression(tenderId, canonicalId, null)`; undated suppressions never expire (A2).

**Failure scenario**
A new tender whose PDF lives in an upload folder older than 90 days (organisations reuse folders and templates; the code comment acknowledges this) is rejected because its server was slow during that scan, and is never imported again.

**Possible solution**
1. Treat "no extraction because nothing was downloaded" as unknown, not as "no text": require `upfront.extractions.length > 0` before using the `every` condition.
2. When the decision is unknown, insert the tender as normal and let the worker decide, instead of suppressing.
3. Give undated suppressions an expiry (A2 step 3).

**Affected files**
- `src/server/scrapers/crawlerEngine.ts`
- `tests/scraper/ingest-queue.test.ts` (download timeout on an old-folder PDF → tender inserted with `doc_fetch_status = 'pending'`, no suppression)

**Done when**
A timed-out download never produces a suppression record.

---

## C1. Reference-number matching is inconsistent and too broad

**Where**
- `src/server/deduplicator.ts:90-91`: the candidate reference is normalised by removing `-`, `/`, `_` and all whitespace.
- `src/server/db/repositories/tendersRepo.ts:625-630`: the stored reference is normalised by removing only `-`, `/` and space. References containing `_`, tabs or line breaks never match.
- The query runs over all tenders, including `Passed`, slimmed and `staging` rows, and matches across all portals with no other check (F3).

**Possible solution**
1. Store a `reference_norm` column computed in JavaScript with one function, index it, and query by equality.
2. Combine with F3 (corroborating signal) and A3 step 4 (exclude `Passed`/`staging`, or treat a match with a `Passed` row as "already decided" explicitly).

**Affected files**
- `src/server/deduplicator.ts`, `src/server/db/repositories/tendersRepo.ts`, `src/server/db/schema.ts`
- `tests/unit/`

---

## C2. Navigation rows ingested as tenders

**Where**
- `src/server/scrapers/crawlerEngine.ts:791` onwards (generic table/row branch): any row of 20+ characters outside `nav/header/footer/aside` becomes an item. The category-link filter (`:821`) matches only exact link texts such as "All Newspapers".

**Live data**: row "All Newspapers Dawn News Express Nawaiwaqt The News The Nati…" (`direct_url = https://tenderservice.pk`) matched 4 tracks with `match_score = 80`, the highest score in the Inbox.

**Possible solution**
1. Drop items whose `directUrl` equals the portal's base or listing URL and that have no date, reference or attachment.
2. Drop items whose title is mostly a list of known newspaper/category names, or add a per-portal row selector for `tender_services` instead of relying on the generic branch.

**Affected files**
- `src/server/scrapers/crawlerEngine.ts`, `src/server/scrapers/portalList.ts`
- `tests/scraper/portal-contracts.test.ts`

---

## C3. Gemini calls outside any budget

**Where**
- `src/server/documentExtractor.ts:351-380`: a Gemini text cross-check runs for every document whose local reading is not `high` confidence; no budget applies.
- `crawlerEngine.ts` `fetchDocumentsForTender` and `analyzeTenderById` call `extractFromDocument` without `allowVisionCall`, so Vision is unlimited there; `analyzeTenderById` also calls `summarizeTenderTextWithAI`.
- `src/server/ingestBudget.ts:71-79`: outside a scan, `tryConsumeScanVision` always returns `true`.

**Possible solution**
Count every Gemini call (text and Vision) against the daily counter in `ingestBudget.ts`, and show the total on the Data tab.

**Affected files**
- `src/server/documentExtractor.ts`, `src/server/ingestBudget.ts`, `src/server/scrapers/crawlerEngine.ts`

---

## C4. HTML decoded chunk-by-chunk as UTF-8

**Where**
- `src/server/scrapers/crawlerEngine.ts:1182` (`fetchHtmlWithMetadata`): `data += chunk` converts each chunk to a string separately. A multi-byte character split across two chunks becomes two replacement characters. The `charset` in `Content-Type` / `<meta>` is ignored.

**Possible solution**
Collect `Buffer` chunks, `Buffer.concat`, then decode once using the declared charset (default UTF-8).

**Affected files**
- `src/server/scrapers/crawlerEngine.ts`

---

## Suggested order

1. **A1, A5, A4** together: one "existing row" path with one deadline-update function. These are the ones that delete or corrupt tenders already in the Pipeline.
2. **A6, A7, A8, A10, A11**: date parsing; each is small and has the verified cases above as tests.
3. **A3, B1, C1** together with `docs/15` F3: dedup identity.
4. **A2, B8**: undated ageing and suppression expiry.
5. **A9, B3**: document classification and one apply-result function.
6. **B6, B7**: coverage and visibility of failed sources.
7. **B2, B4, B5, C2, C3, C4**.

Each fix should add the verified examples in this document as tests; the current 491 tests pass with all of these flaws present.

---

## Resolution & Verification (2026-11-11)

All 23 logic flaws (A1–A11, B1–B8, C1–C4) alongside F1–F7 from `docs/15` have been resolved in code and verified by unit/integration tests (525 passing tests in Vitest). The live database was cleaned with the automated migration (D1–D3). One complete full scan with a before/after Pipeline comparison (D4) is still to be run:

- **A1, A5, A4 (Re-scan & Ingestion Integrity)**: Implemented dedicated `re-scan` path in `crawlerEngine.ts` preventing overwriting or staging existing rows. Pipeline rows ('Under Review', 'Preparing Bid', 'Submitted', 'Won', 'Passed') retain stages, notes, and dossiers across re-scans. Deadlines update only via `applyRescannedDeadline` with Corrigendum logs on extensions and Review flags on earlier dates.
- **A6, A7, A8, A10, A11 (Strict Date & Time Parsing)**: Lone unlabeled date partitions into future -> closing date, past/today -> publication date. Labels about queries/pre-bid/sale ignored. Military hours ("1100 hrs", "1430 hrs") parsed as 24-hr time. Deepest Create Date element extracted without setting closing date. `isPlausibleTenderYear` enforces 2010 to current+5.
- **A9, B3 (Document Classification & Unified Application)**: Corrigendum/cancellation triggers restricted to document headings; TOC mentions ignored. Unified `applyDocumentResultToTender` (`src/server/documentApply.ts`) used across crawler, fetch documents, and analyze APIs.
- **A3, B1, C1, F3, F7 (Deduplication & Matching)**: Strict `referenceNo.ts` normalisation and validation. Similarity dedup excludes tender's own portal. `titlesAreDistinguishable` prevents merging distinct tenders differing by 1-2 key words. Whole-word keyword matching via `containsKeyword` in `trackMatcher.ts`.
- **A2, B8 (Retention & Suppression Safety)**: Unified 90-day undated ageing limit (`UNDATED_MAX_AGE_DAYS = 90`). Upload-folder dates tagged `publish_date_source = 'upload_folder'` and excluded from ageing. Undated suppressions expire after 120 days and lift if future deadline reappears. Failed downloads never trigger suppression.
- **B2 (Slimming Safety)**: Slimming Passed tenders retains `status_notes`; tenders ever in the pipeline (tracked in `pipeline_audit_logs`) preserve description and history.
- **B4, B5, C2, C4 (Scraping & Download Robustness)**: Downloads inspect magic bytes and Content-Type, rejecting HTML payloads. Navigation rows dropped. Image logos/stamps ignored in `collectRowAttachments`. HTML decoded from full Buffer chunks using declared/default UTF-8 charset.
- **B6, B7, F1, F5 (Sources Reliability & Scheduler)**: Multi-page crawler pagination with safety bounds. Retry on transient timeouts with exponential backoff (no auto-heal). Catch-up scan waits for full completion before running daily advisement. `last_full_scan_at` tracked in `app_settings`.
- **C3 (AI Budget Guardrails)**: All Gemini text and Vision calls bounded by `ingest_ai_text_calls_per_day` (default 150) and daily Vision budget.

