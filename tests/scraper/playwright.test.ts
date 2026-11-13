import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { launchLocalBrowserHITL, verifyAndResumePortal, playwrightDeps } from '../../src/server/scrapers/playwrightEngine.js';
import { initDatabase, getPortalHealthList, updatePortalHealth, SESSIONS_DIR } from '../../src/server/db/index.js';

describe('playwrightEngine & HITL orchestration', () => {
  let originalImport: any;

  beforeEach(() => {
    initDatabase();
    originalImport = playwrightDeps.importPlaywright;
  });

  afterEach(() => {
    playwrightDeps.importPlaywright = originalImport;
    vi.restoreAllMocks();
  });

  it('provides a graceful fallback message when headless or desktop browser is invoked', async () => {
    const result = await launchLocalBrowserHITL('epads');

    expect(result.success).toBe(true);
    expect(result.portalName).toBeDefined();
    expect(result.portalUrl).toContain('epads');
    expect(result.message).toBeDefined();
  });

  it('handles unknown portal fallback correctly with default URL', async () => {
    const result = await launchLocalBrowserHITL('unknown_test_portal_xyz');

    expect(result.success).toBe(true);
    expect(result.portalName).toBe('unknown_test_portal_xyz');
    expect(result.portalUrl).toBe('#');
    expect(result.message).toBeDefined();
  });

  it('resumes portal status to online and clears error message on verifyAndResumePortal', () => {
    updatePortalHealth('epads', {
      status: 'hitl_required',
      last_error_message: 'Verification challenge'
    });

    const before = getPortalHealthList().find(p => p.portal_id === 'epads');
    expect(before?.status).toBe('hitl_required');

    const success = verifyAndResumePortal('epads');
    expect(success).toBe(true);

    const after = getPortalHealthList().find(p => p.portal_id === 'epads');
    expect(after?.status).toBe('online');
    expect(after?.last_error_message).toBeNull();
  });

  it('launches local browser window when Playwright is available and handles close event', async () => {
    let closeListener: (() => void) | null = null;
    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined)
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'close') closeListener = cb;
      }),
      close: vi.fn().mockResolvedValue(undefined)
    };
    const mockPlaywright = {
      chromium: {
        launchPersistentContext: vi.fn().mockResolvedValue(mockBrowser)
      }
    };

    playwrightDeps.importPlaywright = vi.fn().mockResolvedValue(mockPlaywright);
    vi.spyOn(playwrightDeps, 'hasDisplay').mockReturnValue(true);

    const result = await launchLocalBrowserHITL('epads');
    expect(result.success).toBe(true);
    expect(result.isHeadlessFallback).toBe(false);
    expect(mockPage.goto).toHaveBeenCalled();

    // Calling launch again for same portal tests closing the previous browser context
    const result2 = await launchLocalBrowserHITL('epads');
    expect(result2.success).toBe(true);
    expect(mockBrowser.close).toHaveBeenCalled();

    // Simulate browser close event
    if (closeListener) (closeListener as () => void)();

    // Verify and resume with active browser context
    await launchLocalBrowserHITL('epads');
    verifyAndResumePortal('epads');
  });

  it('handles error gracefully when browser close or page goto throws', async () => {
    const mockBrowser = {
      newPage: vi.fn().mockRejectedValue(new Error('Navigation timeout')),
      on: vi.fn(),
      close: vi.fn().mockRejectedValue(new Error('Close error'))
    };
    const mockPlaywright = {
      chromium: {
        launchPersistentContext: vi.fn().mockResolvedValue(mockBrowser)
      }
    };

    playwrightDeps.importPlaywright = vi.fn().mockResolvedValue(mockPlaywright);
    vi.spyOn(playwrightDeps, 'hasDisplay').mockReturnValue(true);

    const result = await launchLocalBrowserHITL('epads');
    expect(result.success).toBe(true);
    expect(result.isHeadlessFallback).toBe(true);
    expect(result.message).toContain('Open Federal PPRA');
  });

  it('returns direct link fallback when running in a headless environment without display', async () => {
    const mockPlaywright = {
      chromium: {
        launchPersistentContext: vi.fn()
      }
    };

    playwrightDeps.importPlaywright = vi.fn().mockResolvedValue(mockPlaywright);
    vi.spyOn(playwrightDeps, 'hasDisplay').mockReturnValue(false);

    const result = await launchLocalBrowserHITL('epads');
    expect(result.success).toBe(true);
    expect(result.isHeadlessFallback).toBe(true);
    expect(result.message).toContain('Direct link provided');
    expect(mockPlaywright.chromium.launchPersistentContext).not.toHaveBeenCalled();
  });

  it('creates SESSIONS_DIR if it does not exist on module load', async () => {
    if (fs.existsSync(SESSIONS_DIR)) {
      fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
    }
    vi.resetModules();
    await import('../../src/server/scrapers/playwrightEngine.js');
    expect(fs.existsSync(SESSIONS_DIR)).toBe(true);
  });

  it('calls default playwrightDeps.importPlaywright wrapper', async () => {
    const defaultRes = await originalImport();
    expect(defaultRes === null || typeof defaultRes === 'object').toBe(true);
  });
});
