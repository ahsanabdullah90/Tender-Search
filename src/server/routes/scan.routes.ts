import { Request, Response, Router } from 'express';
import {
  asyncHandler,
  getValidatedBody,
  getValidatedQuery,
  v,
  validateBody,
  validateQuery,
  type InferSchema
} from './routeUtils.js';
import { getDocumentQueueCounts } from '../db/index.js';
import { getDefaultRuntimeContext, type RuntimeContext } from '../runtime/context.js';
import { ScanStatus } from '../../shared/types.js';
import { ScanProgressEventType } from '../scrapers/crawlerEngine.js';

const startScanBodySchema = v.object({
  portalId: v.nullish(v.string({ trim: true })),
  depth: v.optional(v.oneOf(['quick', 'deep'] as const))
});

const startScanQuerySchema = v.object({
  portalId: v.optional(v.string({ trim: true })),
  depth: v.optional(v.oneOf(['quick', 'deep'] as const))
});

export function createScanRouter(ctx: RuntimeContext = getDefaultRuntimeContext()): Router {
  const router = Router();

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
      docQueue: ctx.scanState.mergeLiveDocQueueStatus({
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

  router.post(
    '/start',
    validateQuery(startScanQuerySchema),
    validateBody(startScanBodySchema),
    asyncHandler(async (req, res) => {
      const body = getValidatedBody<InferSchema<typeof startScanBodySchema>>(res, req);
      const query = getValidatedQuery<InferSchema<typeof startScanQuerySchema>>(res);
      const portalId = (body.portalId || query.portalId || '').trim() || undefined;
      const depth = body.depth ?? query.depth;
      const status = await ctx.startCrawlerScan(portalId, false, depth ? { depth } : undefined);
      res.json(status);
    })
  );

  router.get('/status', (_req, res) => {
    res.json(withLiveDocQueue(ctx.scanState.getSnapshot()));
  });

  const handleScanSse = (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let unsubscribe: () => void = () => {};
    const sendStatus = (status: ScanStatus, eventType: ScanProgressEventType = 'scan_progress') => {
      try {
        res.write(`data: ${JSON.stringify({ type: eventType, status: withLiveDocQueue(status) })}\n\n`);
      } catch {
        unsubscribe();
      }
    };

    sendStatus(ctx.scanState.getSnapshot(), 'scan_progress');
    unsubscribe = ctx.scanState.subscribe(sendStatus);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 30_000);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  };

  router.get('/stream', handleScanSse);
  router.get('/progress', handleScanSse);

  return router;
}

export const scanRouter = createScanRouter();
