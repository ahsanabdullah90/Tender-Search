import { db, getAllDomainTracks, updatePortalHealth, getPortalHealthList } from '../db.js';
import { PORTAL_DEFINITIONS, PortalDefinition } from './portalList.js';
import { findCanonicalMatch } from '../deduplicator.js';
import { getHumanJitterDelay, sleep, sslTolerantAgent, HUMAN_CHROME_HEADERS } from './baseScraper.js';
import { ScanStatus, Tender } from '../../types.js';
import * as cheerio from 'cheerio';
import https from 'https';
import http from 'http';

// Global scan state for solo operator monitoring
export let currentScanStatus: ScanStatus = {
  isScanning: false,
  currentPortal: null,
  progressPercent: 0,
  completedPortals: 0,
  totalPortals: PORTAL_DEFINITIONS.length,
  newTendersFound: 0,
  corrigendaFound: 0,
  lastScanTimestamp: null
};

type ProgressListener = (status: ScanStatus) => void;
const progressListeners: Set<ProgressListener> = new Set();

export function addProgressListener(listener: ProgressListener) {
  progressListeners.add(listener);
}

export function removeProgressListener(listener: ProgressListener) {
  progressListeners.delete(listener);
}

function broadcastProgress() {
  for (const listener of progressListeners) {
    listener({ ...currentScanStatus });
  }
}

/**
 * Executes a full scan across all 16+ portals or a single target portal
 */
export async function startCrawlerScan(targetPortalId?: string) {
  if (currentScanStatus.isScanning) {
    return currentScanStatus;
  }

  const portalsToScan = targetPortalId
    ? PORTAL_DEFINITIONS.filter(p => p.id === targetPortalId)
    : PORTAL_DEFINITIONS;

  currentScanStatus = {
    isScanning: true,
    currentPortal: null,
    progressPercent: 0,
    completedPortals: 0,
    totalPortals: portalsToScan.length,
    newTendersFound: 0,
    corrigendaFound: 0,
    lastScanTimestamp: currentScanStatus.lastScanTimestamp
  };
  broadcastProgress();

  // Run in background
  (async () => {
    try {
      const activeTracks = getAllDomainTracks().filter(t => t.is_active === 1);

      for (let i = 0; i < portalsToScan.length; i++) {
        const portal = portalsToScan[i];
        currentScanStatus.currentPortal = portal.name;
        currentScanStatus.progressPercent = Math.round((i / portalsToScan.length) * 100);
        broadcastProgress();

        // Update portal state to scanning
        updatePortalHealth(portal.id, { status: 'scanning' });

        try {
          const rawItems = await scrapePortal(portal);

          let itemsMatched = 0;
          for (const item of rawItems) {
            const result = processAndSaveTender(item, portal, activeTracks);
            if (result.isNew) currentScanStatus.newTendersFound++;
            if (result.hasCorrigendum) currentScanStatus.corrigendaFound++;
            if (result.matched) itemsMatched++;
          }

          // Reset consecutive zero yields if items found
          const health = db.prepare('SELECT consecutive_zero_yields FROM portal_health WHERE portal_id = ?').get(portal.id) as any;
          const currentZeros = health?.consecutive_zero_yields || 0;
          const newZeros = itemsMatched === 0 ? currentZeros + 1 : 0;
          const nextStatus = newZeros >= 3 ? 'selector_broken' : 'online';

          updatePortalHealth(portal.id, {
            status: nextStatus,
            last_scan_at: new Date().toISOString(),
            last_items_found: itemsMatched,
            consecutive_zero_yields: newZeros,
            last_error_message: null
          });
        } catch (err: any) {
          console.error(`Error scanning portal ${portal.id}:`, err);
          updatePortalHealth(portal.id, {
            status: 'error',
            last_error_message: err.message || 'Scrape connection failure'
          });
        }

        currentScanStatus.completedPortals = i + 1;
        currentScanStatus.progressPercent = Math.round(((i + 1) / portalsToScan.length) * 100);
        broadcastProgress();

        // Human-like pause before next portal if more remain
        if (i < portalsToScan.length - 1) {
          const delay = getHumanJitterDelay(2000, 4500);
          await sleep(delay);
        }
      }
    } finally {
      currentScanStatus.isScanning = false;
      currentScanStatus.currentPortal = null;
      currentScanStatus.lastScanTimestamp = new Date().toISOString();
      currentScanStatus.progressPercent = 100;
      broadcastProgress();
    }
  })();

  return currentScanStatus;
}

export interface RawScrapedItem {
  referenceNo?: string;
  title: string;
  organization: string;
  directUrl: string;
  publishDate?: string;
  closingDate?: string | null;
  estimatedValue?: string;
  location?: string;
  description?: string;
  isCorrigendum?: boolean;
}

/**
 * Scrapes a portal via tolerant HTTP/Cheerio
 */
async function scrapePortal(portal: PortalDefinition): Promise<RawScrapedItem[]> {
  try {
    const html = await fetchHtmlWithTolerantAgent(portal.tendersUrl);
    const $ = cheerio.load(html);
    const items: RawScrapedItem[] = [];

    // Check for CAPTCHA or blocking elements
    if ($('iframe[src*="cloudflare"], #captcha, input[name*="captcha"]').length > 0 || html.includes('cf-browser-verification')) {
      updatePortalHealth(portal.id, { status: 'hitl_required' });
      return [];
    }

    // Portal-specific and generic table/list parser
    // Selectors:
    // - Punjab eProc: table#ContentPlaceHolder1_GridView1 tr, table.grid tr
    // - NDMA: .view-content .views-row, table.table tr
    // - FDE: .wp-block-file, .download-item, table tbody tr, article
    // - MOFEPT: table tr, .tender-list li
    // - Ignite: .tender-box, .procurement-item, table tbody tr, .tab-pane tr
    // - PSDF: .procurement-card, table tr, .tender-card
    // - TechDestination (PSEB): .tender-item, article, table tr
    // - Generic fallbacks
    const selector = [
      'table tbody tr',
      'table#ContentPlaceHolder1_GridView1 tr',
      '.tender-row',
      '.notice-item',
      '.view-content .views-row',
      '.procurement-item',
      '.download-item',
      '.tender-item',
      '.tab-pane table tr',
      'article'
    ].join(', ');

    $(selector).each((_, el) => {
      const rowText = $(el).text().trim();
      if (!rowText || rowText.length < 20) return;

      const link = $(el).find('a').first();
      const href = link.attr('href') || portal.tendersUrl;
      const fullUrl = href.startsWith('http') ? href : new URL(href, portal.baseUrl).toString();
      const title = link.text().trim() || $(el).find('td:nth-child(2), h3, h4').first().text().trim() || rowText.slice(0, 100);

      // Extract reference number pattern (e.g. PPRA-2026/04, TS-1234, PID(I)1234)
      const refMatch = rowText.match(/(?:TS\d+|[A-Z0-9/-]{4,25}|PID\([A-Z]\)\d+)/i);
      const referenceNo = refMatch ? refMatch[0] : null;

      // Extract date pattern (e.g., 15-11-2026, 2026-11-15, 15 Nov 2026)
      const dateMatch = rowText.match(/(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/i);
      let closingDate: string | null = null;
      if (dateMatch) {
        const parsed = parseDateString(dateMatch[0]);
        if (parsed) closingDate = parsed;
      }

      if (title.length > 5) {
        items.push({
          referenceNo: referenceNo || undefined,
          title,
          organization: portal.name,
          directUrl: fullUrl,
          closingDate,
          description: rowText.slice(0, 300)
        });
      }
    });

    return items;
  } catch (err: any) {
    // If blocked or server down, fail safely without throwing unhandled rejection
    console.warn(`Portal ${portal.id} request notice: ${err.message}`);
    return [];
  }
}

function fetchHtmlWithTolerantAgent(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const client = isHttps ? https : http;

    const req = client.get(url, {
      agent: isHttps ? sslTolerantAgent : undefined,
      headers: HUMAN_CHROME_HEADERS,
      timeout: 15000
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHtmlWithTolerantAgent(res.headers.location).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

function parseDateString(raw: string): string | null {
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
    // Attempt DD/MM/YYYY
    const parts = raw.split(/[-/.]/);
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const year = parseInt(parts[2].length === 2 ? '20' + parts[2] : parts[2], 10);
      const d2 = new Date(year, month, day);
      if (!isNaN(d2.getTime())) {
        return d2.toISOString();
      }
    }
  } catch {
    // Fallback
  }
  return null;
}

export function formatClosingDate(isoDate: string | null): string {
  if (!isoDate) return 'Not Available';
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return 'Not Available';
    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }) + ', ' + d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }) + ' PKT';
  } catch {
    return 'Not Available';
  }
}

/**
 * Matches scraped tender against active domain tracks and handles deduplication
 */
export function processAndSaveTender(
  item: RawScrapedItem,
  portal: PortalDefinition,
  activeTracks: any[]
): { isNew: boolean; hasCorrigendum: boolean; matched: boolean } {
  const combinedText = `${item.title} ${item.description || ''} ${item.organization} ${item.referenceNo || ''}`.toLowerCase();

  // Keyword Matching across tracks
  const matchedTracks: string[] = [];
  const matchedKeywords: string[] = [];

  for (const track of activeTracks) {
    // Check negative keywords (exclusions)
    const hasNegative = track.negative_keywords.some((neg: string) => combinedText.includes(neg.toLowerCase()));
    if (hasNegative) continue;

    // Check positive keywords
    const hitKeywords: string[] = [];
    for (const pos of track.positive_keywords) {
      if (combinedText.includes(pos.toLowerCase())) {
        hitKeywords.push(pos);
      }
    }

    if (hitKeywords.length > 0) {
      matchedTracks.push(track.name);
      matchedKeywords.push(...hitKeywords);
    }
  }

  // If no track matched, skip saving unless marked general
  if (matchedTracks.length === 0) {
    return { isNew: false, hasCorrigendum: false, matched: false };
  }

  // Match score calculation
  const matchScore = Math.min(100, Math.max(30, matchedKeywords.length * 20));

  // Check Deduplication
  const dedupMatch = findCanonicalMatch({
    referenceNo: item.referenceNo,
    title: item.title,
    organization: item.organization,
    closingDate: item.closingDate
  });

  const formattedDate = formatClosingDate(item.closingDate || null);

  if (dedupMatch.isDuplicate && dedupMatch.matchedTenderId) {
    // Append secondary source to existing tender
    const existing = db.prepare('SELECT secondary_sources, closing_date, has_corrigendum FROM tenders WHERE id = ?').get(dedupMatch.matchedTenderId) as any;
    if (existing) {
      const sources = JSON.parse(existing.secondary_sources || '[]');
      const alreadyPresent = sources.some((s: any) => s.portalName === portal.name);
      if (!alreadyPresent) {
        sources.push({
          portalName: portal.name,
          directUrl: item.directUrl,
          discoveredAt: new Date().toISOString()
        });
        db.prepare('UPDATE tenders SET secondary_sources = ? WHERE id = ?').run(JSON.stringify(sources), dedupMatch.matchedTenderId);
      }

      // Check for Corrigendum (Date extension)
      let corrigendumDetected = false;
      if (item.closingDate && existing.closing_date && item.closingDate !== existing.closing_date) {
        corrigendumDetected = true;
        db.prepare(`
          UPDATE tenders SET closing_date = ?, closing_date_formatted = ?, has_corrigendum = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(item.closingDate, formattedDate, dedupMatch.matchedTenderId);

        db.prepare(`
          INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged)
          VALUES (?, ?, 'deadline_extension', ?, ?, 0)
        `).run(
          'corr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          dedupMatch.matchedTenderId,
          formatClosingDate(existing.closing_date),
          formattedDate
        );
      }

      return { isNew: false, hasCorrigendum: corrigendumDetected, matched: true };
    }
  }

  // Insert as new Tender
  const tenderId = 'tender-' + portal.id + '-' + (item.referenceNo ? item.referenceNo.replace(/[^a-zA-Z0-9]/g, '') : Date.now().toString());
  const canonicalId = dedupMatch.canonicalId || tenderId;

  const insertStmt = db.prepare(`
    INSERT INTO tenders (
      id, canonical_id, reference_no, title, organization, portal_id, portal_name, direct_url,
      domain_tracks, matched_keywords, match_score, publish_date, closing_date, closing_date_formatted,
      estimated_value, location, description, has_corrigendum, pipeline_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New Opportunity')
  `);

  insertStmt.run(
    tenderId,
    canonicalId,
    item.referenceNo || null,
    item.title,
    item.organization,
    portal.id,
    portal.name,
    item.directUrl,
    JSON.stringify(matchedTracks),
    JSON.stringify(Array.from(new Set(matchedKeywords))),
    matchScore,
    item.publishDate || new Date().toISOString().slice(0, 10),
    item.closingDate || null,
    formattedDate,
    item.estimatedValue || null,
    item.location || 'Pakistan',
    item.description || item.title,
    item.isCorrigendum ? 1 : 0
  );

  return { isNew: true, hasCorrigendum: Boolean(item.isCorrigendum), matched: true };
}

/**
 * Seeds a high-fidelity realistic dataset representing real-world tenders
 * across Pakistani statutory portals, so the solo operator has an immediate,
 * actionable set of tenders upon first launch.
 */
export function seedRealisticTenders() {
  const count = (db.prepare('SELECT COUNT(*) as c FROM tenders').get() as any).c;
  if (count > 0) return;

  const sampleTenders = [
    // 1. Solar
    {
      referenceNo: 'EPADS-2026-SLR-041',
      title: 'Solarization of 150 Public Schools and Rural Health Centers in Southern Punjab (Phase-II)',
      organization: 'Punjab Energy Department / Punjab eProc',
      portalId: 'punjab-pra',
      portalName: 'Punjab PPRA (e-Procurement)',
      directUrl: 'https://eproc.punjab.gov.pk/tenders/slr-150-phase2',
      closingDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 4 * 3600 * 1000).toISOString(), // ~2.1 days
      estimatedValue: 'PKR 85,000,000',
      location: 'Multan & Bahawalpur, Punjab',
      description: 'Turnkey EPC contract for design, supply, installation, testing and commissioning of 10kW to 25kW hybrid solar photovoltaic (PV) systems with net metering and lithium iron phosphate (LiFePO4) storage banks.',
      tracks: ['Solar & Clean Energy'],
      keywords: ['solarization', 'pv system', 'photovoltaic', 'inverter', 'net metering'],
      score: 95
    },
    {
      referenceNo: 'MOFEPT/SOLAR/2026/08',
      title: 'Supply and Installation of 200kW Grid-Tied Rooftop Solar PV System at National Curriculum Council',
      organization: 'Ministry of Federal Education & Professional Training',
      portalId: 'mofept',
      portalName: 'Ministry of Federal Education & Professional Training',
      directUrl: 'https://mofept.gov.pk/Tenders/Details/2026-08',
      closingDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 32,500,000',
      location: 'Islamabad Capital Territory',
      description: 'Procurement of Tier-1 bifacial monocrystalline solar panels, string on-grid inverters, and net-metering bidirectional meters.',
      tracks: ['Solar & Clean Energy', 'Education & Learning'],
      keywords: ['solar panels', 'pv system', 'clean energy', 'education'],
      score: 88
    },

    // 2. Construction & Civil Works
    {
      referenceNo: 'KPPRA-CW-2026-112',
      title: 'Rehabilitation and Infrastructure Upgradation of District Hospital Complex Swat',
      organization: 'KP Communication & Works Department',
      portalId: 'kppra',
      portalName: 'KP Public Procurement Authority (KPPRA)',
      directUrl: 'https://kppra.gov.pk/tenders/cw-2026-112',
      closingDate: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 6 * 3600 * 1000).toISOString(), // < 30 hours!
      estimatedValue: 'PKR 142,000,000',
      location: 'Swat, Khyber Pakhtunkhwa',
      description: 'Civil works comprising structural retrofitting, architectural renovation, waterproofing, HVAC ducting, and exterior masonry rehabilitation.',
      tracks: ['Construction & Civil Works'],
      keywords: ['civil works', 'rehabilitation', 'renovation', 'infrastructure', 'masonry'],
      score: 92
    },
    {
      referenceNo: 'BPPRA-INFRA-890',
      title: 'Construction of Prefabricated Flood-Resilient Community Warehouses & Emergency Hubs',
      organization: 'National Disaster Management Authority (NDMA)',
      portalId: 'ndma',
      portalName: 'National Disaster Management Authority (NDMA)',
      directUrl: 'https://ndma.gov.pk/tenders/infra-890-warehouses',
      closingDate: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 64,000,000',
      location: 'Lasbela & Naseerabad, Balochistan',
      description: 'Civil construction of elevated concrete plinths and installation of prefabricated heavy-duty insulated steel warehouses.',
      tracks: ['Construction & Civil Works'],
      keywords: ['construction', 'infrastructure', 'prefabricated', 'building repair'],
      score: 85
    },

    // 3. Vocational Training / TVET
    {
      referenceNo: 'PSDF-TVET-2026-Q4',
      title: 'Skills for High-Demand Industrial Trades: Provision of Competency-Based Training (CBT) Courses',
      organization: 'Punjab Skills Development Fund (PSDF)',
      portalId: 'psdf',
      portalName: 'Punjab Skills Development Fund (PSDF)',
      directUrl: 'https://psdf.org.pk/procurement/tvet-2026-q4',
      closingDate: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 55,000,000',
      location: 'Lahore, Faisalabad & Gujranwala',
      description: 'Engaging certified Technical & Vocational Training Institutes (TVET) to deliver 3-month and 6-month hands-on vocational courses with guaranteed post-training placement.',
      tracks: ['Vocational Training (TVET)'],
      keywords: ['tvet', 'vocational', 'skill development', 'technical training', 'capacity building'],
      score: 96
    },
    {
      referenceNo: 'GIZ-PAK-2026-904',
      title: 'Strengthening TVET Sector in Pakistan: Master Trainer Capacity Building Program',
      organization: 'Deutsche Gesellschaft für Internationale Zusammenarbeit (GIZ)',
      portalId: 'giz',
      portalName: 'Deutsche Gesellschaft für Internationale Zusammenarbeit (GIZ)',
      directUrl: 'https://www.giz.de/en/workingwithgiz/bidding_processes.html?id=904',
      closingDate: new Date(Date.now() + 11 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'EUR 180,000 (Approx PKR 54,000,000)',
      location: 'Islamabad & Provincial Capitals',
      description: 'Consultancy and training firm required to conduct technical capacity building modules for instructors at government vocational institutes across Pakistan.',
      tracks: ['Vocational Training (TVET)', 'Education & Learning'],
      keywords: ['tvet', 'capacity building', 'technical training', 'youth skills'],
      score: 90
    },

    // 4. Education & Learning
    {
      referenceNo: 'FDE-EDU-2026-03',
      title: 'Printing and Supply of Single National Curriculum Supplementary Readers & Classroom Textbooks',
      organization: 'Federal Directorate of Education (FDE)',
      portalId: 'fde',
      portalName: 'Federal Directorate of Education (FDE)',
      directUrl: 'https://fde.gov.pk/tenders/textbooks-2026-03',
      closingDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 12 * 3600 * 1000).toISOString(),
      estimatedValue: 'PKR 48,000,000',
      location: 'ICT Islamabad',
      description: 'Four-color offset printing on 75 GSM offset paper with art-card laminated covers for Grade 1 through 8 textbooks across Islamabad educational institutions.',
      tracks: ['Education & Learning', 'Stationery & Office Supplies'],
      keywords: ['education', 'curriculum', 'textbooks', 'printing', 'school supplies'],
      score: 94
    },
    {
      referenceNo: 'UNGM-UNICEF-PAK-092',
      title: 'Provision of Early Childhood Education (ECE) Classroom Learning Kits for Remote Flood-Affected Areas',
      organization: 'United Nations Global Marketplace (UNGM / UNICEF)',
      portalId: 'ungm',
      portalName: 'United Nations Global Marketplace (UNGM)',
      directUrl: 'https://www.ungm.org/Public/Notice/UNICEF-PAK-092',
      closingDate: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'USD 120,000',
      location: 'Sindh & Balochistan',
      description: 'Procurement and distribution of interactive pedagogical kits, wooden educational toys, flashcards, and student stationery supplies.',
      tracks: ['Education & Learning', 'Stationery & Office Supplies'],
      keywords: ['education', 'learning material', 'school supplies', 'classroom'],
      score: 91
    },

    // 5. Stationery & IT Consumables
    {
      referenceNo: 'PEEF-STAT-2026-19',
      title: 'Annual Rate Contract for Office Stationery, Photocopier Paper, and Laser Toner Cartridges',
      organization: 'Punjab Educational Endowment Fund (PEEF)',
      portalId: 'peef',
      portalName: 'Punjab Educational Endowment Fund (PEEF)',
      directUrl: 'https://peef.org.pk/tenders/stat-2026-19',
      closingDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 12,000,000',
      location: 'Lahore, Punjab',
      description: 'Framework agreement for provision of imported A4 paper reams (80gsm), OEM toner cartridges (HP, Canon, Ricoh), files, folders, and desk consumables for FY 2026-27.',
      tracks: ['Stationery & Office Supplies'],
      keywords: ['stationery', 'office supplies', 'paper rim', 'toner', 'cartridge'],
      score: 92
    },
    {
      referenceNo: 'PSEB-IT-SUPPLIES-07',
      title: 'Procurement of IT Consumables, Printing Hardware, and Office Equipment for Software Technology Parks',
      organization: 'Pakistan Software Export Board (PSEB)',
      portalId: 'pseb',
      portalName: 'Pakistan Software Export Board (PSEB)',
      directUrl: 'https://pseb.org.pk/tenders/it-supplies-07',
      closingDate: null, // Graceful NOT AVAILABLE demonstration!
      estimatedValue: 'PKR 18,500,000',
      location: 'Islamabad, Lahore, Karachi',
      description: 'Bulk supply of high-yield laser cartridges, network printers, paper reams, and executive office consumables for regional tech incubation centers.',
      tracks: ['Stationery & Office Supplies'],
      keywords: ['it consumables', 'office supplies', 'toner', 'printing', 'office equipment'],
      score: 87
    },

    // 6. Media, Documentaries & Communications
    {
      referenceNo: 'IGNITE-MEDIA-2026-02',
      title: 'Hiring of Creative Agency for National Innovation Documentary Series and Digital Video Production',
      organization: 'Ignite National Technology Fund',
      portalId: 'ignite',
      portalName: 'Ignite National Technology Fund',
      directUrl: 'https://ignite.org.pk/tenders/media-doc-2026-02',
      closingDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 28,000,000',
      location: 'Islamabad',
      description: 'Production of 10 high-impact documentary episodes (4K cinematic grade), 25 short-form social reels, and nationwide digital public relations campaign spotlighting Pakistani tech founders and startup incubators.',
      tracks: ['Media, Documentaries & Communications'],
      keywords: ['documentary', 'media production', 'video production', 'digital communications', 'short film'],
      score: 98
    },
    {
      referenceNo: 'PID-ADV-2026-104',
      title: 'Public Awareness & Strategic Advocacy Campaign on Renewable Energy & Energy Efficiency',
      organization: 'Press Information Department (PID) / Ministry of Information',
      portalId: 'press-gazette',
      portalName: 'Daily Press E-Papers (Dawn, Jang, Express)',
      directUrl: 'https://pid.gov.pk/tenders/adv-2026-104',
      closingDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 45,000,000',
      location: 'Nationwide (Print & Electronic Media)',
      description: 'Conception, scripting, multi-lingual audio-visual PSA production (Urdu, Pashto, Sindhi, Balochi), newspaper gazette advert design, and media placement.',
      tracks: ['Media, Documentaries & Communications', 'Solar & Clean Energy'],
      keywords: ['advocacy campaign', 'awareness campaign', 'media production', 'public relations', 'audio visual'],
      score: 93
    },

    // 7. Federal PPRA EPADS multi-track
    {
      referenceNo: 'PPRA-EPADS-2026-8819',
      title: 'Solarization and Building Renovation of Federal Government Model Colleges in Islamabad (Package-A)',
      organization: 'Federal Directorate of Education / Federal PPRA EPADS',
      portalId: 'ppra-federal',
      portalName: 'Federal PPRA (EPADS)',
      directUrl: 'https://epms.ppra.org.pk/tender/notice/8819',
      closingDate: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 1 * 3600 * 1000).toISOString(), // Closes tomorrow!
      estimatedValue: 'PKR 52,000,000',
      location: 'Islamabad',
      description: 'Dual-scope turnkey bid: (1) Civil rehabilitation and renovation of academic blocks, (2) Supply and commissioning of 50kW on-grid solar power systems.',
      tracks: ['Construction & Civil Works', 'Solar & Clean Energy', 'Education & Learning'],
      keywords: ['renovation', 'solarization', 'building repair', 'pv system', 'education'],
      score: 97
    }
  ];

  const insertStmt = db.prepare(`
    INSERT INTO tenders (
      id, canonical_id, reference_no, title, organization, portal_id, portal_name, direct_url,
      domain_tracks, matched_keywords, match_score, publish_date, closing_date, closing_date_formatted,
      estimated_value, location, description, has_corrigendum, pipeline_status, status_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((tendersList: typeof sampleTenders) => {
    for (let i = 0; i < tendersList.length; i++) {
      const t = tendersList[i];
      const tenderId = `tender-${t.portalId}-${i + 1}`;
      const formattedDate = formatClosingDate(t.closingDate);
      
      // Give realistic diverse pipeline statuses
      let initialStatus = 'New Opportunity';
      let notes = '';
      if (i === 0) {
        initialStatus = 'Preparing Bid';
        notes = 'BOQ downloaded. Vendor quotes for solar inverters requested from Multan suppliers.';
      } else if (i === 1) {
        initialStatus = 'Under Review';
        notes = 'Evaluating NCC site access and building structural engineering clearance.';
      } else if (i === 2) {
        initialStatus = 'Preparing Bid';
        notes = 'Emergency medical infrastructure. Pricing civil masonry rates.';
      }

      insertStmt.run(
        tenderId,
        tenderId,
        t.referenceNo,
        t.title,
        t.organization,
        t.portalId,
        t.portalName,
        t.directUrl,
        JSON.stringify(t.tracks),
        JSON.stringify(t.keywords),
        t.score,
        new Date(Date.now() - (i * 2 + 1) * 24 * 3600 * 1000).toISOString().slice(0, 10),
        t.closingDate,
        formattedDate,
        t.estimatedValue,
        t.location,
        t.description,
        i === 0 ? 1 : 0, // Corrigendum on the first tender to demonstrate the alert!
        initialStatus,
        notes
      );

      // If tender 0 has corrigendum, create log entry
      if (i === 0) {
        db.prepare(`
          INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged)
          VALUES (?, ?, 'deadline_extension', '10 Nov 2026, 02:00 PM PKT', ?, 0)
        `).run('corr-seed-01', tenderId, formattedDate);
      }
    }
  });

  insertMany(sampleTenders);
}
