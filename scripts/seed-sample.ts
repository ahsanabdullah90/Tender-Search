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
for (const sub of ['backups', 'dossiers', 'sessions', 'models', 'logs', 'tessdata']) {
  const p = path.resolve(sampleDir, sub);
  if (!fs.existsSync(p)) {
    try { fs.mkdirSync(p, { recursive: true }); } catch {}
  }
}
process.env.TENDER_DATA_DIR = sampleDir;

const { db, initDatabase, DATA_DIR } = await import('../src/server/db/index.js');
const { formatClosingDate } = await import('../src/server/scrapers/dateParser.js');
if (path.resolve(DATA_DIR) !== sampleDir) throw new Error('Refusing to seed: not pointing at sampleDir');
initDatabase();

const H = 3600_000, D = 24 * H;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const fmt = (ms: number) => formatClosingDate(iso(ms));

type Opts = { bookmark?: boolean; amended?: boolean; ageDays?: number; value?: string; location?: string; notes?: string };
type S = [string, string, string, string, number | null, string[], string[], Opts?];

const SAMPLES: S[] = [
  // Closing-dates strip anchors:
  ['epms_ppra', 'EPMS/2026/0412', 'Procurement of Enterprise Textbook Printing & Classroom Materials', 'Ministry of Federal Education', now + 2 * D, ['Education & Learning', 'Stationery & Office Supplies'], ['education', 'textbooks', 'printing', 'classroom'], { bookmark: true, value: 'PKR 45,000,000', location: 'Islamabad' }],
  ['epms_ppra', 'EPMS/2026/0398', 'Solar Hybrid Inverter & Battery Bank for 40 Rural Health Centers', 'National Health Services', now + 3 * D, ['Solar & Clean Energy', 'Construction & Civil Works'], ['solar', 'hybrid solar', 'battery bank', 'infrastructure'], { value: 'PKR 120,000,000', location: 'Nationwide' }],
  ['punjab_eproc', 'PPRA-LHR-9921', 'Competency-Based Youth Skills & Technical Training Program', 'Punjab TEVTA', now + 5 * D, ['Vocational Training (TVET)', 'Education & Learning'], ['tvet', 'technical training', 'youth skills'], { bookmark: true, value: 'PKR 85,000,000', location: 'Lahore' }],
  ['punjab_eproc', 'PPRA-RWP-4410', 'Civil Renovation & Prefabricated Classrooms Expansion', 'Rawalpindi Development Authority', now + 7 * D, ['Construction & Civil Works', 'Education & Learning'], ['renovation', 'prefabricated', 'classroom'], { value: 'PKR 28,000,000', location: 'Rawalpindi' }],
  ['sppra', 'SPPRA-KHI-2026-118', 'Rehabilitation & Masonry Infrastructure Works at Regional Centers', 'Works & Services Department Sindh', now + 12 * D, ['Construction & Civil Works'], ['rehabilitation', 'masonry', 'infrastructure'], { value: 'PKR 65,000,000', location: 'Karachi' }],
  ['sppra', 'SPPRA-HYD-5502', 'Supply of Office Stationery, Toner & Photocopier Consumables', 'Sindh School Education Department', now + 14 * D, ['Stationery & Office Supplies'], ['stationery', 'toner', 'consumables'], { bookmark: true, value: 'PKR 18,000,000', location: 'Hyderabad' }],

  // Rest of the 15-day runway + farther out:
  ['kppra', 'KPPRA/PESH/2026/88', 'Supply of Vocational Tool Kits & Apprenticeship Training', 'KP TEVTA Peshawar', now + 8 * D, ['Vocational Training (TVET)'], ['tool kits', 'apprenticeship', 'vocational'], { value: 'PKR 48,000,000', location: 'Peshawar' }],
  ['bppra', 'BPPRA-QTA-2026-033', 'Establishment of 10MW Off-Grid Solar PV Microgrids', 'Balochistan Energy Department', now + 9 * D, ['Solar & Clean Energy'], ['solar', 'pv system', 'solarization'], { value: 'PKR 180,000,000', location: 'Quetta' }],
  ['ajk_ppra', 'AJK-CW-2026-004', 'Building Repair & Earthwork Protection Walls in Muzaffarabad', 'AJK Communication & Works', now + 10 * D, ['Construction & Civil Works'], ['building repair', 'earthwork', 'civil works'], { value: 'PKR 32,000,000', location: 'Muzaffarabad, AJK' }],
  ['ungm', 'UNGM-PAK-2026-004', 'Teacher Training & Digital EdTech Classroom Rollout', 'UNICEF Pakistan', now + 11 * D, ['Education & Learning'], ['teacher training', 'edtech', 'classroom'], { value: 'USD 850,000', location: 'Nationwide' }],
  ['giz', 'GIZ-PAK-9021', 'Advocacy Campaign & Documentary Media Production on TVET Reform', 'GIZ Pakistan Country Office', now + 11 * D, ['Media, Documentaries & Communications', 'Vocational Training (TVET)'], ['advocacy campaign', 'documentary', 'tvet'], { value: 'EUR 350,000', location: 'Islamabad' }],
  ['ndma', 'NDMA-REL-2026-077', 'Construction of Prefabricated Flood-Resilient Community Warehouses', 'National Disaster Management Authority', now + 13 * D, ['Construction & Civil Works'], ['construction', 'prefabricated', 'infrastructure'], { value: 'PKR 55,000,000', location: 'Islamabad' }],
  ['fde', 'FDE-EDU-2026-102', 'Provision of Classroom Supplies & Solar Backup for 50 Colleges', 'Federal Directorate of Education', now + 6 * D, ['Education & Learning', 'Solar & Clean Energy'], ['classroom', 'school supplies', 'solar'], { amended: true, value: 'PKR 42,000,000', location: 'Islamabad' }],
  ['mofept', 'MOFEPT-PROC-2026-19', 'National Literacy & Curriculum Digital Learning Content', 'Ministry of Federal Education & Professional Training', now + 4 * D, ['Education & Learning'], ['literacy', 'curriculum', 'education'], { value: 'PKR 34,000,000', location: 'Islamabad' }],
  ['gilgit', 'GB-TND-2026-015', 'Hybrid Solarization & Net Metering for District Schools', 'Gilgit-Baltistan Education Department', now + 15 * D, ['Solar & Clean Energy', 'Education & Learning'], ['solarization', 'net metering', 'education'], { value: 'PKR 78,000,000', location: 'Hunza' }],
  ['pseb', 'PSEB-TECH-2026-08', 'Digital Communications & Public Relations Summit Campaign', 'Pakistan Software Export Board', now + 1 * D, ['Media, Documentaries & Communications'], ['digital communications', 'public relations', 'event management'], { bookmark: true, value: 'PKR 18,000,000', location: 'Islamabad' }],

  // Special cases: amended, older unread, edge cases
  ['tender_services', 'TSP-CORR-2026-03', 'Rehabilitation & Asphalt Road Works (Corrigendum 2)', 'Capital Development Authority', now + 11 * D, ['Construction & Civil Works'], ['rehabilitation', 'asphalt', 'civil works'], { amended: true, value: 'PKR 110,000,000', location: 'Islamabad' }],
  ['peef', 'PEEF-SCH-2026-01', 'Annual Printing & Distribution of 50,000 Scholarship Packs', 'Punjab Educational Endowment Fund', now + 13 * D, ['Stationery & Office Supplies', 'Education & Learning'], ['printing', 'scholarships', 'stationery'], { value: 'PKR 8,500,000', location: 'Lahore' }],
  ['psdf', 'PSDF-TRG-2026-44', 'Skills Development & Renewable Solar PV Vocational Courses', 'Punjab Skills Development Fund', now + 10 * D, ['Vocational Training (TVET)', 'Solar & Clean Energy'], ['skill development', 'vocational courses', 'solar'], { value: 'PKR 38,000,000', location: 'Lahore' }],
  ['ignite', 'IGNITE-INC-2026-05', 'Audio Visual & Animation Series for National Tech Incubation', 'Ignite National Technology Fund', now + 15 * D, ['Media, Documentaries & Communications'], ['audio visual', 'animation', 'video production'], { bookmark: true, value: 'PKR 24,000,000', location: 'Karachi' }]
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

console.log('Seeded successfully: 20 tenders, clean runway distribution across all 19 portals.');
console.log('Database path:', path.resolve(sampleDir, 'tender_tracker.db'));
