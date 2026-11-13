---
name: file-creation-and-management
description: >-
  Enforces codebase architecture, directory conventions, and file placement rules
  for the Tender-Search repository. Use this skill whenever creating new files,
  adding folders, refactoring existing modules, introducing API routes, database
  repositories, scraper components, or UI elements to ensure clean separation of
  concerns, root hygiene, and zero regressions.
---

# Codebase File Creation & Management Skill

This skill defines the architectural standards, directory hierarchy, and governance rules for maintaining clean, modular, and maintainable files across the **Tender-Search** repository.

---

## 1. Canonical Directory Map

Every file in the repository must belong to its designated canonical directory:

```text
Tender-Search/
├── .agents/skills/               # Custom workspace skills (including this skill)
├── data/                         # Local database & runtime files (gitignored)
│   ├── tender_tracker.db
│   ├── backups/                  # SQLite snapshot backups
│   ├── dossiers/                 # Cached tender PDF/image attachments
│   └── sessions/                 # Persistent Playwright browser auth states
├── docs/                         # Technical documentation & architecture specs
├── public/                       # Static web assets served verbatim by Vite/Express
│   ├── brand/                    # Application logos (logo-square.png, logo-landscape.png)
│   └── favicon.ico / icons
├── scripts/                      # Standalone CLI tools & maintenance scripts
├── src/                          # TypeScript source code
│   ├── client/                   # Frontend React application
│   │   ├── components/           # React screens and compound UI components
│   │   ├── ui/                   # Atomic design UI primitives (Button, Chip, Dialog, etc.)
│   │   ├── App.tsx / main.tsx    # Vite React entrypoint
│   │   └── index.css / theme.ts  # Design tokens & theme handler
│   ├── shared/                   # Shared domain interfaces (client & server)
│   │   └── types.ts
│   └── server/                   # Backend Node.js / Express application
│       ├── routes/               # Modular Express API route controllers
│       ├── db/                   # Database connection, schema DDL, and repositories
│       │   └── repositories/     # Domain data access objects (tenders, portals, etc.)
│       ├── scrapers/             # Ingestion pipeline, parsers, and auto-healer
│       └── services/             # Domain services (deduplicator, dossierManager, ocrService, scheduler, etc.)
├── tests/                        # Automated tests mirroring src/ 1:1
│   ├── api/                      # REST endpoint and SSE integration tests
│   ├── db/                       # Database schema and repository tests
│   ├── scraper/                  # Crawler, dossier, and scraper tests
│   ├── ui/                       # React screen and component tests
│   └── unit/                     # Pure domain logic tests (dateParser, match, etc.)
├── server.ts                     # Thin server bootstrap launcher (< 120 lines)
├── index.html                    # Vite HTML entrypoint
└── [config files]                # package.json, tsconfig.json, vite.config.ts, vitest.config.ts
```

---

## 2. File Placement Decision Tree

When creating a new file, find its exact home using this decision table:

| What are you adding? | Canonical Location | Naming Pattern |
| :--- | :--- | :--- |
| **New API endpoint or REST domain** | `src/server/routes/` | `<domain>.routes.ts` (register in `routes/index.ts`) |
| **New database query or table access** | `src/server/db/repositories/` | `<domain>Repo.ts` (export via `db/index.ts`) |
| **Database table DDL or schema migration** | `src/server/db/schema.ts` | Within `initDatabase()` or migration block |
| **New procurement portal parser** | `src/server/scrapers/` | `portalParsers.ts` or registered in `crawlerEngine.ts` |
| **Date / string / parsing utility** | `src/server/scrapers/dateParser.ts` | Standalone exported function with tests |
| **Scraper recovery or link scoring** | `src/server/scrapers/healer.ts` | Adhere strictly to the 7 Anti-Corruption Rules |
| **Scraper transport & ingestion pipeline** | `src/server/scrapers/` | `htmlFetcher.ts`, `ingestPipeline.ts`, `tenderAnalysis.ts` |
| **Core backend service or orchestrator** | `src/server/services/` | `<serviceName>.ts` (e.g. `dossierManager.ts`) |
| **Shared client/server TypeScript type** | `src/shared/` | `types.ts` |
| **React screen or full view** | `src/client/components/` | `<Name>Screen.tsx` |
| **Reusable UI widget / slideover / modal** | `src/client/components/<screen>/` | Subdivided component (`Detail.tsx`, `AddTenderModal.tsx`, `TenderRow.tsx`) |
| **Atomic UI primitive (button, input, badge)** | `src/client/ui/` | Within `src/client/ui/index.tsx` or `src/client/ui/<primitive>.tsx` |
| **Logo, icon, or static brand image** | `public/brand/` | Lowercase kebab/hyphenated PNG/SVG (`logo-*.png`) |
| **Standalone CLI or maintenance script** | `scripts/` | `<action>-<target>.ts` |
| **Automated test suite** | `tests/<domain>/` | Mirroring `src/` path (`tests/<domain>/<name>.test.ts`) |

---

## 3. Strict Layer Architecture Rules

### Rule 1: Project Root Hygiene
- **Never place loose image files, media, PDFs, or raw assets in the project root.** All brand assets belong exclusively in `public/brand/`.
- **Never place route handlers or business logic directly in `server.ts`.** `server.ts` is strictly a thin bootstrapper that configures middleware, delegates `/api` to `apiRouter`, and mounts Vite or static files.
- The project root must only contain standard configuration files (`package.json`, `tsconfig.json`, `vite.config.ts`, etc.) and the bootstrapper `server.ts`.

### Rule 2: Modular Route Controllers (`src/server/routes/`)
- Every HTTP endpoint must reside in a domain controller:
  - `tenders.routes.ts`: Tenders listing, filters, status, notes, bookmarks, AI analysis, manual entry.
  - `portals.routes.ts`: Portal operational health, URL edits, reset to default, credentials, HITL.
  - `tracks.routes.ts`: Domain tracks, positive/negative keywords, corrigenda alerts, KPIs.
  - `scan.routes.ts`: Crawl scan initiation, SSE progress stream, live status.
  - `system.routes.ts`: Database backups, storage metrics, dossier pruning, wipe, Gemini API key.
- All domain routers must be aggregated through `src/server/routes/index.ts` mounted under `/api`.

### Rule 3: Domain Database Repositories (`src/server/db/`)
- Database connection, WAL pragma configuration, and filesystem paths belong in `src/server/db/connection.ts`.
- Schema table creation (`CREATE TABLE IF NOT EXISTS`), index creation, and initial seeders belong in `src/server/db/schema.ts`.
- SQL queries and database mutations must be organized into domain repositories:
  - `tendersRepo.ts`
  - `portalsRepo.ts`
  - `tracksRepo.ts`
  - `systemRepo.ts`
  - `ingestJobsRepo.ts` (document ingest retry queue)
- `src/server/db/index.ts` re-exports all connection and repository symbols directly.

### Rule 4: Scraper Pipeline & Autonomous Healer (`src/server/scrapers/`)
- Date parsing logic and regexes belong in `src/server/scrapers/dateParser.ts`. Always parse Pakistani dates with explicit PKT (+05:00) timezone and DD/MM/YYYY priority to prevent US day/month swaps.
- Self-healing and portal link discovery belong in `src/server/scrapers/healer.ts` and **must strictly obey the 7 Anti-Corruption Rules**:
  1. **Strict Trigger Gating**: Never trigger Auto-Heal on 200 OK 0-item scans, TLS resets, or timeouts. Only trigger on dead-link HTTP 404/410/500 errors or manual operator request.
  2. **Non-Destructive Redirects**: Only persist redirect URLs if valid and verified with tender yield.
  3. **Registrable Domain Boundary**: Candidates must match portal hostname or parent domain.
  4. **Anti-Downgrade Path Guard**: Never replace a specific listing path (e.g., `/ActiveTenders.aspx`) with a bare root `/` or static file.
  5. **Quality-Verified Yield Proof**: Require >= 2 items, or 1 item with date + ref/attachment. Never accept empty table states.
  6. **Strict `base_url` Normalization**: Store only the clean URL origin in `base_url` (never file paths or query strings).
  7. **Canonical Baseline Immutability**: Always retain canonical defaults from `PORTAL_DEFINITIONS`.

### Rule 5: 1:1 Test Mirroring (`tests/`)
- Every new feature, route, or repository function must have corresponding tests in `tests/`:
  - New route endpoint -> Add test to `tests/api/routes.test.ts`.
  - New DB function -> Add test to `tests/db/db.test.ts`.
  - New scraper parser or healing rule -> Add test to `tests/scraper/crawler.test.ts` or `tests/unit/`.
  - New UI component -> Add test to `tests/ui/`.
- Tests must pass synchronously and cleanly without orphan handles.

---

## 4. Step-by-Step Workflow for Adding or Moving Files

When introducing a new file or refactoring an existing one:

1. **Verify Location**: Check the [File Placement Decision Tree](#2-file-placement-decision-tree). Ensure it is in the right domain folder.
2. **Use ES Module Syntax**: Always include `.js` extensions in local relative imports (e.g., `import { db } from '../db/connection.js';`).
3. **Preserve Compatibility**: When extracting code from a large file, leave a re-export in the original file if external consumers depend on it.
4. **Run Verification Suite**:
   ```bash
   npm run lint        # Must pass with 0 errors
   npx vitest run      # All unit/integration tests must pass
   npm run build       # Vite production bundle must build cleanly
   ```
5. **Git Hygiene**: Commit logical changes in small, well-described commits. Never commit temporary scratch files or loose root assets.
