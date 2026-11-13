import { Router } from 'express';
import { getAppSetting } from '../db/repositories/systemRepo.js';
import { ScanDepth } from '../../shared/types.js';
import {
  startCrawlerScan,
  currentScanStatus,
  addProgressListener,
  removeProgressListener
} from '../scrapers/crawlerEngine.js';

export const scanRouteDeps = {
  startCrawlerScan: (portalId?: string, awaitCompletion?: boolean, options?: { depth?: ScanDepth }) =>
    startCrawlerScan(portalId, awaitCompletion, options)
};

export const scanRouter = Router();

scanRouter.post('/start', async (req, res) => {
  const portalId = req.body?.portalId || (req.query?.portalId as string | undefined);
  const rawDepth = req.body?.depth || (req.query?.depth as string | undefined);
  const depth = rawDepth === 'deep' || rawDepth === 'quick' ? rawDepth : undefined;
  const status = await scanRouteDeps.startCrawlerScan(portalId, false, depth ? { depth } : undefined);
  res.json(status);
});

scanRouter.get('/status', (_req, res) => {
  const fullScanAt = getAppSetting('last_full_scan_at') || null;
  res.json({ ...currentScanStatus, lastFullScanTimestamp: fullScanAt });
});

const handleScanSse = (req: any, res: any) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendStatus = (status: any) => {
    res.write(`data: ${JSON.stringify({ type: 'scan_progress', status })}\n\n`);
  };

  sendStatus(currentScanStatus);
  addProgressListener(sendStatus);

  req.on('close', () => {
    removeProgressListener(sendStatus);
  });
};

scanRouter.get('/stream', handleScanSse);
scanRouter.get('/progress', handleScanSse);
