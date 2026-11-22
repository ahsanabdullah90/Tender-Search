import * as cheerio from 'cheerio';
import type { Tender } from '../../../shared/types.js';
import type { PortalDefinition } from '../portalList.js';
import { collectRowAttachments, isGenericListingUrl, ScrapeResult } from '../parserHelpers.js';
import type { PortalWithSession } from './types.js';

/**
 * Detects Cloudflare / FortiWeb / Gov WAF challenges, CAPTCHA blocks, or login walls
 * before deterministic portal DOM parsers run.
 */
export function detectHtmlAccessBlock(
  $: cheerio.CheerioAPI,
  html: string,
  portal: PortalWithSession
): ScrapeResult | null {
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
    !portal.sessionCookies &&
    $('a[href*="login.php"], a[href*="/login"]').length > 0 &&
    !$('.tender-item, .procurement-item').length
  ) {
    return { items: [], hitlRequired: true, isLoginRequired: true };
  }
  const hasLoginForm =
    $('input[type="password"]').length > 0 ||
    /login to continue|enter credentials|sign in to access|session expired/i.test(html);
  if (
    hasLoginForm &&
    !$('table, .tender-row, .notice-item, .procurement-item, .tender-card, .package-title, .tender-item').length
  ) {
    return { items: [], hitlRequired: true, isLoginRequired: true };
  }

  return null;
}

/**
 * Locates the matching row or card container for a tender when its direct_url points at a shared listing page.
 */
export function findListingRowContainer($: cheerio.CheerioAPI, tender: Tender): cheerio.Cheerio<any> | null {
  let matchingContainer: cheerio.Cheerio<any> | null = null;
  $('tr, .job-post-item, .tender-card, .card, article').each((_, el) => {
    const text = $(el).text();
    if (
      (tender.reference_no && text.includes(tender.reference_no)) ||
      (tender.title && text.toLowerCase().includes(tender.title.toLowerCase().slice(0, 30)))
    ) {
      matchingContainer = $(el);
      return false;
    }
  });
  return matchingContainer;
}

/**
 * Extracts attachment URLs and clean body/row text from a detail or listing HTML page,
 * guarding against whole-body attachment scraping when the tender's URL is a generic listing page.
 */
export function extractHtmlDetailTargets(
  html: string,
  tender: Tender,
  portal: PortalDefinition
): { found: boolean; isListing: boolean; detailText: string; discoveredUrls: string[] } {
  const isListing = isGenericListingUrl(tender.direct_url, portal);
  const $ = cheerio.load(html);
  $('script, style, nav, header, footer, select, option, form, .job-search, .search-form, .filter-bar, aside').remove();

  const targetEl: any = isListing ? (findListingRowContainer($, tender)?.get(0) ?? null) : $('body').get(0);
  if (!targetEl) {
    return { found: false, isListing, detailText: '', discoveredUrls: [] };
  }

  const detailText = (isListing ? $(targetEl) : $('main, article, .content, .card, .package-details, body').first())
    .text()
    .replace(/\s+/g, ' ')
    .trim();
  const discoveredUrls = collectRowAttachments($, targetEl, portal);
  return { found: true, isListing, detailText, discoveredUrls };
}
