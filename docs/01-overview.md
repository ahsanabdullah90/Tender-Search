# 01. Overview

## Purpose and Problem Statement

Public procurement in Pakistan is fragmented across dozens of independent federal, provincial, and institutional portals. Government entities, regulatory bodies (PPRAs), state enterprises, and multilateral programs each publish procurement notices independently on bespoke or legacy web systems. Many of these portals lack RSS feeds, unified search, automated alerts, or structured data APIs. Furthermore, deadlines frequently shift without prominent notice, corrigenda (amendments) are published as separate listings or embedded image scans, and access is periodically disrupted by network instability, SSL certificate errors, or bot challenges.

**Tender Tracker** is a specialized, private intelligence system designed and operated by Ahsan Abdullah. It serves as a unified discovery, analysis, deduplication, and pipeline management cockpit for high-value tenders across Pakistan.

---

## Core Value Proposition

1. **Autonomous Multi-Portal Discovery**:
   Continuously monitors 18 public procurement portals across Pakistan, covering regulatory authorities (Federal PPRA/EPADS, Punjab PPRA, Sindh SPPRA), federal infrastructure agencies (WAPDA, NHA, OGDCL, CAA, SNGPL), regional authorities (KP, Balochistan, Gilgit-Baltistan, AJK), educational/TVET programs (NAVTTC, TEVTA Punjab, PEEF), and aggregators (Tender Services Pakistan).

2. **Domain-Specific Filtering and Keyword Matching**:
   Evaluates scraped listings against customizable business domain tracks (e.g., *Solar & Clean Energy*, *Construction & Civil Works*, *Vocational Training (TVET)*, *Media & Documentaries*). Uses positive and negative keyword sets to eliminate irrelevant tenders before they clutter the inbox.

3. **Intelligent Deduplication**:
   Cross-references incoming notices using reference numbers and bigram Dice-coefficient string similarity on titles. Consolidates multi-source listings under a single canonical tender with secondary source citations.

4. **Corrigenda and Amendment Tracking**:
   Detects changes to tender deadlines, requirements, and scope revisions across crawls, automatically alerting the operator and recording auditable change logs.

5. **Human-in-the-Loop (HITL) Friction Resolution**:
   Gracefully navigates Cloudflare Turnstile challenges and portal authentication barriers by launching dedicated interactive browser sessions while isolating session cookies for subsequent headless passes.

6. **Full-Lifecycle Bid Pipeline**:
   Tracks bids through 6 deterministic stages: `New Opportunity` $\rightarrow$ `Under Review` $\rightarrow$ `Preparing Bid` $\rightarrow$ `Submitted` $\rightarrow$ `Won` (or `Passed`), supported by an interactive Kanban Board and Gantt timeline.

---

## System Context & Operations

- **Operator**: Ahsan Abdullah (single-operator system).
- **Time Zone**: `Asia/Karachi` (PKT, UTC+5). All closing deadlines, timestamps, and scheduling intervals operate strictly in PKT.
- **Environment**: Local Windows 11 desktop running Node.js with local embedded SQLite storage and browser automation.
- **Data Protection**: Strict isolation between production operational data (`data/`) and testing/sample environments (`data-sample/`, temporary test sandboxes). Production data is never touched or cleared by automated test runs or sample seeders.
