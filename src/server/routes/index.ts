import { Router } from 'express';
import { getDefaultRuntimeContext, type RuntimeContext } from '../runtime/context.js';
import { sendError } from './httpErrors.js';
import { createTendersRouter } from './tenders.routes.js';
import { createPortalsRouter } from './portals.routes.js';
import { createTracksRouter, kpisRouter, corrigendaRouter } from './tracks.routes.js';
import { createScanRouter } from './scan.routes.js';
import { createSystemRouter } from './system.routes.js';

export function createApiRouter(ctx: RuntimeContext = getDefaultRuntimeContext()): Router {
  const router = Router();

  router.use('/tenders', createTendersRouter(ctx));
  router.use('/portals', createPortalsRouter(ctx));
  router.use('/tracks', createTracksRouter());
  router.use('/kpis', kpisRouter);
  router.use('/corrigenda', corrigendaRouter);
  router.use('/scan', createScanRouter(ctx));
  router.use('/', createSystemRouter(ctx));

  router.use((_req, res) => {
    sendError(res, 404, 'Endpoint not found', 'NOT_FOUND');
  });

  return router;
}

export const apiRouter = createApiRouter();
