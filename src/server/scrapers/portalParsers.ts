import * as cheerio from 'cheerio';
import { safeDecodeURIComponent, isImageUrl, isCorrigendumLabel } from '../../shared/documentUtils.js';
import { isAuctionOrDisposalTender } from './scraperUtils.js';
import { PortalDefinition } from './portalList.js';
import { parseDateString, extractDatesFromText, normalizeExtractedDate } from './dateParser.js';
import {
  RawScrapedItem,
  ScrapeResult,
  GENERIC_LINK_LABELS,
  resolvePortalUrl,
  isNonBidEvaluationOrPlanTitle,
  extractRefFromText,
  cleanRowSummary,
  stripLiteralHtmlTags,
  sanitizeScrapedItems,
  collectRowAttachments,
  extractPunjabLocation,
  extractGbLocation,
  extractAjkLocation
} from './parserHelpers.js';

export * from './parserHelpers.js';

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
      // Skip historical PSDF upload archive folders (>1 year before current year)
      const archiveYearMatch = href.match(/\/wp-content\/uploads\/(20\d{2})\//i);
      if (archiveYearMatch && Number(archiveYearMatch[1]) < new Date().getUTCFullYear() - 1) return;

      const fullUrl = resolvePortalUrl(href, portal);
      if (seenUrls.has(fullUrl)) return;

      const liText = stripLiteralHtmlTags(
        $(aEl).find('li').first().text().replace(/\s+/g, ' ').trim() || $(aEl).text().replace(/\s+/g, ' ').trim()
      );
      const fileSlug = safeDecodeURIComponent(fullUrl.split('/').pop() || '')
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

    // 3a-2. Parse advertisement listing boxes (.inner-advertisement-listing-box)
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
      const nonImageDoc = attachmentUrls.find(u => !isImageUrl(u));
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
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 3c. Structured GBPPRA & Laravel Job/Procurement Cards (.job-post-item)
  if ($('.job-post-item').length > 0) {
    const NON_BID_GB_BADGE_RE =
      /\b(?:final\s+evaluation(?:\s+report)?|technical\s+evaluation(?:\s+report)?|financial\s+evaluation(?:\s+result|\s+report)?|evaluation\s+report|result|cancelled|canceled|postponed|auction|work\s+order|supply\s+order)\b/i;

    $('.job-post-item').each((_, el) => {
      const badgeText = $(el)
        .find('.badge-wrap .badge')
        .map((__, b) => $(b).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean)
        .join(' | ');
      if (badgeText && NON_BID_GB_BADGE_RE.test(badgeText)) return;

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
      const nonImageDoc = attachmentUrls.find(u => !isImageUrl(u));
      const directUrl = detailUrl || nonImageDoc || portal.tendersUrl;

      if (isNonBidEvaluationOrPlanTitle(title, directUrl)) return;

      const rowText = $(el).text().replace(/\s+/g, ' ').trim();
      const rawSuccessDate = $(el).find('.text-success').first().text().replace(/\s+/g, ' ').trim();
      const rawDangerDate = $(el).find('.text-danger').first().text().replace(/\s+/g, ' ').trim();
      const directPublish = rawSuccessDate ? parseDateString(rawSuccessDate) : null;
      const directClosing = rawDangerDate ? parseDateString(rawDangerDate) : null;
      const fallbackDates = (!directPublish || !directClosing) ? extractDatesFromText(rowText) : { publishDate: null, closingDate: null };
      const publishDate = directPublish || fallbackDates.publishDate;
      const closingDate = directClosing || fallbackDates.closingDate;

      const isCorrigendum =
        /\b(?:corrigendum|addendum)\b/i.test(badgeText) ||
        /\b(?:corrigendum|addendum)\b/i.test(title);

      items.push({
        referenceNo: refNo || extractRefFromText(rowText),
        title,
        organization,
        location: extractGbLocation(organization, title),
        directUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: badgeText,
        isCorrigendum: isCorrigendum || undefined,
        attachmentUrls
      });
    });
    return { items: sanitizeScrapedItems(items, portal), hitlRequired: false };
  }

  // 3d. Structured Sindh SPPRA EPADS Angular Cards (section.card with EPADS-S-... tender numbers)
  const spCards = $('section.card').filter((_, el) => /EPADS-S-\d+/i.test($(el).text()));
  if (spCards.length > 0) {
    spCards.each((_, el) => {
      const card = $(el);
      const cardText = card.text().replace(/\s+/g, ' ').trim();
      if (/Status:\s*(Closed|Cancelled|Completed|Awarded)/i.test(cardText)) return;

      const headings = card.find('h6').map((__, h) => $(h).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
      const refNo = headings.find(h => /^EPADS-S-\d+/i.test(h)) || cardText.match(/\b(EPADS-S-\d+)\b/i)?.[1];
      const title = headings.find(h => !/^EPADS-S-\d+/i.test(h) && !/^Department Name:/i.test(h) && h.length > 5) || '';
      if (!title) return;

      const deptMatch = cardText.match(/Department Name:\s*([^\n]+?)(?=\s+Status:|\s+Published Date:|$)/i);
      const organization = deptMatch?.[1]?.trim() || portal.name;
      const locMatch = cardText.match(/Location:\s*([^\n]+?)(?=\s+Published Date:|\s+View\/Download|$)/i);
      const rawLoc = locMatch?.[1]?.trim();
      const location = rawLoc ? (/sindh/i.test(rawLoc) ? rawLoc : `${rawLoc}, Sindh`) : 'Sindh, Pakistan';

      const pubMatch = cardText.match(/Published Date:\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}(?:,?\s+\d{1,2}:\d{2}\s*[AP]M)?)/i);
      const closeMatch = cardText.match(/Closing Date:\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}(?:,?\s+\d{1,2}:\d{2}\s*[AP]M)?)/i);
      const { publishDate: fallbackPub, closingDate: fallbackClose } = extractDatesFromText(cardText);
      const publishDate = (pubMatch ? normalizeExtractedDate(pubMatch[1]) : undefined) || fallbackPub || undefined;
      const closingDate = (closeMatch ? normalizeExtractedDate(closeMatch[1]) : undefined) || fallbackClose;

      const directUrl = refNo
        ? `${portal.baseUrl.replace(/\/$/, '')}/#/?tender=${encodeURIComponent(refNo)}`
        : portal.tendersUrl;

      items.push({
        referenceNo: refNo,
        title,
        organization,
        location,
        directUrl,
        publishDate,
        closingDate,
        description: cleanRowSummary(cardText, title, card),
        attachmentUrls: collectRowAttachments($, el, portal)
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 3d-2. Structured UNGM Notice Rows (.tableRow.dataRow, .ungm-list-item, div[data-noticeid])
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
      const rawTitle = nameClone
        .text()
        .replace(/\(\s*\)\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!rawTitle) return;

      const typeText = $(tds[2]).text().replace(/\s+/g, ' ').trim();
      const publishDate = parseDateString($(tds[3]).text().trim()) || undefined;
      const closingDate = parseDateString($(tds[4]).text().trim());
      const deptText = $(tds[5]).text().replace(/\s+/g, ' ').trim();
      const statusText = tds.length > 6 ? $(tds[6]).text().replace(/\s+/g, ' ').trim() : '';

      if (isAuctionOrDisposalTender(rawTitle, procType, typeText)) return;

      let title = rawTitle;
      if (deptText && /^(?:tender\s+notice|notice\s+inviting\s+tenders?|invitation\s+(?:for|to)\s+bids?|tender\s+advertisement|procurement\s+notice|short\s+tender\s+notice|nit)$/i.test(rawTitle)) {
        title = `Tender Notice — ${deptText}`;
      } else if (deptText && /^(?:corrigendum|addendum)(?:\s+notice)?$/i.test(rawTitle)) {
        title = `${rawTitle} — ${deptText}`;
      }
      if (!title || title.length <= 5) return;

      const attachmentUrls = collectRowAttachments($, el, portal);
      const detailUrl = detailHref ? resolvePortalUrl(detailHref, portal) : null;
      const nonImageDoc = attachmentUrls.find(u => !isImageUrl(u));
      const directUrl = detailUrl || nonImageDoc || portal.tendersUrl;

      if (isNonBidEvaluationOrPlanTitle(title, directUrl)) return;

      const isCorrigendum = isCorrigendumLabel(procType) || isCorrigendumLabel(rawTitle);

      const summaryParts = [procType, typeText, statusText].filter(Boolean);

      items.push({
        referenceNo: extractRefFromText(rawTitle),
        title,
        organization: deptText || portal.name,
        location: extractPunjabLocation(deptText, rawTitle),
        directUrl,
        publishDate,
        closingDate,
        description: summaryParts.join(' | ').slice(0, 350),
        isCorrigendum,
        attachmentUrls
      });
    });
    if (items.length > 0) return { items: sanitizeScrapedItems(items, portal), hitlRequired: false };
  }

  // 3f. Structured Federal PPRA EPMS Active Tenders Table (https://epms.ppra.gov.pk/public/tenders/active-tenders)
  const epmsRows = $('table tbody tr').filter((_, el) => $(el).find('a[href*="/public/tenders/tender-details/"]').length > 0);
  if (epmsRows.length > 0) {
    const decodeAmp = (s: string) => s.replace(/&#0*38;|&amp;/gi, '&');
    epmsRows.each((_, el) => {
      const statusCell = $(el).find('td[data-label="Status"]');
      const statusText = statusCell.text().replace(/\s+/g, ' ').trim();
      if (/\bcancelled\b/i.test(statusText) || statusCell.find('.badge-danger').length > 0) return;

      const detailLink = $(el).find('a[href*="/public/tenders/tender-details/"]').first();
      const directUrl = resolvePortalUrl(detailLink.attr('href'), portal);

      const detailsCell = $(el).find('td[data-label="Tender Details"]').first();
      const title = decodeAmp((detailsCell.find('strong').first().text() || '').replace(/\s+/g, ' ').trim());
      if (!title || title.length <= 5) return;
      if (isNonBidEvaluationOrPlanTitle(title, directUrl)) return;

      const tenderNoCell = $(el).find('td[data-label="Tender No"]').first();
      const ppraRef = (tenderNoCell.find('strong').first().text() || '').replace(/\s+/g, ' ').trim();
      const noticeMethod = (tenderNoCell.find('.badge').first().text() || '').replace(/\s+/g, ' ').trim();

      const snippet = decodeAmp((detailsCell.find('small.text-muted').first().text() || '').replace(/\s+/g, ' ').trim());
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
            const orgName = decodeAmp(valEl.find('strong').first().text().replace(/\s+/g, ' ').trim());
            const subOffice = decodeAmp(valEl.find('.text-dark').first().text().replace(/\s+/g, ' ').trim());
            const locTxt = decodeAmp(valEl.find('small').first().text().replace(/\s+/g, ' ').trim());
            if (orgName.length > 2) {
              organization = subOffice && subOffice !== orgName ? `${orgName} (${subOffice})` : orgName;
            }
            if (locTxt.length > 2) {
              location = locTxt;
            }
          } else {
            detailMeta[label] = decodeAmp(valEl.text().replace(/\s+/g, ' ').trim());
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
        isCorrigendum:
          statusCell.find('.badge-corrigendum').length > 0 ||
          /\b(?:corrigendum|amendment|addendum|extension)\b/i.test(
            `${title} ${snippet} ${statusText} ${detailMeta['tender type'] || ''}`
          ),
        attachmentUrls: collectRowAttachments($, el, portal)
      });
    });
    if (items.length > 0) return { items: sanitizeScrapedItems(items, portal), hitlRequired: false };
  }

  // 3g. Structured AJK PPRA Active Advertisements Table (https://www.ajkppra.gov.pk/advertisements.php)
  const ajkTable = $('table.table').filter((_, tbl) => {
    const firstRowText = $(tbl).find('tr').first().text().replace(/\s+/g, ' ').trim().toLowerCase();
    return (
      firstRowText.includes('procurement') &&
      firstRowText.includes('publishing date') &&
      firstRowText.includes('closing date') &&
      (firstRowText.includes('procuring agency') || portal.id === 'ajk_ppra')
    );
  }).first();
  if (ajkTable.length > 0) {
    ajkTable.find('tr').each((_, el) => {
      if ($(el).find('th').length > 0) return;
      const tds = $(el).children('td');
      if (tds.length < 7) return;

      const col0Text = $(tds[0]).text().replace(/\s+/g, ' ').trim();
      if (!col0Text || isAuctionOrDisposalTender('', col0Text)) return;

      const idMatch = col0Text.match(/\b(\d{3,8})\b/);
      const referenceNo = idMatch ? `AJKPPRA-${idMatch[1]}` : undefined;
      const procType = col0Text.replace(/\b\d{3,8}\b/, '').replace(/\s+/g, ' ').trim();

      const titleClone = $(tds[1]).clone();
      titleClone.find('strong').each((__, sEl) => {
        if (/^\(?\d+\)?$/.test($(sEl).text().trim())) {
          $(sEl).remove();
        }
      });
      const title = titleClone.text().replace(/\s+/g, ' ').trim();
      if (!title || title.length <= 5) return;
      if (isAuctionOrDisposalTender(title)) {
        return;
      }

      const publishDate = parseDateString($(tds[2]).text().trim()) || undefined;
      const closingDate = parseDateString($(tds[3]).text().trim());
      const department = $(tds[4]).text().replace(/\s+/g, ' ').trim();
      const agency = $(tds[5]).text().replace(/\s+/g, ' ').trim();
      const organization =
        agency && department && !agency.toLowerCase().includes(department.toLowerCase())
          ? `${agency} (${department})`
          : (agency || department || portal.name);

      const attachmentUrls: string[] = [];
      let mainDocUrl: string | undefined;
      let hasCorrLink = false;
      $(tds[6]).find('a[href]').each((__, aEl) => {
        const href = $(aEl).attr('href');
        if (!href) return;
        const absUrl = resolvePortalUrl(href, portal);
        if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);

        const linkText = $(aEl).text().replace(/\s+/g, ' ').trim();
        const linkTitle = $(aEl).attr('title') || '';
        const linkStyle = ($(aEl).attr('style') || '').toLowerCase();
        const isCorr =
          isCorrigendumLabel(linkText) ||
          isCorrigendumLabel(`${href} ${linkTitle}`) ||
          /#ff0000|\bred\b/.test(linkStyle);
        if (isCorr) {
          hasCorrLink = true;
        } else if (!mainDocUrl && !isImageUrl(absUrl)) {
          mainDocUrl = absUrl;
        }
      });

      const directUrl = mainDocUrl || attachmentUrls[0] || portal.tendersUrl;
      if (isNonBidEvaluationOrPlanTitle(title, directUrl)) return;

      const isCorrigendum =
        hasCorrLink ||
        isCorrigendumLabel(col0Text) ||
        isCorrigendumLabel(title);

      items.push({
        referenceNo,
        title,
        organization,
        location: extractAjkLocation(`${agency} ${department}`, title),
        directUrl,
        publishDate,
        closingDate,
        description: [procType, department, agency].filter(Boolean).join(' | ').slice(0, 350),
        isCorrigendum: isCorrigendum || undefined,
        attachmentUrls
      });
    });
    return { items: sanitizeScrapedItems(items, portal), hitlRequired: false };
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

      const fileSlug = safeDecodeURIComponent(fullUrl.split('/').pop() || '').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();
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
