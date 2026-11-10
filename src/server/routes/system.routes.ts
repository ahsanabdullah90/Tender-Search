import { Router } from 'express';
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
  db
} from '../db.js';
import { CANDIDATE_MODELS, extractTenderFromImage } from '../ocrService.js';
import { getEmbeddingEngineStatus } from '../embeddingService.js';
import { listSessionLogs, readSessionLog, getCurrentSessionFilename } from '../logger.js';
import { getRetentionStatus, runRetentionCycle } from '../retention.js';
import { reconcileDossiers } from '../dossierStore.js';

export const systemRouter = Router();

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
    escapeCsv(t.closing_date_formatted),
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
systemRouter.get('/backups', (req, res) => res.json(listBackups()));

systemRouter.post('/backups', async (req, res) => {
  const backup = await backupNow();
  if (!backup) return res.status(500).json({ error: 'Backup failed' });
  res.json(backup);
});

systemRouter.get('/storage', (req, res) => {
  const key = getGeminiApiKey();
  const maskedKey = key
    ? key.length > 8
      ? `${key.slice(0, 4)}••••${key.slice(-4)}`
      : '••••••••'
    : null;
  res.json({
    ...getStorageStats(),
    ai_configured: Boolean(key),
    ai_masked_key: maskedKey,
    session_logs: listSessionLogs(),
    retention: getRetentionStatus()
  });
});

systemRouter.post('/dossiers/prune-passed', (req, res) => res.json(pruneDossiersForPassed()));

// 4. Google AI Studio (Gemini API) Configuration & Extraction Routes
systemRouter.get('/ai/status', (req, res) => {
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
systemRouter.get('/system/embedding-status', (req, res) => {
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
const handleListLogs = (req: any, res: any) => {
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
const handleGetRetention = (req: any, res: any) => {
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
