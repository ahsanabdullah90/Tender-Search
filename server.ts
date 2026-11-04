import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  initDatabase,
  getAllTenders,
  getTenderById,
  updateTenderStatus,
  updateTenderNotes,
  updateTenderResultDate,
  toggleTenderBookmark,
  getAllDomainTracks,
  saveDomainTrack,
  deleteDomainTrack,
  getPortalHealthList,
  updatePortalHealth,
  getUnacknowledgedCorrigenda,
  acknowledgeCorrigendum,
  getKpiStats,
  clearAllTenders,
  listBackups,
  backupNow,
  getStorageStats,
  pruneDossiersForPassed,
  savePortalCredentials,
  getPortalAuthCredentials,
  getGeminiApiKey,
  setAppSetting,
  updateTenderFields,
  createManualTender,
  DOSSIERS_DIR,
  db
} from './src/server/db.js';
import { authenticatePortal } from './src/server/scrapers/portalAuth.js';
import {
  startCrawlerScan,
  currentScanStatus,
  addProgressListener,
  removeProgressListener,
  analyzeTenderById,
  matchTracks,
  parseDateString,
  formatClosingDate,
  healPortalConnection,
  getActivePortalsList
} from './src/server/scrapers/crawlerEngine.js';
import { saveManualDossier } from './src/server/dossierManager.js';
import { extractTenderFromImage, CANDIDATE_MODELS } from './src/server/ocrService.js';
import { initStartupScheduler, stopStartupScheduler } from './src/server/scheduler.js';
import { launchLocalBrowserHITL, verifyAndResumePortal } from './src/server/scrapers/playwrightEngine.js';
import { TENDER_STATUSES } from './src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // API Endpoints

// 1. Tenders Listing & Filtering
app.get('/api/tenders', (req, res) => {
  try {
    const { track, status, search, bookmarkedOnly, corrigendumOnly } = req.query;
    const tenders = getAllTenders({
      track: track as string,
      status: status as string,
      search: search as string,
      bookmarkedOnly: bookmarkedOnly === 'true',
      corrigendumOnly: corrigendumOnly === 'true'
    });
    res.json(tenders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tenders/:id', (req, res) => {
  const tender = getTenderById(req.params.id);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  res.json(tender);
});

// 2. Status & Pipeline Updates
app.patch('/api/tenders/:id/status', (req, res) => {
  const { status, notes } = req.body;
  if (!status) return res.status(400).json({ error: 'Status is required' });
  if (!TENDER_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Invalid status: "${status}". Valid statuses are: ${TENDER_STATUSES.join(', ')}`
    });
  }
  const success = updateTenderStatus(req.params.id, status, notes);
  if (!success) return res.status(404).json({ error: 'Tender not found' });
  res.json({ success: true, status });
});

// Support both PATCH and POST for notes
const handleNotesUpdate = (req: any, res: any) => {
  const { notes } = req.body;
  const success = updateTenderNotes(req.params.id, notes || '');
  if (!success) {
    return res.status(404).json({ success: false, error: 'Tender not found' });
  }
  res.json({ success: true, notes });
};
app.patch('/api/tenders/:id/notes', handleNotesUpdate);
app.post('/api/tenders/:id/notes', handleNotesUpdate);

app.patch('/api/tenders/:id/result-date', (req, res) => {
  const { date } = req.body;
  if (date && Number.isNaN(new Date(date).getTime())) {
    return res.status(400).json({ error: 'Invalid date' });
  }
  if (!updateTenderResultDate(req.params.id, date || null)) {
    return res.status(404).json({ error: 'Tender not found' });
  }
  res.json({ success: true, result_expected_date: date || null });
});

// Support both PATCH and POST for bookmarks, returning is_bookmarked state
const handleBookmarkToggle = (req: any, res: any) => {
  const result = toggleTenderBookmark(req.params.id);
  res.json(result);
};
app.patch('/api/tenders/:id/bookmark', handleBookmarkToggle);
app.post('/api/tenders/:id/bookmark', handleBookmarkToggle);

// 3. KPI Statistics
app.get('/api/kpis', (req, res) => {
  const stats = getKpiStats();
  res.json(stats);
});

// 4. Corrigenda Alerts & Acknowledgement (alias /ack and /acknowledge)
app.get('/api/corrigenda', (req, res) => {
  const corrigenda = getUnacknowledgedCorrigenda();
  res.json(corrigenda);
});

const handleAckCorrigendum = (req: any, res: any) => {
  acknowledgeCorrigendum(req.params.id);
  res.json({ success: true });
};
app.post('/api/corrigenda/:id/acknowledge', handleAckCorrigendum);
app.post('/api/corrigenda/:id/ack', handleAckCorrigendum);

// 5. Dynamic Domain Tracks
app.get('/api/tracks', (req, res) => {
  const tracks = getAllDomainTracks();
  res.json(tracks);
});

app.post('/api/tracks', (req, res) => {
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

app.delete('/api/tracks/:id', (req, res) => {
  deleteDomainTrack(req.params.id);
  res.json({ success: true });
});

// 6. Portal Health & HITL Launcher
app.get('/api/portals', (req, res) => {
  const portals = getPortalHealthList();
  res.json(portals);
});

app.put('/api/portals/:portalId', (req, res) => {
  const { portalId } = req.params;
  const updates: any = {};
  for (const key of ['portal_name', 'base_url', 'tenders_url', 'tier', 'access_mode', 'verified_status', 'status', 'last_error_message']) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  // Enforce strict origin normalization on base_url (Rule 6: never store file paths in base_url)
  if (typeof updates.base_url === 'string' && updates.base_url.trim()) {
    try {
      updates.base_url = new URL(updates.base_url.trim()).origin;
    } catch {}
  }

  // If operator updated tenders_url, derive clean base_url origin and clear stale offline/error states
  if (typeof updates.tenders_url === 'string' && updates.tenders_url.trim()) {
    try {
      const parsedOrigin = new URL(updates.tenders_url.trim()).origin;
      if (!updates.base_url || updates.base_url === updates.tenders_url) {
        updates.base_url = parsedOrigin;
      }
    } catch {}
    if (updates.status === undefined) {
      updates.status = 'online';
    }
    if (updates.last_error_message === undefined) {
      updates.last_error_message = null;
    }
    if (updates.access_mode === undefined) {
      const existing = getPortalHealthList().find(p => p.portal_id === portalId);
      if (existing && existing.access_mode === 'offline_broken') {
        updates.access_mode = 'public';
      }
    }
  }

  updatePortalHealth(portalId, updates);
  res.json({ success: true, message: 'Portal updated successfully' });
});

app.post('/api/portals/:portalId/heal', async (req, res) => {
  try {
    const { portalId } = req.params;
    const portals = getActivePortalsList(portalId);
    if (portals.length === 0) {
      return res.status(404).json({ success: false, message: 'Portal not found' });
    }
    const targetPortal = { ...portals[0] };
    if (typeof req.body?.baseUrl === 'string' && req.body.baseUrl.trim()) {
      targetPortal.baseUrl = req.body.baseUrl.trim();
    }

    const healed = await healPortalConnection(targetPortal);
    if (!healed) {
      return res.json({
        success: false,
        message: 'Could not automatically locate an active tenders page from this website.'
      });
    }

    res.json({
      success: true,
      baseUrl: healed.healedPortal.baseUrl,
      tendersUrl: healed.healedPortal.tendersUrl,
      itemsFound: healed.result.items.length,
      message: `Discovered tender page (${healed.result.items.length} listings found)`
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || 'Auto-discovery failed' });
  }
});

app.post('/api/portals/:portalId/hitl-launch', async (req, res) => {
  try {
    const result = await launchLocalBrowserHITL(req.params.portalId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/portals/:portalId/hitl-verify', (req, res) => {
  verifyAndResumePortal(req.params.portalId);
  res.json({ success: true });
});

app.get('/api/portals/:portalId/credentials', (req, res) => {
  const creds = getPortalAuthCredentials(req.params.portalId);
  if (!creds) {
    return res.status(404).json({ success: false, message: 'Portal not found' });
  }
  res.json({
    username: creds.username || '',
    loginUrl: creds.loginUrl || '',
    hasPassword: Boolean(creds.password)
  });
});

app.post('/api/portals/:portalId/credentials', async (req, res) => {
  try {
    const { username, password, loginUrl } = req.body;
    savePortalCredentials(req.params.portalId, { username, password, loginUrl });

    if (username && password) {
      const authResult = await authenticatePortal(req.params.portalId, username, password, loginUrl);
      return res.json(authResult);
    }

    res.json({ success: true, message: 'Portal credentials saved successfully.' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. Crawler Scan & Streaming (alias /stream and /progress)
app.post('/api/scan/start', async (req, res) => {
  const portalId = req.body?.portalId || (req.query?.portalId as string | undefined);
  const status = await startCrawlerScan(portalId);
  res.json(status);
});

app.get('/api/scan/status', (req, res) => {
  res.json(currentScanStatus);
});

// SSE endpoint for live scan progress
const handleScanSse = (req: any, res: any) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendStatus = (status: any) => {
    // Send both raw status object and typed event envelope for compatibility
    res.write(`data: ${JSON.stringify({ type: 'scan_progress', status })}\n\n`);
  };

  sendStatus(currentScanStatus);
  addProgressListener(sendStatus);

  req.on('close', () => {
    removeProgressListener(sendStatus);
  });
};

app.get('/api/scan/stream', handleScanSse);
app.get('/api/scan/progress', handleScanSse);

// 8. Serve Cached Local Dossiers (Static mount + direct route)
app.use('/dossiers', express.static(DOSSIERS_DIR));
app.use('/data/dossiers', express.static(DOSSIERS_DIR));

app.get('/api/dossiers/:tenderId/:filename', (req, res) => {
  const { tenderId, filename } = req.params;
  const resolvedRoot = path.resolve(DOSSIERS_DIR);
  const filePath = path.resolve(DOSSIERS_DIR, tenderId, filename);

  if (!filePath.startsWith(resolvedRoot + path.sep)) {
    return res.status(400).send('Invalid dossier path');
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Dossier file not found on disk');
  }

  res.sendFile(filePath);
});

// 9. Clear tenders: supports unreviewedOnly (preserves active pursuits) or full wipe
app.post('/api/tenders/clear', (req, res) => {
  const unreviewedOnly = req.body?.unreviewedOnly === true;
  clearAllTenders(unreviewedOnly);
  res.json({
    success: true,
    message: unreviewedOnly
      ? 'Unreviewed opportunities cleared. Active bid pursuits and bookmarks preserved.'
      : 'All tenders wiped. Database is now 100% clean.'
  });
});

// 10. Export Tenders to CSV (supports active filtering & UTF-8 BOM for Excel)
app.get('/api/export/csv', (req, res) => {
  const { track, status, search, bookmarkedOnly, corrigendumOnly, scope } = req.query;
  let tenders = getAllTenders({
    track: track as string,
    status: status as string,
    search: search as string,
    bookmarkedOnly: bookmarkedOnly === 'true',
    corrigendumOnly: corrigendumOnly === 'true'
  });
  // scope: 'inbox' = unreviewed only, 'pipeline' = everything being worked on. Anything else = all.
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

// 11. Backups, storage and saved-document clean-up (Sources & Keywords > Data)
app.get('/api/backups', (req, res) => res.json(listBackups()));

app.post('/api/backups', async (req, res) => {
  const backup = await backupNow();
  if (!backup) return res.status(500).json({ error: 'Backup failed' });
  res.json(backup);
});

app.get('/api/storage', (req, res) => {
  const key = getGeminiApiKey();
  const maskedKey = key
    ? key.length > 8
      ? `${key.slice(0, 4)}••••${key.slice(-4)}`
      : '••••••••'
    : null;
  res.json({
    ...getStorageStats(),
    ai_configured: Boolean(key),
    ai_masked_key: maskedKey
  });
});

app.post('/api/dossiers/prune-passed', (req, res) => res.json(pruneDossiersForPassed()));

// 12. Google AI Studio (Gemini API) Configuration & Extraction Routes
app.get('/api/ai/status', (req, res) => {
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

app.post('/api/ai/config', (req, res) => {
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

app.post('/api/ai/extract-file', async (req, res) => {
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

// 13. On-Demand Tender AI Analysis, Live Refresh, Manual Edit, File Upload & Manual Tender Creation
app.post('/api/tenders/:id/analyze', async (req, res) => {
  if (!getGeminiApiKey()) {
    return res.status(400).json({ error: 'Google AI Studio API key is not configured. Add it in Sources & Keywords > Data.' });
  }
  const tender = await analyzeTenderById(req.params.id);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  res.json({ success: true, tender, message: 'Tender analyzed with Google AI.' });
});

app.post('/api/tenders/:id/refresh', async (req, res) => {
  const tender = await analyzeTenderById(req.params.id, { forceRefresh: true });
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  res.json({
    success: true,
    tender,
    message: getGeminiApiKey()
      ? 'Tender information refreshed from portal and summarized with AI.'
      : 'Tender information refreshed from portal.'
  });
});

app.post('/api/tenders/:id/attachments', async (req, res) => {
  const existing = getTenderById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tender not found' });

  const { filename, mimeType, base64Data, dataBase64, label, runAi = true } = req.body || {};
  const rawBase64 = base64Data || dataBase64;
  if (!rawBase64) {
    return res.status(400).json({ error: 'base64Data is required' });
  }

  const cleanBase64 = String(rawBase64).replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  const doc = saveManualDossier(existing.id, filename || 'notice.png', buffer, label, mimeType);
  const updatedDossiers = [...(Array.isArray(existing.cached_dossiers) ? existing.cached_dossiers : []), doc];

  const fieldUpdates: Parameters<typeof updateTenderFields>[1] = {
    cached_dossiers: updatedDossiers
  };

  let aiExtracted = false;
  if (runAi && getGeminiApiKey() && (doc.mimeType.startsWith('image/') || doc.mimeType === 'application/pdf')) {
    const aiRes = await extractTenderFromImage(buffer, doc.mimeType);
    if (aiRes) {
      aiExtracted = true;
      if (aiRes.summaryScope) fieldUpdates.description = aiRes.summaryScope;
      if (aiRes.referenceNo && !existing.reference_no) fieldUpdates.reference_no = aiRes.referenceNo;
      if (aiRes.estimatedValue && !existing.estimated_value) fieldUpdates.estimated_value = aiRes.estimatedValue;
      if (aiRes.closingDateISO && !existing.closing_date) {
        const iso = parseDateString(aiRes.closingDateISO) || aiRes.closingDateISO;
        fieldUpdates.closing_date = iso;
        fieldUpdates.closing_date_formatted = aiRes.closingDateFormatted || formatClosingDate(iso);
      }
    }
  }

  const tender = updateTenderFields(existing.id, fieldUpdates);
  res.json({ success: true, tender, attachment: doc, aiExtracted });
});

app.patch('/api/tenders/:id', (req, res) => {
  const existing = getTenderById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tender not found' });

  const { title, organization, reference_no, closing_date, estimated_value, description, direct_url, location } = req.body || {};
  const updates: Parameters<typeof updateTenderFields>[1] = {};

  if (title !== undefined) updates.title = String(title).trim() || existing.title;
  if (organization !== undefined) updates.organization = String(organization).trim() || existing.organization;
  if (reference_no !== undefined) updates.reference_no = reference_no ? String(reference_no).trim() : null;
  if (estimated_value !== undefined) updates.estimated_value = estimated_value ? String(estimated_value).trim() : null;
  if (description !== undefined) updates.description = String(description);
  if (direct_url !== undefined) updates.direct_url = String(direct_url).trim() || existing.direct_url;
  if (location !== undefined) updates.location = location ? String(location).trim() : null;
  if (closing_date !== undefined) {
    const parsedIso = closing_date ? (parseDateString(String(closing_date)) || String(closing_date)) : null;
    updates.closing_date = parsedIso;
    updates.closing_date_formatted = formatClosingDate(parsedIso);
  }

  const tender = updateTenderFields(existing.id, updates);
  res.json({ success: true, tender });
});

app.post('/api/tenders', async (req, res) => {
  const {
    title,
    organization,
    reference_no,
    portal_name,
    direct_url,
    closing_date,
    estimated_value,
    location,
    description,
    attachment,
    fileBase64,
    filename,
    mimeType
  } = req.body || {};

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  const orgName = organization && String(organization).trim() ? String(organization).trim() : 'Not Specified';

  const parsedClosing = closing_date ? (parseDateString(String(closing_date)) || String(closing_date)) : null;
  const activeTracks = getAllDomainTracks().filter(t => t.is_active === 1);
  const { matchedTracks, matchedKeywords, matchScore } = matchTracks(
    {
      title: String(title),
      organization: orgName,
      referenceNo: reference_no ? String(reference_no) : undefined,
      description: description ? String(description) : '',
      directUrl: direct_url ? String(direct_url) : '#'
    },
    activeTracks
  );

  let created = createManualTender({
    title: String(title).trim(),
    organization: orgName,
    reference_no: reference_no ? String(reference_no).trim() : null,
    portal_name: portal_name ? String(portal_name).trim() : 'Manual Entry',
    direct_url: direct_url ? String(direct_url).trim() : '#',
    closing_date: parsedClosing,
    closing_date_formatted: formatClosingDate(parsedClosing),
    estimated_value: estimated_value ? String(estimated_value).trim() : null,
    location: location ? String(location).trim() : 'Pakistan',
    description: description ? String(description).trim() : '',
    domain_tracks: matchedTracks,
    matched_keywords: Array.from(new Set(matchedKeywords)),
    match_score: matchScore || 80
  });

  const attachBase64 = attachment?.base64Data || attachment?.dataBase64 || fileBase64;
  if (attachBase64) {
    const cleanBase64 = String(attachBase64).replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    const doc = saveManualDossier(
      created.id,
      attachment?.filename || filename || 'notice.png',
      buffer,
      attachment?.label || filename || 'Tender Notice',
      attachment?.mimeType || mimeType
    );
    created = updateTenderFields(created.id, { cached_dossiers: [doc] }) || created;
  }

  res.status(201).json({ success: true, tender: created });
});

  return app;
}

// Vite Integration & Server Startup
export async function startServer() {
  initDatabase();
  initStartupScheduler();

  const app = createApp();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const HOST = process.env.HOST || '127.0.0.1';

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
      optimizeDeps: process.env.VITEST ? { noDiscovery: true } : undefined
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`[Tender Tracker] Solo-Operator Console online at http://${HOST}:${PORT}`);
  });

  // Graceful shutdown handling on Windows / Linux
  const handleExit = () => {
    console.log('\n[Tender Tracker] Shutting down cleanly...');
    stopStartupScheduler();
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      console.log('[Tender Tracker] Database closed cleanly.');
    } catch {}
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);

  return server;
}

const isDirectRun = Boolean(
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
   process.argv[1].endsWith('server.ts') ||
   process.argv[1].endsWith('server.js'))
);

/* v8 ignore next 3 - direct execution branch is impossible by construction when imported by Vitest */
if (isDirectRun) {
  startServer();
}
