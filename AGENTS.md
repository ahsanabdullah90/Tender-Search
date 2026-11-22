# Tender-Search Project Rules & Codebase Governance

## 1. File Placement & Root Hygiene Rules
- **Root Directory**: The repository root must contain ONLY top-level build configuration files (`package.json`, `tsconfig.json`, `vite.config.ts`, etc.), `index.html`, the thin launcher `server.ts`, and authorized Windows desktop launchers (`start-tender-tracker.bat`, `Launch Tender Tracker.lnk`). NEVER place loose image files, media, test dumps, or scratch files in the root directory.
- **Brand Assets**: All branding logos live strictly under `public/brand/` (`logo-square.png`, `logo-landscape.png`). Favicons live in `public/`.
- **Server Routes**: All REST endpoints and SSE streams belong in domain route controllers under `src/server/routes/` (`tenders.routes.ts`, `portals.routes.ts`, `tracks.routes.ts`, `scan.routes.ts`, `system.routes.ts`), backed by zero-dependency runtime schema validation (`validation.ts`), uniform HTTP error envelopes/middleware (`httpErrors.ts`), and shared route utilities (`routeUtils.ts`), and must be registered via `src/server/routes/index.ts`. Never put route handlers directly into `server.ts`.
- **Database Layer**: Database connection belongs in `src/server/db/connection.ts`, the `PRAGMA user_version` migration engine in `src/server/db/migrations.ts`, versioned schema DDL and idempotent seeders in `src/server/db/schema.ts`, domain queries in `src/server/db/repositories/` (`tendersRepo.ts`, `tenderLifecycleRepo.ts`, `portalsRepo.ts`, `tracksRepo.ts`, `systemRepo.ts`, `ingestJobsRepo.ts`), and barrel exports in `src/server/db/index.ts`. Never write ad-hoc SQL queries outside these repositories.
- **Domain Layer (`src/server/domain/`)**: Pure business rules, path resolution, TLS transport policies, portal catalog definitions, Pakistani date parsing, reference validation, track matching, detail-URL discovery predicates, and embedding helpers (`paths.ts`, `portalList.ts`, `dateParser.ts`, `referenceNo.ts`, `fileUtils.ts`, `tlsTransport.ts`, `detailDiscovery.ts`, `embeddingService.ts`, `trackMatcher.ts`) live in `src/server/domain/` with downward re-export shims preserved at legacy paths.
- **Backend Services (`src/server/services/`)**: Core domain services (deduplication, dossiers, SPPRA DMS client `sppraClient.ts`, document extraction, OCR/AI, budget, retention, logging, URL safety, network monitor) live in `src/server/services/`.
- **Scrapers & Parsers (`src/server/scrapers/`)**: Pluggable portal connectors live behind the `PortalAdapter` registry in `src/server/scrapers/adapters/` (`registry.ts`, `types.ts`, `guards.ts`, `genericAdapter.ts`, and dedicated portal/agency adapters). Supporting scraper modules cover transport & charset decoding (`htmlFetcher.ts`), typed transport/dossier ports (`crawlerDeps.ts`), encapsulated scan & queue progress state (`scanState.ts`), Playwright/HITL session management (`playwrightEngine.ts`), deterministic DOM extraction helpers (`portalParsers.ts`, `parserHelpers.ts`, `scraperUtils.ts`), self-healing discovery (`healer.ts`), tender detail analysis (`tenderAnalysis.ts`), ingestion/dedup/rescan pipelining (`ingestPipeline.ts`), and orchestrator/public facade (`crawlerEngine.ts`).
- **Runtime Orchestration (`src/server/runtime/`)**: Runtime dependency wiring (`context.ts` providing `RuntimeContext`, `createRuntimeContext`, and `getDefaultRuntimeContext`), background workers (`ingestWorker.ts`), and startup cron orchestration (`scheduler.ts`) live above `scrapers/` so server imports remain strictly unidirectional (`shared -> domain -> db -> services -> scrapers -> runtime -> routes`, enforced by `GOV-4`).
- **Frontend Client (`src/client/`) & Shared Types (`src/shared/`)**: React entry, styling, primitives, and screens live under `src/client/` (`src/client/ui/`, `src/client/utils/`, `src/client/components/`). Shared interfaces live in `src/shared/types.ts`. Decompose large screens into focused submodules under `src/client/components/<domain>/` (e.g. `src/client/components/inbox/Detail.tsx`, `DossierSection.tsx`, `detailHelpers.ts`, `AddTenderModal.tsx`, `TenderRow.tsx`, `index.ts`, and `src/client/components/sources/`), keeping top-level screens clean while preserving re-export compatibility.
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

## 3. Mandatory Skill Activation & North-Star Quality Standard
For comprehensive instructions, decision trees, and checklists, consult the workspace skill:
[`.agents/skills/file-creation-and-management/SKILL.md`](.agents/skills/file-creation-and-management/SKILL.md)

For the numbered requirements register (the immutable single source of rules the app must obey), the invariant acceptance gates, and the pre-completion verification checklist, consult:
[`docs/13-north-star-quality-standard.md`](docs/13-north-star-quality-standard.md)

That register is an absolute reference—do not modify its rules or thresholds for routine runs; update §3/§6 only when a requirement or operator decision itself changes. Operational status, runtime telemetry, and open work are tracked in [`docs/14-active-backlog.md`](docs/14-active-backlog.md).

## 4. Code-to-Documentation Synchronization Matrix
Every code revision must update its matching documentation in the **same commit** (enforced automatically by `QA-4` in `tests/unit/docs-consistency.test.ts` on every `npm test` and `npm run verify`):

| Code Change Scope | Required Documentation Updates |
|---|---|
| `src/server/db/schema.ts` (tables, columns, FTS5, migrations) | [`docs/03-database-schema.md`](docs/03-database-schema.md) |
| `src/server/routes/*.routes.ts` (endpoints, params, validation, payloads) | [`docs/04-api-reference.md`](docs/04-api-reference.md) |
| `src/server/scrapers/` (`portalList.ts`, parsers, healer, crawler) | [`docs/05-portals-and-scraping.md`](docs/05-portals-and-scraping.md) (& `docs/13` if rules change) |
| New modules or structural changes under `src/server/` | [`docs/02-architecture-and-stack.md`](docs/02-architecture-and-stack.md) |
| `app_settings` keys, `.env` vars, directory layout, or startup scripts | [`docs/11-configuration-and-env.md`](docs/11-configuration-and-env.md) & [`docs/03-database-schema.md`](docs/03-database-schema.md) |
| Operator-facing UI screens, filters, or workflows (`src/client/`) | [`docs/10-operator-guide.md`](docs/10-operator-guide.md) |
| Test infrastructure or new unit/integration suites (`tests/`) | [`docs/08-testing-and-coverage.md`](docs/08-testing-and-coverage.md) (never hardcode brittle test/suite counts) |
| Version bump, new feature rollout, or resolved backlog work | [`docs/12-decisions-and-changelog.md`](docs/12-decisions-and-changelog.md), [`docs/14-active-backlog.md`](docs/14-active-backlog.md), and [`README.md`](README.md) |
