# 05. Portals Catalog & Scraping Architecture

## The 18 Pakistan Procurement Portals

Tender Tracker catalogs 18 official and aggregator procurement portals across Pakistan, grouped into 5 distinct categories:

| ID | Portal Name | Category | Tier | Access Mode | Notes |
|---|---|---|---|---|---|
| `epads` | Federal PPRA (EPMS / EPADS) | Regulatory | `playwright` | `login_required` | Statutory federal procurement portal. Main notice board is public; document downloads require operator login. |
| `punjab_eproc` | Punjab PPRA | Regulatory | `http` | `public` | Highest volume provincial source (850+ live tenders). Scraped via Cheerio with toleration for legacy .NET tables. |
| `sppra` | Sindh SPPRA | Regulatory | `playwright` | `public` | Dynamic Angular/Vue interface with 12,000+ listings. Headless Playwright context renders DOM before extraction. |
| `kppra` | KPK KPPRA | Regulatory | `http` | `offline_broken` | Known intermittently unreachable/offline. Flagged as offline; health probe monitors connectivity without breaking scans. |
| `bppra` | Balochistan BPPRA | Regulatory | `http` | `offline_broken` | Provincial portal experiencing prolonged domain routing downtime. |
| `ajk_ppra` | AJK PPRA | Regulatory | `http` | `public` | Azad Jammu & Kashmir public notices. |
| `gb_portal` | Gilgit-Baltistan Eproc | Regulatory | `http` | `offline_broken` | Intermittent regional gateway; skipped during normal full scans. |
| `wapda` | WAPDA | Federal/Regional | `http` | `public` | Water & Power Development Authority major hydropower and transmission tenders. |
| `nha` | National Highway Authority | Federal/Regional | `http` | `public` | Highway, road rehabilitation, and civil infrastructure projects. |
| `ogdcl` | OGDCL | Federal/Regional | `http` | `public` | Oil & Gas Development Company Limited engineering and supply bids. |
| `caa` | Civil Aviation Authority | Federal/Regional | `http` | `public` | Airport equipment, radar, and civil works. |
| `sngpl` | Sui Northern Gas (SNGPL) | Federal/Regional | `http` | `public` | Gas infrastructure, pipelines, and meter procurement. |
| `navttc` | NAVTTC | Tech & Skills | `http` | `public` | National Vocational & Technical Training Commission vocational programs. |
| `tevta_punjab`| TEVTA Punjab | Tech & Skills | `http` | `public` | Technical Education & Vocational Training Authority Punjab equipment and lab tenders. |
| `peef` | PEEF | Tech & Skills | `http` | `offline_broken` | Punjab Educational Endowment Fund educational supply tenders. |
| `undp_pk` | UNDP Pakistan | Multilateral | `http` | `public` | UN development projects, humanitarian, and climate tenders. |
| `worldbank_pk`| World Bank Pakistan | Multilateral | `http` | `public` | Multilateral financed development projects. |
| `tender_services`| Tender Services Pakistan | Aggregator | `http` | `login_required` | Major national tender aggregator. Requires login at `https://tenderservice.pk/permits/login.php`. |

---

## Two-Tier Scraping Architecture

### Tier 1: Tolerant HTTP + Cheerio (`tier: 'http'`)
Static HTML pages are fetched using `fetch` or Node's `https` module equipped with a tolerant SSL agent (`rejectUnauthorized: false`).
- **Why Tolerant SSL?**: Several Pakistani government and municipal subdomains use self-signed, expired, or intermediate chain-broken SSL certificates. Without tolerant agent configuration, automated requests fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `CERT_HAS_EXPIRED`.
- **Parsing**: Cheerio traverses table rows, div cards, and anchor tags to extract title, reference number, organization, dates, and download links.

### Tier 2: Dynamic Browser Execution (`tier: 'playwright'`)
Portals employing client-side Single Page Application (SPA) architectures (such as Sindh SPPRA) require full JavaScript execution.
- **Headless Browser Execution**: Uses a pooled Chromium instance running in headless mode with realistic viewports and masqueraded User-Agent headers.
- **Session Persistence**: Extracted session cookies and local storage tokens are cached in `data/sessions/<portalId>.json` so that subsequent scans do not trigger re-authentication or challenges.

---

## Friction Resolution & Human-in-the-Loop (HITL)

When a portal deploys Cloudflare Turnstile, bot protection, or requires interactive multi-factor verification:
1. **Challenge Detection (Bug B4)**:
   The crawler inspects HTTP response codes (403/503) and HTML content for Cloudflare challenge markers (`cf-browser-verification`, `Turnstile`, `cf-chl-bypass`).
2. **Flagging**:
   Instead of crashing the crawler or recording an uncaught exception, the portal's status in `portal_health` is set to `hitl_required`, and `verified_status` displays `"Challenge detected"` or `"Credentials required"`.
3. **Interactive Resolution**:
   The operator clicks **"Launch Interactive Browser"** from the UI. A visible (headed) Chromium window opens to the target URL. The operator solves the CAPTCHA or logs in.
4. **Cookie Harvesting**:
   Upon operator confirmation (or automated cookie polling), cookies are serialized to `data/sessions/` and portal status returns to `online`.
