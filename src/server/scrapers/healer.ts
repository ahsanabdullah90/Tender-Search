import * as cheerio from 'cheerio';
import { PORTAL_DEFINITIONS, PortalDefinition } from './portalList.js';
import { updatePortalHealth } from '../db/index.js';
import { discoverTenderLinkWithAI, extractTenderListFromHtmlWithAI } from '../services/ocrService.js';
import {
  RawScrapedItem,
  ScrapeResult,
  fetchHtmlSmart,
  parsePortalHtml,
  hasEmptyTenderTableState,
  hasProcurementSignals,
  compactHtmlForAiExtraction
} from './crawlerEngine.js';

/**
 * Step 3 of the 5-Step Autonomous Healer:
 * Scores all navigation/page links on an organization's homepage to locate the "Tenders" button/portal URL.
 */
export function scoreCandidateTenderLinks(
  html: string,
  finalBaseUrl: string
): Array<{ text: string; href: string; score: number }> {
  const $ = cheerio.load(html);
  const baseTagHref = $('base[href]').attr('href');
  let effectiveBase = finalBaseUrl;
  if (baseTagHref) {
    try {
      effectiveBase = new URL(baseTagHref, finalBaseUrl).toString();
    } catch {}
  }

  const scoreMap = new Map<string, { text: string; href: string; score: number }>();

  $('a[href]').each((_, aEl) => {
    const rawHref = ($(aEl).attr('href') || '').trim();
    if (!rawHref || rawHref.startsWith('#') || /^(javascript:|mailto:|tel:)/i.test(rawHref)) return;

    let absUrl: string;
    try {
      absUrl = rawHref.startsWith('http') ? rawHref : new URL(rawHref, effectiveBase).toString();
    } catch {
      return;
    }

    // Ignore external social media and map links
    if (/facebook\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|instagram\.com|google\.com\/maps|whatsapp\.com/i.test(absUrl)) {
      return;
    }

    // Ignore direct static file links when looking for a portal navigation page
    if (/\.(pdf|docx?|xlsx?|zip|rar|jpe?g|png|gif)(\?|$)/i.test(absUrl)) {
      return;
    }

    const text = $(aEl).text().replace(/\s+/g, ' ').trim();
    const combined = `${text} ${rawHref}`;
    let score = 0;

    if (/\b(active\s+tenders?|open\s+tenders?|tenders?|e-?tenders?|procurement|tender\s+notices?|rfps?|active\s+bids?|nit|quotations?)\b/i.test(text)) {
      score += 10;
    }
    if (/^(tenders?|active\s+tenders?|open\s+tenders?|procurement|bids?|rfps?|e-?tenders?|nit)$/i.test(text)) {
      score += 4;
    }
    if (/\/(tenders?|active-tenders|procurement|bids|rfp|nit|quotations?|download-category\/tender)(\/|$|\?)/i.test(absUrl)) {
      score += 5;
    }
    if (/\b(archived?|closed|awarded|cancelled|corrigendum-archive|rules|regulations|act|ordinance|faq|contact|about|login|register|sign\s*in|career|jobs?|press\s+release|gallery|team|wings|prc\s+decisions|tendersstats)\b/i.test(combined)) {
      score -= 15;
    }

    if (score > 0) {
      const existing = scoreMap.get(absUrl);
      if (!existing || score > existing.score) {
        scoreMap.set(absUrl, { text: text || absUrl, href: absUrl, score });
      }
    }
  });

  return Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
}

/**
 * Rule 6: Strict base_url Origin Normalization — never store file paths or queries in base_url.
 */
export function sanitizeBaseOrigin(url: string, fallback: string = ''): string {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return fallback;
  }
}

/**
 * Rule 1: Strict Trigger Gating — never trigger Auto-Heal on 0-item scans, network timeouts, TLS resets, or 502/503/504 gateway errors.
 * Only trigger when explicitly invoked by the operator (isManualTrigger = true) or on structural HTTP 404/410/500 dead-link errors.
 */
export function shouldTriggerAutoHeal(fetchError: any, isManualTrigger: boolean = false): boolean {
  if (isManualTrigger) return true;
  if (!fetchError) return false;
  const msg = String(fetchError?.message || fetchError || '');
  const statusCode = Number(fetchError?.statusCode || 0);
  if (statusCode === 404 || statusCode === 410) return true;
  if (/^HTTP\s+(404|410|500)\b/i.test(msg)) return true;
  return false;
}

/**
 * Rule 3: Registrable Domain Boundary — candidate URL must belong to the same hostname/subdomain as the portal
 * (or the official server-redirected root URL), preventing external ministry/footer link hijacking.
 */
export function isAllowedPortalDomain(
  candidateUrl: string,
  portal: PortalDefinition,
  redirectedRootUrl?: string
): boolean {
  try {
    const candHost = new URL(candidateUrl).hostname.toLowerCase().replace(/^www\./, '');
    const allowedHosts = new Set<string>();

    const addHost = (u?: string) => {
      if (!u) return;
      try {
        const h = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
        if (h) allowedHosts.add(h);
      } catch {}
    };

    addHost(portal.baseUrl);
    addHost(portal.tendersUrl);
    addHost(redirectedRootUrl);
    const canonicalDef = PORTAL_DEFINITIONS.find(p => p.id === portal.id);
    if (canonicalDef) {
      addHost(canonicalDef.baseUrl);
      addHost(canonicalDef.tendersUrl);
    }

    for (const allowed of allowedHosts) {
      if (candHost === allowed || candHost.endsWith(`.${allowed}`) || allowed.endsWith(`.${candHost}`)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Rule 4: Anti-Downgrade & Path Integrity Guard — prevents overwriting a specific tender path (e.g. /ActiveTenders.aspx)
 * with a bare root homepage (/), static file, login page, or non-procurement section.
 */
export function isValidHealedTendersUrl(candidateUrl: string, portal: PortalDefinition): boolean {
  try {
    const parsed = new URL(candidateUrl);
    const pathname = parsed.pathname || '/';

    // Block static files/assets from becoming the portal listing URL
    if (/\.(pdf|docx?|xlsx?|zip|rar|jpe?g|png|gif|webp|css|js)(\?|$)/i.test(pathname)) {
      return false;
    }

    // Block login, auth, or non-procurement pages
    if (/\/(login|signin|sign-in|auth|register|about|contact|careers?|jobs?|faq|gallery|press|rules|regulations)(\/|$|\.)/i.test(pathname)) {
      return false;
    }

    // Block downgrading a specific non-root path to a bare root homepage "/"
    const canonicalDef = PORTAL_DEFINITIONS.find(p => p.id === portal.id);
    const referenceTendersUrl = canonicalDef?.tendersUrl || portal.tendersUrl;
    const currentPath = new URL(referenceTendersUrl).pathname || '/';
    const isCurrentSpecific = currentPath !== '/' && currentPath !== '' && !/^\/index\.(html?|php|aspx?)$/i.test(currentPath);
    const isCandidateRoot = pathname === '/' || pathname === '' || /^\/(index|home|default)\.(html?|php|aspx?)$/i.test(pathname);

    if (isCurrentSpecific && isCandidateRoot) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Rule 5: Quality-Verified Yield Proof — requires >= 2 valid items, or >= 1 item that has BOTH a date (closingDate or publishDate)
 * AND a reference number or attachment URL. Never accepts 0 items or empty table states.
 */
export function hasVerifiedTenderYield(items: RawScrapedItem[]): boolean {
  if (!Array.isArray(items) || items.length === 0) return false;
  if (items.length >= 2) return true;
  const first = items[0];
  const hasDate = Boolean(first.closingDate || first.publishDate);
  const hasRefOrAttachment = Boolean(first.referenceNo) || Boolean(first.attachmentUrls && first.attachmentUrls.length > 0);
  return hasDate && hasRefOrAttachment;
}

/**
 * Executes the 5-Step Autonomous Portal Discovery & Self-Healing Process governed by the 7 Anti-Corruption Rules:
 * 1. Identify organization base domain (including canonical PORTAL_DEFINITIONS baseline recovery)
 * 2. Open official website (following cross-domain/port redirects)
 * 3. Look for the "Tenders" button (deterministic scoring + Gemini link discovery fallback)
 * 4. Validate domain boundary, path integrity, and quality-verified tender yield
 * 5. Save the healed portal web address (with sanitized origin base_url) to SQLite portal_health
 */
export async function healPortalConnection(
  portal: PortalDefinition & { sessionCookies?: string }
): Promise<{ healedPortal: PortalDefinition; result: ScrapeResult } | null> {
  const canonicalDef = PORTAL_DEFINITIONS.find(p => p.id === portal.id);
  const rootCandidates: string[] = [];
  if (portal.baseUrl) rootCandidates.push(sanitizeBaseOrigin(portal.baseUrl, portal.baseUrl));
  if (canonicalDef?.baseUrl && !rootCandidates.includes(canonicalDef.baseUrl)) {
    rootCandidates.push(canonicalDef.baseUrl);
  }
  try {
    const tendersOrigin = new URL(portal.tendersUrl).origin;
    if (!rootCandidates.includes(tendersOrigin)) {
      rootCandidates.push(tendersOrigin);
    }
  } catch {}

  for (const rootUrl of rootCandidates) {
    let rootHtml = '';
    let finalRootUrl = rootUrl;
    try {
      const fetched = await fetchHtmlSmart(rootUrl, portal.sessionCookies);
      rootHtml = fetched.html;
      finalRootUrl = fetched.finalUrl;
    } catch {
      continue;
    }

    if (!rootHtml || rootHtml.length < 50) continue;

    // Step 3: Look for the tenders button on the official homepage
    const scoredLinks = scoreCandidateTenderLinks(rootHtml, finalRootUrl);
    let candidateUrls = scoredLinks.filter(l => l.score >= 5).map(l => l.href);

    // Rule 7: Always include canonical PORTAL_DEFINITIONS tendersUrl as recovery candidate if current DB tendersUrl diverged
    if (canonicalDef && canonicalDef.tendersUrl !== portal.tendersUrl) {
      candidateUrls.unshift(canonicalDef.tendersUrl);
    }

    // Step 3B: AI Navigation Link Discovery Fallback if heuristic scoring finds no strong match
    if (candidateUrls.length === 0) {
      const $ = cheerio.load(rootHtml);
      const rawLinks: Array<{ text: string; href: string }> = [];
      $('a[href]').each((_, aEl) => {
        const rawHref = ($(aEl).attr('href') || '').trim();
        const text = $(aEl).text().replace(/\s+/g, ' ').trim();
        if (!rawHref || rawHref.startsWith('#') || /^(javascript:|mailto:|tel:)/i.test(rawHref) || !text) return;
        try {
          const abs = rawHref.startsWith('http') ? rawHref : new URL(rawHref, finalRootUrl).toString();
          if (!rawLinks.some(r => r.href === abs)) {
            rawLinks.push({ text, href: abs });
          }
        } catch {}
      });
      if (rawLinks.length > 0) {
        const aiUrls = await discoverTenderLinkWithAI({
          links: rawLinks,
          portalName: portal.name,
          baseUrl: finalRootUrl
        });
        candidateUrls.push(...aiUrls);
      }
    }

    // Deduplicate, skip already-failed tendersUrl, and enforce Rules 3 & 4 (Domain Boundary + Anti-Downgrade Path Guard)
    const uniqueCandidates = Array.from(new Set(candidateUrls))
      .filter(u => u !== portal.tendersUrl)
      .filter(u => isAllowedPortalDomain(u, portal, finalRootUrl) && isValidHealedTendersUrl(u, portal))
      .slice(0, 3);

    // Step 4: Open each candidate portal URL and verify tender extraction
    for (const candidateUrl of uniqueCandidates) {
      try {
        const { html: candidateHtml, finalUrl: resolvedCandidateUrl } = await fetchHtmlSmart(
          candidateUrl,
          portal.sessionCookies
        );
        if (!isAllowedPortalDomain(resolvedCandidateUrl, portal, finalRootUrl) || !isValidHealedTendersUrl(resolvedCandidateUrl, portal)) {
          continue;
        }

        const resolvedBaseOrigin = sanitizeBaseOrigin(resolvedCandidateUrl, portal.baseUrl);
        const candidatePortal: PortalDefinition = {
          ...portal,
          baseUrl: resolvedBaseOrigin,
          tendersUrl: resolvedCandidateUrl
        };

        let parsed = parsePortalHtml(candidateHtml, candidatePortal);

        // If deterministic selectors found 0 items, try Phase 2 Adaptive AI Layout Extraction
        if (
          parsed.items.length === 0 &&
          !parsed.hitlRequired &&
          !hasEmptyTenderTableState(candidateHtml) &&
          hasProcurementSignals(candidateHtml)
        ) {
          const compacted = compactHtmlForAiExtraction(candidateHtml, candidatePortal.baseUrl);
          const aiItems = await extractTenderListFromHtmlWithAI({
            compactedHtml: compacted,
            portalName: candidatePortal.name,
            baseUrl: candidatePortal.baseUrl,
            tendersUrl: candidatePortal.tendersUrl
          });
          if (aiItems.length > 0) {
            parsed = { items: aiItems, hitlRequired: false };
          }
        }

        // Rule 5: Only persist to SQLite if candidate passes Quality-Verified Yield Proof (NEVER on empty table state)
        if (hasVerifiedTenderYield(parsed.items)) {
          portal.baseUrl = candidatePortal.baseUrl;
          portal.tendersUrl = candidatePortal.tendersUrl;
          updatePortalHealth(portal.id, {
            base_url: candidatePortal.baseUrl,
            tenders_url: candidatePortal.tendersUrl,
            access_mode: 'public',
            status: 'online',
            last_error_message: null,
            verified_status: `Auto-healed -> ${candidatePortal.tendersUrl}`
          });
          return { healedPortal: candidatePortal, result: parsed };
        }
      } catch {
        // Try next candidate
      }
    }
  }

  return null;
}
