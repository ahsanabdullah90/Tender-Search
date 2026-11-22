import https from 'https';
import * as cheerio from 'cheerio';
import { BidBrief, ScanDepth } from '../../shared/types.js';
import { isImageUrl } from '../../shared/documentUtils.js';
import { PortalDefinition } from './portalList.js';
import { extractDatesFromText } from './dateParser.js';
import { sslTolerantAgent, HUMAN_CHROME_HEADERS } from './baseScraper.js';
import { fetchHtmlSmart } from './crawlerDeps.js';
import { launchHeadlessChromium } from './playwrightEngine.js';
import { resolvePaginationMaxPages, shouldEarlyStopKnownPage, KnownTenderStopEntry } from './scraperUtils.js';
import {
  RawScrapedItem,
  ScrapeResult,
  extractRefFromText,
  collectRowAttachments,
  resolvePortalUrl
} from './parserHelpers.js';
import { detectHtmlAccessBlock } from './adapters/guards.js';
import type { HtmlParseMatchResult, PortalWithSession } from './adapters/types.js';

export const BPPRA_PORTAL_ORIGIN = 'https://bpptwo.vdc.services:5451';
export const BPPRA_REPORT_API_BASE = 'https://bpptwo.vdc.services:9446';
export const BPPRA_EXTRA_TABS = ['/RFP', '/PreQualification', '/EOI'] as const;

export interface BppraDetailMeta {
  bidId: number;
  bidBrief: BidBrief;
  extractedText: string;
  boqPdfUrl: string | null;
  isCorrigendum: boolean;
}

/**
 * Collapses redundant slashes in BPPRA report URLs (e.g. `:9446//Reports/...` -> `:9446/Reports/...`)
 * without disturbing `https://`.
 */
export function normalizeBppraUrl(url: string): string {
  if (!url) return url;
  return url.trim().replace(/^(https?:\/\/[^/]+)(\/{2,})/i, '$1/');
}

/**
 * Extracts the numeric BPPRA report/bid ID from any `:9446/Reports/...?id=<num>` URL,
 * including malformed query strings like `?id=1164Nitflaf=true`.
 */
export function extractBppraBidId(url?: string | null): number | null {
  if (!url) return null;
  const match = url.match(/bpptwo\.vdc\.services:9446\/+Reports\/[^?#]*[?&]id=(\d+)/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function parseJsonArrayField(val: unknown): any[] {
  if (Array.isArray(val)) return val;
  if (typeof val !== 'string') return [];
  const trimmed = val.trim();
  if (!trimmed || trimmed === 'null' || !trimmed.startsWith('[')) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cleanText(val: unknown): string {
  return typeof val === 'string' ? val.replace(/\s+/g, ' ').trim() : '';
}

function pushUnique(arr: string[], value: string) {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return;
  if (!arr.some(existing => existing.toLowerCase() === clean.toLowerCase())) {
    arr.push(clean);
  }
}

/**
 * Parses the JSON response from `GetProc_NITItemsReportDataHTML?id=<id>` into
 * deterministic `BidBrief`, FTS5 `extractedText`, BOQ PDF URL, and corrigendum flag.
 */
export function parseBppraNitApiResponse(raw: any): BppraDetailMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const biddingArr = parseJsonArrayField(raw.BiddingData);
  const bd = biddingArr[0];
  if (!bd || typeof bd !== 'object') return null;

  const bidId = Number(bd.Bidding_ID ?? bd.BidIdCopy ?? 0);
  const eligibility = parseJsonArrayField(raw.EligibilityCriteria);
  const tenderItems = parseJsonArrayField(raw.TenderItems);
  const corrigenda = parseJsonArrayField(raw.CorrigendumData);

  // 1. Bid Security
  const secPct = Number(bd.BidSecurityPercentage);
  let bidSecurityAmount: string | null = null;
  if (Number.isFinite(secPct) && secPct > 0) {
    const payType = cleanText(bd.BidPaymentType);
    const payMethod = cleanText(bd.BidSecurityPaymentMethod);
    const methodLabel = payType || (payMethod && !/^[\d,\s]+$/.test(payMethod) ? payMethod : '');
    bidSecurityAmount = methodLabel
      ? `${secPct}% (${methodLabel.replace(/,(?=\S)/g, ', ')})`
      : `${secPct}%`;
  } else if (cleanText(bd.BidSecurity)) {
    bidSecurityAmount = cleanText(bd.BidSecurity);
  }

  // 2. Tender Document Fee
  const docFee = Number(bd.TenderDocFee);
  const tenderFee = Number.isFinite(docFee) && docFee > 0
    ? `PKR ${docFee.toLocaleString('en-US')}`
    : null;

  // 3. Required Registrations & Experience from EligibilityCriteria
  const requiredRegistrations: string[] = [];
  const experienceParts: string[] = [];
  const eligibilityTextLines: string[] = [];

  for (const row of eligibility) {
    if (!row || typeof row !== 'object') continue;
    const factor = cleanText(row.EligibilityFactor);
    const desc = cleanText(row.FactorDescription);
    const reqDoc = cleanText(row.RequiredDocument);

    if (row.IncomeTaxCheck || /\b(tax payer|atl|ntn|income tax)\b/i.test(`${factor} ${desc} ${reqDoc}`)) {
      pushUnique(requiredRegistrations, 'NTN / Active Tax Payer (ATL)');
    }
    if (row.BRARegistrationcheck || /\b(bra|balochistan revenue)\b/i.test(`${factor} ${desc} ${reqDoc}`)) {
      pushUnique(requiredRegistrations, 'BRA Registration');
    }
    if (row.PECCheck || /\b(pec|pakistan engineering council)\b/i.test(`${factor} ${desc} ${reqDoc}`)) {
      pushUnique(requiredRegistrations, cleanText(row.SpecializedCode) ? `PEC (${cleanText(row.SpecializedCode)})` : 'PEC Registration');
    }
    if (row.SalesTaxCheck || /\b(gst|sales tax|strn)\b/i.test(`${factor} ${desc} ${reqDoc}`)) {
      pushUnique(requiredRegistrations, 'Sales Tax / GST');
    }
    if (!row.IncomeTaxCheck && !row.BRARegistrationcheck && !row.PECCheck && !row.SalesTaxCheck) {
      if (/registration|license|certificate/i.test(factor)) {
        pushUnique(requiredRegistrations, factor);
      }
    }

    if (/\b(experience|turnover|financial capacity|similar nature|annual)\b/i.test(`${factor} ${desc}`)) {
      const expLine = desc || factor;
      if (expLine && !experienceParts.includes(expLine)) {
        experienceParts.push(expLine);
      }
    }

    const line = [factor, desc, reqDoc ? `Doc: ${reqDoc}` : ''].filter(Boolean).join(' — ');
    if (line) eligibilityTextLines.push(line);
  }

  const requiredExperience = experienceParts.length > 0 ? experienceParts.join('; ').slice(0, 500) : null;

  // 4. Deliverables summary
  const deliverablesSummary: string[] = [];
  const itemTextLines: string[] = [];
  for (const item of tenderItems) {
    if (!item || typeof item !== 'object') continue;
    const name = cleanText(item.ItemName || item.SubItemName || item.SubsubItemName || item.ItemDetail);
    const detail = cleanText(item.ItemDetail);
    const qty = item.Quantity !== null && item.Quantity !== undefined && item.Quantity !== '' ? String(item.Quantity).trim() : '';
    if (!name) continue;
    const line = qty ? `${name} (Qty: ${qty})` : name;
    if (deliverablesSummary.length < 8) pushUnique(deliverablesSummary, line);
    itemTextLines.push(detail && detail !== name ? `${line}: ${detail}` : line);
  }
  if (deliverablesSummary.length === 0) {
    for (const candidate of [
      cleanText(bd.ProcurementTitle) || cleanText(bd.TenderName),
      cleanText(bd.Nature) ? `Scope: ${cleanText(bd.Nature)}` : '',
      cleanText(bd.ProcurementCategory) ? `Category: ${cleanText(bd.ProcurementCategory)}` : ''
    ]) {
      if (candidate && deliverablesSummary.length < 5) pushUnique(deliverablesSummary, candidate);
    }
  }

  // 5. Bid Method
  const methodParts = [cleanText(bd.Method), cleanText(bd.EVALUATIONTYPE), cleanText(bd.Criteria)].filter(Boolean);
  const bidMethod = methodParts.length > 0 ? methodParts.join(' • ') : null;

  // 6. BOQ PDF URL
  const attachDoc = cleanText(bd.AttachDocument);
  let boqPdfUrl: string | null = null;
  if (attachDoc && /\.pdf$/i.test(attachDoc)) {
    boqPdfUrl = /^https?:\/\//i.test(attachDoc)
      ? normalizeBppraUrl(attachDoc)
      : `${BPPRA_REPORT_API_BASE}/Images/BOQManual/${encodeURIComponent(attachDoc)}`;
  }

  // 7. FTS5 searchable text
  const textSections: string[] = [];
  const headerFields = [
    cleanText(bd.TSENumber) ? `Reference: ${cleanText(bd.TSENumber)}` : '',
    cleanText(bd.TenderName || bd.ProcurementTitle),
    cleanText(bd.AgencyName || bd.Agency) ? `Procuring Agency: ${cleanText(bd.AgencyName || bd.Agency)}` : '',
    cleanText(bd.BiddingPlace) ? `Submission Place: ${cleanText(bd.BiddingPlace)}` : '',
    cleanText(bd.Address) ? `Address: ${cleanText(bd.Address)}` : '',
    bd.ApprovedBudget ? `Approved Budget: PKR ${Number(bd.ApprovedBudget).toLocaleString('en-US')}` : '',
    bidMethod ? `Method: ${bidMethod}` : '',
    tenderFee ? `Tender Fee: ${tenderFee}` : '',
    bidSecurityAmount ? `Bid Security: ${bidSecurityAmount}` : ''
  ].filter(Boolean);

  if (headerFields.length > 0) textSections.push(headerFields.join(' | '));
  if (eligibilityTextLines.length > 0) textSections.push(`Eligibility: ${eligibilityTextLines.join(' ; ')}`);
  if (itemTextLines.length > 0) textSections.push(`Items: ${itemTextLines.slice(0, 40).join(' ; ')}`);

  return {
    bidId,
    bidBrief: {
      bidSecurityAmount,
      tenderFee,
      requiredRegistrations,
      requiredExperience,
      deliverablesSummary,
      bidMethod
    },
    extractedText: textSections.join('\n').trim(),
    boqPdfUrl,
    isCorrigendum: Boolean(bd.IsCorrigendum || corrigenda.length > 0)
  };
}

/**
 * Fetches structured NIT & Eligibility metadata from `bpptwo.vdc.services:9446` JSON API
 * over HTTPS using `sslTolerantAgent`. Returns `null` on non-200 or invalid payloads.
 */
export function fetchBppraDetailMetadata(bidId: number, timeoutMs: number = 15000): Promise<BppraDetailMeta | null> {
  if (!Number.isFinite(bidId) || bidId <= 0) return Promise.resolve(null);
  const url = `${BPPRA_REPORT_API_BASE}/api/BiddingDocument/GetProc_NITItemsReportDataHTML?id=${bidId}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (val: BppraDetailMeta | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const finishReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = https.get(
      url,
      {
        agent: sslTolerantAgent,
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': HUMAN_CHROME_HEADERS['User-Agent']
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', finishReject);
        res.on('aborted', () => finishReject(new Error(`BPPRA report API stream aborted for bidId=${bidId}`)));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            return finishResolve(null);
          }
          try {
            const rawText = Buffer.concat(chunks).toString('utf8');
            if (!rawText || !rawText.trim().startsWith('{')) return finishResolve(null);
            const parsed = JSON.parse(rawText);
            finishResolve(parseBppraNitApiResponse(parsed));
          } catch {
            finishResolve(null);
          }
        });
      }
    );

    req.on('error', finishReject);
    req.on('timeout', () => {
      req.destroy(new Error(`BPPRA report API timeout for bidId=${bidId}`));
    });
  });
}

function dedupKey(item: RawScrapedItem): string {
  return (item.referenceNo || item.directUrl || item.title).toLowerCase().trim();
}

/**
 * Parses BPPRA ePPS multi-row tables (`tr.tender-row-main` + sibling `tr.tender-row-dates`).
 */
export function parseBppraHtml($: cheerio.CheerioAPI, portal: PortalDefinition): HtmlParseMatchResult {
  // 3b. Structured BPPRA ePPS Multi-Row Table (tr.tender-row-main + sibling tr.tender-row-dates)
  if ($('tr.tender-row-main').length === 0) {
    return { matched: false, items: [] };
  }

  const items: RawScrapedItem[] = [];
  $('tr.tender-row-main').each((_, el) => {
    const footerEl = $(el).find('.td-title-footer');
    const hasClosedBadge =
      footerEl.find('[title="Closed"], [title="Cancelled"], [title="Canceled"], [title="Awarded"]').length > 0 ||
      footerEl.find('.badge').toArray().some(b => /\b(Closed|Cancelled|Canceled|Awarded)\b/i.test($(b).text()));
    if (hasClosedBadge) return;

    const titleLink = $(el).find('.td-title-link').first();
    const rawTitleBlock = (titleLink.text() || $(el).find('.td-title-cell').first().text()).replace(/\s+/g, ' ').trim();
    if (!rawTitleBlock || rawTitleBlock.length <= 5) return;

    const boldRef = titleLink.find('b').first().text().replace(/\s+/g, ' ').trim();
    const refFromBlock = /^TSE-\d+$/i.test(boldRef) ? boldRef : extractRefFromText(rawTitleBlock);
    let cleanTitle = rawTitleBlock;
    if (refFromBlock) {
      cleanTitle = cleanTitle.replace(refFromBlock, '').trim();
    }
    cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim();
    if (cleanTitle.length <= 5) cleanTitle = rawTitleBlock;

    // Extract agency/department, district location, UNSPSC category, and budget from main row cells
    const agencyText = $(el).find('td:nth-child(3)').text().replace(/\s+/g, ' ').trim();
    const districtMatch = agencyText.match(/District:\s*([A-Za-z0-9\s,&/-]+?)(?=\s*$|\s+Department:)/i);
    const rawDistrict = districtMatch?.[1]?.trim().replace(/[.,;:]+$/, '');
    const location = rawDistrict
      ? (/balochistan/i.test(rawDistrict) ? rawDistrict : `${rawDistrict}, Balochistan`)
      : 'Balochistan, Pakistan';
    const unspscText = $(el).find('td:nth-child(4)').text().replace(/\s+/g, ' ').trim();
    const budgetText = (
      $(el).find('td:nth-child(5)').text() ||
      footerEl.text()
    ).replace(/Estimated\s*budget\s*:\s*/i, '').replace(/\bOpen\b/gi, '').replace(/\s+/g, ' ').trim();

    const isCorrigendum =
      footerEl.find('[title="Corrigendum"]').length > 0 ||
      /\bCorrigendum\s*\(/i.test(footerEl.text());

    // Extract dates from sibling .tender-row-dates rows belonging to this rowspan group
    let siblingDatesText = '';
    let nextTr = $(el).next('tr');
    let steps = 0;
    while (nextTr.length > 0 && !nextTr.hasClass('tender-row-main') && steps < 3) {
      siblingDatesText += ' ' + (nextTr.html() || nextTr.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      nextTr = nextTr.next('tr');
      steps++;
    }

    const { publishDate, closingDate } = extractDatesFromText(siblingDatesText || $(el).text());

    // Collect document links (.td-doc-link and standard file attachments)
    const attachmentUrls = collectRowAttachments($, el, portal);
    $(el).find('a.td-doc-link[href], .td-doc-links a[href]').each((__, aEl) => {
      const href = $(aEl).attr('href');
      if (href) {
        const absUrl = resolvePortalUrl(href, portal);
        if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);
      }
    });

    const titleHref = titleLink.attr('href');
    const tenderDetailUrl = (titleHref && !titleHref.startsWith('#') && !titleHref.startsWith('javascript:'))
      ? resolvePortalUrl(titleHref, portal)
      : null;
    const reportUrl =
      attachmentUrls.find(u => /\/Reports\/.+(?:BiddingDocument|PQNDocument|RFPDocument).*?[?&]id=\d+/i.test(u)) ||
      attachmentUrls.find(u => /\/Reports\/.+[?&]id=\d+/i.test(u));
    const nonImageDoc = attachmentUrls.find(u => !isImageUrl(u));
    const directUrl = tenderDetailUrl || reportUrl || nonImageDoc || portal.tendersUrl;
    const summaryParts = [agencyText, unspscText].filter(Boolean);

    items.push({
      referenceNo: refFromBlock,
      title: cleanTitle,
      organization: agencyText || portal.name,
      location,
      directUrl,
      publishDate: publishDate || undefined,
      closingDate,
      estimatedValue: budgetText || undefined,
      description: summaryParts.join(' | ').slice(0, 350),
      isCorrigendum: isCorrigendum || undefined,
      attachmentUrls
    });
  });

  return { matched: true, items, stopOnEmpty: false, sanitize: false };
}

function parseBppraPageHtml(html: string, portal: PortalWithSession): ScrapeResult {
  const $ = cheerio.load(html);
  const blocked = detectHtmlAccessBlock($, html, portal);
  if (blocked) return blocked;
  const res = parseBppraHtml($, portal);
  return { items: res.items, hitlRequired: false };
}

function mergeParsedItems(
  target: RawScrapedItem[],
  seen: Set<string>,
  incoming: RawScrapedItem[]
): number {
  let added = 0;
  for (const item of incoming) {
    const k = dedupKey(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    target.push(item);
    added++;
  }
  return added;
}

async function readShowingText(page: any): Promise<string> {
  return page
    .locator('text=/Showing\\s+\\d+\\s+to\\s+\\d+/')
    .first()
    .textContent({ timeout: 2500 })
    .then((s: string | null) => (s || '').replace(/\s+/g, ' ').trim())
    .catch(() => '');
}

async function waitForShowingChange(page: any, prevShowing: string, timeoutMs: number = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readShowingText(page);
    if (current && current !== prevShowing) return;
    await page.waitForTimeout(250);
  }
}

async function fetchBppraBlazorPages(
  portal: PortalDefinition & { sessionCookies?: string },
  maxPages: number,
  knownMap: Map<string, KnownTenderStopEntry> | null | undefined,
  timeoutMs: number
): Promise<{ items: RawScrapedItem[]; pagesScanned: number }> {
  let browser: any = null;
  try {
    browser = await launchHeadlessChromium();

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: HUMAN_CHROME_HEADERS['User-Agent']
    });
    const page = await context.newPage();

    await page.goto(portal.tendersUrl, { waitUntil: 'networkidle', timeout: Math.max(timeoutMs, 25000) });

    // Switch filter dropdown from "All Tenders" (85k+) to "Active Tenders" (~400)
    try {
      const beforeFilter = await readShowingText(page);
      const toggle = page.locator('.dropdown-toggle:has-text("All Tenders")').first();
      if ((await toggle.count()) > 0) {
        await toggle.click({ timeout: 4000 });
        await page.locator('.dropdown-item:has-text("Active Tenders")').first().click({ timeout: 4000 });
        await waitForShowingChange(page, beforeFilter, 5000);
        await page.waitForTimeout(300);
      }
    } catch (e: any) {
      console.warn('[BPPRA] Could not switch to Active Tenders dropdown:', e?.message || e);
    }

    // Set Records Per Page = 100 and trigger Reload if Blazor defers rendering on select change
    try {
      const recSelect = page.locator('select[name="tenderListView.RecordsPerPage"]').first();
      if ((await recSelect.count()) > 0) {
        await recSelect.selectOption('100');
        await page.waitForTimeout(1500);
        const rowsAfterSelect = await page.locator('tr.tender-row-main').count();
        if (rowsAfterSelect <= 15) {
          const reloadBtn = page.locator('button[title="Reload"]').first();
          if ((await reloadBtn.count()) > 0) {
            await reloadBtn.click({ timeout: 4000 });
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
              if ((await page.locator('tr.tender-row-main').count()) > 15) break;
              await page.waitForTimeout(250);
            }
          }
        }
      }
    } catch (e: any) {
      console.warn('[BPPRA] RecordsPerPage=100 adjustment note:', e?.message || e);
    }

    const collected: RawScrapedItem[] = [];
    const seen = new Set<string>();
    let pagesScanned = 0;

    // Page 1
    const page1Html = await page.content();
    const page1Parsed = parseBppraPageHtml(page1Html, portal);
    pagesScanned++;
    mergeParsedItems(collected, seen, page1Parsed.items);

    // Pages 2..maxPages
    for (let pageNum = 2; pageNum <= maxPages; pageNum++) {
      const pageLink = page.locator('.pagination a.page-link', { hasText: new RegExp(`^${pageNum}$`) }).first();
      if ((await pageLink.count()) === 0) break;

      const beforeShowing = await readShowingText(page);
      await pageLink.click({ timeout: 5000 });
      await waitForShowingChange(page, beforeShowing, 6000);
      await page.waitForTimeout(400);

      const pageHtml = await page.content();
      const parsed = parseBppraPageHtml(pageHtml, portal);
      pagesScanned++;
      if (parsed.items.length === 0) break;

      const added = mergeParsedItems(collected, seen, parsed.items);
      if (added === 0) break;
      if (shouldEarlyStopKnownPage(parsed.items, knownMap)) {
        break;
      }
    }

    return { items: collected, pagesScanned };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Scrapes Balochistan BPPRA across Blazor `/Tenders` (`Active Tenders`, up to 100/page pagination)
 * plus `/RFP`, `/PreQualification`, and `/EOI` active listings.
 */
export async function scrapeBppraPortal(
  portal: PortalDefinition & { sessionCookies?: string },
  options?: {
    depth?: ScanDepth;
    knownMap?: Map<string, KnownTenderStopEntry> | null;
    timeoutMs?: number;
  }
): Promise<ScrapeResult> {
  const depth: ScanDepth = options?.depth === 'deep' ? 'deep' : 'quick';
  const maxPages = resolvePaginationMaxPages(portal, depth, 2);
  const timeoutMs = options?.timeoutMs ?? 25000;

  const items: RawScrapedItem[] = [];
  const seen = new Set<string>();
  let pagesScanned = 0;

  // Step A: Primary /Tenders via Playwright Blazor pagination (falling back to plain HTTP SSR if Playwright fails)
  try {
    const blazorRes = await fetchBppraBlazorPages(portal, maxPages, depth === 'quick' ? options?.knownMap : null, timeoutMs);
    pagesScanned += blazorRes.pagesScanned;
    mergeParsedItems(items, seen, blazorRes.items);
  } catch (pwErr: any) {
    console.warn(`[BPPRA] Playwright pagination fallback to HTTP SSR (${pwErr?.message || pwErr})`);
    const fetched = await fetchHtmlSmart(portal.tendersUrl, portal.sessionCookies, timeoutMs);
    const parsed = parseBppraPageHtml(fetched.html, portal);
    pagesScanned = 1;
    mergeParsedItems(items, seen, parsed.items);
  }

  // Step B: Supplemental active solicitation tabs (/RFP, /PreQualification, /EOI)
  const origin = (portal.baseUrl || BPPRA_PORTAL_ORIGIN).replace(/\/$/, '');
  for (const tabPath of BPPRA_EXTRA_TABS) {
    const tabUrl = `${origin}${tabPath}`;
    try {
      const fetched = await fetchHtmlSmart(tabUrl, portal.sessionCookies, timeoutMs);
      if (!fetched.html) continue;
      const tabPortal: PortalDefinition = { ...portal, tendersUrl: tabUrl };
      const parsed = parseBppraPageHtml(fetched.html, tabPortal);
      if (parsed.items.length > 0) {
        pagesScanned++;
        mergeParsedItems(items, seen, parsed.items);
      }
    } catch (tabErr: any) {
      console.warn(`[BPPRA] Failed to fetch extra tab ${tabPath}: ${tabErr?.message || tabErr}`);
    }
  }

  return {
    items,
    hitlRequired: false,
    pagesScanned: Math.max(1, pagesScanned)
  };
}
