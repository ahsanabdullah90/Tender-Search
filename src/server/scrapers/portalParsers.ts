import * as cheerio from 'cheerio';
import { BidBrief } from '../../shared/types.js';
import { PortalDefinition } from './portalList.js';
import { isValidReferenceNo } from '../services/deduplicator.js';
import { parseDateString, extractDatesFromText, DATE_CANDIDATE_PATTERN } from './dateParser.js';

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
  isLoginRequired?: boolean;
  pagesScanned?: number;
}

const GENERIC_LINK_LABELS = /^(download(?:\s+rfp|\s+specs|\s+doc|\s+file)?|click\s+to\s+view|view(?:\s+tender\s+details?|\s+details?|\s+file)?|details|advertisement|bidding\s+document|nit\s+document|boq\s+document|rfq\s+document|bid\s+document|evaluation\s+report|tender\s+document|read\s+more|open|apply|corrigendum|asset\s+register|o&m\s+manuals|drawings)$/i;

export function resolvePortalUrl(href: string | undefined, portal: PortalDefinition): string {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return portal.tendersUrl;
  try {
    const resolved = href.startsWith('http') ? new URL(href) : new URL(href, portal.baseUrl);
    resolved.pathname = resolved.pathname.replace(/\/{2,}/g, '/');
    return resolved.toString();
  } catch {
    return portal.tendersUrl;
  }
}

/**
 * Checks whether a title or filename represents a post-bid evaluation report, pre-bid meeting minutes,
 * annual procurement plan, or architectural/CAD drawing rather than an open tender opportunity.
 */
export function isNonBidEvaluationOrPlanTitle(title: string, url?: string): boolean {
  const cleanTitle = (title || '').replace(/\s+/g, ' ').trim();
  const fileSlug = url
    ? decodeURIComponent(url.split('/').pop() || '').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim()
    : '';
  const combined = `${cleanTitle} ${fileSlug}`;

  // 1. Post-bid evaluation reports (Technical / Financial / Final / PPRA Evaluation Report)
  if (
    /^(?:ppra\s+)?(?:technical\s+|financial\s+|final\s+|bid\s+)?eval(?:ua|u)tion\s+report\b/i.test(cleanTitle) ||
    /\b(?:technical|financial|final|bid)\s+eval(?:ua|u)tion\s+(?:report|as\s+per\s+ppra)\b/i.test(combined) ||
    /^evaluation\s+report\b/i.test(cleanTitle)
  ) {
    return true;
  }

  // 2. Pre-bid minutes, pre-bid meeting notices, procurement plans, templates, and non-tender notices
  if (
    /^(?:minutes?\s+of\s+pre[- ]?bid|minuets?\s+of\s+meeting|mom\s+of\s+|annual\s+procurement\s+plan|cancellation(?:\s+notice)?|approval\s+mechanism|management\s+team\s+cv\s+format|cv\s+format|list\s+of\s+trades|manual\s+skills\s+scholarship\s+program\s+system|formats?|pre[- ]?bid\s+meeting)\b/i.test(cleanTitle) ||
    /\b(?:annual\s+procurement\s+plan|minutes?\s+of\s+pre[- ]?bid|minuets?\s+of\s+meeting|pre[- ]?bid\s+meeting)\b/i.test(combined)
  ) {
    return true;
  }

  // 3. CAD floor plans, site plans, asset registers, and bid summaries (e.g. PSEB sub-files like "SITE PLANGround")
  if (
    /(?:site\s*plan|floor\s*plans?|ground\s*floor|elevation\s*plan|cad\s*drawing|assets?\s*register|bid\s*summary|tech\s+destination\s+of\s+the\s+year|approval\s+mechanism)/i.test(combined)
  ) {
    return true;
  }

  return false;
}

export function extractRefFromText(text: string): string | undefined {
  const refMatch = text.match(/(?:\bTS[-/]?\d{3,10}\b|\bPID\s*\([A-Z]+\)\s*\d+\b|\b[A-Z]{2,10}[-/][A-Z0-9/-]*\d[A-Z0-9/-]{1,20}\b)/i);
  return refMatch && isValidReferenceNo(refMatch[0]) ? refMatch[0] : undefined;
}

/**
 * Strips repeated titles, dates, serial numbers, and generic button words from raw table/card text
 * so the summary never displays noisy table garbage. Returns empty string if no genuine scope text remains.
 */
export function cleanRowSummary(rowText: string, title: string, $el?: cheerio.Cheerio<any>): string {
  if ($el) {
    const paragraphs: string[] = [];
    $el.find('p').each((_, p) => {
      const pText = $el.find(p).text().replace(/\s+/g, ' ').trim();
      if (
        pText.length >= 20 &&
        !/^(reference|organization|submission deadline|published|closing date|opening date)\s*:/i.test(pText) &&
        pText.toLowerCase() !== title.toLowerCase()
      ) {
        paragraphs.push(pText);
      }
    });
    if (paragraphs.length > 0) {
      return paragraphs.join('\n').slice(0, 500);
    }
  }

  let cleaned = rowText.replace(/\s+/g, ' ').trim();
  if (title) {
    cleaned = cleaned.split(title).join(' ');
  }
  // Remove dates, standalone row numbers, and generic action button labels
  cleaned = cleaned
    .replace(new RegExp(DATE_CANDIDATE_PATTERN, 'gi'), ' ')
    .replace(/\b(?:download(?:\s+rfp|\s+specs|\s+doc|\s+file)?|click\s+to\s+view|view(?:\s+details|\s+file)?|details|advertisement|tender\s+document|read\s+more|open|apply|submission\s+date|opening\s+date|closing\s+date|publish\s+date|published|due\s+date|closed|active)\b/gi, ' ')
    .replace(/^\s*\d+\s*/, '')
    .replace(/[|•:,-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < 25 || cleaned.toLowerCase() === title.toLowerCase()) {
    return '';
  }
  return cleaned.slice(0, 350);
}

const NEWSPAPER_LIST_PATTERN = /\b(all\s+newspapers|dawn|nawaiwaqt|the\s+news|the\s+nation|express|daily\s+jang|dunya|khabrain|mashriq|ausaf|business\s+recorder)\b/gi;

export function isGenericListingUrl(url: string, portalDef?: PortalDefinition): boolean {
  if (!url) return true;
  try {
    const cleanUrl = url.replace(/\/+$/, '').toLowerCase();
    if (portalDef) {
      const cleanBase = portalDef.baseUrl.replace(/\/+$/, '').toLowerCase();
      const cleanTenders = portalDef.tendersUrl.replace(/\/+$/, '').toLowerCase();
      if (cleanUrl === cleanBase || cleanUrl === cleanTenders) return true;
    }
    const parsed = new URL(url);
    return parsed.pathname === '' || parsed.pathname === '/' || /^\/(tenders?|active-tenders?|procurements?)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Detects junk navigation rows (such as newspaper lists or portal home/listing rows with no tender data) (docs/16 C2).
 */
export function isNavigationRow(item: RawScrapedItem, portal: PortalDefinition): boolean {
  const title = (item.title || '').trim();
  const newspaperMatches = title.match(NEWSPAPER_LIST_PATTERN);
  if (newspaperMatches && newspaperMatches.length >= 3) {
    return true;
  }
  if (/^all\s+newspapers\b/i.test(title)) {
    return true;
  }
  if (/^(all\s+categories|category\s+list|site\s+navigation|useful\s+links)$/i.test(title)) {
    return true;
  }

  // Drop items whose directUrl is the portal's base or listing URL and that have no date, reference or attachment
  const isGenericUrl = isGenericListingUrl(item.directUrl, portal);
  const hasDate = Boolean(item.closingDate || item.publishDate);
  const hasRef = Boolean(item.referenceNo);
  const hasAttachments = Boolean(item.attachmentUrls && item.attachmentUrls.length > 0);

  if (isGenericUrl && !hasDate && !hasRef && !hasAttachments) {
    return true;
  }

  return false;
}

export function stripLiteralHtmlTags(text: string): string {
  return (text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function sanitizeScrapedItems(items: RawScrapedItem[], portal: PortalDefinition): RawScrapedItem[] {
  const cleaned: RawScrapedItem[] = [];
  for (const item of items) {
    const cleanTitle = stripLiteralHtmlTags(item.title || '');
    if (cleanTitle.length <= 5) continue;
    const nextItem = cleanTitle === item.title ? item : { ...item, title: cleanTitle };
    if (!isNavigationRow(nextItem, portal)) {
      cleaned.push(nextItem);
    }
  }
  return cleaned;
}

export function collectRowAttachments($: cheerio.CheerioAPI, el: any, portal: PortalDefinition): string[] {
  const attachmentUrls: string[] = [];
  $(el).find('a[href], a[data-downloadurl]').each((__, aEl) => {
    const aHref = $(aEl).attr('data-downloadurl') || $(aEl).attr('href');
    if (!aHref || aHref.startsWith('#') || aHref.startsWith('javascript:')) return;

    if (/\.(pdf|docx?|xlsx?)(\?|$)/i.test(aHref) || /[?&]wpdmdl=\d+/i.test(aHref) || /\/pdf\?file=/i.test(aHref) || $(aEl).hasClass('wpdm-download-link')) {
      const absUrl = resolvePortalUrl(aHref, portal);
      if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);
    } else if (/\.(jpe?g|png|webp)(\?|$)/i.test(aHref)) {
      // Image linked via <a>: only if not site-chrome (/img/, /images/) and not a stamp/seal/logo/watermark (docs/16 B5)
      if (/\/(img|images)\//i.test(aHref)) return;
      if (/stamp|seal|badge|watermark|logo|icon|avatar|spinner|zoom-onhover|banner|flag|placeholder/i.test(aHref)) return;
      const absUrl = resolvePortalUrl(aHref, portal);
      if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);
    }
  });

  $(el).find('img').each((__, imgEl) => {
    const src = $(imgEl).attr('data-lazy-src') || $(imgEl).attr('data-src') || $(imgEl).attr('src');
    if (!src || src.startsWith('data:')) return;
    if (!/\.(jpe?g|png|webp)(\?|$)/i.test(src)) return;

    const cls = ($(imgEl).attr('class') || '').toLowerCase();
    const alt = ($(imgEl).attr('alt') || '').toLowerCase();
    const combo = `${src} ${cls} ${alt}`;

    // Skip site-chrome (/img/, /images/), logos, stamps, seals, badges, watermarks (docs/16 B5)
    if (/\/(img|images)\//i.test(src)) return;
    if (/stamp|seal|badge|watermark|logo|icon|avatar|spinner|zoom-onhover|banner|flag|placeholder|download-icon/i.test(combo)) return;

    // Only collect images that are inside an <a> tag OR whose src is under an uploads/notices/tenders path
    const insideLink = $(imgEl).closest('a[href]').length > 0;
    const isUploadPath = /\/(upload|uploads|notice|notices|tender|tenders|advertisement|documents|proc_files|wp-content\/uploads)\//i.test(src);
    if (!insideLink && !isUploadPath) return;

    const absUrl = resolvePortalUrl(src, portal);
    if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);
  });
  return attachmentUrls;
}

/**
 * Parses raw HTML string from a portal into structured items or detects verification challenge.
 */
export function parsePortalHtml(html: string, portal: PortalDefinition): ScrapeResult {
  const $ = cheerio.load(html);
  const items: RawScrapedItem[] = [];

  // Hard Cloudflare / FortiWeb / Gov WAF / challenge block checks (Bug B4)
  if (
    $('iframe[src*="challenges.cloudflare.com"], #cf-browser-verification').length > 0 ||
    html.includes('cf-browser-verification') ||
    html.includes('challenges.cloudflare.com') ||
    html.includes('Just a moment...') ||
    html.includes('Attention Required! | Cloudflare') ||
    /Web Page Blocked!|Attack ID:\s*\d+|FortiWeb|The page cannot be displayed\.\s*Please contact the administrator/i.test(html)
  ) {
    return { items: [], hitlRequired: true };
  }

  // Generic CAPTCHA check only triggers on small challenge pages without content (prevents false-positives on WP footer widgets)
  if (
    $('iframe[src*="cloudflare"], #captcha, input[name*="captcha"]').length > 0 &&
    html.length < 50000 &&
    !$('table, .tender-card, .package-title, .inner-advertisement-listing-box, a[href*=".pdf"]').length
  ) {
    return { items: [], hitlRequired: true };
  }

  // Check for login forms or credentials requirement (Bug B5)
  if (
    portal.accessMode === 'login_required' &&
    !(portal as any).sessionCookies &&
    $('a[href*="login.php"], a[href*="/login"]').length > 0 &&
    !$('.tender-item, .procurement-item').length
  ) {
    return { items: [], hitlRequired: true, isLoginRequired: true };
  }
  const hasLoginForm = $('input[type="password"]').length > 0 ||
    /login to continue|enter credentials|sign in to access|session expired/i.test(html);
  if (hasLoginForm && !$('table, .tender-row, .notice-item, .procurement-item, .tender-card, .package-title, .tender-item').length) {
    return { items: [], hitlRequired: true, isLoginRequired: true };
  }

  // 1. Structured NDMA tender cards (.tender-card)
  if ($('.tender-card').length > 0) {
    $('.tender-card').each((_, el) => {
      const titleLink = $(el).find('.tender-card__title a').first();
      const title = (titleLink.text() || $(el).find('.tender-card__title').text()).replace(/\s+/g, ' ').trim();
      if (title.length <= 5) return;

      const href = titleLink.attr('href');
      const fullUrl = resolvePortalUrl(href, portal);
      if (isNonBidEvaluationOrPlanTitle(title, fullUrl)) return;

      const subText = $(el).find('[data-label*="Submission"], [data-label*="Closing"]').text().trim();
      const openText = $(el).find('[data-label*="Opening"], [data-label*="Publish"]').text().trim();
      const rowText = $(el).text().replace(/\s+/g, ' ').trim();

      const fallbackDates = extractDatesFromText(rowText);
      const closingDate = parseDateString(subText) || fallbackDates.closingDate;
      const publishDate = parseDateString(openText) || fallbackDates.publishDate;

      const attachmentUrls = collectRowAttachments($, el, portal);
      if (href && /\.(pdf|docx?|xlsx?|jpe?g|png|webp)(\?|$)/i.test(href) && !attachmentUrls.includes(fullUrl)) {
        attachmentUrls.unshift(fullUrl);
      }

      items.push({
        referenceNo: extractRefFromText(rowText),
        title,
        organization: portal.name,
        directUrl: fullUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: cleanRowSummary(rowText, title, $(el)),
        attachmentUrls
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 2. Structured WordPress Download Manager cards (FDE: h3.package-title)
  if ($('h3.package-title').length > 0) {
    $('h3.package-title').each((_, el) => {
      const link = $(el).find('a').first();
      const rawTitle = (link.text() || $(el).text()).replace(/\s+/g, ' ').trim();
      if (rawTitle.length <= 5) return;

      const fullUrl = resolvePortalUrl(link.attr('href'), portal);
      const cardEl = $(el).closest('.card, .media, article, .wpdm-link-tpl, .col-md-4, .col-md-6');
      const rowText = (cardEl.length ? cardEl.text() : rawTitle).replace(/\s+/g, ' ').trim();
      const { publishDate, closingDate } = extractDatesFromText(rowText);

      // Strip leading date prefix from title if present (e.g. "22-08-2026, RENOVATION OF...")
      const cleanTitle = rawTitle.replace(/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\s*[,:-]?\s*/, '').trim() || rawTitle;
      if (isNonBidEvaluationOrPlanTitle(cleanTitle, fullUrl)) return;

      const attachmentUrls = cardEl.length ? collectRowAttachments($, cardEl.get(0), portal) : [];

      items.push({
        referenceNo: extractRefFromText(rowText),
        title: cleanTitle,
        organization: portal.name,
        directUrl: fullUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: cleanRowSummary(rowText, cleanTitle, cardEl.length ? cardEl : undefined),
        attachmentUrls
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 3. Structured PSDF advertisement listing boxes (.inner-advertisement-listing-box) & dropdown PDFs (#tendersdownload-button)
  if ($('.inner-advertisement-listing-box').length > 0 || $('#tendersdownload-button .dropdown-content a[href$=".pdf"]').length > 0) {
    const seenTitles = new Set<string>();
    const seenUrls = new Set<string>();

    // 3a. Parse active tender PDFs in #tendersdownload-button .dropdown-content
    $('#tendersdownload-button .dropdown-content a[href$=".pdf"], .dropdown-content a[href$=".pdf"]').each((_, aEl) => {
      const href = $(aEl).attr('href');
      if (!href) return;
      // Skip historical archive years 2020-2024 on PSDF uploads
      if (/\/wp-content\/uploads\/202[0-4]\//i.test(href)) return;

      const fullUrl = resolvePortalUrl(href, portal);
      if (seenUrls.has(fullUrl)) return;

      const liText = stripLiteralHtmlTags(
        $(aEl).find('li').first().text().replace(/\s+/g, ' ').trim() || $(aEl).text().replace(/\s+/g, ' ').trim()
      );
      const fileSlug = decodeURIComponent(fullUrl.split('/').pop() || '')
        .replace(/\.pdf$/i, '')
        .replace(/^(?:Tender[-_ ]Document[-_ ]|Bidding[-_ ]Document[-_ ])/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();

      const isGenericLabel = !liText || liText.length <= 5 || GENERIC_LINK_LABELS.test(liText) || /^(tender\s+document(?:\s+uploaded)?|bidding\s+document|corrigendum(?:\s+bd|\s+tender\s+doc)?|advertisement(?:\s+\d+)?|formats?|ks)$/i.test(liText);
      const title = isGenericLabel ? fileSlug : liText;
      if (!title || title.length <= 5) return;
      if (/^(tender\s+document(?:\s+uploaded)?|bidding\s+document|corrigendum(?:\s+bd|\s+tender\s+doc)?|advertisement(?:\s+\d+)?|formats?|ks)$/i.test(title)) return;
      if (isNonBidEvaluationOrPlanTitle(title, fullUrl)) return;

      const normTitle = title.toLowerCase();
      if (seenTitles.has(normTitle)) return;
      seenTitles.add(normTitle);
      seenUrls.add(fullUrl);

      const { publishDate, closingDate } = extractDatesFromText(`${title} ${fileSlug}`);
      items.push({
        referenceNo: extractRefFromText(title),
        title,
        organization: portal.name,
        directUrl: fullUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: '',
        attachmentUrls: [fullUrl]
      });
    });

    // 3b. Parse advertisement listing boxes (.inner-advertisement-listing-box)
    $('.inner-advertisement-listing-box').each((_, el) => {
      const title = stripLiteralHtmlTags(
        ($(el).find('h4.listingadver-title1').first().text() || $(el).find('h4, h3, .listingadver-title1').first().text()).replace(/\s+/g, ' ').trim()
      );
      if (title.length <= 5 || seenTitles.has(title.toLowerCase())) return;
      if (isNonBidEvaluationOrPlanTitle(title)) return;
      seenTitles.add(title.toLowerCase());

      const attachmentUrls = collectRowAttachments($, el, portal);
      const rowText = $(el).text().replace(/\s+/g, ' ').trim();
      const { publishDate, closingDate } = extractDatesFromText(rowText);

      const boxLink = $(el).find('a[href]').first().attr('href');
      const boxDetailUrl = (boxLink && !boxLink.startsWith('#') && !boxLink.startsWith('javascript:'))
        ? resolvePortalUrl(boxLink, portal)
        : null;
      const nonImageDoc = attachmentUrls.find(u => !/\.(jpe?g|png|webp)(\?|$)/i.test(u));
      const directUrl = boxDetailUrl || nonImageDoc || portal.tendersUrl;

      items.push({
        referenceNo: extractRefFromText(title),
        title,
        organization: portal.name,
        directUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: '',
        attachmentUrls
      });
    });
    if (items.length > 0) return { items: sanitizeScrapedItems(items, portal), hitlRequired: false };
  }

  // 3b. Structured BPPRA ePPS Multi-Row Table (tr.tender-row-main + sibling tr.tender-row-dates)
  if ($('tr.tender-row-main').length > 0) {
    $('tr.tender-row-main').each((_, el) => {
      const titleLink = $(el).find('.td-title-link').first();
      const rawTitleBlock = (titleLink.text() || $(el).find('.td-title-cell').first().text()).replace(/\s+/g, ' ').trim();
      if (!rawTitleBlock || rawTitleBlock.length <= 5) return;

      const refFromBlock = extractRefFromText(rawTitleBlock);
      let cleanTitle = rawTitleBlock;
      if (refFromBlock) {
        cleanTitle = cleanTitle.replace(refFromBlock, '').trim();
      }
      cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim();
      if (cleanTitle.length <= 5) cleanTitle = rawTitleBlock;

      // Extract agency/department, UNSPSC category, and budget from main row cells
      const agencyText = $(el).find('td:nth-child(3)').text().replace(/\s+/g, ' ').trim();
      const unspscText = $(el).find('td:nth-child(4)').text().replace(/\s+/g, ' ').trim();
      const budgetText = (
        $(el).find('td:nth-child(5)').text() ||
        $(el).find('.td-title-footer').text()
      ).replace(/Estimated\s*budget\s*:\s*/i, '').replace(/\bOpen\b/gi, '').replace(/\s+/g, ' ').trim();

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
      const nonImageDoc = attachmentUrls.find(u => !/\.(jpe?g|png|webp)(\?|$)/i.test(u));
      const directUrl = tenderDetailUrl || nonImageDoc || portal.tendersUrl;
      const summaryParts = [agencyText, unspscText].filter(Boolean);

      items.push({
        referenceNo: refFromBlock,
        title: cleanTitle,
        organization: agencyText || portal.name,
        directUrl,
        publishDate: publishDate || undefined,
        closingDate,
        estimatedValue: budgetText || undefined,
        description: summaryParts.join(' | ').slice(0, 350),
        attachmentUrls
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 3c. Structured GBPPRA & Laravel Job/Procurement Cards (.job-post-item)
  if ($('.job-post-item').length > 0) {
    $('.job-post-item').each((_, el) => {
      let refNo: string | undefined;
      const refMatch = $(el).text().match(/\[?(TSE-[\w\d]+)\]?/i);
      if (refMatch) refNo = refMatch[1];

      let title = '';
      $(el).find('.job-post-item-header h2, .job-post-item-header h3, .job-post-item-header h4').each((__, hEl) => {
        const text = $(hEl).text().replace(/\s+/g, ' ').trim();
        if (text && (!refNo || !text.includes(refNo)) && text.length > 5 && !title) {
          title = text;
        }
      });
      if (!title) {
        title = $(el).find('h2, h3, h4').last().text().replace(/\s+/g, ' ').trim();
      }
      if (!title || title.length <= 5) return;

      let organization = portal.name;
      const orgEl = $(el).find('.fa-university').parent();
      if (orgEl.length > 0) {
        const orgText = orgEl.text().replace(/\s+/g, ' ').trim();
        if (orgText && orgText.length > 2) organization = orgText;
      }

      const rowText = $(el).text().replace(/\s+/g, ' ').trim();
      const { publishDate, closingDate } = extractDatesFromText(rowText);

      const attachmentUrls = collectRowAttachments($, el, portal);
      $(el).find('a[href*="proc_files"], a[href$=".pdf"]').each((__, aEl) => {
        const href = $(aEl).attr('href');
        if (href) {
          const absUrl = resolvePortalUrl(href, portal);
          if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);
        }
      });

      let detailUrl: string | undefined;
      const detailLink = $(el).find('a[href*="/procurementdetails/"], a.btn-primary[href]').first().attr('href');
      if (detailLink) {
        detailUrl = resolvePortalUrl(detailLink, portal);
      }
      const nonImageDoc = attachmentUrls.find(u => !/\.(jpe?g|png|webp)(\?|$)/i.test(u));
      const directUrl = detailUrl || nonImageDoc || portal.tendersUrl;

      items.push({
        referenceNo: refNo || extractRefFromText(rowText),
        title,
        organization,
        directUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: '',
        attachmentUrls
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 3d. Structured UNGM Notice Rows (.tableRow.dataRow, .ungm-list-item, div[data-noticeid])
  if ($('.tableRow.dataRow, .ungm-list-item, div[data-noticeid]').length > 0) {
    $('.tableRow.dataRow, .ungm-list-item, div[data-noticeid]').each((_, el) => {
      const noticeLink = $(el).find('a[href*="/Public/Notice/"]').first();
      const title = (
        noticeLink.find('.ungm-title').text() ||
        noticeLink.text() ||
        $(el).find('.ungm-title, .resultTitle').text()
      ).replace(/\s+/g, ' ').trim();
      if (!title || title.length <= 5) return;

      const noticeId = $(el).attr('data-noticeid');
      const href = noticeLink.attr('href') || (noticeId ? `/Public/Notice/${noticeId}` : undefined);
      const directUrl = resolvePortalUrl(href, portal);
      const rowText = $(el).text().replace(/\s+/g, ' ').trim();
      const { publishDate, closingDate } = extractDatesFromText(rowText);

      const cells = $(el).find('.tableCell');
      const refText = cells.length >= 6 ? $(cells[5]).text().replace(/\s+/g, ' ').trim() : undefined;
      const agencyText = cells.length >= 4 ? $(cells[3]).text().replace(/\s+/g, ' ').trim() : undefined;

      items.push({
        referenceNo: (refText && refText.length >= 3 && refText.length <= 40 ? refText : undefined) || extractRefFromText(rowText),
        title,
        organization: (agencyText && agencyText.length >= 2 && agencyText.length <= 60) ? `${agencyText} (${portal.name})` : portal.name,
        directUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: cleanRowSummary(rowText, title, $(el)),
        attachmentUrls: collectRowAttachments($, el, portal)
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 3e. Structured ASP.NET Telerik RadGrid table (Punjab eProc: table.rgMasterTable inside <form id="aspnetForm">)
  const radGridRows = $('table.rgMasterTable tbody > tr.rgRow, table.rgMasterTable tbody > tr.rgAltRow');
  if (radGridRows.length > 0) {
    radGridRows.each((_, el) => {
      const tds = $(el).children('td');
      if (tds.length < 6) return;

      const procType = $(tds[0]).text().replace(/\s+/g, ' ').trim();
      const nameCell = $(tds[1]);
      let detailHref: string | undefined;
      nameCell.find('a[href]').each((__, aEl) => {
        const href = $(aEl).attr('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          detailHref = href;
          return false;
        }
      });

      const nameClone = nameCell.clone();
      nameClone.find('a').each((__, aEl) => {
        const aText = $(aEl).text().replace(/\s+/g, ' ').trim();
        if (GENERIC_LINK_LABELS.test(aText)) {
          $(aEl).remove();
        }
      });
      const title = nameClone
        .text()
        .replace(/\(\s*\)\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!title || title.length <= 5) return;

      const typeText = $(tds[2]).text().replace(/\s+/g, ' ').trim();
      const publishDate = parseDateString($(tds[3]).text().trim()) || undefined;
      const closingDate = parseDateString($(tds[4]).text().trim());
      const deptText = $(tds[5]).text().replace(/\s+/g, ' ').trim();
      const statusText = tds.length > 6 ? $(tds[6]).text().replace(/\s+/g, ' ').trim() : '';

      const attachmentUrls = collectRowAttachments($, el, portal);
      const detailUrl = detailHref ? resolvePortalUrl(detailHref, portal) : null;
      const nonImageDoc = attachmentUrls.find(u => !/\.(jpe?g|png|webp)(\?|$)/i.test(u));
      const directUrl = detailUrl || nonImageDoc || portal.tendersUrl;

      if (isNonBidEvaluationOrPlanTitle(title, directUrl)) return;

      const summaryParts = [procType, typeText, statusText].filter(Boolean);

      items.push({
        referenceNo: extractRefFromText(title),
        title,
        organization: deptText || portal.name,
        directUrl,
        publishDate,
        closingDate,
        description: summaryParts.join(' | ').slice(0, 350),
        isCorrigendum: /corrigendum/i.test(procType),
        attachmentUrls
      });
    });
    if (items.length > 0) return { items: sanitizeScrapedItems(items, portal), hitlRequired: false };
  }

  // 3f. Structured Federal PPRA EPMS Active Tenders Table (https://epms.ppra.gov.pk/public/tenders/active-tenders)
  const epmsRows = $('table tbody tr').filter((_, el) => $(el).find('a[href*="/public/tenders/tender-details/"]').length > 0);
  if (epmsRows.length > 0) {
    epmsRows.each((_, el) => {
      const statusText = $(el).find('td[data-label="Status"]').text().replace(/\s+/g, ' ').trim();
      if (/^cancelled$/i.test(statusText)) return;

      const detailLink = $(el).find('a[href*="/public/tenders/tender-details/"]').first();
      const directUrl = resolvePortalUrl(detailLink.attr('href'), portal);

      const detailsCell = $(el).find('td[data-label="Tender Details"]').first();
      const title = (detailsCell.find('strong').first().text() || '').replace(/\s+/g, ' ').trim();
      if (!title || title.length <= 5) return;
      if (isNonBidEvaluationOrPlanTitle(title, directUrl)) return;

      const tenderNoCell = $(el).find('td[data-label="Tender No"]').first();
      const ppraRef = (tenderNoCell.find('strong').first().text() || '').replace(/\s+/g, ' ').trim();
      const noticeMethod = (tenderNoCell.find('.badge').first().text() || '').replace(/\s+/g, ' ').trim();

      const snippet = (detailsCell.find('small.text-muted').first().text() || '').replace(/\s+/g, ' ').trim();
      const detailBadges = detailsCell.find('div small.badge').map((__, b) => $(b).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
      const sectorBadge = detailBadges[0] || '';
      const inquiryRef = detailBadges[1] && detailBadges[1] !== ppraRef ? detailBadges[1] : '';

      const expandId = $(el).find('.cb-rt-expand').attr('data-id');
      const expandedRow = expandId ? $(`#cb-rt-detail-${expandId}`) : $(el).next('tr.cb-rt-detail-row');
      let organization = portal.name;
      let location: string | undefined;
      const detailMeta: Record<string, string> = {};

      if (expandedRow.length > 0) {
        expandedRow.find('.cb-rt-grid > div').each((__, col) => {
          const label = $(col).find('.cb-rt-dl').text().replace(/\s+/g, ' ').trim().toLowerCase();
          const valEl = $(col).find('.cb-rt-dv').first();
          if (!label || !valEl.length) return;
          if (label === 'organization') {
            const orgName = valEl.find('strong').first().text().replace(/\s+/g, ' ').trim();
            const subOffice = valEl.find('.text-dark').first().text().replace(/\s+/g, ' ').trim();
            const locTxt = valEl.find('small').first().text().replace(/\s+/g, ' ').trim();
            if (orgName.length > 2) {
              organization = subOffice && subOffice !== orgName ? `${orgName} (${subOffice})` : orgName;
            }
            if (locTxt.length > 2) {
              location = locTxt;
            }
          } else {
            detailMeta[label] = valEl.text().replace(/\s+/g, ' ').trim();
          }
        });
      }

      const advRaw = $(el).find('td[data-label="Advertised"]').first().text().replace(/\s+/g, ' ').trim();
      const publishDate = parseDateString(advRaw) || undefined;

      const closeCell = $(el).find('td[data-label="Closing"]').first();
      const closeDatePart = closeCell.find('strong').first().text().replace(/\s+/g, ' ').trim();
      const closeTimePart = closeCell.find('small').first().text().replace(/\s+/g, ' ').trim();
      const closeRaw = closeDatePart && closeTimePart
        ? `${closeDatePart} ${closeTimePart}`
        : closeCell.text().replace(/\s+/g, ' ').trim();
      const closingDate = parseDateString(closeRaw);

      const metaTags = [
        noticeMethod,
        detailMeta['tender type'],
        detailMeta['procurement category'],
        sectorBadge || detailMeta['sector'],
        detailMeta['tender nature'],
        inquiryRef ? `Ref: ${inquiryRef}` : ''
      ].filter(Boolean);
      const description = [snippet, metaTags.join(' · ')].filter(Boolean).join(' — ').slice(0, 350);

      items.push({
        referenceNo: (ppraRef && /^[A-Z]{2}\d{5,}[A-Z0-9]*$/i.test(ppraRef) ? ppraRef : undefined) || inquiryRef || extractRefFromText(title),
        title,
        organization,
        directUrl,
        publishDate,
        closingDate,
        location,
        description,
        isCorrigendum: /\b(?:corrigendum|amendment|addendum|extension)\b/i.test(`${title} ${snippet} ${detailMeta['tender type'] || ''}`),
        attachmentUrls: collectRowAttachments($, el, portal)
      });
    });
    if (items.length > 0) return { items: sanitizeScrapedItems(items, portal), hitlRequired: false };
  }

  // 4. Standard & Drupal / NinjaTable / GridView rows
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
    if ($(el).closest('form, select, nav, header, footer, .job-search, .search-form, .filter-bar, .pagination, aside').length > 0) return;
    if ($(el).is('article') && $(el).find('table, tbody tr, .tender-row, .tender-card, .job-post-item').length > 0) return;
    if ($(el).is('th') || $(el).closest('thead').length > 0 || $(el).find('th').length > $(el).find('td').length) return;

    const rowText = $(el).text().replace(/\s+/g, ' ').trim();
    if (!rowText || rowText.length < 20) return;

    let chosenHref: string | undefined;
    let chosenLinkText = '';
    $(el).find('a[href]').each((__, aEl) => {
      const aText = $(aEl).text().replace(/\s+/g, ' ').trim();
      const aHref = $(aEl).attr('href');
      if (!chosenHref && aHref) chosenHref = aHref;
      if (!chosenLinkText && aText.length > 5 && !GENERIC_LINK_LABELS.test(aText) && !parseDateString(aText)) {
        chosenLinkText = aText;
        if (aHref) chosenHref = aHref;
      }
    });

    if (
      chosenHref &&
      (/\/(category|tag|searchresults?|search|login)(\/|$)/i.test(chosenHref) ||
       /^(all newspapers|newspapers?|canteen|all categories)$/i.test(chosenLinkText))
    ) {
      return;
    }

    const fullUrl = resolvePortalUrl(chosenHref, portal);

    let title = chosenLinkText;
    if (!title) {
      const candidateCells = [
        $(el).find('.views-field-title').first().text(),
        $(el).find('h3, h4').first().text(),
        $(el).find('td:nth-child(2)').first().text(),
        $(el).find('td:nth-child(1)').first().text()
      ];
      for (const c of candidateCells) {
        const cleaned = c.replace(/\s+/g, ' ').trim();
        if (
          cleaned.length > 5 &&
          !/^\d+$/.test(cleaned) &&
          !GENERIC_LINK_LABELS.test(cleaned) &&
          !parseDateString(cleaned)
        ) {
          title = cleaned;
          break;
        }
      }
    }
    if (!title) {
      title = rowText.slice(0, 100);
    }

    if (isNonBidEvaluationOrPlanTitle(title, fullUrl)) return;

    const referenceNo = extractRefFromText(rowText);

    let { publishDate, closingDate } = extractDatesFromText(rowText);
    if (!closingDate) {
      const closingCellText = $(el).find('.views-field-field-tender-closing-date, td:nth-child(4), td:nth-child(3)').text().trim();
      closingDate = parseDateString(closingCellText);
    }
    if (!publishDate) {
      const openingCellText = $(el).find('.views-field-field-tender-opening-date, td:nth-child(3), td:nth-child(2)').text().trim();
      const candidatePub = parseDateString(openingCellText);
      if (candidatePub && candidatePub !== closingDate) {
        publishDate = candidatePub;
      }
    }

    const attachmentUrls = collectRowAttachments($, el, portal);

    if (title.length > 5) {
      items.push({
        referenceNo,
        title,
        organization: portal.name,
        directUrl: fullUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: cleanRowSummary(rowText, title, $(el)),
        attachmentUrls
      });
    }
  });

  // 5. Fallback for Elementor / WordPress direct PDF procurement listings (e.g. PSEB TechDestination)
  if (items.length === 0) {
    const seenUrls = new Set<string>();
    $('a[href*="/wp-content/uploads/"][href$=".pdf"], a[href*="/Tender"][href$=".pdf"]').each((_, aEl) => {
      const href = $(aEl).attr('href');
      if (!href) return;
      const fullUrl = resolvePortalUrl(href, portal);
      if (seenUrls.has(fullUrl)) return;

      const fileSlug = decodeURIComponent(fullUrl.split('/').pop() || '').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();
      const aText = $(aEl).text().replace(/\s+/g, ' ').trim();
      const title = (!aText || GENERIC_LINK_LABELS.test(aText)) ? fileSlug : aText;
      if (title.length <= 5) return;
      if (isNonBidEvaluationOrPlanTitle(title, fullUrl)) return;

      seenUrls.add(fullUrl);

      const containerText = $(aEl).closest('.e-con, tr, article, li, div').text().replace(/\s+/g, ' ').trim();
      const { publishDate, closingDate } = extractDatesFromText(containerText);

      items.push({
        referenceNo: extractRefFromText(title),
        title,
        organization: portal.name,
        directUrl: fullUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: '',
        attachmentUrls: [fullUrl]
      });
    });
  }

  return { items: sanitizeScrapedItems(items, portal), hitlRequired: false };
}

export function compactHtmlForAiExtraction(html: string, baseUrl: string): string {
  const $ = cheerio.load(html);
  $('script, style, svg, noscript, iframe, nav, footer, header, select, option, optgroup, datalist, form, .job-search, .search-form, .filter-bar, .pagination, aside').remove();

  $('a[href]').each((_, aEl) => {
    const href = $(aEl).attr('href');
    const text = $(aEl).text().replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    try {
      const absUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
      $(aEl).replaceWith(` [${text || 'Link'}](${absUrl}) `);
    } catch {
      // Keep original text if URL is malformed
    }
  });

  const bodyText = ($('body').text() || $.root().text())
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

  return bodyText.slice(0, 25000);
}

export function hasEmptyTenderTableState(html: string): boolean {
  return /no\s+active\s+(?:tenders?|records?|procurements?)|no\s+records?\s+found|currently\s+0\s+open\s+tenders?|no\s+open\s+tenders?|0\s+tenders?\s+found|no\s+openings?\b/i.test(html);
}

export function hasProcurementSignals(html: string): boolean {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 120) return false;
  const signals = [
    /\btenders?\b/i,
    /\bprocurements?\b/i,
    /\brfps?\b|\brfqs?\b/i,
    /\bbids?\b|\bbidding\b/i,
    /\bnit\b|\bnotice\s+inviting\b/i,
    /\bclosing\s+date\b|\bdead\s*line\b|\bsubmission\b/i
  ];
  let matchedCount = 0;
  for (const rx of signals) {
    if (rx.test(text)) matchedCount++;
  }
  return matchedCount >= 2;
}

/**
 * Extracts an ASP.NET __doPostBack form payload from an HTML page for navigating to `targetPage`.
 */
export function buildAspNetPostBackBody(html: string, targetPage: number): string | null {
  const $ = cheerio.load(html);
  const pagerLink = $('.rgNumPart a, .pagination a, a[href*="__doPostBack"]')
    .filter((_, a) => $(a).text().replace(/\s+/g, ' ').trim() === String(targetPage))
    .first();
  if (!pagerLink.length) return null;

  const rawJs = `${pagerLink.attr('href') || ''} ${pagerLink.attr('onclick') || ''}`;
  const m = /__doPostBack\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*\)/.exec(rawJs);
  if (!m) return null;

  const form = pagerLink.closest('form').length ? pagerLink.closest('form') : $('form').first();
  if (!form.length) return null;

  const params = new URLSearchParams();
  form.find('input').each((_, el) => {
    const name = $(el).attr('name');
    const type = ($(el).attr('type') || '').toLowerCase();
    if (!name || type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return;
    if ((type === 'checkbox' || type === 'radio') && !$(el).is(':checked')) return;
    params.set(name, $(el).attr('value') || '');
  });
  params.set('__EVENTTARGET', m[1]);
  params.set('__EVENTARGUMENT', m[2]);
  return params.toString();
}

export interface EpmsDetailMetadata {
  description?: string;
  location?: string;
  bidBrief?: BidBrief;
}

/**
 * Deterministically extracts structured BidBrief fields, city, and full tender description
 * from an EPMS PPRA `/public/tenders/tender-details/<TS_ID>` page with zero AI API calls.
 */
export function parseEpmsDetailHtml(html: string): EpmsDetailMetadata | null {
  const $ = cheerio.load(html);
  const fields: Record<string, string> = {};

  $('.list-group-item').each((_, item) => {
    const label = $(item).find('.detail-label').first().text().replace(/\s+/g, ' ').trim().toLowerCase();
    if (!label) return;
    const valEl = $(item).find('.flex-grow-1').first();
    const val = (valEl.length ? valEl.text() : $(item).text()).replace(/\s+/g, ' ').trim();
    if (val && val !== '-') {
      fields[label] = val;
    }
  });

  if (Object.keys(fields).length === 0) return null;

  const bidSecRaw = fields['bid security'];
  const bidSecurityAmount = bidSecRaw
    ? (/^(?:PKR|Rs)/i.test(bidSecRaw) ? bidSecRaw : `PKR ${bidSecRaw}`)
    : null;
  const bidMethod = fields['procurement procedure'] || null;
  const bidValidity = fields['bid validity'] || null;
  const inquiryRef = fields['tender no / reference no / tender inquiry no'] || null;
  const contactPerson = fields['contact person'] || null;
  const contactEmail = fields['contact email'] || null;
  const contactPhone = fields['contact phone'] || null;

  const contactBits = [contactPerson, contactPhone, contactEmail].filter(Boolean).join(' · ');
  const summaryParts = [
    inquiryRef ? `Inquiry Ref: ${inquiryRef}` : '',
    bidValidity ? `Bid Validity: ${bidValidity}` : '',
    contactBits ? `Contact: ${contactBits}` : ''
  ].filter(Boolean);

  const deliverablesSummary = summaryParts.length > 0
    ? summaryParts
    : (fields['description'] ? [fields['description'].slice(0, 220)] : []);

  const bidBrief: BidBrief | undefined = (bidSecurityAmount || bidMethod || deliverablesSummary.length > 0)
    ? {
        bidSecurityAmount,
        tenderFee: null,
        requiredRegistrations: [],
        requiredExperience: null,
        deliverablesSummary,
        bidMethod
      }
    : undefined;

  return {
    description: fields['description'] || undefined,
    location: fields['city'] || undefined,
    bidBrief
  };
}
