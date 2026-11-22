import { db } from '../connection.js';
import { sanitizeOriginUrl } from '../../../shared/documentUtils.js';
import { PortalHealth } from '../../../shared/types.js';

function mapPortalHealthRow(r: any): PortalHealth {
  return {
    portal_id: r.portal_id,
    portal_name: r.portal_name,
    category: r.category,
    tier: r.tier,
    base_url: r.base_url,
    tenders_url: r.tenders_url,
    login_url: r.login_url,
    auth_username: r.auth_username,
    has_credentials: Boolean(r.auth_password),
    session_cookies: r.session_cookies,
    status: r.status,
    last_scan_at: r.last_scan_at,
    last_items_found: r.last_items_found,
    consecutive_zero_yields: r.consecutive_zero_yields,
    last_error_message: r.last_error_message,
    last_error_code: r.last_error_code ?? null,
    access_mode: r.access_mode,
    verified_status: r.verified_status,
    last_success_at: r.last_success_at ?? null,
    pages_scanned: r.pages_scanned ?? 0
  };
}

export function getPortalHealthList(): PortalHealth[] {
  const rows = db.prepare('SELECT * FROM portal_health ORDER BY portal_name ASC').all() as any[];
  return rows.map(mapPortalHealthRow);
}

export function updatePortalHealth(portalId: string, updates: Partial<PortalHealth> & { auth_password?: string }) {
  const existing = db.prepare('SELECT * FROM portal_health WHERE portal_id = ?').get(portalId);
  if (!existing) return;

  const allowedColumns = new Set([
    'portal_name', 'category', 'tier', 'base_url', 'tenders_url', 'login_url',
    'auth_username', 'auth_password', 'session_cookies',
    'status', 'last_scan_at', 'last_items_found', 'consecutive_zero_yields',
    'last_error_message', 'last_error_code', 'access_mode', 'verified_status',
    'last_success_at', 'pages_scanned'
  ]);

  const fields: string[] = [];
  const values: any[] = [];

  for (const [key, val] of Object.entries(updates)) {
    if (allowedColumns.has(key) && val !== undefined) {
      let normalizedVal = val;
      if (key === 'base_url' && typeof val === 'string' && val.trim()) {
        normalizedVal = sanitizeOriginUrl(val, val);
      }
      fields.push(`${key} = ?`);
      values.push(normalizedVal);
    }
  }

  if (fields.length === 0) return;
  values.push(portalId);

  db.prepare(`UPDATE portal_health SET ${fields.join(', ')} WHERE portal_id = ?`).run(...values);
}

export function savePortalCredentials(portalId: string, creds: { username?: string; password?: string; loginUrl?: string }) {
  const updates: any = {};
  if (creds.username !== undefined) updates.auth_username = creds.username;
  if (creds.password !== undefined && creds.password.trim().length > 0) updates.auth_password = creds.password;
  if (creds.loginUrl !== undefined) updates.login_url = creds.loginUrl;
  updatePortalHealth(portalId, updates);
}

export function getPortalAuthCredentials(portalId: string): { username?: string; password?: string; loginUrl?: string; cookies?: string } | null {
  const row = db.prepare('SELECT auth_username, auth_password, login_url, session_cookies FROM portal_health WHERE portal_id = ?').get(portalId) as any;
  if (!row) return null;
  return {
    username: row.auth_username,
    password: row.auth_password,
    loginUrl: row.login_url,
    cookies: row.session_cookies
  };
}

export function getPortalById(portalId: string): PortalHealth | null {
  const r = db.prepare('SELECT * FROM portal_health WHERE portal_id = ?').get(portalId) as any;
  return r ? mapPortalHealthRow(r) : null;
}

export function createPortal(input: {
  portal_id?: string;
  portal_name: string;
  tenders_url: string;
  base_url?: string;
  category?: string;
  tier?: string;
  access_mode?: string;
  login_url?: string;
}): PortalHealth {
  const name = input.portal_name.trim();
  const tendersUrl = input.tenders_url.trim();
  const rawBaseUrl = (input.base_url || '').trim();
  const baseUrl = rawBaseUrl
    ? sanitizeOriginUrl(rawBaseUrl, rawBaseUrl)
    : sanitizeOriginUrl(tendersUrl, tendersUrl);

  // Derive unique portal_id slug
  let portalId = (input.portal_id || '').trim();
  if (!portalId) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    portalId = slug || `portal-${Date.now()}`;
  }

  // Ensure unique ID in SQLite
  const existing = db.prepare('SELECT portal_id FROM portal_health WHERE portal_id = ?').get(portalId);
  if (existing) {
    portalId = `${portalId}-${Math.random().toString(36).substring(2, 6)}`;
  }

  const category = input.category?.trim() || 'Provincial';
  const tier = (input.tier === 'playwright' ? 'playwright' : 'http');
  const accessMode = (input.access_mode || 'public');
  const status = accessMode === 'login_required' || accessMode === 'cloudflare' ? 'hitl_required' : 'online';
  const loginUrl = input.login_url?.trim() || null;

  const insertTx = db.transaction(() => {
    // If this portal was previously deleted, remove it from deleted_portals tracking
    try {
      db.prepare('DELETE FROM deleted_portals WHERE portal_id = ?').run(portalId);
    } catch {}

    db.prepare(`
      INSERT INTO portal_health (
        portal_id, portal_name, category, tier, base_url, tenders_url, login_url,
        status, last_items_found, consecutive_zero_yields, access_mode, verified_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'User-added portal')
    `).run(portalId, name, category, tier, baseUrl, tendersUrl, loginUrl, status, accessMode);
  });

  insertTx();

  return getPortalById(portalId)!;
}

export function deletePortal(portalId: string): boolean {
  const deleteTx = db.transaction(() => {
    try {
      db.prepare('INSERT OR IGNORE INTO deleted_portals (portal_id) VALUES (?)').run(portalId);
    } catch {}

    const res = db.prepare('DELETE FROM portal_health WHERE portal_id = ?').run(portalId);
    return res.changes > 0;
  });

  return deleteTx();
}

export function getScanningPortalIds(): string[] {
  const rows = db.prepare("SELECT portal_id FROM portal_health WHERE status = 'scanning'").all() as { portal_id: string }[];
  return rows.map(r => r.portal_id);
}

export function getLastSuccessfulScanTimestamp(): string | null {
  const row = db.prepare("SELECT MAX(last_scan_at) as last_scan FROM portal_health WHERE status != 'error'").get() as { last_scan?: string | null } | undefined;
  return row?.last_scan ?? null;
}

