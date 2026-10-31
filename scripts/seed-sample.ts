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
const sampleDir = path.resolve(root, 'data-sample');
fs.rmSync(sampleDir, { recursive: true, force: true });
fs.mkdirSync(sampleDir, { recursive: true });
process.env.TENDER_DATA_DIR = sampleDir;

const { db, initDatabase, DATA_DIR } = await import('../src/server/db.ts');
if (path.resolve(DATA_DIR) !== sampleDir) throw new Error('Refusing to seed: not pointing at data-sample');
initDatabase();

const H = 3600_000, D = 24 * H;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const fmt = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Karachi' });

type Opts = { bookmark?: boolean; amended?: boolean; ageDays?: number; value?: string; location?: string; notes?: string };
type S = [string, string, string, string, number | null, string[], string[], Opts?];

const rows: S[] = [
  // Inbox (New Opportunity)
  ['Supply and Installation of 500 kW Solar PV System', 'Punjab Energy Department', 'punjab_ppra', 'New Opportunity', 14 * H, ['Solar & Clean Energy'], ['solar', 'photovoltaic'], { value: 'PKR 82,000,000', location: 'Lahore' }],
  ['Rehabilitation of Road, Kohat to Hangu Section', 'C&W Department KP', 'kppra', 'New Opportunity', 20 * H, ['Construction & Civil Works'], ['rehabilitation', 'road'], { amended: true, location: 'Kohat' }],
  ['Video Production Services for Awareness Campaign', 'Ministry of Information', 'ppra_federal', 'New Opportunity', 2 * D, ['Media, Documentaries & Communications'], ['video production'], {}],
  ['Construction of Skills Training Institute Building', 'NAVTTC', 'navttc', 'New Opportunity', 3 * D, ['Construction & Civil Works', 'Vocational Training (TVET)'], ['construction', 'institute'], { value: 'PKR 140,000,000' }],
  ['Net Metering Inverters, Procurement of 120 Units', 'LESCO', 'punjab_ppra', 'New Opportunity', 5 * D, ['Solar & Clean Energy'], ['inverter', 'net metering'], { bookmark: true }],
  ['Documentary on Water Conservation, 3 Episodes', 'Sindh Irrigation Dept', 'sindh_spra', 'New Opportunity', 6 * D, ['Media, Documentaries & Communications'], ['documentary'], {}],
  ['Civil Works for Boundary Wall, District Complex', 'District Admin Swat', 'kppra', 'New Opportunity', 9 * D, ['Construction & Civil Works'], ['civil works'], {}],
  ['Workshop Equipment for TVET Centres (Lot 2)', 'TEVTA', 'punjab_ppra', 'New Opportunity', 12 * D, ['Vocational Training (TVET)'], ['workshop', 'TVET'], {}],
  ['Annual Maintenance of Solar Street Lights', 'CDA Islamabad', 'ppra_federal', 'New Opportunity', null, ['Solar & Clean Energy'], ['solar'], { notes: 'No closing date stated on portal' }],
  ['Animation Content for Public Health Messaging', 'Health Dept Balochistan', 'bppra', 'New Opportunity', 4 * D, ['Media, Documentaries & Communications'], ['animation'], { ageDays: 6 }],
  ['Renovation of Government Girls School Building', 'Education Dept GB', 'gb_portal', 'New Opportunity', 8 * D, ['Construction & Civil Works'], ['building', 'rehabilitation'], {}],
  ['Photovoltaic Pumping Systems for 40 Tubewells', 'PHED Punjab', 'punjab_ppra', 'New Opportunity', 16 * D, ['Solar & Clean Energy'], ['photovoltaic'], { value: 'PKR 56,500,000' }],
  // Pipeline
  ['Solar Rooftop Installation, Provincial Assembly', 'KP Assembly Secretariat', 'kppra', 'Under Review', 3 * D, ['Solar & Clean Energy'], ['solar'], { bookmark: true, notes: 'Check site visit date' }],
  ['Skills Training Services for 2,000 Trainees', 'NAVTTC', 'navttc', 'Under Review', 10 * D, ['Vocational Training (TVET)'], ['skills training'], {}],
  ['Construction of Community Centre, Phase II', 'Local Govt Punjab', 'punjab_ppra', 'Preparing Bid', 2 * D, ['Construction & Civil Works'], ['construction'], { amended: true, notes: 'Pricing sheet half done' }],
  ['Documentary Series, National Heritage Sites', 'PTV Corporation', 'ppra_federal', 'Preparing Bid', 6 * D, ['Media, Documentaries & Communications'], ['documentary'], { bookmark: true }],
  ['Supply of Solar Inverters, 60 kVA', 'WAPDA', 'ppra_federal', 'Submitted', -2 * D, ['Solar & Clean Energy'], ['inverter'], { ageDays: 18, notes: 'Submitted by courier' }],
  ['Office Furniture and Fit-out, Regional Office', 'SBP', 'ppra_federal', 'Submitted', -5 * D, ['Construction & Civil Works'], ['building'], { ageDays: 25 }],
  ['Road Rehabilitation, Abbottabad Bypass', 'C&W KP', 'kppra', 'Won', -20 * D, ['Construction & Civil Works'], ['road', 'rehabilitation'], { ageDays: 45, value: 'PKR 210,000,000' }],
  // Passed
  ['CCTV Surveillance Camera Upgrade', 'Police Dept', 'sindh_spra', 'Passed', -1 * D, [], ['camera'], { ageDays: 9 }],
];

const insert = db.prepare(`
  INSERT INTO tenders (id, canonical_id, reference_no, title, organization, portal_id, portal_name, direct_url,
    domain_tracks, matched_keywords, match_score, publish_date, closing_date, closing_date_formatted,
    estimated_value, location, description, has_corrigendum, pipeline_status, status_notes, is_bookmarked, viewed, created_at, updated_at)
  VALUES (@id, @cid, @ref, @title, @org, @portal, @portalName, @url, @tracks, @kw, @score, @pub, @close, @closeFmt,
    @value, @loc, @desc, @amended, @status, @notes, @bm, @viewed, @created, @created)
`);
const corr = db.prepare(`INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged, detected_at)
  VALUES (?, ?, 'Closing Date Extended', ?, ?, 0, ?)`);

db.transaction(() => {
  rows.forEach(([title, org, portal, status, closeIn, tracks, kw, o = {}], i) => {
    const id = `sample-${String(i + 1).padStart(3, '0')}`;
    const age = (o.ageDays ?? 1 + (i % 3)) * D;
    const close = closeIn === null ? null : now + closeIn;
    insert.run({
      id, cid: id, ref: `SMP/2026/${100 + i}`, title, org, portal, portalName: portal,
      url: 'https://example.invalid/sample', tracks: JSON.stringify(tracks), kw: JSON.stringify(kw),
      score: 60 + ((i * 7) % 40), pub: iso(now - age), close: close ? iso(close) : null,
      closeFmt: close ? fmt(close) : null, value: o.value ?? null, loc: o.location ?? null,
      desc: 'Sample tender for design review. Not real data.', amended: o.amended ? 1 : 0,
      status, notes: o.notes ?? '', bm: o.bookmark ? 1 : 0, viewed: status === 'New Opportunity' && i % 2 ? 0 : 1,
      created: iso(now - age),
    });
    if (o.amended && close) corr.run(`${id}-c1`, id, fmt(close - 2 * D), fmt(close), iso(now - 6 * H));
  });
})();

// Portal health: spread across every status the Portals tab shows
const portals = db.prepare('SELECT portal_id FROM portal_health ORDER BY portal_id').all() as { portal_id: string }[];
const upd = db.prepare('UPDATE portal_health SET status=?, last_scan_at=?, last_error_message=? WHERE portal_id=?');
const errs = ['Site not responding', 'Certificate error', 'Site not responding'];
portals.forEach((p, i) => {
  if (i < 2) upd.run('hitl_required', null, 'Asks for a human check', p.portal_id);
  else if (i < 5) upd.run('error', iso(now - (1 + (i % 2)) * D), errs[i - 2], p.portal_id);
  else upd.run('online', iso(now - 3 * H), null, p.portal_id);
});

const n = (db.prepare('SELECT COUNT(*) c FROM tenders').get() as { c: number }).c;
console.log(`Seeded ${n} sample tenders and ${portals.length} portals into ${sampleDir}`);
db.close();
