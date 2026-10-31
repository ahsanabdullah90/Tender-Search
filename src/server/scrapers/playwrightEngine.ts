import path from 'path';
import fs from 'fs';
import { updatePortalHealth } from '../db.js';
import { PORTAL_DEFINITIONS } from './portalList.js';

const SESSIONS_DIR = path.resolve(process.cwd(), 'data', 'sessions');

export interface HitlLaunchResult {
  success: boolean;
  message: string;
  portalName: string;
  portalUrl: string;
  isHeadlessFallback?: boolean;
}

/**
 * Launches the local Playwright browser window on the operator's desktop (headless: false)
 * for CAPTCHA / Cloudflare Turnstile / 2FA resolution.
 */
export async function launchLocalBrowserHITL(portalId: string): Promise<HitlLaunchResult> {
  const portal = PORTAL_DEFINITIONS.find(p => p.id === portalId);
  if (!portal) {
    return { success: false, message: 'Portal not found', portalName: portalId, portalUrl: '#' };
  }

  const sessionPath = path.resolve(SESSIONS_DIR, portalId);
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  try {
    // Attempt dynamic import of playwright if installed locally
    const modName = 'playwright';
    const playwright: any = await (Function('m', 'return import(m)')(modName) as Promise<any>).catch(() => null);

    if (playwright && process.env.DISPLAY || process.platform === 'win32' || process.platform === 'darwin') {
      const browser = await playwright.chromium.launchPersistentContext(sessionPath, {
        headless: false,
        viewport: { width: 1280, height: 800 }
      });

      const page = await browser.newPage();
      await page.goto(portal.tendersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Return success indicating window opened on the user's laptop
      return {
        success: true,
        message: `Local browser window opened for ${portal.name}. Complete the verification and close the browser.`,
        portalName: portal.name,
        portalUrl: portal.tendersUrl,
        isHeadlessFallback: false
      };
    } else {
      // In cloud sandbox or headless server without GUI display:
      // Provide direct portal launch link and instant verification
      return {
        success: true,
        message: `Direct link provided. Open in your browser, complete the CAPTCHA, and click 'Verify Session' below.`,
        portalName: portal.name,
        portalUrl: portal.tendersUrl,
        isHeadlessFallback: true
      };
    }
  } catch (err: any) {
    console.warn(`Local browser launch for ${portalId} encountered:`, err.message);
    return {
      success: true,
      message: `Open ${portal.name} in your browser to verify, then click 'Verify Session' to resume.`,
      portalName: portal.name,
      portalUrl: portal.tendersUrl,
      isHeadlessFallback: true
    };
  }
}

/**
 * Resumes automated scraping on a portal after operator confirms human verification
 */
export function verifyAndResumePortal(portalId: string) {
  updatePortalHealth(portalId, {
    status: 'online',
    last_error_message: null
  });
  return true;
}
