import { describe, it, expect, beforeEach } from 'vitest';
import { launchLocalBrowserHITL, verifyAndResumePortal } from '../../src/server/scrapers/playwrightEngine.js';
import { initDatabase, getPortalHealthList, updatePortalHealth } from '../../src/server/db.js';

describe('playwrightEngine & HITL orchestration', () => {
  beforeEach(() => {
    initDatabase();
  });

  it('provides a graceful fallback message when headless or desktop browser is invoked', async () => {
    const result = await launchLocalBrowserHITL('epads');

    expect(result.success).toBe(true);
    expect(result.portalName).toBeDefined();
    expect(result.portalUrl).toContain('ppra');
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
});
