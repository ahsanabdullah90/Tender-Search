import { db } from '../connection.js';
import { PortalHealth } from '../../../types.js';

export function getPortalHealthList(): PortalHealth[] {
  const rows = db.prepare('SELECT * FROM portal_health ORDER BY portal_name ASC').all() as any[];
  return rows.map(r => ({
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
    access_mode: r.access_mode,
    verified_status: r.verified_status
  }));
}

export function updatePortalHealth(portalId: string, updates: Partial<PortalHealth> & { auth_password?: string }) {
  const existing = db.prepare('SELECT * FROM portal_health WHERE portal_id = ?').get(portalId);
  if (!existing) return;

  const allowedColumns = new Set([
    'portal_name', 'category', 'tier', 'base_url', 'tenders_url', 'login_url',
    'auth_username', 'auth_password', 'session_cookies',
    'status', 'last_scan_at', 'last_items_found', 'consecutive_zero_yields',
    'last_error_message', 'access_mode', 'verified_status'
  ]);

  const fields: string[] = [];
  const values: any[] = [];

  for (const [key, val] of Object.entries(updates)) {
    if (allowedColumns.has(key) && val !== undefined) {
      let normalizedVal = val;
      if (key === 'base_url' && typeof val === 'string' && val.trim()) {
        try {
          normalizedVal = new URL(val.trim()).origin;
        } catch {}
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
