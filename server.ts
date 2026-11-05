import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  initDatabase,
  reScoreTendersAgainstTracks,
  DOSSIERS_DIR,
  db
} from './src/server/db.js';
import { initStartupScheduler, stopStartupScheduler } from './src/server/scheduler.js';
import { initEmbeddingModel } from './src/server/embeddingService.js';
import { apiRouter } from './src/server/routes/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Mount modular API domain routers
  app.use('/api', apiRouter);

  // Serve Cached Local Dossiers (Static mount + direct route)
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

  return app;
}

// Vite Integration & Server Startup
export async function startServer() {
  initDatabase();
  initStartupScheduler();
  void initEmbeddingModel().then(() => {
    try { reScoreTendersAgainstTracks(); } catch {}
  });

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
