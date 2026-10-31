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
  db
} from './src/server/db.js';
import {
  startCrawlerScan,
  currentScanStatus,
  addProgressListener,
  removeProgressListener
} from './src/server/scrapers/crawlerEngine.js';
import { initStartupScheduler, stopStartupScheduler } from './src/server/scheduler.js';
import { launchLocalBrowserHITL, verifyAndResumePortal } from './src/server/scrapers/playwrightEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Initialize SQLite database and catch-up scheduler
initDatabase();
initStartupScheduler();

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
  for (const key of ['portal_name', 'base_url', 'tenders_url', 'tier', 'access_mode', 'verified_status']) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  updatePortalHealth(portalId, updates);
  res.json({ success: true, message: 'Portal updated successfully' });
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
const DOSSIERS_DIR = path.resolve(__dirname, 'data', 'dossiers');
app.use('/dossiers', express.static(DOSSIERS_DIR));
app.use('/data/dossiers', express.static(DOSSIERS_DIR));

app.get('/api/dossiers/:tenderId/:filename', (req, res) => {
  const { tenderId, filename } = req.params;
  const filePath = path.resolve(DOSSIERS_DIR, tenderId, filename);

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
  const { track, status, search, bookmarkedOnly, corrigendumOnly } = req.query;
  const tenders = getAllTenders({
    track: track as string,
    status: status as string,
    search: search as string,
    bookmarkedOnly: bookmarkedOnly === 'true',
    corrigendumOnly: corrigendumOnly === 'true'
  });

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
  res.setHeader('Content-Disposition', 'attachment; filename="sentinel_tenders_' + new Date().toISOString().slice(0, 10) + '.csv"');
  res.send(csvContent);
});

// Vite Integration & Server Startup
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Sentinel Watchdog] Solo-Operator Console online at http://localhost:${PORT}`);
  });

  // Graceful shutdown handling on Windows / Linux
  const handleExit = () => {
    console.log('\n[Sentinel Watchdog] Shutting down cleanly...');
    stopStartupScheduler();
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      console.log('[Sentinel Watchdog] Database closed cleanly.');
    } catch {}
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);
}

startServer();
