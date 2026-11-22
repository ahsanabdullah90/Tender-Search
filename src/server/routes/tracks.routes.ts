import { Request, Response, Router } from 'express';
import {
  getAllDomainTracks,
  saveDomainTrack,
  deleteDomainTrack,
  getKpiStats,
  getUnacknowledgedCorrigenda,
  acknowledgeCorrigendum
} from '../db/index.js';

export const tracksRouter = Router();

tracksRouter.get('/', (_req, res) => {
  const tracks = getAllDomainTracks();
  res.json(tracks);
});

tracksRouter.post('/', (req, res) => {
  const { name, positive_keywords, negative_keywords, id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Track name is required' });
  const trackId = saveDomainTrack({
    id,
    name: name.trim(),
    positive_keywords: positive_keywords || [],
    negative_keywords: negative_keywords || [],
    is_active: 1
  });
  res.json({ success: true, id: trackId });
});

tracksRouter.delete('/:id', (req, res) => {
  deleteDomainTrack(req.params.id);
  res.json({ success: true });
});

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
