import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { updatePortalHealth, getPortalHealthList } from '../db.js';
import { PORTAL_DEFINITIONS } from './portalList.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const SESSIONS_DIR = path.resolve(PROJECT_ROOT, 'data', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export interface HitlLaunchResult {
  success: boolean;
  message: string;
  portalName: string;
  portalUrl: string;
  isHeadlessFallback?: boolean;
}

// Active HITL browser contexts tracked to prevent multiple hanging processes
const activeHitlContexts = new Map<string, any>();

/**
 * Launches the local Playwright browser window on the operator's desktop (headless: false)
 * for CAPTCHA / Cloudflare Turnstile / 2FA resolution.
 */
export async function launchLocalBrowserHITL(portalId: string): Promise<HitlLaunchResult> {
  const dbPortals = getPortalHealthList();
  const dbPortal = dbPortals.find(p => p.portal_id === portalId);
  const defPortal = PORTAL_DEFINITIONS.find(p => p.id === portalId);

  const portalName = dbPortal?.portal_name || defPortal?.name || portalId;
  const targetUrl = dbPortal?.login_url || defPortal?.loginUrl || dbPortal?.tenders_url || defPortal?.tendersUrl || '#';

  const sessionPath = path.resolve(SESSIONS_DIR, portalId);
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  try {
    const modName = 'playwright';
    const playwright: any = await (Function('m', 'return import(m)')(modName) as Promise<any>).catch(() => null);

    if (playwright && (process.env.DISPLAY || process.platform === 'win32' || process.platform === 'darwin')) {
      // Close any already open context for this portal
      if (activeHitlContexts.has(portalId)) {
        try {
          await activeHitlContexts.get(portalId).close();
        } catch {}
        activeHitlContexts.delete(portalId);
      }

      const browser = await playwright.chromium.launchPersistentContext(sessionPath, {
        headless: false,
        viewport: { width: 1280, height: 800 }
      });

      activeHitlContexts.set(portalId, browser);
      browser.on('close', () => {
        activeHitlContexts.delete(portalId);
      });

      const page = await browser.newPage();
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      return {
        success: true,
        message: `Local browser window opened for ${portalName}. Complete the verification and close the browser.`,
        portalName,
        portalUrl: targetUrl,
        isHeadlessFallback: false
      };
    } else {
      return {
        success: true,
        message: `Direct link provided. Open in your browser, complete the CAPTCHA, and click 'Verify Session' below.`,
        portalName,
        portalUrl: targetUrl,
        isHeadlessFallback: true
      };
    }
  } catch (err: any) {
    console.warn(`Local browser launch for ${portalId} encountered:`, err.message);
    return {
      success: true,
      message: `Open ${portalName} in your browser to verify, then click 'Verify Session' to resume.`,
      portalName,
      portalUrl: targetUrl,
      isHeadlessFallback: true
    };
  }
}

/**
 * Resumes automated scraping on a portal after operator confirms human verification
 */
export function verifyAndResumePortal(portalId: string) {
  // If browser context is still open, attempt graceful close
  if (activeHitlContexts.has(portalId)) {
    try {
      activeHitlContexts.get(portalId).close();
    } catch {}
    activeHitlContexts.delete(portalId);
  }

  updatePortalHealth(portalId, {
    status: 'online',
    last_error_message: null
  });
  return true;
}
