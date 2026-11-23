import { Router } from 'express';
import {
  asyncHandler,
  getValidatedBody,
  getValidatedQuery,
  sendError,
  v,
  validateBody,
  validateQuery,
  type InferSchema,
  type Schema
} from './routeUtils.js';
import {
  getPortalHealthList,
  getPortalById,
  createPortal,
  deletePortal,
  cleanupDeletedPortalResources,
  updatePortalHealth,
  savePortalCredentials,
  getPortalAuthCredentials
} from '../db/index.js';
import { getDefaultRuntimeContext, type RuntimeContext } from '../runtime/context.js';
import { PORTAL_DEFINITIONS } from '../scrapers/portalList.js';
import { authenticatePortal } from '../scrapers/portalAuth.js';
import { healPortalConnection, getActivePortalsList } from '../scrapers/crawlerEngine.js';
import { sanitizeOriginUrl } from '../../shared/documentUtils.js';
import type { PortalHealth } from '../../shared/types.js';

const optionalExternalUrlOrBlank: Schema<string | undefined> = (input, field = 'url') => {
  if (input === undefined || input === null) {
    return { ok: true, value: undefined };
  }
  if (typeof input === 'string' && !input.trim()) {
    return { ok: true, value: undefined };
  }
  return v.externalHttpUrl()(input, field);
};

const createPortalSchema = v.object(
  {
    portal_id: v.optional(v.string({ trim: true })),
    portal_name: v.nonEmptyString('Portal name is required.'),
    tenders_url: optionalExternalUrlOrBlank,
    base_url: optionalExternalUrlOrBlank,
    login_url: optionalExternalUrlOrBlank,
    category: v.optional(v.string({ trim: true })),
    tier: v.optional(v.oneOf(['http', 'playwright'] as const)),
    access_mode: v.optional(v.string({ trim: true }))
  },
  {
    refine: val =>
      !val.tenders_url && !val.base_url ? 'Portal website or tenders URL is required.' : null
  }
);

const updatePortalSchema = v.object({
  portal_name: v.optional(v.nonEmptyString('Portal name must not be empty.')),
  category: v.optional(v.nonEmptyString('Category must not be empty.')),
  base_url: v.optional(v.externalHttpUrl()),
  tenders_url: v.optional(v.externalHttpUrl()),
  login_url: v.nullish(optionalExternalUrlOrBlank),
  tier: v.optional(v.oneOf(['http', 'playwright'] as const)),
  access_mode: v.optional(v.string({ trim: true })),
  verified_status: v.optional(v.string({ trim: true })),
  status: v.optional(
    v.oneOf(['online', 'scanning', 'hitl_required', 'selector_broken', 'error'] as const)
  ),
  last_error_message: v.nullish(v.string())
});

const deletePortalBodySchema = v.object({
  removeUnreviewedTenders: v.optional(v.boolean())
});

const deletePortalQuerySchema = v.object({
  removeUnreviewedTenders: v.optional(v.queryBoolean())
});

const healPortalSchema = v.object({
  baseUrl: v.optional(v.externalHttpUrl())
});

const portalCredentialsSchema = v.object({
  username: v.optional(v.string({ trim: true })),
  password: v.optional(v.string()),
  loginUrl: optionalExternalUrlOrBlank
});

export function createPortalsRouter(ctx: RuntimeContext = getDefaultRuntimeContext()): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const portals = getPortalHealthList();
    res.json(portals);
  });

  router.post('/', validateBody(createPortalSchema), asyncHandler(async (req, res) => {
    const body = getValidatedBody<InferSchema<typeof createPortalSchema>>(res, req);
    const effectiveUrl = (body.tenders_url || body.base_url)!;

    const portal = createPortal({
      portal_id: body.portal_id || undefined,
      portal_name: body.portal_name,
      tenders_url: effectiveUrl,
      base_url: body.base_url || effectiveUrl,
      category: body.category || undefined,
      tier: body.tier,
      access_mode: body.access_mode || undefined,
      login_url: body.login_url
    });
    ctx.scanState.syncTotalPortals();

    res.status(201).json({
      success: true,
      portal,
      message: `Added portal "${portal.portal_name}" successfully.`
    });
  }));

  router.delete(
    '/:portalId',
    validateQuery(deletePortalQuerySchema),
    validateBody(deletePortalBodySchema),
    (req, res) => {
      const { portalId } = req.params;
      const existing = getPortalById(portalId);
      if (!existing) {
        return sendError(res, 404, 'Portal not found.', 'NOT_FOUND');
      }

      const body = getValidatedBody<InferSchema<typeof deletePortalBodySchema>>(res, req);
      const query = getValidatedQuery<InferSchema<typeof deletePortalQuerySchema>>(res);
      const removeUnreviewedTenders = Boolean(
        body?.removeUnreviewedTenders ?? query?.removeUnreviewedTenders
      );

      const success = deletePortal(portalId);
      if (!success) {
        return sendError(res, 500, 'Failed to delete portal.', 'INTERNAL_ERROR');
      }

      const cleanup = cleanupDeletedPortalResources(portalId, { removeUnreviewedTenders });
      ctx.scanState.syncTotalPortals();

      res.json({
        success: true,
        portal_id: portalId,
        cancelledJobs: cleanup.cancelledJobs,
        removedTenders: cleanup.removedTenders,
        message: `Deleted portal "${existing.portal_name}" successfully.`
      });
    }
  );

  router.put('/:portalId', validateBody(updatePortalSchema), (req, res) => {
    const { portalId } = req.params;
    const existing = getPortalById(portalId);
    if (!existing) {
      return sendError(res, 404, 'Portal not found.', 'NOT_FOUND');
    }

    const body = getValidatedBody<InferSchema<typeof updatePortalSchema>>(res, req);
    const updates: Partial<PortalHealth> = {
      ...(body.portal_name !== undefined ? { portal_name: body.portal_name } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.base_url !== undefined ? { base_url: sanitizeOriginUrl(body.base_url, body.base_url) } : {}),
      ...(body.tenders_url !== undefined ? { tenders_url: body.tenders_url } : {}),
      ...(body.login_url !== undefined ? { login_url: body.login_url || (null as any) } : {}),
      ...(body.tier !== undefined ? { tier: body.tier } : {}),
      ...(body.access_mode !== undefined ? { access_mode: body.access_mode } : {}),
      ...(body.verified_status !== undefined ? { verified_status: body.verified_status } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.last_error_message !== undefined ? { last_error_message: body.last_error_message } : {})
    };

    // If operator updated tenders_url, derive clean base_url origin and clear stale offline/error states
    if (updates.tenders_url) {
      const parsedOrigin = sanitizeOriginUrl(updates.tenders_url);
      if (parsedOrigin && (!updates.base_url || updates.base_url === updates.tenders_url)) {
        updates.base_url = parsedOrigin;
      }
      if (updates.status === undefined) {
        updates.status = 'online';
      }
      if (updates.last_error_message === undefined) {
        updates.last_error_message = null;
      }
      if (updates.access_mode === undefined && existing.access_mode === 'offline_broken') {
        updates.access_mode = 'public';
      }
    }

    updatePortalHealth(portalId, updates);
    res.json({
      success: true,
      portal: getPortalById(portalId),
      message: 'Portal updated successfully'
    });
  });

  router.post('/:portalId/reset-default', (req, res) => {
    const { portalId } = req.params;
    const canonicalDef = PORTAL_DEFINITIONS.find(p => p.id === portalId);
    if (!canonicalDef) {
      return sendError(res, 404, 'Default definition not found for this portal', 'NOT_FOUND');
    }

    const nextStatus = canonicalDef.accessMode === 'login_required' ? 'hitl_required' : 'online';
    updatePortalHealth(portalId, {
      portal_name: canonicalDef.name,
      base_url: canonicalDef.baseUrl,
      tenders_url: canonicalDef.tendersUrl,
      login_url: canonicalDef.loginUrl ?? undefined,
      access_mode: canonicalDef.accessMode,
      tier: canonicalDef.tier,
      verified_status: canonicalDef.verifiedStatus,
      status: nextStatus,
      last_error_message: null,
      consecutive_zero_yields: 0
    });

    res.json({
      success: true,
      portal_name: canonicalDef.name,
      base_url: canonicalDef.baseUrl,
      tenders_url: canonicalDef.tendersUrl,
      status: nextStatus,
      message: `Reset ${canonicalDef.name} to official default URL`
    });
  });

  router.post('/:portalId/heal', validateBody(healPortalSchema), asyncHandler(async (req, res) => {
    const { portalId } = req.params;
    const portals = getActivePortalsList(portalId);
    if (portals.length === 0) {
      return sendError(res, 404, 'Portal not found', 'NOT_FOUND');
    }

    const { baseUrl } = getValidatedBody<InferSchema<typeof healPortalSchema>>(res, req);
    const targetPortal = { ...portals[0] };
    if (baseUrl) {
      targetPortal.baseUrl = baseUrl;
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
  }));

  router.post('/:portalId/hitl-launch', asyncHandler(async (req, res) => {
    const result = await ctx.playwright.launchLocalBrowserHITL(req.params.portalId);
    res.json(result);
  }));

  router.post('/:portalId/hitl-verify', (req, res) => {
    ctx.playwright.verifyPortalHITL(req.params.portalId);
    res.json({ success: true });
  });

  router.get('/:portalId/credentials', (req, res) => {
    const creds = getPortalAuthCredentials(req.params.portalId);
    if (!creds) {
      return sendError(res, 404, 'Portal not found', 'NOT_FOUND');
    }
    res.json({
      username: creds.username || '',
      loginUrl: creds.loginUrl || '',
      hasPassword: Boolean(creds.password)
    });
  });

  router.post('/:portalId/credentials', validateBody(portalCredentialsSchema), asyncHandler(async (req, res) => {
    const existing = getPortalById(req.params.portalId);
    if (!existing) {
      return sendError(res, 404, 'Portal not found', 'NOT_FOUND');
    }

    const { username, password, loginUrl } =
      getValidatedBody<InferSchema<typeof portalCredentialsSchema>>(res, req);
    savePortalCredentials(req.params.portalId, { username, password, loginUrl });

    if (username && password) {
      const authResult = await authenticatePortal(req.params.portalId, username, password, loginUrl);
      return res.json(authResult);
    }

    res.json({ success: true, message: 'Portal credentials saved successfully.' });
  }));

  return router;
}

export const portalsRouter = createPortalsRouter();
