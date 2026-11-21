import { Router } from 'express';
import { getAppSetting } from '../db/repositories/systemRepo.js';
import { getDocumentQueueCounts } from '../db/index.js';
import { ScanDepth, ScanStatus } from '../../shared/types.js';
import {
  startCrawlerScan,
  currentScanStatus,
  addProgressListener,
  removeProgressListener,
  mergeLiveDocQueueStatus,
  ScanProgressEventType
} from '../scrapers/crawlerEngine.js';

export const scanRouteDeps = {
  startCrawlerScan: (portalId?: string, awaitCompletion?: boolean, options?: { depth?: ScanDepth }) =>
    startCrawlerScan(portalId, awaitCompletion, options)
};

export const scanRouter = Router();

function withLiveDocQueue(status: ScanStatus): ScanStatus {
  let counts = {
    readyPending: 0,
    readyTenders: 0,
    awaitingScopePending: 0,
    awaitingScopeTenders: 0,
    totalPending: 0,
    processing: 0,
    processingTenders: 0,
    activeTenderIds: [] as string[]
  };
  try {
    counts = getDocumentQueueCounts();
  } catch {}
  return {
    ...status,
    docQueue: mergeLiveDocQueueStatus({
      isFetching: Boolean(status.docQueue?.isFetching || counts.processing > 0),
      readyPending: counts.readyPending,
      readyTenders: counts.readyTenders,
      awaitingScopePending: counts.awaitingScopePending,
      awaitingScopeTenders: counts.awaitingScopeTenders,
      totalPending: counts.totalPending,
      processing: counts.processing,
      processingTenders: counts.processingTenders,
      activeTenderIds: counts.activeTenderIds,
      completedInRun: status.docQueue?.completedInRun ?? 0,
      lastUpdatedAt: status.docQueue?.lastUpdatedAt ?? null
    })
  };
}

scanRouter.post('/start', async (req, res) => {
  const portalId = req.body?.portalId || (req.query?.portalId as string | undefined);
  const rawDepth = req.body?.depth || (req.query?.depth as string | undefined);
  const depth = rawDepth === 'deep' || rawDepth === 'quick' ? rawDepth : undefined;
  const status = await scanRouteDeps.startCrawlerScan(portalId, false, depth ? { depth } : undefined);
  res.json(status);
});

scanRouter.get('/status', (_req, res) => {
  const fullScanAt = getAppSetting('last_full_scan_at') || null;
  res.json(withLiveDocQueue({ ...currentScanStatus, lastFullScanTimestamp: fullScanAt }));
});

const handleScanSse = (req: any, res: any) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendStatus = (status: ScanStatus, eventType: ScanProgressEventType = 'scan_progress') => {
    res.write(`data: ${JSON.stringify({ type: eventType, status: withLiveDocQueue(status) })}\n\n`);
  };

  sendStatus(currentScanStatus, 'scan_progress');
  addProgressListener(sendStatus);

  req.on('close', () => {
    removeProgressListener(sendStatus);
  });
};

scanRouter.get('/stream', handleScanSse);
scanRouter.get('/progress', handleScanSse);
