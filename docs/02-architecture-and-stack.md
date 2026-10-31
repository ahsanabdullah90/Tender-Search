# 02. Architecture & Technology Stack

## High-Level System Architecture

Tender Tracker is architected as an integrated single-process Node.js application pairing an Express REST/SSE backend with a React 19 single-page application (SPA) bundled via Vite. The server orchestrates crawling routines, database transactions, background schedulers, document retrieval, and Playwright automation, while the client renders a responsive operational dashboard.

```mermaid
graph TD
    subgraph Client [Browser Client (React 19 + Tailwind v4)]
        AppShell[App Shell & Navigation]
        Inbox[Inbox Screen]
        Pipeline[Pipeline Board & Gantt]
        Sources[Sources & Keywords Management]
        KpiBanner[KPI Header & HITL Alerts]
        SSEClient[SSE Real-time Scan Progress]
    end

    subgraph Server [Backend Engine (Express on Node 24)]
        API[Express REST API /api/*]
        SSEHub[Server-Sent Events Stream]
        Scheduler[Background Crawl Scheduler]
        Crawler[Crawler Engine]
        Deduplicator[Bigram Deduplicator]
        DossierMgr[Dossier Manager & Cache]
        OCR[Gemini Vision OCR Service]
        BrowserEngine[Playwright Engine & Session Manager]
    end

    subgraph Storage [Local Storage Layer]
        DB[(SQLite WAL: tender_tracker.db)]
        DossierStorage[data/dossiers/]
        SessionStorage[data/sessions/]
        BackupStorage[data/backups/]
    end

    subgraph External [External Web & Services]
        GovPortals[18 Pakistan Procurement Portals]
        GeminiAPI[Google Gemini API]
    end

    AppShell --> API
    SSEClient --> SSEHub
    API --> DB
    Scheduler --> Crawler
    Crawler --> Deduplicator
    Crawler --> GovPortals
    Crawler --> BrowserEngine
    BrowserEngine --> GovPortals
    BrowserEngine --> SessionStorage
    Deduplicator --> DB
    Crawler --> DossierMgr
    DossierMgr --> DossierStorage
    DossierMgr --> OCR
    OCR --> GeminiAPI
    API --> BackupStorage
```

---

## Technology Stack

### Runtime & Core Frameworks
- **Runtime**: Node.js v24 (LTS/Current).
- **Backend Framework**: Express v4 (`server.ts`, modularized via `createApp()`).
- **Frontend Framework**: React v19 with React DOM.
- **Build Tool**: Vite v8 with `@vitejs/plugin-react` and `@tailwindcss/vite`.
- **Styling**: Tailwind CSS v4 using semantic design tokens defined in `src/index.css` and `src/theme.ts`.
- **Icons**: Lucide React.
- **Language**: TypeScript v5 throughout client, server, and test suites.

### Data & Persistence
- **Database**: SQLite 3 using `better-sqlite3` compiled for Node 24.
- **Journal Mode**: Write-Ahead Logging (`PRAGMA journal_mode = WAL`) for concurrent reads and writes without blocking.
- **Migrations**: Programmatic, idempotent guarded `ALTER TABLE` schema updates executed upon database initialization in `src/server/db.ts`.

### Scraping, Automation & AI
- **HTML Parsing**: `cheerio` for fast, lightweight DOM parsing of static HTML responses.
- **HTTP Client**: Tolerant HTTPS/HTTP agents with configurable timeouts, header masquerading, and unverified TLS bypass for misconfigured legacy government SSL certs.
- **Browser Automation**: `@playwright/test` / Playwright Chromium for rendering dynamic SPA portals (e.g., Sindh SPPRA) and interactive HITL Cloudflare bypass.
- **OCR Engine**: `@google/genai` integrating Google Gemini Vision (`gemini-2.5-flash`) for scanned image corrigenda extraction.

---

## Client-Server Communication

1. **REST API**:
   38 endpoints serve data queries, record mutations, status updates, bookmark toggles, credential submissions, and manual crawl triggers.
2. **Server-Sent Events (SSE)**:
   `/api/scan/progress` delivers non-blocking, real-time push updates during crawl execution. The frontend displays active portal names, progress bars, and yield counts without polling.
3. **Graceful Shutdown**:
   Listens for `SIGTERM` and `SIGINT`, shutting down the HTTP listener, terminating background schedulers, and safely closing SQLite database connections with WAL flush.

---

## Data Boundary & Security Isolation

- **Production Directory (`data/`)**: Contains live operational database `tender_tracker.db`, dossier downloads, encrypted session cookies, and database backups.
- **Sample Directory (`data-sample/`)**: Isolated environment populated by `npm run seed:sample` for demonstration and preview.
- **Automated Test Isolation**: Tests enforce `TENDER_DATA_DIR` pointing to temporary isolated folders (`tests/temp/`) or explicit mock environments. The setup guard throws an immediate exception if a test attempts to bind to the root production `data/` directory.
- **Loopback Binding**: By default, `server.ts` binds strictly to `127.0.0.1` (`HOST=127.0.0.1`), preventing exposure on public network interfaces.
