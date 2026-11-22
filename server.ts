import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDatabase,
  reScoreTendersAgainstTracks,
  closeDatabase
} from './src/server/db/index.js';
import { initStartupScheduler, stopStartupScheduler } from './src/server/runtime/scheduler.js';
import { initEmbeddingModel } from './src/server/services/embeddingService.js';
import { backfillModelEmbeddings } from './src/server/services/embeddingBackfill.js';
import { apiRouter } from './src/server/routes/index.js';
import { setShutdownHandler } from './src/server/routes/system.routes.js';
import { initSessionLogger, closeSessionLogger, requestLoggerMiddleware } from './src/server/services/logger.js';
import { terminateLocalOcrWorker } from './src/server/services/localOcrService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.basename(__dirname) === 'dist-server' ? path.resolve(__dirname, '..') : __dirname;

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(requestLoggerMiddleware);

  // Mount modular API domain routers
  app.use('/api', apiRouter);

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    const status = typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;
    res.status(status).json({ error: err?.message || 'Internal server error' });
  });

  return app;
}

// Vite Integration & Server Startup
export async function startServer() {
  initSessionLogger();
  initDatabase();
  initStartupScheduler();

  let isShuttingDown = false;
  void initEmbeddingModel().then(async () => {
    if (isShuttingDown) return;
    // Upgrade legacy/fast vectors to MiniLM before re-scoring, so track matching compares
    // like with like.
    try { await backfillModelEmbeddings(1000); } catch (err) { console.warn('[Embedding Engine] Backfill failed:', err); }
    if (isShuttingDown) return;
    try { reScoreTendersAgainstTracks(); } catch {}
  });

  const app = createApp();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const HOST = process.env.HOST || '127.0.0.1';

  const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
      optimizeDeps: process.env.VITEST ? { noDiscovery: true } : undefined
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(projectRoot, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`[Tender Tracker] Solo-Operator Console online at http://${HOST}:${PORT}`);
  });

  // Graceful shutdown handling on Windows / Linux
  const handleExit = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    process.off('SIGINT', handleExit);
    process.off('SIGTERM', handleExit);
    setShutdownHandler(null);
    console.log('\n[Tender Tracker] Shutting down cleanly...');
    stopStartupScheduler();

    const shutdownOcr = Promise.resolve(terminateLocalOcrWorker()).catch(() => {});
    const ocrWait = Promise.race([shutdownOcr, new Promise<void>(resolve => setTimeout(resolve, 2000))]);
    void ocrWait.finally(() => {
      try {
        closeDatabase();
        console.log('[Tender Tracker] Database closed cleanly.');
      } catch {}
      closeSessionLogger('Clean Shutdown');
      server.close(() => {
        process.exit(0);
      });
      try {
        server.closeAllConnections?.();
      } catch {}
    });
  };

  setShutdownHandler(handleExit);
  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);

  return server;
}

const isDirectRun = Boolean(
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
   process.argv[1].endsWith('server.ts') ||
   process.argv[1].endsWith('server.js') ||
   process.argv[1].endsWith('server.mjs'))
);

/* v8 ignore next 3 - direct execution branch is impossible by construction when imported by Vitest */
if (isDirectRun) {
  startServer().catch(err => {
    console.error('[Tender Tracker] Failed to start:', err);
    process.exit(1);
  });
}
