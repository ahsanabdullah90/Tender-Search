import net from 'net';

export type UrlValidationResult =
  | { valid: true; url: URL }
  | { valid: false; reason: string };

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(rawHost: string): boolean {
  const ip = rawHost.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    return net.isIPv4(mapped) ? isPrivateIpv4(mapped) : true;
  }
  return false;
}

/**
 * Validates operator-supplied HTTP(S) URLs (portals & digest webhooks) and rejects
 * non-HTTP schemes, embedded credentials, loopback, link-local, and private RFC1918 targets.
 */
export function validateExternalHttpUrl(rawUrl: string): UrlValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, reason: 'URL cannot be empty.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'Invalid URL format.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only http:// and https:// URLs are allowed.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'Embedded URL credentials are not allowed.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || BLOCKED_HOST_SUFFIXES.some(s => host.endsWith(s))) {
    return { valid: false, reason: 'Local or internal hostnames are not allowed.' };
  }

  // Reject bare decimal/hex/octal host obfuscations (e.g. http://2130706433 or http://0x7f000001)
  if (/^(?:\d+|0x[0-9a-f]+)$/i.test(host)) {
    return { valid: false, reason: 'Numeric host literals are not allowed.' };
  }

  const unbracketed = host.replace(/^\[|\]$/g, '');
  const ipVersion = net.isIP(unbracketed);
  if (ipVersion === 4 && isPrivateIpv4(unbracketed)) {
    return { valid: false, reason: 'Private, loopback, or link-local IPv4 addresses are not allowed.' };
  }
  if (ipVersion === 6 && isPrivateIpv6(unbracketed)) {
    return { valid: false, reason: 'Private, loopback, or link-local IPv6 addresses are not allowed.' };
  }

  if (ipVersion === 0 && !host.includes('.')) {
    return { valid: false, reason: 'Hostname must be a fully qualified public domain.' };
  }

  return { valid: true, url: parsed };
}
