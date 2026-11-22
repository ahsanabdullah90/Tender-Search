import { Request, Response, Router } from 'express';
import { getValidatedBody, v, validateBody, type InferSchema } from './routeUtils.js';
import {
  getAllDomainTracks,
  saveDomainTrack,
  deleteDomainTrack,
  getKpiStats,
  getUnacknowledgedCorrigenda,
  acknowledgeCorrigendum
} from '../db/index.js';

const createTrackSchema = v.object({
  id: v.optional(v.string({ trim: true })),
  name: v.nonEmptyString('Track name is required'),
  positive_keywords: v.optional(v.array(v.string({ trim: true }))),
  negative_keywords: v.optional(v.array(v.string({ trim: true }))),
  is_active: v.optional(v.number({ integer: true, min: 0, max: 1 }))
});

export function createTracksRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const tracks = getAllDomainTracks();
    res.json(tracks);
  });

  router.post('/', validateBody(createTrackSchema), (req, res) => {
    const body = getValidatedBody<InferSchema<typeof createTrackSchema>>(res, req);
    const trackId = saveDomainTrack({
      id: body.id || undefined,
      name: body.name,
      positive_keywords: body.positive_keywords || [],
      negative_keywords: body.negative_keywords || [],
      is_active: body.is_active ?? 1
    });
    res.json({ success: true, id: trackId });
  });

  router.delete('/:id', (req, res) => {
    deleteDomainTrack(req.params.id);
    res.json({ success: true });
  });

  return router;
}

export const tracksRouter = createTracksRouter();

export const kpisRouter = Router();
kpisRouter.get('/', (_req, res) => {
  const stats = getKpiStats();
  res.json(stats);
});

export const corrigendaRouter = Router();
corrigendaRouter.get('/', (_req, res) => {
  const corrigenda = getUnacknowledgedCorrigenda();
  res.json(corrigenda);
});

const handleAckCorrigendum = (req: Request, res: Response) => {
  acknowledgeCorrigendum(req.params.id);
  res.json({ success: true });
};
corrigendaRouter.post('/:id/acknowledge', handleAckCorrigendum);
