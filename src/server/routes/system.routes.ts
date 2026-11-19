import { Router } from 'express';
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
import { CANDIDATE_MODELS, extractTenderFromImage } from '../services/ocrService.js';
import { getEmbeddingEngineStatus } from '../services/embeddingService.js';
import { listSessionLogs, readSessionLog, getCurrentSessionFilename } from '../services/logger.js';
import { getRetentionStatus, runRetentionCycle } from '../services/retention.js';
import { reconcileDossiers } from '../services/dossierStore.js';
import { getIngestBudgetSettings, updateIngestBudgetSettings } from '../services/ingestBudget.js';
import { validateExternalHttpUrl } from '../services/urlSafety.js';
import { checkNetworkHealth } from '../services/networkMonitor.js';

export const systemRouter = Router();

// 0. Dossier Static File Serving with Path-Traversal Guard
systemRouter.get('/dossiers/:tenderId/:filename', (req, res) => {
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
systemRouter.post('/tenders/clear', (req, res) => {
  const unreviewedOnly = req.body?.unreviewedOnly === true;
  clearAllTenders(unreviewedOnly);
  res.json({
    success: true,
    message: unreviewedOnly
      ? 'Unreviewed opportunities cleared. Active bid pursuits and bookmarks preserved.'
      : 'All tenders wiped. Database is now 100% clean.'
  });
});

// 2. Export Tenders to CSV
systemRouter.get('/export/csv', (req, res) => {
  const { track, status, search, bookmarkedOnly, corrigendumOnly, scope } = req.query;
  let tenders = getAllTenders({
    track: track as string,
    status: status as string,
    search: search as string,
    bookmarkedOnly: bookmarkedOnly === 'true',
    corrigendumOnly: corrigendumOnly === 'true'
  });
  if (scope === 'inbox') tenders = tenders.filter(t => t.pipeline_status === 'New Opportunity');
  else if (scope === 'pipeline') tenders = tenders.filter(t => t.pipeline_status !== 'New Opportunity' && t.pipeline_status !== 'Passed');

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
systemRouter.get('/backups', (_req, res) => res.json(listBackups()));

systemRouter.post('/backups', async (_req, res) => {
  const backup = await backupNow();
  if (!backup) return res.status(500).json({ error: 'Backup failed' });
  res.json(backup);
});

systemRouter.get('/storage', (_req, res) => {
  const key = getGeminiApiKey();
  const maskedKey = key
    ? key.length > 8
      ? `${key.slice(0, 4)}••••${key.slice(-4)}`
      : '••••••••'
    : null;
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

systemRouter.post('/dossiers/prune-passed', (_req, res) => res.json(pruneDossiersForPassed()));

// 3b. Ingest & Vision Budgets Configuration
const handleGetIngestBudgets = (_req: any, res: any) => {
  res.json(getIngestBudgetSettings());
};

const handleUpdateIngestBudgets = (req: any, res: any) => {
  const updated = updateIngestBudgetSettings(req.body || {});
  res.json({ success: true, budgets: updated });
};

systemRouter.get('/ingest-budgets', handleGetIngestBudgets);
systemRouter.get('/system/ingest-budgets', handleGetIngestBudgets);
systemRouter.post('/ingest-budgets', handleUpdateIngestBudgets);
systemRouter.post('/system/ingest-budgets', handleUpdateIngestBudgets);

// 4. Google AI Studio (Gemini API) Configuration & Extraction Routes
systemRouter.get('/ai/status', (_req, res) => {
  const key = getGeminiApiKey();
  const maskedKey = key
    ? key.length > 8
      ? `${key.slice(0, 4)}••••${key.slice(-4)}`
      : '••••••••'
    : null;
  res.json({
    configured: Boolean(key),
    maskedKey,
    model: 'Gemini Flash (Multi-Model Failover)',
    candidateModels: CANDIDATE_MODELS
  });
});

systemRouter.post('/ai/config', (req, res) => {
  const { apiKey } = req.body || {};
  setAppSetting('gemini_api_key', typeof apiKey === 'string' ? apiKey : null);
  const key = getGeminiApiKey();
  const maskedKey = key
    ? key.length > 8
      ? `${key.slice(0, 4)}••••${key.slice(-4)}`
      : '••••••••'
    : null;
  res.json({
    success: true,
    configured: Boolean(key),
    maskedKey,
    message: key ? 'Google AI Studio API key saved.' : 'Google AI Studio API key cleared.'
  });
});

systemRouter.post('/ai/extract-file', async (req, res) => {
  const { base64Data, dataBase64, mimeType } = req.body || {};
  const rawBase64 = base64Data || dataBase64;
  if (!rawBase64) {
    return res.status(400).json({ error: 'base64Data is required' });
  }
  if (!getGeminiApiKey()) {
    return res.status(400).json({ error: 'Google AI Studio API key is not configured. Add it in Sources & Keywords > Data.' });
  }
  const cleanBase64 = String(rawBase64).replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  const extracted = await extractTenderFromImage(buffer, mimeType || 'image/jpeg');
  if (!extracted) {
    return res.status(422).json({ error: 'Could not extract structured tender information from this file.' });
  }
  res.json({ success: true, extracted });
});

// 5. Local Hybrid Embedding Engine Status
systemRouter.get('/system/embedding-status', (_req, res) => {
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
const handleListLogs = (_req: any, res: any) => {
  res.json({
    currentSession: getCurrentSessionFilename(),
    sessions: listSessionLogs()
  });
};

const handleGetLogFile = (req: any, res: any) => {
  const { filename } = req.params;
  const content = readSessionLog(filename);
  if (content === null) {
    return res.status(404).json({ error: 'Session log file not found or invalid filename' });
  }

  if (req.query?.download === 'true') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(content);
  }

  res.json({ filename, content });
};

systemRouter.get('/logs', handleListLogs);
systemRouter.get('/system/logs', handleListLogs);
systemRouter.get('/logs/:filename', handleGetLogFile);
systemRouter.get('/system/logs/:filename', handleGetLogFile);

// 7. Automated Retention & Dossier Reconciliation
const handleGetRetention = (_req: any, res: any) => {
  res.json(getRetentionStatus());
};

const handleRunRetention = (req: any, res: any) => {
  const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1' || req.body?.dryRun === true;
  const report = runRetentionCycle({ dryRun, forceAll: true });
  res.json(report);
};

const handleUpdateRetentionSettings = (req: any, res: any) => {
  const { autoClean, graceDays, passedDays } = req.body || {};
  if (autoClean !== undefined) setAppSetting('retention_auto_clean', String(Boolean(autoClean)));
  if (graceDays !== undefined) setAppSetting('retention_grace_days', String(Math.max(1, Number(graceDays) || 2)));
  if (passedDays !== undefined) setAppSetting('retention_passed_days', String(Math.max(1, Number(passedDays) || 10)));
  res.json({ success: true, status: getRetentionStatus() });
};

const handleReconcileDossiers = (req: any, res: any) => {
  const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1' || req.body?.dryRun === true;
  const result = reconcileDossiers({ dryRun, graceMinutes: 60 });
  res.json(result);
};

systemRouter.get('/retention', handleGetRetention);
systemRouter.get('/system/retention', handleGetRetention);
systemRouter.post('/retention/run', handleRunRetention);
systemRouter.post('/system/retention/run', handleRunRetention);
systemRouter.post('/retention/settings', handleUpdateRetentionSettings);
systemRouter.post('/system/retention/settings', handleUpdateRetentionSettings);
systemRouter.post('/dossiers/reconcile', handleReconcileDossiers);
systemRouter.post('/system/dossiers/reconcile', handleReconcileDossiers);

// 8. Proactive 48h Closing Alerts & Daily Digest (Plan B)
const handleGetDigest = (req: any, res: any) => {
  const settings = getDigestSettings();
  const hoursParam = req.query?.hours ? Number(req.query.hours) : settings.withinHours;
  const summary = getAlertsDigest(Number.isFinite(hoursParam) ? hoursParam : 48);
  res.json({ ...summary, settings });
};

const handleUpdateDigestSettings = (req: any, res: any) => {
  const { enabled, webhookUrl, withinHours } = req.body || {};
  if (typeof webhookUrl === 'string' && webhookUrl.trim()) {
    const check = validateExternalHttpUrl(webhookUrl);
    if (!check.valid) {
      return res.status(400).json({ success: false, message: check.reason });
    }
  }
  const updated = updateDigestSettings({
    ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
    ...(typeof webhookUrl === 'string' ? { webhookUrl: webhookUrl.trim() } : {}),
    ...(withinHours !== undefined ? { withinHours: Number(withinHours) } : {})
  });
  res.json({ success: true, settings: updated });
};

systemRouter.get('/digest', handleGetDigest);
systemRouter.get('/system/digest', handleGetDigest);
systemRouter.post('/digest/settings', handleUpdateDigestSettings);
systemRouter.post('/system/digest/settings', handleUpdateDigestSettings);

// 9. Token-Guarded Graceful Shutdown (for standalone desktop tray host)
let shutdownHandler: (() => void) | null = null;

export function setShutdownHandler(handler: (() => void) | null): void {
  shutdownHandler = handler;
}

function tokensMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

systemRouter.post('/system/shutdown', (req, res) => {
  const expectedToken = (process.env.TENDER_SHUTDOWN_TOKEN || '').trim();
  if (!expectedToken) {
    return res.status(403).json({ success: false, error: 'Shutdown endpoint is disabled.' });
  }

  const provided = (req.get('x-shutdown-token') || '').trim();
  if (!provided || !tokensMatch(expectedToken, provided)) {
    return res.status(403).json({ success: false, error: 'Invalid shutdown token.' });
  }

  if (!shutdownHandler) {
    return res.status(503).json({ success: false, error: 'Shutdown handler is not registered.' });
  }

  const handler = shutdownHandler;
  res.setHeader('Connection', 'close');
  res.status(200).json({ success: true, message: 'Shutting down cleanly...' });
  setTimeout(() => handler(), 50);
});

// 10. Network Connectivity Health Diagnostics
systemRouter.get('/system/network', async (_req, res) => {
  res.json(await checkNetworkHealth());
});

systemRouter.post('/system/network/check', async (_req, res) => {
  res.json(await checkNetworkHealth({ force: true }));
});
