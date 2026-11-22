function isDirectDocumentUrl(url: string): boolean {
  return /\.(pdf|docx?|xlsx?|jpe?g|png|webp)(\?|$)/i.test(url) || /[?&]wpdmdl=\d+/i.test(url);
}

function isHttpUrl(url?: string | null): url is string {
  return Boolean(url && /^https?:\/\//i.test(url));
}

export function isEpmsDetailDiscoveryUrl(url: string, portalId?: string | null): boolean {
  if (!isHttpUrl(url) || isDirectDocumentUrl(url)) return false;
  if (/epms\.ppra\.gov\.pk\/public\/tenders\/tender-details\//i.test(url)) return true;
  return portalId === 'epms_ppra' && /\/tender-details\//i.test(url);
}

export function isFdeDetailDiscoveryUrl(url: string): boolean {
  if (!isHttpUrl(url) || isDirectDocumentUrl(url)) return false;
  return /fde\.gov\.pk\/download\/[^/?#]+/i.test(url) && !/\/download-category\//i.test(url) && !/[?&]wpdmdl=\d+/i.test(url);
}

export function isBppraDetailDiscoveryUrl(url: string): boolean {
  if (!isHttpUrl(url) || isDirectDocumentUrl(url)) return false;
  return /bpptwo\.vdc\.services:9446\/+Reports\/.+[?&]id=\d+/i.test(url);
}

/**
 * Dedicated tender detail pages whose listing row omits downloadable PDF/attachment links,
 * so the background worker must inspect the detail page HTML once to discover them.
 * Generic listing URLs and unrelated sites are excluded so tests and non-document links stay untouched.
 */
export function isDetailPageDiscoveryUrl(url?: string | null, portalId?: string | null): boolean {
  if (!isHttpUrl(url) || isDirectDocumentUrl(url)) return false;
  if (isEpmsDetailDiscoveryUrl(url, portalId)) return true;
  if (isFdeDetailDiscoveryUrl(url)) return true;
  if (portalId === 'bppra' && isBppraDetailDiscoveryUrl(url)) return true;
  return false;
}
