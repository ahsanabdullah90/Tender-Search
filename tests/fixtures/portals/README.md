# Portal HTML Test Fixtures

Offline, sanitized HTML fixtures of Pakistani procurement portals for deterministic tests without live internet.

## Captured fixtures (portal contract tests)

Captured with `scripts/capture-portal-fixture.ts` (run with `TENDER_DATA_DIR` pointing at a scratch folder). Each folder holds `page.html` (sanitized listing page) and `expected.json` (what the parser found at capture time). `tests/scraper/portal-contracts.test.ts` parses each one and pushes it through the full ingest pipeline with the clock frozen to the capture date.

Sanitizing removes scripts, styles, hidden form state, emails, phone numbers, CNICs, session tokens and honorific-prefixed names (`Mr.`, `Engr.`, `Dr.` …), then trims the page to about 50 KB, keeping every listing the parser used. **Limitation:** names written without an honorific cannot be detected automatically and may remain; these are public officials named on public tender pages.

| Portal | Captured | Listings | With deadline | With documents | Notes |
|---|---|---|---|---|---|
| `bppra` | 2026-11-10 | 9 | 8 | 9 | |
| `ndma` | 2026-11-10 | 4 | 4 | 4 | |
| `fde` | 2026-11-10 | 12 | 1 | 0 | Download-Manager documents sit on detail pages |
| `mofept` | 2026-11-10 | 16 | 16 | 16 | |
| `pseb` | 2026-11-10 | 10 | 0 | 10 | Direct-PDF listings: deadlines come from the documents |
| `ignite` | 2026-11-10 | 18 | 18 | 18 | |
| `psdf` | 2026-11-10 | 19 (of 41) | 0 | 19 | 109 KB: listings spread across the page |
| `peef` | 2026-11-10 | 25 | 25 | 25 | |
| `psda` | 2026-11-10 | 0 | – | – | **Parser gap:** live page yields no tenders over HTTP |
| `giz` | 2026-11-10 | 0 | – | – | **Parser gap:** live page yields no tenders over HTTP |
| `pid` | 2026-11-10 | 0 | – | – | **Parser gap:** live page yields no tenders over HTTP |

Re-capture a portal after fixing its parser: `npx tsx scripts/capture-portal-fixture.ts <portalId>`.

## Synthetic fixtures (hand-written)

- `punjab_eproc/page.html`: Punjab PPRA eProcurement table structure.
- `sppra/page.html`: Sindh PPRA listing.
- `epads/page.html`: Federal PPRA EPADS structure.
- `tender_services/page.html`: Tender Services Pakistan aggregated listing.
- `cloudflare_challenge/page.html`: Cloudflare Turnstile challenge response.
- `login_required/page.html`: Portal login challenge.

## Not covered

- `kppra`, `gilgit`: `offline_broken` (unreachable).
- `ungm`: JavaScript-rendered; needs the Playwright tier.

## Document fixtures

`tests/fixtures/documents/buildFixtures.ts` generates small synthetic PDFs and `.docx` files at test time. No real tender documents are stored in the repository.
