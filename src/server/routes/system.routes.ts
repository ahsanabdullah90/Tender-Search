import { Request, Response, Router } from 'express';
import {
  asyncHandler,
  decodeBase64Payload,
  getValidatedBody,
  getValidatedQuery,
  maskApiKey,
  sendError,
  v,
  validateBody,
  validateQuery,
  type InferSchema,
  type Schema
} from './routeUtils.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import {
  clearAllTenders,
  countTenderEmbeddingsBySpace,
  getAllTenders,
  listBackups,
  backupNow,
  getStorageStats,
  pruneDossiersForPassed,
  getGeminiApiKey,
  setAppSetting,
  getAlertsDigest,
  getDigestSettings,
  updateDigestSettings,
  DOSSIERS_DIR
} from '../db/index.js';
import { getDefaultRuntimeContext, type RuntimeContext } from '../runtime/context.js';
import { CANDIDATE_MODELS, extractTenderFromImage } from '../services/ocrService.js';
import { getEmbeddingEngineStatus } from '../services/embeddingService.js';
import { listSessionLogs, readSessionLog, getCurrentSessionFilename } from '../services/logger.js';
import { getRetentionStatus, runRetentionCycle } from '../services/retention.js';
import { reconcileDossiers } from '../services/dossierStore.js';
import { getIngestBudgetSettings, updateIngestBudgetSettings } from '../services/ingestBudget.js';

const clearTendersSchema = v.object({
  unreviewedOnly: v.optional(v.boolean())
});

const exportCsvQuerySchema = v.object({
  track: v.optional(v.string()),
  portal: v.optional(v.string()),
  portalId: v.optional(v.string()),
  status: v.optional(v.string()),
  search: v.optional(v.string()),
  bookmarkedOnly: v.optional(v.queryBoolean()),
  corrigendumOnly: v.optional(v.queryBoolean()),
  scope: v.optional(v.oneOf(['all', 'inbox', 'pipeline'] as const))
});

const ingestBudgetsSchema = v.object({
  upfrontTimeBudgetSec: v.optional(v.number({ integer: true, min: 0, max: 3600 })),
  maxFileMb: v.optional(v.number({ integer: true, min: 1, max: 200 })),
  visionCallsPerScan: v.optional(v.number({ integer: true, min: 0, max: 500 })),
  visionCallsPerDay: v.optional(v.number({ integer: true, min: 0, max: 5000 })),
  aiTextCallsPerDay: v.optional(v.number({ integer: true, min: 0, max: 5000 }))
});

const aiConfigSchema = v.object({
  apiKey: v.nullish(v.string())
});

const extractFileSchema = v.object(
  {
    base64Data: v.optional(v.nonEmptyString()),
    dataBase64: v.optional(v.nonEmptyString()),
    mimeType: v.optional(v.string({ trim: true }))
  },
  {
    refine: val =>
      !val.base64Data && !val.dataBase64
        ? [{ field: 'base64Data', message: 'base64Data is required' }]
        : null
  }
);

const logFileQuerySchema = v.object({
  download: v.optional(v.queryBoolean())
});

const dryRunQuerySchema = v.object({
  dryRun: v.optional(v.queryBoolean())
});

const dryRunBodySchema = v.object({
  dryRun: v.optional(v.boolean())
});

const retentionSettingsSchema = v.object({
  autoClean: v.optional(v.boolean()),
  graceDays: v.optional(v.number({ integer: true, min: 1, max: 365 })),
  passedDays: v.optional(v.number({ integer: true, min: 1, max: 365 }))
});

const digestQuerySchema = v.object({
  hours: v.optional(v.number({ coerce: true, min: 1, max: 336 }))
});

const optionalWebhookUrlSchema: Schema<string | undefined> = (input, field = 'webhookUrl') => {
  if (input === undefined) return { ok: true, value: undefined };
  if (typeof input !== 'string') {
    return { ok: false, issues: [{ field, message: `${field} must be a string` }] };
  }
  if (!input.trim()) {
    return { ok: true, value: '' };
  }
  return v.externalHttpUrl()(input, field);
};

const digestSettingsSchema = v.object({
  enabled: v.optional(v.boolean()),
  webhookUrl: optionalWebhookUrlSchema,
  withinHours: v.optional(v.number({ min: 1, max: 336 }))
});

export function setShutdownHandler(handler: (() => void) | null): void {
  getDefaultRuntimeContext().setShutdownHandler(handler);
}

function tokensMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export function createSystemRouter(ctx: RuntimeContext = getDefaultRuntimeContext()): Router {
  const router = Router();

  // 0. Dossier Static File Serving with Path-Traversal Guard
  router.get('/dossiers/:tenderId/:filename', (req, res) => {
    const { tenderId, filename } = req.params;
    const tenderDir = path.resolve(DOSSIERS_DIR, tenderId);
    const filePath = path.resolve(tenderDir, filename);

    if (
      path.basename(filename) !== filename ||
      path.basename(tenderId) !== tenderId ||
      !filePath.startsWith(tenderDir + path.sep)
    ) {
      return res.status(400).send('Invalid dossier path');
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('Dossier file not found on disk');
    }

    if (req.query?.download === '1' || req.query?.download === 'true') {
      return res.download(filePath, filename);
    }

    res.sendFile(filePath);
  });

  // 1. Tenders Wipe / Clear
  router.post('/tenders/clear', validateBody(clearTendersSchema), (req, res) => {
    const body = getValidatedBody<InferSchema<typeof clearTendersSchema>>(res, req);
    const unreviewedOnly = body.unreviewedOnly === true;
    clearAllTenders(unreviewedOnly);
    res.json({
      success: true,
      message: unreviewedOnly
        ? 'Unreviewed opportunities cleared. Active bid pursuits and bookmarks preserved.'
        : 'All tenders wiped. Database is now 100% clean.'
    });
  });

  // 2. Export Tenders to CSV
  router.get('/export/csv', validateQuery(exportCsvQuerySchema), (_req, res) => {
    const query = getValidatedQuery<InferSchema<typeof exportCsvQuerySchema>>(res);
    let tenders = getAllTenders({
      track: query.track,
      portalId: query.portal || query.portalId,
      status: query.status,
      search: query.search,
      bookmarkedOnly: query.bookmarkedOnly,
      corrigendumOnly: query.corrigendumOnly
    });
    if (query.scope === 'inbox') {
      tenders = tenders.filter(t => t.pipeline_status === 'New Opportunity');
    } else if (query.scope === 'pipeline') {
      tenders = tenders.filter(t => t.pipeline_status !== 'New Opportunity' && t.pipeline_status !== 'Passed');
    }

    const headers = [
      'Reference No',
      'Title',
      'Organization',
      'Portal Name',
      'Domain Tracks',
      'Matched Keywords',
      'Pipeline Status',
      'Closing Date',
      'Estimated Value',
      'Location',
      'Has Corrigendum',
      'Direct URL',
      'Notes'
    ];

    const escapeCsv = (str: string | null | undefined) => {
      if (!str) return '""';
      const s = String(str).replace(/"/g, '""');
      return `"${s}"`;
    };

    const rows = tenders.map(t => [
      escapeCsv(t.reference_no),
      escapeCsv(t.title),
      escapeCsv(t.organization),
      escapeCsv(t.portal_name),
      escapeCsv(t.domain_tracks.join(', ')),
      escapeCsv(t.matched_keywords.join(', ')),
      escapeCsv(t.pipeline_status),
      escapeCsv(!t.closing_date || t.closing_date_formatted === 'Not Available' ? 'No deadline stated' : t.closing_date_formatted),
      escapeCsv(t.estimated_value),
      escapeCsv(t.location),
      escapeCsv(t.has_corrigendum ? 'Yes' : 'No'),
      escapeCsv(t.direct_url),
      escapeCsv(t.status_notes)
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tender_tracker_tenders_' + new Date().toISOString().slice(0, 10) + '.csv"');
    res.send(csvContent);
  });

  // 3. Backups & Storage
  router.get('/backups', (_req, res) => res.json(listBackups()));

  router.post('/backups', asyncHandler(async (_req, res) => {
    const backup = await backupNow();
    if (!backup) return sendError(res, 500, 'Backup failed', 'INTERNAL_ERROR');
    res.json(backup);
  }));

  router.get('/storage', (_req, res) => {
    const key = getGeminiApiKey();
    const maskedKey = maskApiKey(key);
    const digestSettings = getDigestSettings();
    res.json({
      ...getStorageStats(),
      ai_configured: Boolean(key),
      ai_masked_key: maskedKey,
      session_logs: listSessionLogs(),
      retention: getRetentionStatus(),
      ingest_budgets: getIngestBudgetSettings(),
      digest: {
        settings: digestSettings,
        summary: getAlertsDigest(digestSettings.withinHours)
      }
    });
  });

  router.post('/dossiers/prune-passed', (_req, res) => res.json(pruneDossiersForPassed()));

  // 3b. Ingest & Vision Budgets Configuration
  const handleGetIngestBudgets = (_req: Request, res: Response) => {
    res.json(getIngestBudgetSettings());
  };

  const handleUpdateIngestBudgets = (req: Request, res: Response) => {
    const body = getValidatedBody<InferSchema<typeof ingestBudgetsSchema>>(res, req);
    const updated = updateIngestBudgetSettings(body);
    res.json({ success: true, budgets: updated });
  };

  router.get('/system/ingest-budgets', handleGetIngestBudgets);
  router.post('/system/ingest-budgets', validateBody(ingestBudgetsSchema), handleUpdateIngestBudgets);

  // 4. Google AI Studio (Gemini API) Configuration & Extraction Routes
  router.get('/ai/status', (_req, res) => {
    const key = getGeminiApiKey();
    const maskedKey = maskApiKey(key);
    res.json({
      configured: Boolean(key),
      maskedKey,
      model: 'Gemini Flash (Multi-Model Failover)',
      candidateModels: CANDIDATE_MODELS
    });
  });

  router.post('/ai/config', validateBody(aiConfigSchema), (req, res) => {
    const { apiKey } = getValidatedBody<InferSchema<typeof aiConfigSchema>>(res, req);
    setAppSetting('gemini_api_key', typeof apiKey === 'string' ? apiKey : null);
    const key = getGeminiApiKey();
    const maskedKey = maskApiKey(key);
    res.json({
      success: true,
      configured: Boolean(key),
      maskedKey,
      message: key ? 'Google AI Studio API key saved.' : 'Google AI Studio API key cleared.'
    });
  });

  router.post('/ai/extract-file', validateBody(extractFileSchema), asyncHandler(async (req, res) => {
    const { base64Data, dataBase64, mimeType } = getValidatedBody<InferSchema<typeof extractFileSchema>>(res, req);
    const rawBase64 = base64Data || dataBase64!;
    if (!getGeminiApiKey()) {
      return sendError(
        res,
        400,
        'Google AI Studio API key is not configured. Add it in Sources & Keywords > Data.',
        'BAD_REQUEST'
      );
    }
    const buffer = decodeBase64Payload(rawBase64);
    const extracted = await extractTenderFromImage(buffer, mimeType || 'image/jpeg');
    if (!extracted) {
      return sendError(
        res,
        422,
        'Could not extract structured tender information from this file.',
        'UNPROCESSABLE_ENTITY'
      );
    }
    res.json({ success: true, extracted });
  }));

  // 5. Local Hybrid Embedding Engine Status
  router.get('/system/embedding-status', (_req, res) => {
    const engineStatus = getEmbeddingEngineStatus();
    let counts = { totalTenders: 0, indexedTenders: 0, modelIndexedTenders: 0 };
    try {
      counts = countTenderEmbeddingsBySpace();
    } catch {}

    res.json({
      ...engineStatus,
      ...counts
    });
  });

  // 6. Session Execution Logs (Strict Last 3 Retained)
  const handleListLogs = (_req: Request, res: Response) => {
    res.json({
      currentSession: getCurrentSessionFilename(),
      sessions: listSessionLogs()
    });
  };

  const handleGetLogFile = (req: Request, res: Response) => {
    const { filename } = req.params;
    const content = readSessionLog(filename);
    if (content === null) {
      return sendError(res, 404, 'Session log file not found or invalid filename', 'NOT_FOUND');
    }

    const query = getValidatedQuery<InferSchema<typeof logFileQuerySchema>>(res);
    if (query.download) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(content);
    }

    res.json({ filename, content });
  };

  router.get('/system/logs', handleListLogs);
  router.get('/system/logs/:filename', validateQuery(logFileQuerySchema), handleGetLogFile);

  // 7. Automated Retention & Dossier Reconciliation
  const handleGetRetention = (_req: Request, res: Response) => {
    res.json(getRetentionStatus());
  };

  const handleRunRetention = (req: Request, res: Response) => {
    const query = getValidatedQuery<InferSchema<typeof dryRunQuerySchema>>(res);
    const body = getValidatedBody<InferSchema<typeof dryRunBodySchema>>(res, req);
    const dryRun = Boolean(query.dryRun ?? body.dryRun);
    const report = runRetentionCycle({ dryRun, forceAll: true });
    res.json(report);
  };

  const handleUpdateRetentionSettings = (req: Request, res: Response) => {
    const { autoClean, graceDays, passedDays } =
      getValidatedBody<InferSchema<typeof retentionSettingsSchema>>(res, req);
    if (autoClean !== undefined) setAppSetting('retention_auto_clean', String(autoClean));
    if (graceDays !== undefined) setAppSetting('retention_grace_days', String(graceDays));
    if (passedDays !== undefined) setAppSetting('retention_passed_days', String(passedDays));
    res.json({ success: true, status: getRetentionStatus() });
  };

  const handleReconcileDossiers = (req: Request, res: Response) => {
    const query = getValidatedQuery<InferSchema<typeof dryRunQuerySchema>>(res);
    const body = getValidatedBody<InferSchema<typeof dryRunBodySchema>>(res, req);
    const dryRun = Boolean(query.dryRun ?? body.dryRun);
    const result = reconcileDossiers({ dryRun, graceMinutes: 60 });
    res.json(result);
  };

  router.get('/system/retention', handleGetRetention);
  router.post(
    '/system/retention/run',
    validateQuery(dryRunQuerySchema),
    validateBody(dryRunBodySchema),
    handleRunRetention
  );
  router.post(
    '/system/retention/settings',
    validateBody(retentionSettingsSchema),
    handleUpdateRetentionSettings
  );
  router.post(
    '/system/dossiers/reconcile',
    validateQuery(dryRunQuerySchema),
    validateBody(dryRunBodySchema),
    handleReconcileDossiers
  );

  // 8. Proactive 48h Closing Alerts & Daily Digest (Plan B)
  const handleGetDigest = (_req: Request, res: Response) => {
    const settings = getDigestSettings();
    const query = getValidatedQuery<InferSchema<typeof digestQuerySchema>>(res);
    const summary = getAlertsDigest(query.hours ?? settings.withinHours);
    res.json({ ...summary, settings });
  };

  const handleUpdateDigestSettings = (req: Request, res: Response) => {
    const { enabled, webhookUrl, withinHours } =
      getValidatedBody<InferSchema<typeof digestSettingsSchema>>(res, req);
    const updated = updateDigestSettings({
      ...(enabled !== undefined ? { enabled } : {}),
      ...(webhookUrl !== undefined ? { webhookUrl } : {}),
      ...(withinHours !== undefined ? { withinHours } : {})
    });
    res.json({ success: true, settings: updated });
  };

  router.get('/system/digest', validateQuery(digestQuerySchema), handleGetDigest);
  router.post('/system/digest/settings', validateBody(digestSettingsSchema), handleUpdateDigestSettings);

  // 9. Token-Guarded Graceful Shutdown (for standalone desktop tray host)
  router.post('/system/shutdown', (req, res) => {
    const expectedToken = (process.env.TENDER_SHUTDOWN_TOKEN || '').trim();
    if (!expectedToken) {
      return sendError(res, 403, 'Shutdown endpoint is disabled.', 'FORBIDDEN');
    }

    const provided = (req.get('x-shutdown-token') || '').trim();
    if (!provided || !tokensMatch(expectedToken, provided)) {
      return sendError(res, 403, 'Invalid shutdown token.', 'FORBIDDEN');
    }

    const handler = ctx.getShutdownHandler();
    if (!handler) {
      return sendError(res, 503, 'Shutdown handler is not registered.', 'SERVICE_UNAVAILABLE');
    }

    res.setHeader('Connection', 'close');
    res.status(200).json({ success: true, message: 'Shutting down cleanly...' });
    setTimeout(() => handler(), 50);
  });

  // 10. Network Connectivity Health Diagnostics
  router.get('/system/network', asyncHandler(async (_req, res) => {
    res.json(await ctx.networkMonitor.checkHealth());
  }));

  router.post('/system/network/check', asyncHandler(async (_req, res) => {
    res.json(await ctx.networkMonitor.checkHealth({ force: true }));
  }));

  return router;
}

export const systemRouter = createSystemRouter();
