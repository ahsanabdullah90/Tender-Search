# Tender-Search Project Rules & Codebase Governance

## 1. File Placement & Root Hygiene Rules
- **Root Directory**: The repository root must contain ONLY top-level build configuration files (`package.json`, `tsconfig.json`, `vite.config.ts`, etc.) and the thin launcher `server.ts`. NEVER place loose image files, media, test dumps, or scratch files in the root directory.
- **Brand Assets**: All branding logos live strictly under `public/brand/` (`logo-square.png`, `logo-landscape.png`). Favicons live in `public/`.
- **Server Routes**: All REST endpoints and SSE streams belong in domain route controllers under `src/server/routes/` (`tenders.routes.ts`, `portals.routes.ts`, `tracks.routes.ts`, `scan.routes.ts`, `system.routes.ts`) and must be registered via `src/server/routes/index.ts`. Never put route handlers directly into `server.ts`.
- **Database Layer**: Database connection belongs in `src/server/db/connection.ts`, schema DDL in `src/server/db/schema.ts`, and domain queries in `src/server/db/repositories/` (`tendersRepo.ts`, `portalsRepo.ts`, `tracksRepo.ts`, `systemRepo.ts`, `ingestJobsRepo.ts`). Never write ad-hoc SQL queries outside these repositories.
- **Scrapers & Parsers**: Strict Pakistani date parsing belongs in `src/server/scrapers/dateParser.ts`. Self-healing discovery belongs in `src/server/scrapers/healer.ts`.
- **Tests**: Every new backend endpoint, database function, or scraper parser must have corresponding tests under `tests/` mirroring the `src/` directory layout.

## 2. Self-Healing Scraper Governance (The 7 Anti-Corruption Rules)
When modifying or interacting with scrapers, strictly adhere to the 7 Anti-Corruption Rules:
1. **Strict Trigger Gating**: Never trigger Auto-Heal on 200 OK 0-item scans, TLS resets, or network timeouts. Only trigger on dead-link HTTP 404/410/500 errors or manual operator request.
2. **Non-Destructive Redirects**: Only update in-memory URLs if verified with tender yield.
3. **Registrable Domain Boundary**: Candidates must share portal hostname or official parent domain.
4. **Anti-Downgrade Path Guard**: Never replace a specific listing path (e.g. `/ActiveTenders.aspx`) with a bare root `/` or static file.
5. **Quality-Verified Yield Proof**: Require >= 2 items, or 1 item with date + ref/attachment. Never accept empty table states.
6. **Strict `base_url` Normalization**: Store only clean URL origins in `base_url` (never file paths or query strings).
7. **Canonical Baseline Immutability**: Always retain canonical defaults from `PORTAL_DEFINITIONS`.

## 3. Mandatory Skill Activation
For comprehensive instructions, decision trees, and checklists, consult the workspace skill:
[`.agents/skills/file-creation-and-management/SKILL.md`](.agents/skills/file-creation-and-management/SKILL.md)
