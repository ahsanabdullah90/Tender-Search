import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import {
  launchLocalBrowserHITL,
  verifyPortalHITL,
  verifyAndResumePortal,
  defaultImportPlaywright,
  defaultPlaywrightManager
} from '../../src/server/scrapers/playwrightEngine.js';
import { initDatabase, getPortalHealthList, updatePortalHealth, SESSIONS_DIR } from '../../src/server/db/index.js';

describe('playwrightEngine & HITL orchestration', () => {
  beforeEach(() => {
    initDatabase();
    defaultPlaywrightManager.resetPorts();
  });

  afterEach(() => {
    defaultPlaywrightManager.resetPorts();
    vi.restoreAllMocks();
  });

  it('provides a graceful fallback message when headless or desktop browser is invoked', async () => {
    const result = await launchLocalBrowserHITL('epms_ppra');

    expect(result.success).toBe(true);
    expect(result.portalName).toBeDefined();
    expect(result.portalUrl).toContain('epms.ppra');
    expect(result.message).toBeDefined();
  });

  it('handles unknown portal fallback correctly with default URL', async () => {
    const result = await launchLocalBrowserHITL('unknown_test_portal_xyz');

    expect(result.success).toBe(true);
    expect(result.portalName).toBe('unknown_test_portal_xyz');
    expect(result.portalUrl).toBe('#');
    expect(result.message).toBeDefined();
  });

  it('resumes portal status to online and clears error message on verifyPortalHITL / verifyAndResumePortal', () => {
    updatePortalHealth('epms_ppra', {
      status: 'hitl_required',
      last_error_message: 'Verification challenge'
    });

    const before = getPortalHealthList().find(p => p.portal_id === 'epms_ppra');
    expect(before?.status).toBe('hitl_required');

    const success = verifyPortalHITL('epms_ppra');
    expect(success).toBe(true);

    const after = getPortalHealthList().find(p => p.portal_id === 'epms_ppra');
    expect(after?.status).toBe('online');
    expect(after?.last_error_message).toBeNull();

    updatePortalHealth('epms_ppra', { status: 'hitl_required', last_error_message: 'Challenge 2' });
    expect(verifyAndResumePortal('epms_ppra')).toBe(true);
    expect(getPortalHealthList().find(p => p.portal_id === 'epms_ppra')?.status).toBe('online');
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

    defaultPlaywrightManager.configurePorts({
      importPlaywright: vi.fn().mockResolvedValue(mockPlaywright),
      hasDisplay: () => true
    });

    const result = await launchLocalBrowserHITL('epms_ppra');
    expect(result.success).toBe(true);
    expect(result.isHeadlessFallback).toBe(false);
    expect(mockPage.goto).toHaveBeenCalled();

    // Calling launch again for same portal tests closing the previous browser context
    const result2 = await launchLocalBrowserHITL('epms_ppra');
    expect(result2.success).toBe(true);
    expect(mockBrowser.close).toHaveBeenCalled();

    // Simulate browser close event
    if (closeListener) (closeListener as () => void)();

    // Verify and resume with active browser context
    await launchLocalBrowserHITL('epms_ppra');
    verifyPortalHITL('epms_ppra');
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

    defaultPlaywrightManager.configurePorts({
      importPlaywright: vi.fn().mockResolvedValue(mockPlaywright),
      hasDisplay: () => true
    });

    const result = await launchLocalBrowserHITL('epms_ppra');
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

    defaultPlaywrightManager.configurePorts({
      importPlaywright: vi.fn().mockResolvedValue(mockPlaywright),
      hasDisplay: () => false
    });

    const result = await launchLocalBrowserHITL('epms_ppra');
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

  it('calls defaultImportPlaywright wrapper', async () => {
    const defaultRes = await defaultImportPlaywright();
    expect(defaultRes === null || typeof defaultRes === 'object').toBe(true);
  });
});
