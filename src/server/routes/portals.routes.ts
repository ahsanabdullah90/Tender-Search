import { Router } from 'express';
import {
  getPortalHealthList,
  updatePortalHealth,
  savePortalCredentials,
  getPortalAuthCredentials
} from '../db.js';
import { PORTAL_DEFINITIONS } from '../scrapers/portalList.js';
import { authenticatePortal } from '../scrapers/portalAuth.js';
import { healPortalConnection, getActivePortalsList } from '../scrapers/crawlerEngine.js';
import { launchLocalBrowserHITL, verifyAndResumePortal } from '../scrapers/playwrightEngine.js';

export const portalsRouter = Router();

portalsRouter.get('/', (req, res) => {
  const portals = getPortalHealthList();
  res.json(portals);
});

portalsRouter.put('/:portalId', (req, res) => {
  const { portalId } = req.params;
  const updates: any = {};
  for (const key of ['portal_name', 'base_url', 'tenders_url', 'tier', 'access_mode', 'verified_status', 'status', 'last_error_message']) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  // Enforce strict origin normalization on base_url (Rule 6: never store file paths in base_url)
  if (typeof updates.base_url === 'string' && updates.base_url.trim()) {
    try {
      updates.base_url = new URL(updates.base_url.trim()).origin;
    } catch {}
  }

  // If operator updated tenders_url, derive clean base_url origin and clear stale offline/error states
  if (typeof updates.tenders_url === 'string' && updates.tenders_url.trim()) {
    try {
      const parsedOrigin = new URL(updates.tenders_url.trim()).origin;
      if (!updates.base_url || updates.base_url === updates.tenders_url) {
        updates.base_url = parsedOrigin;
      }
    } catch {}
    if (updates.status === undefined) {
      updates.status = 'online';
    }
    if (updates.last_error_message === undefined) {
      updates.last_error_message = null;
    }
    if (updates.access_mode === undefined) {
      const existing = getPortalHealthList().find(p => p.portal_id === portalId);
      if (existing && existing.access_mode === 'offline_broken') {
        updates.access_mode = 'public';
      }
    }
  }

  updatePortalHealth(portalId, updates);
  res.json({ success: true, message: 'Portal updated successfully' });
});

portalsRouter.post('/:portalId/reset-default', (req, res) => {
  const { portalId } = req.params;
  const canonicalDef = PORTAL_DEFINITIONS.find(p => p.id === portalId);
  if (!canonicalDef) {
    return res.status(404).json({ success: false, message: 'Default definition not found for this portal' });
  }

  updatePortalHealth(portalId, {
    base_url: canonicalDef.baseUrl,
    tenders_url: canonicalDef.tendersUrl,
    login_url: canonicalDef.loginUrl ?? undefined,
    access_mode: canonicalDef.accessMode,
    tier: canonicalDef.tier,
    verified_status: canonicalDef.verifiedStatus,
    status: canonicalDef.accessMode === 'login_required' ? 'hitl_required' : 'online',
    last_error_message: null,
    consecutive_zero_yields: 0
  });

  res.json({
    success: true,
    portal_name: canonicalDef.name,
    base_url: canonicalDef.baseUrl,
    tenders_url: canonicalDef.tendersUrl,
    message: `Reset ${canonicalDef.name} to official default URL`
  });
});

portalsRouter.post('/:portalId/heal', async (req, res) => {
  try {
    const { portalId } = req.params;
    const portals = getActivePortalsList(portalId);
    if (portals.length === 0) {
      return res.status(404).json({ success: false, message: 'Portal not found' });
    }
    const targetPortal = { ...portals[0] };
    if (typeof req.body?.baseUrl === 'string' && req.body.baseUrl.trim()) {
      targetPortal.baseUrl = req.body.baseUrl.trim();
    }

    const healed = await healPortalConnection(targetPortal);
    if (!healed) {
      return res.json({
        success: false,
        message: 'Could not automatically locate an active tenders page from this website.'
      });
    }

    res.json({
      success: true,
      baseUrl: healed.healedPortal.baseUrl,
      tendersUrl: healed.healedPortal.tendersUrl,
      itemsFound: healed.result.items.length,
      message: `Discovered tender page (${healed.result.items.length} listings found)`
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || 'Auto-discovery failed' });
  }
});

portalsRouter.post('/:portalId/hitl-launch', async (req, res) => {
  try {
    const result = await launchLocalBrowserHITL(req.params.portalId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

portalsRouter.post('/:portalId/hitl-verify', (req, res) => {
  verifyAndResumePortal(req.params.portalId);
  res.json({ success: true });
});

portalsRouter.get('/:portalId/credentials', (req, res) => {
  const creds = getPortalAuthCredentials(req.params.portalId);
  if (!creds) {
    return res.status(404).json({ success: false, message: 'Portal not found' });
  }
  res.json({
    username: creds.username || '',
    loginUrl: creds.loginUrl || '',
    hasPassword: Boolean(creds.password)
  });
});

portalsRouter.post('/:portalId/credentials', async (req, res) => {
  try {
    const { username, password, loginUrl } = req.body;
    savePortalCredentials(req.params.portalId, { username, password, loginUrl });

    if (username && password) {
      const authResult = await authenticatePortal(req.params.portalId, username, password, loginUrl);
      return res.json(authResult);
    }

    res.json({ success: true, message: 'Portal credentials saved successfully.' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});
