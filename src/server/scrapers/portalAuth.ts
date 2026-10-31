import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { updatePortalHealth, getPortalAuthCredentials } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SESSIONS_DIR = path.resolve(PROJECT_ROOT, 'data', 'sessions');

export interface AuthResult {
  success: boolean;
  message: string;
  cookies?: string;
}

/**
 * Attempts direct HTTP authentication against known portal login endpoints.
 */
export async function authenticatePortal(
  portalId: string,
  username: string,
  password: string,
  customLoginUrl?: string
): Promise<AuthResult> {
  const sessionDir = path.resolve(SESSIONS_DIR, portalId);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // 1. Specific handler for Tender Services Pakistan
  if (portalId === 'tender_services') {
    const loginUrl = customLoginUrl || 'https://tenderservice.pk/permits/login.php';
    try {
      const params = new URLSearchParams();
      params.append('email', username);
      params.append('password', password);

      const res = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Referer': loginUrl
        },
        body: params.toString()
      });

      const bodyText = await res.text();

      // Check failure indicators from tenderservice.pk login.php
      if (
        bodyText.includes('Wrong Password Given') ||
        bodyText.includes('Payments missing') ||
        bodyText.includes('Invalid credentials')
      ) {
        return {
          success: false,
          message: 'Invalid credentials or payment missing. Please check your Tender Services email and key.'
        };
      }

      // Extract cookies from Set-Cookie headers
      let cookieHeader = '';
      if (typeof (res.headers as any).getSetCookie === 'function') {
        const rawCookies: string[] = (res.headers as any).getSetCookie();
        cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');
      } else {
        const raw = res.headers.get('set-cookie');
        if (raw) {
          cookieHeader = raw.split(';')[0];
        }
      }

      // Persist session cookies
      if (cookieHeader) {
        fs.writeFileSync(path.resolve(sessionDir, 'cookies.txt'), cookieHeader, 'utf8');
      }

      updatePortalHealth(portalId, {
        session_cookies: cookieHeader || undefined,
        status: 'online',
        last_error_message: null
      });

      return {
        success: true,
        message: 'Successfully authenticated with tenderservice.pk! Active session saved.',
        cookies: cookieHeader
      };
    } catch (err: any) {
      console.error('[PortalAuth] tender_services login error:', err);
      return {
        success: false,
        message: `Network error reaching tenderservice.pk: ${err.message}`
      };
    }
  }

  // 2. Generic portal credentials saving (e.g. EPADS or others)
  updatePortalHealth(portalId, {
    status: 'online',
    last_error_message: null
  });

  return {
    success: true,
    message: 'Credentials saved successfully. You can now scan or launch the browser session.'
  };
}
