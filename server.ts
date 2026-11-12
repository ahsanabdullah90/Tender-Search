import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDatabase,
  reScoreTendersAgainstTracks,
  db
} from './src/server/db.js';
import { initStartupScheduler, stopStartupScheduler } from './src/server/scheduler.js';
import { initEmbeddingModel } from './src/server/embeddingService.js';
import { backfillModelEmbeddings } from './src/server/embeddingBackfill.js';
import { apiRouter } from './src/server/routes/index.js';
import { initSessionLogger, closeSessionLogger, requestLoggerMiddleware } from './src/server/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(requestLoggerMiddleware);

  // Mount modular API domain routers
  app.use('/api', apiRouter);

  return app;
}

// Vite Integration & Server Startup
export async function startServer() {
  initSessionLogger();
  initDatabase();
  initStartupScheduler();
  void initEmbeddingModel().then(async () => {
    // Upgrade legacy/fast vectors to MiniLM before re-scoring, so track matching compares
    // like with like.
    try { await backfillModelEmbeddings(1000); } catch (err) { console.warn('[Embedding Engine] Backfill failed:', err); }
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
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Endpoint not found' });
      }
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
    closeSessionLogger('Clean Shutdown');
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
