import { Router } from 'express';
import { tendersRouter } from './tenders.routes.js';
import { portalsRouter } from './portals.routes.js';
import { tracksRouter, kpisRouter, corrigendaRouter } from './tracks.routes.js';
import { scanRouter } from './scan.routes.js';
import { systemRouter } from './system.routes.js';

export const apiRouter = Router();

apiRouter.use('/tenders', tendersRouter);
apiRouter.use('/portals', portalsRouter);
apiRouter.use('/tracks', tracksRouter);
apiRouter.use('/kpis', kpisRouter);
apiRouter.use('/corrigenda', corrigendaRouter);
apiRouter.use('/scan', scanRouter);
apiRouter.use('/', systemRouter);

apiRouter.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});
