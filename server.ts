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
  clearAllTenders
} from './src/server/db.js';
import {
  startCrawlerScan,
  currentScanStatus,
  addProgressListener,
  removeProgressListener,
  seedRealisticTenders
} from './src/server/scrapers/crawlerEngine.js';
import { initStartupScheduler } from './src/server/scheduler.js';
import { launchLocalBrowserHITL, verifyAndResumePortal } from './src/server/scrapers/playwrightEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Initialize SQLite database and catch-up scheduler
initDatabase();
// seedRealisticTenders() removed to ensure zero dummy/fabricated data
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

app.patch('/api/tenders/:id/notes', (req, res) => {
  const { notes } = req.body;
  const success = updateTenderNotes(req.params.id, notes || '');
  res.json({ success });
});

app.patch('/api/tenders/:id/bookmark', (req, res) => {
  const success = toggleTenderBookmark(req.params.id);
  res.json({ success });
});

// 3. KPI Statistics
app.get('/api/kpis', (req, res) => {
  const stats = getKpiStats();
  res.json(stats);
});

// 4. Corrigenda Alerts
app.get('/api/corrigenda', (req, res) => {
  const corrigenda = getUnacknowledgedCorrigenda();
  res.json(corrigenda);
});

app.post('/api/corrigenda/:id/acknowledge', (req, res) => {
  acknowledgeCorrigendum(req.params.id);
  res.json({ success: true });
});

// 5. Dynamic Domain Tracks
app.get('/api/tracks', (req, res) => {
  const tracks = getAllDomainTracks();
  res.json(tracks);
});

app.post('/api/tracks', (req, res) => {
  const { name, positive_keywords, negative_keywords, id } = req.body;
  if (!name) return res.status(400).json({ error: 'Track name is required' });
  const trackId = saveDomainTrack({
    id,
    name,
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
  const { portal_name, base_url, tenders_url, tier, access_mode, verified_status } = req.body;
  
  updatePortalHealth(portalId, {
    portal_name,
    base_url,
    tenders_url,
    tier,
    access_mode,
    verified_status
  });
  
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

// 7. Crawler Scan & Streaming
app.post('/api/scan/start', async (req, res) => {
  const { portalId } = req.body;
  const status = await startCrawlerScan(portalId);
  res.json(status);
});

app.get('/api/scan/status', (req, res) => {
  res.json(currentScanStatus);
});

// SSE endpoint for live scan progress
app.get('/api/scan/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendStatus = (status: any) => {
    res.write(`data: ${JSON.stringify(status)}\n\n`);
  };

  sendStatus(currentScanStatus);
  addProgressListener(sendStatus);

  req.on('close', () => {
    removeProgressListener(sendStatus);
  });
});

// 8. Serve Cached Local Dossiers (Static mount + direct route)
app.use('/dossiers', express.static(path.join(process.cwd(), 'data', 'dossiers')));

app.get('/api/dossiers/:tenderId/:filename', (req, res) => {
  const { tenderId, filename } = req.params;
  const filePath = path.resolve(process.cwd(), 'data', 'dossiers', tenderId, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Dossier file not found on disk');
  }

  res.sendFile(filePath);
});

// Clear all tenders for a 100% clean live slate
app.post('/api/tenders/clear', (req, res) => {
  clearAllTenders();
  res.json({ success: true, message: 'All tenders wiped. Database is now 100% clean.' });
});

// 9. Export Tenders to CSV (UTF-8 with BOM for Excel)
app.get('/api/export/csv', (req, res) => {
  const tenders = getAllTenders();

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

  // UTF-8 BOM (\uFEFF) ensures Excel renders Urdu and special characters properly
  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sentinel_tenders_' + new Date().toISOString().slice(0, 10) + '.csv"');
  res.send(csvContent);
});

// Vite Integration (Dev middleware mode)
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    // Production static serving
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Sentinel Watchdog] Solo-Operator Console online at http://localhost:${PORT}`);
  });
}

startServer();
