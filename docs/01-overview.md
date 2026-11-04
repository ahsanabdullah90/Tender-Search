# 01. Overview

## Purpose and Problem Statement

Public procurement in Pakistan is fragmented across dozens of independent federal, provincial, and institutional portals. Government entities, regulatory bodies (PPRAs), state enterprises, and multilateral programs each publish procurement notices independently on bespoke or legacy web systems. Many of these portals lack RSS feeds, unified search, automated alerts, or structured data APIs. Furthermore, deadlines frequently shift without prominent notice, corrigenda (amendments) are published as separate listings or embedded image scans, and portals periodically migrate domains, change URL sub-paths, or redesign their HTML templates without notice.

**Tender Tracker** is a specialized, private intelligence system designed and operated by Ahsan Abdullah. It serves as a unified discovery, self-healing extraction, deduplication, and pipeline management cockpit for high-value tenders across Pakistan.

---

## Core Value Proposition

1. **Autonomous Multi-Portal Discovery**:
   Continuously monitors 18 public procurement portals across Pakistan, covering regulatory authorities (Federal PPRA/EPADS, Punjab PPRA, Sindh SPPRA, Balochistan BPPRA, KP KPPRA), federal & regional entities (NDMA, FDE, MOFEPT, Gilgit-Baltistan), technology & skills authorities (PSEB/TechDestination, Ignite, PSDF, PSDA, PEEF), multilateral agencies (UNGM, GIZ), and aggregators (Tender Services Pakistan, PID).

2. **Self-Healing Scraper & 5-Step Autonomous URL Recovery**:
   Automatically recovers when a government portal moves its tender page (HTTP 404/500), redirects to a new host/port (e.g., `bppra.gob.pk` $\rightarrow$ `bpptwo.vdc.services:5451/Tenders`), or redesigns its HTML layout:
   - **5-Step URL Healer (`healPortalConnection`)**: Probes the organization's root domain, follows cross-origin redirects, scores homepage navigation links for "Tenders / Procurement / Bids" (with AI link discovery fallback), verifies candidate pages, and persists the healed URL to SQLite.
   - **Adaptive AI DOM Extraction**: When deterministic CSS selectors yield 0 items on a page containing procurement text, compacts the DOM while preserving inline `[Label](URL)` links and extracts structured tender items via Google Gemini.

3. **Zero-Failure 4-Model AI Pool**:
   All OCR, document parsing, First-Look summarization, and self-healing extraction calls route through a 4-model failover chain (`gemini-flash-lite-latest` $\rightarrow$ `gemini-3.1-flash-lite` $\rightarrow$ `gemini-3.5-flash` $\rightarrow$ `gemini-3.8-flash`) paired with a self-healing JSON repair parser.

4. **Domain-Specific Filtering and Keyword Matching**:
   Evaluates scraped listings against customizable business domain tracks (e.g., *Solar & Clean Energy*, *Construction & Civil Works*, *Vocational Training (TVET)*, *Media & Documentaries*). Uses positive and negative keyword sets to eliminate irrelevant tenders before they clutter the inbox.

5. **Intelligent Deduplication**:
   Cross-references incoming notices using reference numbers and bigram Dice-coefficient string similarity on titles. Consolidates multi-source listings under a single canonical tender with secondary source citations.

6. **Corrigenda and Amendment Tracking**:
   Detects changes to tender deadlines, requirements, and scope revisions across crawls, automatically alerting the operator and recording auditable change logs.

7. **Human-in-the-Loop (HITL) Friction Resolution**:
   Gracefully navigates Cloudflare Turnstile challenges and portal authentication barriers by launching dedicated interactive browser sessions while isolating session cookies for subsequent headless passes.

8. **Full-Lifecycle Bid Pipeline**:
   Tracks bids through 6 deterministic stages: `New Opportunity` $\rightarrow$ `Under Review` $\rightarrow$ `Preparing Bid` $\rightarrow$ `Submitted` $\rightarrow$ `Won` (or `Passed`), supported by an interactive Kanban Board and Gantt timeline.

---

## System Context & Operations

- **Operator**: Ahsan Abdullah (single-operator system).
- **Time Zone**: `Asia/Karachi` (PKT, UTC+5). All closing deadlines, timestamps, and scheduling intervals operate strictly in PKT.
- **Environment**: Local Windows 11 desktop running Node.js with local embedded SQLite WAL storage and browser automation.
- **Data Protection**: Strict isolation between production operational data (`data/`) and testing/sample environments (`data-sample/`, temporary test sandboxes). Production data is never touched or cleared by automated test runs or sample seeders.
