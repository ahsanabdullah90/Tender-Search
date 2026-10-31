import { db, getAllDomainTracks, updatePortalHealth, getPortalHealthList } from '../db.js';
import { PORTAL_DEFINITIONS, PortalDefinition } from './portalList.js';
import { findCanonicalMatch, isValidReferenceNo, normalizeText } from '../deduplicator.js';
import { getHumanJitterDelay, sleep, sslTolerantAgent, HUMAN_CHROME_HEADERS } from './baseScraper.js';
import { ScanStatus, Tender } from '../../types.js';
import { downloadAndCacheDossier } from '../dossierManager.js';
import { extractTenderFromImage } from '../ocrService.js';
import * as cheerio from 'cheerio';
import https from 'https';
import http from 'http';
import crypto from 'crypto';

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
    try {
      listener({ ...currentScanStatus });
    } catch (e) {
      // Ignore stale subscriber errors
    }
  }
}

/**
 * Builds merged portal list combining SQLite overrides with base defaults
 */
export function getActivePortalsList(targetPortalId?: string): PortalDefinition[] {
  const dbPortals = getPortalHealthList();
  const dbMap = new Map<string, any>(dbPortals.map(p => [p.portal_id, p]));

  let list: PortalDefinition[] = PORTAL_DEFINITIONS.map(def => {
    const dbP = dbMap.get(def.id);
    if (!dbP) return def;

    return {
      ...def,
      name: dbP.portal_name || def.name,
      category: (dbP.category as any) || def.category,
      tier: (dbP.tier as any) || def.tier,
      baseUrl: dbP.base_url || def.baseUrl,
      tendersUrl: dbP.tenders_url || def.tendersUrl,
      loginUrl: dbP.login_url || def.loginUrl,
      accessMode: (dbP.access_mode as any) || def.accessMode,
      verifiedStatus: dbP.verified_status || def.verifiedStatus,
      sessionCookies: dbP.session_cookies || undefined
    };
  });

  if (targetPortalId) {
    list = list.filter(p => p.id === targetPortalId);
  }

  return list;
}

/**
 * Executes a full scan across all active portals or a single target portal
 */
export async function startCrawlerScan(targetPortalId?: string) {
  if (currentScanStatus.isScanning) {
    return currentScanStatus;
  }

  const allPortals = getActivePortalsList(targetPortalId);
  // In automated full scans, skip offline_broken portals unless explicitly triggered individually
  const portalsToScan = targetPortalId 
    ? allPortals 
    : allPortals.filter(p => p.accessMode !== 'offline_broken');

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
          const scrapeResult = await scrapePortal(portal);

          if (scrapeResult.hitlRequired) {
            updatePortalHealth(portal.id, {
              status: 'hitl_required',
              last_scan_at: new Date().toISOString(),
              last_error_message: 'Verification challenge detected (Cloudflare Turnstile or CAPTCHA)'
            });
          } else {
            const rawItems = scrapeResult.items;
            let itemsMatched = 0;

            for (const item of rawItems) {
              try {
                const result = await processAndSaveTender(item, portal, activeTracks);
                if (result.isNew) currentScanStatus.newTendersFound++;
                if (result.hasCorrigendum) currentScanStatus.corrigendaFound++;
                if (result.matched) itemsMatched++;
              } catch (itemErr: any) {
                console.warn(`[Crawler] Failed saving item from ${portal.id}:`, itemErr.message);
              }
            }

            // Consecutive zero yields tracks raw items count (website structure/selector failure), not keyword match rate
            const health = db.prepare('SELECT consecutive_zero_yields FROM portal_health WHERE portal_id = ?').get(portal.id) as any;
            const currentZeros = health?.consecutive_zero_yields || 0;
            const newZeros = rawItems.length === 0 ? currentZeros + 1 : 0;
            const nextStatus = newZeros >= 3 ? 'selector_broken' : 'online';

            updatePortalHealth(portal.id, {
              status: nextStatus,
              last_scan_at: new Date().toISOString(),
              last_items_found: itemsMatched,
              consecutive_zero_yields: newZeros,
              last_error_message: null
            });
          }
        } catch (err: any) {
          console.error(`[Crawler] Error scanning portal ${portal.id}:`, err.message || err);
          updatePortalHealth(portal.id, {
            status: 'error',
            last_scan_at: new Date().toISOString(),
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
  attachmentUrls?: string[];
}

export interface ScrapeResult {
  items: RawScrapedItem[];
  hitlRequired: boolean;
}

/**
 * Scrapes a portal via tolerant HTTP/Cheerio
 */
async function scrapePortal(portal: PortalDefinition & { sessionCookies?: string }): Promise<ScrapeResult> {
  const html = await fetchHtmlWithTolerantAgent(portal.tendersUrl, 0, portal.sessionCookies);
  const $ = cheerio.load(html);
  const items: RawScrapedItem[] = [];

  // Check for CAPTCHA or Cloudflare Turnstile blocking elements
  if ($('iframe[src*="cloudflare"], #captcha, input[name*="captcha"]').length > 0 || html.includes('cf-browser-verification')) {
    return { items: [], hitlRequired: true };
  }

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
    let fullUrl = href;
    try {
      fullUrl = href.startsWith('http') ? href : new URL(href, portal.baseUrl).toString();
    } catch {
      fullUrl = portal.tendersUrl;
    }

    const title = link.text().trim() || $(el).find('td:nth-child(2), h3, h4').first().text().trim() || rowText.slice(0, 100);

    // Extract genuine procurement reference number pattern (must contain at least one digit)
    const refMatch = rowText.match(/(?:\bTS[-/]?\d{3,10}\b|\bPID\s*\([A-Z]+\)\s*\d+\b|\b[A-Z]{2,10}[-/][A-Z0-9/-]*\d[A-Z0-9/-]{1,20}\b)/i);
    const referenceNo = refMatch && isValidReferenceNo(refMatch[0]) ? refMatch[0] : null;

    // Extract date pattern (e.g. 15-11-2026, 2026-11-15, 15 Nov 2026)
    const dateMatch = rowText.match(/(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/i);
    let closingDate: string | null = null;
    if (dateMatch) {
      const parsed = parseDateString(dateMatch[0]);
      if (parsed) closingDate = parsed;
    }

    // Collect any file attachments in row
    const attachmentUrls: string[] = [];
    $(el).find('a[href]').each((__, aEl) => {
      const aHref = $(aEl).attr('href');
      if (aHref && /\.(pdf|docx?|xlsx?|jpe?g|png)(\?|$)/i.test(aHref)) {
        try {
          const absUrl = aHref.startsWith('http') ? aHref : new URL(aHref, portal.baseUrl).toString();
          attachmentUrls.push(absUrl);
        } catch {}
      }
    });

    if (title.length > 5) {
      items.push({
        referenceNo: referenceNo || undefined,
        title,
        organization: portal.name,
        directUrl: fullUrl,
        closingDate,
        description: rowText.slice(0, 300),
        attachmentUrls
      });
    }
  });

  return { items, hitlRequired: false };
}

function fetchHtmlWithTolerantAgent(url: string, redirectCount: number = 0, cookieStr?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error('Too many redirects while loading portal page'));
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqHeaders: Record<string, string> = { ...HUMAN_CHROME_HEADERS };
    if (cookieStr) {
      reqHeaders['Cookie'] = cookieStr;
    }

    const req = client.get(url, {
      agent: isHttps ? sslTolerantAgent : undefined,
      headers: reqHeaders,
      timeout: 15000
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return fetchHtmlWithTolerantAgent(nextUrl, redirectCount + 1, cookieStr).then(resolve).catch(reject);
      }

      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from portal server`));
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

/**
 * Strict date string parsing for Pakistani tenders:
 * Checks DD/MM/YYYY and DD-MM-YYYY first with explicit PKT (+05:00) timezone,
 * preventing US-style day/month swaps on days 1-12.
 */
export function parseDateString(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  const str = raw.trim();

  try {
    // 1. Check numeric DD/MM/YYYY or DD-MM-YYYY with optional time
    const dmyMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (dmyMatch) {
      const day = parseInt(dmyMatch[1], 10);
      const month = parseInt(dmyMatch[2], 10);
      let year = parseInt(dmyMatch[3], 10);
      if (year < 100) year += 2000;

      const hour = dmyMatch[4] ? String(dmyMatch[4]).padStart(2, '0') : '14';
      const minute = dmyMatch[5] ? String(dmyMatch[5]).padStart(2, '0') : '00';
      const second = dmyMatch[6] ? String(dmyMatch[6]).padStart(2, '0') : '00';

      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        // Construct with explicit PKT (+05:00)
        const d = new Date(Date.parse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hour}:${minute}:${second}+05:00`));
        if (!isNaN(d.getTime())) {
          return d.toISOString();
        }
      }
    }

    // 2. Named month format: e.g. 15 Nov 2026, 15-November-2026 with optional time
    const namedMonthMatch = str.match(/^(\d{1,2})\s*[-/.\s]\s*([A-Za-z]{3,9})\s*[-/.\s]\s*(\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (namedMonthMatch) {
      const day = parseInt(namedMonthMatch[1], 10);
      const monthName = namedMonthMatch[2];
      let year = parseInt(namedMonthMatch[3], 10);
      if (year < 100) year += 2000;

      const hour = namedMonthMatch[4] || '14';
      const minute = namedMonthMatch[5] || '00';
      const second = namedMonthMatch[6] || '00';

      const d = new Date(Date.parse(`${day} ${monthName} ${year} ${hour}:${minute}:${second} GMT+0500`));
      if (!isNaN(d.getTime())) {
        return d.toISOString();
      }
    }

    // 3. ISO format YYYY-MM-DD with optional time
    const isoMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (isoMatch) {
      const year = isoMatch[1];
      const month = String(isoMatch[2]).padStart(2, '0');
      const day = String(isoMatch[3]).padStart(2, '0');
      const hour = isoMatch[4] ? String(isoMatch[4]).padStart(2, '0') : '14';
      const minute = isoMatch[5] ? String(isoMatch[5]).padStart(2, '0') : '00';
      const second = isoMatch[6] ? String(isoMatch[6]).padStart(2, '0') : '00';

      const d = new Date(Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+05:00`));
      if (!isNaN(d.getTime())) {
        return d.toISOString();
      }
    }

    // 4. Fallback standard parse
    const fallback = new Date(str);
    if (!isNaN(fallback.getTime())) {
      return fallback.toISOString();
    }
  } catch {}

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
export async function processAndSaveTender(
  item: RawScrapedItem,
  portal: PortalDefinition,
  activeTracks: any[]
): Promise<{ isNew: boolean; hasCorrigendum: boolean; matched: boolean }> {
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

  // If no track matched, skip saving
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
    const existing = db.prepare('SELECT secondary_sources, closing_date, has_corrigendum, cached_dossiers FROM tenders WHERE id = ?').get(dedupMatch.matchedTenderId) as any;
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
        const updateTx = db.transaction(() => {
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
        });
        updateTx();
      }

      return { isNew: false, hasCorrigendum: corrigendumDetected, matched: true };
    }
  }

  // Deterministic, collision-free tender primary key based on SHA-256 hash
  const idMaterial = `${portal.id}:${item.referenceNo || ''}:${normalizeText(item.title)}:${item.directUrl}`;
  const tenderHash = crypto.createHash('sha256').update(idMaterial).digest('hex').slice(0, 16);
  const tenderId = `tender-${portal.id}-${tenderHash}`;
  const canonicalId = dedupMatch.canonicalId || tenderId;

  // Insert as new Tender wrapped in a transaction
  const insertTx = db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT INTO tenders (
        id, canonical_id, reference_no, title, organization, portal_id, portal_name, direct_url,
        domain_tracks, matched_keywords, match_score, publish_date, closing_date, closing_date_formatted,
        estimated_value, location, description, has_corrigendum, pipeline_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New Opportunity')
      ON CONFLICT(id) DO UPDATE SET
        match_score = excluded.match_score,
        domain_tracks = excluded.domain_tracks,
        matched_keywords = excluded.matched_keywords,
        updated_at = CURRENT_TIMESTAMP
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
  });

  insertTx();

  // If tender notice has downloadable attachments, cache first attachment in background
  if (item.attachmentUrls && item.attachmentUrls.length > 0) {
    const firstUrl = item.attachmentUrls[0];
    const label = `${item.title.slice(0, 30)}_Doc`;
    downloadAndCacheDossier(tenderId, firstUrl, label).then(async (doc) => {
      if (doc) {
        db.prepare('UPDATE tenders SET cached_dossiers = ? WHERE id = ?').run(JSON.stringify([doc]), tenderId);
        // If document is an image and tender lacks date or reference, attempt Gemini OCR extraction
        if (doc.mimeType.startsWith('image/') && (!item.closingDate || !item.referenceNo)) {
          try {
            const fs = await import('fs');
            const path = await import('path');
            const filename = path.basename(doc.localPath);
            const diskPath = path.resolve(process.cwd(), 'data', 'dossiers', tenderId, filename);
            if (fs.existsSync(diskPath)) {
              const imgBuffer = fs.readFileSync(diskPath);
              const ocrResult = await extractTenderFromImage(imgBuffer, doc.mimeType);
              if (ocrResult) {
                if (ocrResult.referenceNo && !item.referenceNo) {
                  db.prepare('UPDATE tenders SET reference_no = ? WHERE id = ?').run(ocrResult.referenceNo, tenderId);
                }
                if (ocrResult.closingDateISO && !item.closingDate) {
                  db.prepare('UPDATE tenders SET closing_date = ?, closing_date_formatted = ? WHERE id = ?').run(
                    ocrResult.closingDateISO,
                    ocrResult.closingDateFormatted || formatClosingDate(ocrResult.closingDateISO),
                    tenderId
                  );
                }
              }
            }
          } catch (ocrErr: any) {
            console.warn('[OCR] Background extraction warning:', ocrErr.message);
          }
        }
      }
    }).catch(() => {});
  }

  return { isNew: true, hasCorrigendum: Boolean(item.isCorrigendum), matched: true };
}

/**
 * Seeds a high-fidelity realistic dataset representing real-world tenders
 * across Pakistani statutory portals on fresh install.
 */
export function seedRealisticTenders() {
  const count = (db.prepare('SELECT COUNT(*) as c FROM tenders').get() as any).c;
  if (count > 0) return;

  const sampleTenders = [
    {
      referenceNo: 'EPADS-2026-SLR-041',
      title: 'Solarization of 150 Public Schools and Rural Health Centers in Southern Punjab (Phase-II)',
      organization: 'Punjab Energy Department / Punjab eProc',
      portalId: 'punjab_eproc',
      portalName: 'Punjab PPRA (eproc.punjab.gov.pk)',
      directUrl: 'http://eproc.punjab.gov.pk/ActiveTenders.aspx',
      closingDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 4 * 3600 * 1000).toISOString(),
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
      directUrl: 'https://mofept.gov.pk/Tenders',
      closingDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 32,500,000',
      location: 'Islamabad Capital Territory',
      description: 'Procurement of Tier-1 bifacial monocrystalline solar panels, string on-grid inverters, and net-metering bidirectional meters.',
      tracks: ['Solar & Clean Energy', 'Education & Learning'],
      keywords: ['solar panels', 'pv system', 'clean energy', 'education'],
      score: 88
    },
    {
      referenceNo: 'KPPRA-CW-2026-112',
      title: 'Rehabilitation and Infrastructure Upgradation of District Hospital Complex Swat',
      organization: 'KP Communication & Works Department',
      portalId: 'kppra',
      portalName: 'Khyber Pakhtunkhwa KPPRA (kp.eprocure.gov.pk)',
      directUrl: 'https://kp.eprocure.gov.pk',
      closingDate: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 6 * 3600 * 1000).toISOString(),
      estimatedValue: 'PKR 142,000,000',
      location: 'Swat, Khyber Pakhtunkhwa',
      description: 'Civil works comprising structural retrofitting, architectural renovation, waterproofing, HVAC ducting, and exterior masonry rehabilitation.',
      tracks: ['Construction & Civil Works'],
      keywords: ['civil works', 'rehabilitation', 'renovation', 'infrastructure', 'masonry'],
      score: 92
    },
    {
      referenceNo: 'NDMA-INFRA-890',
      title: 'Construction of Prefabricated Flood-Resilient Community Warehouses & Emergency Hubs',
      organization: 'National Disaster Management Authority (NDMA)',
      portalId: 'ndma',
      portalName: 'National Disaster Management Authority (NDMA)',
      directUrl: 'https://ndma.gov.pk/tenders',
      closingDate: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 64,000,000',
      location: 'Lasbela & Naseerabad, Balochistan',
      description: 'Civil construction of elevated concrete plinths and installation of prefabricated heavy-duty insulated steel warehouses.',
      tracks: ['Construction & Civil Works'],
      keywords: ['construction', 'infrastructure', 'prefabricated', 'building repair'],
      score: 85
    },
    {
      referenceNo: 'PSDF-TVET-2026-Q4',
      title: 'Skills for High-Demand Industrial Trades: Provision of Competency-Based Training (CBT) Courses',
      organization: 'Punjab Skills Development Fund (PSDF)',
      portalId: 'psdf',
      portalName: 'Punjab Skills Development Fund (PSDF)',
      directUrl: 'https://psdf.org.pk/procurement',
      closingDate: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 55,000,000',
      location: 'Lahore, Faisalabad & Gujranwala',
      description: 'Engaging certified Technical & Vocational Training Institutes (TVET) to deliver 3-month and 6-month hands-on vocational courses with guaranteed post-training placement.',
      tracks: ['Vocational Training (TVET)'],
      keywords: ['tvet', 'vocational', 'skill development', 'technical training', 'capacity building'],
      score: 96
    },
    {
      referenceNo: 'FDE-EDU-2026-03',
      title: 'Printing and Supply of Single National Curriculum Supplementary Readers & Classroom Textbooks',
      organization: 'Federal Directorate of Education (FDE)',
      portalId: 'fde',
      portalName: 'Federal Directorate of Education (FDE)',
      directUrl: 'https://fde.gov.pk/download-category/tender/',
      closingDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 12 * 3600 * 1000).toISOString(),
      estimatedValue: 'PKR 48,000,000',
      location: 'ICT Islamabad',
      description: 'Four-color offset printing on 75 GSM offset paper with art-card laminated covers for Grade 1 through 8 textbooks across Islamabad educational institutions.',
      tracks: ['Education & Learning', 'Stationery & Office Supplies'],
      keywords: ['education', 'curriculum', 'textbooks', 'printing', 'school supplies'],
      score: 94
    },
    {
      referenceNo: 'IGNITE-MEDIA-2026-02',
      title: 'Hiring of Creative Agency for National Innovation Documentary Series and Digital Video Production',
      organization: 'Ignite National Technology Fund',
      portalId: 'ignite',
      portalName: 'Ignite National Technology Fund',
      directUrl: 'https://ignite.org.pk/procurement/',
      closingDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 28,000,000',
      location: 'Islamabad',
      description: 'Production of 10 high-impact documentary episodes (4K cinematic grade), 25 short-form social reels, and nationwide digital public relations campaign spotlighting Pakistani tech founders and startup incubators.',
      tracks: ['Media, Documentaries & Communications'],
      keywords: ['documentary', 'media production', 'video production', 'digital communications', 'short film'],
      score: 98
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
      
      let initialStatus = 'New Opportunity';
      let notes = '';
      if (i === 0) {
        initialStatus = 'Preparing Bid';
        notes = 'BOQ evaluated. Vendor quotes for solar inverters requested from Multan suppliers.';
      } else if (i === 1) {
        initialStatus = 'Under Review';
        notes = 'Evaluating NCC site access and building structural engineering clearance.';
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
        i === 0 ? 1 : 0,
        initialStatus,
        notes
      );

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
