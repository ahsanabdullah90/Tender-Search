# Sentinel: Enterprise Split-Pane Procurement Command Center

A high-performance, enterprise-grade redesign elevating Sentinel into a split-pane procurement command center. Built with clean enterprise white surfaces, deep navy structural framing, crisp hairline dividers, a persistent right-hand reading dossier, and real-time ticking countdown timers for urgent Pakistani federal and provincial tenders.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> **Confirmed Design & Architecture Decisions:**
> 1. **Primary Workspace**: **Split-Pane Command Center** — The main workspace features a responsive two-pane architecture: a scannable triage opportunity feed on the left (40%–45% width) and a persistent, high-density dossier reading pane on the right (55%–60% width), eliminating slide-over friction during high-volume daily reviews.
> 2. **Aesthetic & Tone**: **Clean Enterprise White with Deep Navy Structure** — Sophisticated white/off-white canvas (`#FFFFFF` / `#F8FAFC`), deep navy brand framing and structural accents (`#0F172A`, `#1E293B`), crisp 1px hairline dividers (`#E2E8F0`), and zero-pill typographic metadata with subtle interpuncts (`·`).
> 3. **Urgency Mechanism**: **Live Ticking Tabular Countdown Clocks** — Real-time ticking timers (`hh:mm:ss`) updated every second for tenders closing within 72 hours, styled with tabular figures (`font-mono tabular-nums`) and measured semantic urgency accents (Amber for $<72\text{h}$, Crimson for $<24\text{h}$).
> 4. **Zero Dummy Data Guarantee**: Maintained strictly. The interface loads with authentic zero-state and real-time scraper feedback; no fabricated records or dummy tenders exist.
> 5. **Local-First Capabilities**: Offline-accessible cached files (`/dossiers/`), native SQLite WAL persistence, and local browser HITL verification remain seamlessly accessible within the new split-pane interface.

---

### 1. Overview & Core Concept

- **What It Does**: Sentinel gives solo Pakistani contractors and business development operators a unified, lightning-fast triage deck for tracking tenders across 16+ statutory and provincial portals (PPRA EPADS, Punjab, Sindh, KPPRA, BPPRA, UNGM, GIZ, NDMA, Ignite, PSEB/TechDestination). Tenders can be previewed, audited, and moved through bid stages with zero latency.
- **Target Audience / Persona**: Managing partners and senior bid directors who must monitor dozens of public procurement boards daily, track corrigendum amendments, and verify compliance within strict deadlines.
- **Key Value**: Reduces daily portal hunting from 2+ hours across 16 websites down to a 5-minute morning scan with side-by-side dossier verification and live countdown clocks.

---

### 2. User Experience & Visual Design

#### A. Key User Flows
1. **Morning Triage & Split-Pane Scanning**: Operator opens the dashboard; the top KPI strip immediately highlights any unacknowledged corrigenda, upcoming deadlines, or portal maintenance notices. Clicking any tender in the left list displays its complete opportunity profile, matched keywords, and cached dossier attachments instantly in the right-hand inspection pane without page reloads.
2. **Urgent Bid Prioritization**: Tenders closing within 72 hours display a live countdown timer (`28h 14m 06s`) that ticks dynamically. Operators can sort or filter directly for urgent items.
3. **Corrigendum Inspection**: When an agency quietly replaces a BOQ or extends a closing date, the tender is highlighted with a crisp amber border; clicking it opens the Corrigendum Audit Log in the right pane showing the exact SHA-256 hash or deadline delta.
4. **Pipeline Progression & Notes**: In the persistent right pane, the operator can update the bid stage (`New Opportunity` $\rightarrow$ `Under Review` $\rightarrow$ `Preparing Bid` $\rightarrow$ `Submitted` $\rightarrow$ `Won` / `Passed`), jot down internal notes, or download cached government PDFs directly.
5. **View Flexibility**: Operators can toggle from the Split-Pane view to a Full High-Density Table or a 6-Column Kanban Deal Board when performing macro pipeline reviews.

#### B. Visual Identity, Color Palette & Hierarchy
- **Canvas & Surface (60%)**: Pure White (`#FFFFFF`) card and panel backgrounds with subtle Off-White body canvas (`#F8FAFC`).
- **Structural Structure & Framing (30%)**: Deep Navy (`#0F172A`) header and primary typography (`#1E293B`), paired with ultra-crisp hairline dividers (`#E2E8F0` / `border-slate-200`).
- **Semantic Accents (10%)**:
  - *Emerald* (`#16A34A`): Healthy portal status, Won bids, normal active status.
  - *Amber* (`#D97706`): Approaching deadline ($<72\text{h}$), Corrigendum alert.
  - *Crimson* (`#DC2626`): Critical urgency ($<24\text{h}$), HITL browser action needed, broken portal.
  - *Deep Indigo/Blue* (`#2563EB`): Active domain track tabs and focused states.
- **Typography & Font Pairing**:
  - Display & Headings: `Plus Jakarta Sans` (font weights 600 & 700) with balanced line wraps.
  - Body & Scannable Lists: `Public Sans` / `Plus Jakarta Sans` (font weights 400 & 500) for effortless legibility at 13px–15px sizes.
  - Tabular Numerals & Identifiers: `JetBrains Mono` (`font-mono tabular-nums`) for Reference Numbers, match percentages, dates, and live countdown timers.
- **Anti-Slop Zero-Pill Rules**:
  - Metadata lines use clean unboxed text separated by subtle interpuncts (`·`), such as:  
    `PPRA EPADS · Ref: TS528914E · Federal Ministry of Education · 48h 20m remaining`
  - No candy badges, floating glowing gradient blobs, or decorative pulsing dots.

---

### 3. Key Product Decisions & Trade-Offs

- **Split-Pane Command Center vs. Drawer Modals**:
  - *Chosen Approach*: Persistent side-by-side two-column workbench (Left: Triage Feed; Right: Dossier Viewport).
  - *Why*: Daily procurement operators review 30–50 items in a single sitting. Slide-over drawers require repeated open/close clicks and obscure list context. A split-pane interface provides instantaneous previewing and keyboard ergonomics.
- **Live React Ticking Clock vs. Static Timestamp**:
  - *Chosen Approach*: Lightweight single interval hook emitting a tick every second for items closing within 72 hours, using CSS tabular numbers.
  - *Why*: In government procurement, 2:00 PM cutoff times are non-negotiable. Live countdown clocks create real-time urgency and eliminate timezone ambiguity without causing CPU lag.
- **Clean Enterprise White vs. All-Dark Theme**:
  - *Chosen Approach*: Pristine white enterprise light theme as the primary visual foundation, with deep navy structural navigation, while preserving an optional dark mode toggle for late-night work.
  - *Why*: Official government dossiers, RFPs, and legal tender documents are predominantly white PDFs. A high-contrast light enterprise theme prevents eye strain when switching between Sentinel and official procurement PDFs.

---

### 4. Technical Architecture & Component Layout

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                      SENTINEL ENTERPRISE COMMAND BAR                        │
│ [Brand: SENTINEL]   ·   [16 Portals Online]   ·   [Live Scan]   ·  [Export] │
├─────────────────────────────────────────────────────────────────────────────┤
│ 5 KPI CARDS: Total Tracked │ Closing <72h │ In Pipeline │ Corrigenda │ HITL │
├─────────────────────────────────────────────────────────────────────────────┤
│ DOMAIN TRACK TABS: All · Construction · Solar · Education · TVET · Media... │
│ FILTERS: Search Bar · Status Filter · View Switcher (Split | Table | Kanban)│
├──────────────────────────────────────┬──────────────────────────────────────┤
│ LEFT FEED: TRIAGE QUEUE (45%)        │ RIGHT PANE: PERSISTENT DOSSIER (55%) │
│                                      │                                      │
│ • Selected Tender Card (Active Navy) │ • Header: Title, Authority & Ref #   │
│   - Ref No, Agency, Title            │ • Live Ticking Tabular Countdown Bar │
│   - Live Countdown: 28h 14m 06s      │ • Official Direct Verified Link      │
│   - Matched Track & Match Score      │ • Cached Local Offline Dossiers/PDFs │
│                                      │ • Corrigendum Amendment Log & Diffs  │
│ • Tender 2                           │ • Solo Operator Internal Notes       │
│ • Tender 3                           │ • One-Click Pipeline Status Buttons  │
│ • Tender 4                           │                                      │
│ [Compact, 0-pill metadata list]      │ [Full scrollable detailed dossier]   │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

#### State & Component Updates
- `src/components/SplitPaneWorkspace.tsx`: New split-pane controller managing the left scannable list and the active right-hand persistent dossier.
- `src/components/LiveCountdown.tsx`: High-performance countdown component computing remaining time with `tabular-nums` formatting.
- `src/components/TenderFeedItem.tsx`: High-density feed item with zero-pill metadata, clean dividers, and keyboard selection support.
- `src/components/PersistentDossier.tsx`: Dedicated document viewer pane featuring direct links, local PDF cache buttons, corrigendum history, and notes editor.
- `src/App.tsx`: Refactored to feature the Split-Pane workspace as default, while retaining one-click toggles to High-Density Table and Kanban views.
