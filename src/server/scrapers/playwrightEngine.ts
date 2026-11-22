import path from 'path';
import fs from 'fs';
import { updatePortalHealth, getPortalHealthList, SESSIONS_DIR } from '../db/index.js';
import { PORTAL_DEFINITIONS } from './portalList.js';

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

export interface PlaywrightPorts {
  importPlaywright: () => Promise<any>;
  hasDisplay: () => boolean;
}

export const defaultImportPlaywright = async (): Promise<any> => {
  return (Function('m', 'return import(m)')('playwright') as Promise<any>).catch(() => null);
};

export const defaultHasDisplay = (): boolean => {
  return Boolean(
    process.env.DISPLAY ||
    process.env.WAYLAND_DISPLAY ||
    process.platform === 'win32' ||
    process.platform === 'darwin'
  );
};

function createDefaultPlaywrightPorts(): PlaywrightPorts {
  return {
    importPlaywright: defaultImportPlaywright,
    hasDisplay: defaultHasDisplay
  };
}

function filterDefinedPlaywrightPorts(overrides?: Partial<PlaywrightPorts>): Partial<PlaywrightPorts> {
  if (!overrides) return {};
  return {
    ...(overrides.importPlaywright !== undefined ? { importPlaywright: overrides.importPlaywright } : {}),
    ...(overrides.hasDisplay !== undefined ? { hasDisplay: overrides.hasDisplay } : {})
  };
}

export class PlaywrightManager {
  // Active HITL browser contexts tracked to prevent multiple hanging processes
  private activeHitlContexts = new Map<string, any>();
  private readonly initialPorts?: Partial<PlaywrightPorts>;
  private ports: PlaywrightPorts;

  constructor(initialPorts?: Partial<PlaywrightPorts>) {
    this.initialPorts = initialPorts;
    this.ports = {
      ...createDefaultPlaywrightPorts(),
      ...filterDefinedPlaywrightPorts(initialPorts)
    };
  }

  configurePorts(overrides: Partial<PlaywrightPorts>): () => void {
    const previous: PlaywrightPorts = { ...this.ports };
    this.ports = {
      ...this.ports,
      ...filterDefinedPlaywrightPorts(overrides)
    };
    return () => {
      this.ports = previous;
    };
  }

  resetPorts(): void {
    this.ports = {
      ...createDefaultPlaywrightPorts(),
      ...filterDefinedPlaywrightPorts(this.initialPorts)
    };
  }

  getPorts(): Readonly<PlaywrightPorts> {
    return { ...this.ports };
  }

  private resolvePorts(portOverrides?: Partial<PlaywrightPorts>): PlaywrightPorts {
    if (!portOverrides) return this.ports;
    return {
      ...this.ports,
      ...filterDefinedPlaywrightPorts(portOverrides)
    };
  }

  async launchHeadlessChromium(portOverrides?: Partial<PlaywrightPorts>): Promise<any> {
    const effectivePorts = this.resolvePorts(portOverrides);
    const playwright: any = await effectivePorts.importPlaywright();
    if (!playwright?.chromium) {
      throw new Error('Playwright Chromium not available');
    }
    return playwright.chromium
      .launch({ headless: true, channel: 'chromium' })
      .catch(() => playwright.chromium.launch({ headless: true }))
      .catch(() => playwright.chromium.launch({ headless: true, channel: 'msedge' }));
  }

  /**
   * Launches the local Playwright browser window on the operator's desktop (headless: false)
   * for CAPTCHA / Cloudflare Turnstile / 2FA resolution.
   */
  async launchLocalBrowserHITL(
    portalId: string,
    portOverrides?: Partial<PlaywrightPorts>
  ): Promise<HitlLaunchResult> {
    const effectivePorts = this.resolvePorts(portOverrides);
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
      const playwright: any = await effectivePorts.importPlaywright();

      if (playwright && effectivePorts.hasDisplay()) {
        // Close any already open context for this portal
        if (this.activeHitlContexts.has(portalId)) {
          try {
            await this.activeHitlContexts.get(portalId).close();
          } catch {}
          this.activeHitlContexts.delete(portalId);
        }

        const browser = await playwright.chromium.launchPersistentContext(sessionPath, {
          headless: false,
          viewport: { width: 1280, height: 800 },
          ignoreHTTPSErrors: true
        });

        this.activeHitlContexts.set(portalId, browser);
        browser.on('close', () => {
          if (this.activeHitlContexts.get(portalId) === browser) {
            this.activeHitlContexts.delete(portalId);
          }
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
  verifyPortalHITL(portalId: string): boolean {
    if (this.activeHitlContexts.has(portalId)) {
      const ctx = this.activeHitlContexts.get(portalId);
      this.activeHitlContexts.delete(portalId);
      try {
        Promise.resolve(ctx?.close?.()).catch(() => {});
      } catch {}
    }

    updatePortalHealth(portalId, {
      status: 'online',
      last_error_message: null
    });
    return true;
  }

  async closeAllHitlSessions(): Promise<void> {
    const entries = Array.from(this.activeHitlContexts.entries());
    this.activeHitlContexts.clear();
    await Promise.allSettled(
      entries.map(async ([, ctx]) => {
        try {
          await ctx?.close?.();
        } catch {}
      })
    );
  }
}

export const defaultPlaywrightManager = new PlaywrightManager();

export async function launchHeadlessChromium(ports?: Partial<PlaywrightPorts>): Promise<any> {
  return defaultPlaywrightManager.launchHeadlessChromium(ports);
}

export async function launchLocalBrowserHITL(
  portalId: string,
  ports?: Partial<PlaywrightPorts>
): Promise<HitlLaunchResult> {
  return defaultPlaywrightManager.launchLocalBrowserHITL(portalId, ports);
}

export function verifyPortalHITL(portalId: string): boolean {
  return defaultPlaywrightManager.verifyPortalHITL(portalId);
}

/**
 * Backward-compatible alias preserved for existing callers during Wave 1 -> Wave 2 transition.
 */
export function verifyAndResumePortal(portalId: string): boolean {
  return defaultPlaywrightManager.verifyPortalHITL(portalId);
}
