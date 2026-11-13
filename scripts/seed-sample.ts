/**
 * Sample-data seed for the redesign. SAFE: writes only to ./data-sample,
 * never to ./data (your real database).
 *
 * Run:   npm run seed:sample
 * Then:  $env:TENDER_DATA_DIR="data-sample"; npm run dev      (PowerShell)
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sampleDir = process.env.TENDER_DATA_DIR && path.resolve(process.env.TENDER_DATA_DIR) !== path.resolve(root, 'data')
  ? path.resolve(process.env.TENDER_DATA_DIR)
  : path.resolve(root, 'data-sample');
if (!fs.existsSync(sampleDir)) {
  fs.mkdirSync(sampleDir, { recursive: true });
}
const dbFile = path.resolve(sampleDir, 'tender_tracker.db');
if (fs.existsSync(dbFile)) {
  try { fs.rmSync(dbFile, { force: true }); } catch {}
}
for (const sub of ['backups', 'dossiers', 'sessions', 'models', 'logs']) {
  const p = path.resolve(sampleDir, sub);
  if (!fs.existsSync(p)) {
    try { fs.mkdirSync(p, { recursive: true }); } catch {}
  }
}
process.env.TENDER_DATA_DIR = sampleDir;

const { db, initDatabase, DATA_DIR } = await import('../src/server/db/index.js');
if (path.resolve(DATA_DIR) !== sampleDir) throw new Error('Refusing to seed: not pointing at sampleDir');
initDatabase();

const H = 3600_000, D = 24 * H;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const fmt = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Karachi' });

type Opts = { bookmark?: boolean; amended?: boolean; ageDays?: number; value?: string; location?: string; notes?: string };
type S = [string, string, string, string, number | null, string[], string[], Opts?];

const SAMPLES: S[] = [
  // Closing-dates strip anchors:
  ['epads', 'EPADS/2026/0412', 'Procurement of Enterprise Cloud Infrastructure & Migration Services', 'Ministry of IT & Telecom', now + 2 * D, ['Technology & IT', 'Infrastructure & Construction'], ['cloud', 'migration', 'enterprise'], { bookmark: true, value: 'PKR 45,000,000', location: 'Islamabad' }],
  ['epads', 'EPADS/2026/0398', 'Solar Hybrid Inverter & Battery Storage for 40 Healthcare Facilities', 'National Health Services', now + 3 * D, ['Alternative Energy & Solar', 'Healthcare & Medical'], ['solar', 'hybrid inverter', 'battery storage'], { value: 'PKR 120,000,000', location: 'Nationwide' }],
  ['punjab_eproc', 'PPRA-LHR-9921', 'Supply of High-Throughput Diagnostic Laboratory Equipment', 'Punjab Health Department', now + 5 * D, ['Healthcare & Medical'], ['laboratory', 'diagnostic', 'medical equipment'], { bookmark: true, value: 'PKR 85,000,000', location: 'Lahore' }],
  ['punjab_eproc', 'PPRA-RWP-4410', 'Consultancy for Smart Traffic Management & Surveillance System', 'Rawalpindi Development Authority', now + 7 * D, ['Security & Surveillance', 'Consultancy & Advisory'], ['surveillance', 'smart traffic', 'consultancy'], { value: 'PKR 28,000,000', location: 'Rawalpindi' }],
  ['sppra', 'SPPRA-KHI-2026-118', 'Desalination Plant Maintenance & Reverse Osmosis Membrane Replacement', 'Karachi Water & Sewerage Board', now + 12 * D, ['Infrastructure & Construction', 'Engineering & Industrial'], ['desalination', 'reverse osmosis', 'maintenance'], { value: 'PKR 65,000,000', location: 'Karachi' }],
  ['sppra', 'SPPRA-HYD-5502', 'Fiber Optic Backbone Ring Expansion Phase 2', 'Sindh IT Board', now + 14 * D, ['Technology & IT', 'Telecom & Networking'], ['fiber optic', 'backbone', 'networking'], { bookmark: true, value: 'PKR 92,000,000', location: 'Hyderabad' }],

  // Rest of the 15-day runway + farther out:
  ['kppra', 'KPPRA/PESH/2026/88', 'Deployment of Electric Feeder Buses for BRT Feeder Routes', 'Peshawar Urban Transport Authority', now + 8 * D, ['Engineering & Industrial'], ['electric buses', 'transport', 'feeder'], { value: 'PKR 210,000,000', location: 'Peshawar' }],
  ['bppra', 'BPPRA-QTA-2026-033', 'Establishment of 10MW Off-Grid Solar Microgrids', 'Balochistan Energy Department', now + 9 * D, ['Alternative Energy & Solar'], ['microgrid', 'off-grid', 'solar power'], { value: 'PKR 180,000,000', location: 'Quetta' }],
  ['ungm', 'UNGM-PAK-2026-004', 'Supply of Cold-Chain Refrigerators for Polio Eradication Drive', 'UNICEF Pakistan', now + 10 * D, ['Healthcare & Medical'], ['cold-chain', 'refrigerator', 'polio'], { value: 'USD 850,000', location: 'Nationwide' }],
  ['giz', 'GIZ-PAK-9021', 'Technical Assistance: Industrial Energy Efficiency Decarbonization Roadmap', 'GIZ Pakistan Country Office', now + 11 * D, ['Consultancy & Advisory', 'Alternative Energy & Solar'], ['energy efficiency', 'decarbonization', 'advisory'], { value: 'EUR 350,000', location: 'Islamabad' }],
  ['ndma', 'NDMA-REL-2026-077', 'Emergency Dewatering Pumps & Rapid Deployment Generator Sets', 'National Disaster Management Authority', now + 13 * D, ['Infrastructure & Construction'], ['dewatering pump', 'generator', 'emergency'], { value: 'PKR 55,000,000', location: 'Islamabad' }],
  ['fde', 'FDE-EDU-2026-102', 'Provision of Interactive Smart Boards & STEM Lab Kits for 50 Colleges', 'Federal Directorate of Education', now + 6 * D, ['Technology & IT'], ['smart board', 'stem kit', 'interactive'], { amended: true, value: 'PKR 42,000,000', location: 'Islamabad' }],
  ['mofept', 'MOFEPT-PROC-2026-19', 'National Digital Learning Portal Revamp & Content Licensing', 'Ministry of Federal Education & Professional Training', now + 4 * D, ['Technology & IT', 'Consultancy & Advisory'], ['digital learning', 'portal', 'lms'], { value: 'PKR 34,000,000', location: 'Islamabad' }],
  ['gilgit', 'GB-TND-2026-015', 'Small Hydro Turbine Replacement for Hunza Mini-Hydel Station', 'Gilgit-Baltistan Power Department', now + 15 * D, ['Alternative Energy & Solar', 'Engineering & Industrial'], ['hydro turbine', 'mini-hydel', 'power'], { value: 'PKR 78,000,000', location: 'Hunza' }],
  ['pseb', 'PSEB-TECH-2026-08', 'Software Technology Park Islamabad - High-Density Data Cabling', 'Pakistan Software Export Board', now + 1 * D, ['Telecom & Networking', 'Technology & IT'], ['data cabling', 'cat6a', 'structured cabling'], { bookmark: true, value: 'PKR 18,000,000', location: 'Islamabad' }],

  // Special cases: amended, older unread, edge cases
  ['tender_services', 'TSP-CORR-2026-03', 'Upgradation of Sewage Treatment Plant Aeration Basins (Corrigendum 2)', 'Capital Development Authority', now + 11 * D, ['Infrastructure & Construction'], ['sewage', 'treatment plant', 'aeration'], { amended: true, value: 'PKR 110,000,000', location: 'Islamabad' }],
  ['peef', 'PEEF-SCH-2026-01', 'Annual Printing & Distribution of 50,000 Scholarship Information Packs', 'Punjab Educational Endowment Fund', now + 13 * D, [], ['printing', 'distribution', 'publications'], { value: 'PKR 8,500,000', location: 'Lahore' }],
  ['psda', 'PSDA-AUTO-2026-02', 'Supply of Automotive Diagnostic Workstations for Vocational Institutes', 'Punjab Skills Development Authority', now + 8 * D, ['Engineering & Industrial'], ['automotive', 'diagnostic workstation', 'vocational'], { value: 'PKR 22,000,000', location: 'Multan' }],
  ['psdf', 'PSDF-TRG-2026-44', 'Skills Training in Renewable Energy & Solar PV Installation', 'Punjab Skills Development Fund', now + 10 * D, ['Alternative Energy & Solar', 'Consultancy & Advisory'], ['skills training', 'solar pv', 'vocational'], { value: 'PKR 38,000,000', location: 'Lahore' }],
  ['ignite', 'IGNITE-INC-2026-05', 'Management and Incubation Operations of National Incubation Center Karachi', 'Ignite National Technology Fund', now + 15 * D, ['Technology & IT', 'Consultancy & Advisory'], ['incubation', 'startup', 'accelerator'], { bookmark: true, value: 'PKR 150,000,000', location: 'Karachi' }]
];

console.log('Seeding', SAMPLES.length, 'rich realistic tenders into data-sample...');

const insertTender = db.prepare(`
  INSERT INTO tenders (
    id, canonical_id, reference_no, title, organization, portal_id, portal_name, direct_url,
    domain_tracks, matched_keywords, match_score, semantic_score, publish_date, closing_date, closing_date_formatted,
    estimated_value, location, description, has_corrigendum, pipeline_status, is_bookmarked, viewed, status_notes, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New Opportunity', ?, ?, ?, ?, ?)
`);

db.transaction(() => {
  for (let i = 0; i < SAMPLES.length; i++) {
    const [portalId, refNo, title, org, closingMs, tracks, keywords, opts = {}] = SAMPLES[i];
    const id = `sample-${portalId}-${String(i + 1).padStart(3, '0')}`;
    const pubMs = now - (opts.ageDays ?? (i % 5 + 1)) * D;
    const closingIso = closingMs !== null ? iso(closingMs) : null;
    const closingFmt = closingMs !== null ? fmt(closingMs) : 'Not Available';
    const isBookmarked = opts.bookmark ? 1 : 0;
    const isAmended = opts.amended ? 1 : 0;
    const viewed = i < 3 ? 1 : 0;
    const matchScore = 75 + ((i * 7) % 25);
    const desc = `${title}. Issued by ${org}. Scope includes complete supply, installation, testing, and commissioning in accordance with standard bidding documents. Interested bidders must hold valid PEC / SECP registration and relevant past experience.`;

    insertTender.run(
      id, id, refNo, title, org, portalId, portalId.toUpperCase(),
      `https://example.com/tenders/${portalId}/${encodeURIComponent(refNo)}`,
      JSON.stringify(tracks), JSON.stringify(keywords), matchScore, matchScore,
      iso(pubMs).slice(0, 10), closingIso, closingFmt,
      opts.value || null, opts.location || 'Pakistan', desc, isAmended,
      isBookmarked, viewed, opts.notes || null, iso(pubMs), iso(now)
    );
  }
})();

console.log('Seeded successfully: 20 tenders, clean runway distribution across all 18 portals.');
console.log('Database path:', path.resolve(sampleDir, 'tender_tracker.db'));
