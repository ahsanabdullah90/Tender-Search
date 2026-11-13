# 01. Overview

## Purpose and Problem Statement

Public procurement in Pakistan is fragmented across dozens of independent federal, provincial, and institutional portals. Government entities, regulatory bodies (PPRAs), state enterprises, and multilateral programs each publish procurement notices independently on bespoke or legacy web systems. Many of these portals lack RSS feeds, unified search, automated alerts, or structured data APIs. Furthermore, deadlines frequently shift without prominent notice, corrigenda (amendments) are published as separate listings or embedded image scans, and portals periodically migrate domains, change URL sub-paths, or redesign their HTML templates without notice.

**Tender Tracker** is a specialized, private intelligence system designed and operated by Ahsan Abdullah. It serves as a unified discovery, self-healing extraction, deduplication, and pipeline management cockpit for high-value tenders across Pakistan.

---

## Core Value Proposition

1. **Autonomous Multi-Portal Discovery**:
   Continuously monitors 18 public procurement portals across Pakistan, covering regulatory authorities (Federal PPRA (EPMS), Punjab PPRA, Sindh SPPRA, Balochistan BPPRA, KP KPPRA), federal & regional entities (NDMA, FDE, MOFEPT, Gilgit-Baltistan), technology & skills authorities (PSEB/TechDestination, Ignite, PSDF, PSDA, PEEF), multilateral agencies (UNGM, GIZ), and aggregators (Tender Services Pakistan, PID).

2. **Self-Healing Scraper & 7 Anti-Corruption Rules**:
   Recovers when a government portal moves its tender page (HTTP 404/410/500) or redirects to a new host/port (e.g., `bppra.gob.pk` $\rightarrow$ `bpptwo.vdc.services:5451/Tenders`), governed by 7 strict Anti-Corruption Rules (`AGENTS.md §2`):
   - **5-Step URL Healer (`healPortalConnection`)**: Triggered strictly on dead-link HTTP 404/410/500 errors or manual operator request (never on HTTP 200 0-item pages). Probes the organization's root domain, scores candidate links within the registrable domain boundary, verifies quality yield proof, and persists the healed URL to SQLite.
   - **Adaptive AI DOM Extraction**: When deterministic CSS selectors yield 0 items on an HTTP 200 page containing procurement text (and not an explicit empty state like `"No active tenders"` or `"No Opening"`), compacts the DOM while preserving inline `[Label](URL)` links and extracts structured tender items via Google Gemini.

3. **Local-First Document Ingestion & Durable Retry Queue**:
   - **Local Digital Extraction (`documentExtractor.ts`)**: Reads the text layer of digital PDFs (`pdfjs-dist`, all pages) and Word `.docx` files (`mammoth`) locally in ~100–250 ms without consuming Gemini quota, extracting phrase-anchored submission deadlines, reference numbers, budgets, scope text, and Go/No-Go `BidBrief` fields.
   - **Budgeted Vision & Offline OCR Fallbacks (`ingestBudget.ts`, `localOcrService.ts`)**: Invokes the 4-model Gemini Vision failover chain (`gemini-flash-lite-latest` $\rightarrow$ `gemini-3.1-flash-lite` $\rightarrow$ `gemini-3.5-flash` $\rightarrow$ `gemini-3.8-flash`) for scanned PDFs and image clippings within configurable per-scan and daily budgets, and falls back to offline `local_ocr` (`tesseract.js` + `@napi-rs/canvas`, capped at 3 pages/PDF) when Vision is unconfigured or over budget.
   - **Durable Background Worker (`ingestWorker.ts` & `document_ingest_jobs`)**: Queues remaining attachments and failed/timed-out downloads with lease-based crash recovery and exponential backoff (2 $\rightarrow$ 10 $\rightarrow$ 30 minutes).

4. **Hybrid Keyword + 384-D Semantic Track Matching**:
   Evaluates scraped listings and extracted document scope against customizable business domain tracks (*Solar & Clean Energy*, *Construction & Civil Works*, *Vocational Training (TVET)*, *Media & Documentaries*, etc.) using positive/negative keywords paired with local 384-dimensional `all-MiniLM-L6-v2` semantic embeddings (`embeddingService.ts`).

5. **3-Tier Canonical Deduplication**:
   Cross-references incoming notices using normalized reference numbers (Tier 1), bigram Dice-coefficient string similarity on titles (Tier 2), and same-space cosine vector similarity (Tier 3). Consolidates multi-source listings under a single canonical tender with secondary source citations.

6. **Canonical Deadline Resolution, Provenance & Corrigenda Tracking**:
   Tracks the provenance (`corrigendum_doc`, `primary_doc`, `html_row`, `manual`) and confidence of every deadline. Automatically logs deadline extensions in `corrigendum_logs` while flagging earlier-shifted deadlines, cancelled notices, or low-confidence past dates (`needs_review = 1`) for explicit operator confirmation in both the Inbox and Pipeline.

7. **Human-in-the-Loop (HITL) Friction Resolution**:
   Gracefully navigates Cloudflare Turnstile challenges and portal authentication barriers by launching dedicated interactive browser sessions while isolating session cookies for subsequent headless passes.

8. **Full-Lifecycle Bid Pipeline & Automated Retention**:
   Tracks bids through 6 deterministic stages: `New Opportunity` $\rightarrow$ `Under Review` $\rightarrow$ `Preparing Bid` $\rightarrow$ `Submitted` $\rightarrow$ `Won` (or `Passed`), supported by an interactive Kanban Board, 5-week Gantt timeline, and automated dossier slimming/reconciliation (`retention.ts`).

---

## System Context & Operations

- **Operator**: Ahsan Abdullah (single-operator system).
- **Workspace Location**: `C:\Tender_Tracker` (moved off Google Drive to eliminate file-sync locking and 0-byte `node_modules` issues).
- **Time Zone**: `Asia/Karachi` (PKT, UTC+5). All closing deadlines, timestamps, and scheduling intervals operate strictly in PKT.
- **Environment**: Local Windows 11 desktop running Node.js with local embedded SQLite WAL storage and browser automation.
- **Data Protection**: Strict isolation between production operational data (`data/`) and testing/sample environments (`data-sample/`, temporary test sandboxes). Production data is never touched or cleared by automated test runs or sample seeders.

---

## Non-Goals & System Boundaries

To maintain focus, security, and low operational overhead, Tender Tracker establishes five explicit architectural boundaries:

1. **Single-Operator Only (No Multi-Tenancy)**:
   - Tender Tracker deliberately contains no user registration, password auth, role-based access control (RBAC), or multi-tenant database partitioning. It is designed and scoped strictly for a single local operator.
2. **Local Desktop Execution (No Public Cloud Hosting)**:
   - Tender Tracker is deliberately **not** deployed to public cloud platforms (AWS, GCP, Vercel, Heroku). Many Pakistani public procurement authorities enforce strict geolocation and block foreign datacenter IP blocks with HTTP 403 Forbidden. Running locally on a legitimate Pakistan commercial/residential ISP connection guarantees authentic IP trust.
3. **Zero Automated CAPTCHA Solving Services**:
   - The application does not integrate with paid third-party CAPTCHA-solving services (e.g. 2Captcha, Anti-Captcha). Instead, the zero-cost **Human-in-the-Loop (HITL)** architecture allows the operator to solve challenges interactively once in a real browser session; harvested cookies keep headless scanning functional for weeks.
4. **No Automated Bid Submission**:
   - Tender Tracker acts as an intelligent scout, analyzer, and proposal preparation tracker. It deliberately **never** submits bids or interacts with legal e-procurement submission forms automatically. Statutory public bidding involves legal bid bonds, earnest money, and strict submission liabilities; the final submission action remains an intentional manual step performed through official statutory channels.
5. **No External Vector Database Daemons**:
   - Embeddings (384-D `all-MiniLM-L6-v2`) are stored directly as compact JSON/BLOB arrays inside SQLite, with similarity calculated via vectorized dot-products in Node.js. Running external vector daemons (Pinecone, Chroma, Milvus) is a deliberate non-goal to keep memory footprints below 200 MB and preserve single-file backup integrity.
