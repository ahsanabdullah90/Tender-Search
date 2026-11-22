import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDatabase,
  reScoreTendersAgainstTracks,
  closeDatabase
} from './src/server/db/index.js';
import { getDefaultRuntimeContext, type RuntimeContext } from './src/server/runtime/context.js';
import { initEmbeddingModel } from './src/server/services/embeddingService.js';
import { backfillModelEmbeddings } from './src/server/services/embeddingBackfill.js';
import { createApiRouter } from './src/server/routes/index.js';
import { errorHandler } from './src/server/routes/httpErrors.js';
import { initSessionLogger, closeSessionLogger, requestLoggerMiddleware } from './src/server/services/logger.js';
import { terminateLocalOcrWorker } from './src/server/services/localOcrService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.basename(__dirname) === 'dist-server' ? path.resolve(__dirname, '..') : __dirname;

export function createApp(ctx: RuntimeContext = getDefaultRuntimeContext()): express.Express {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(requestLoggerMiddleware);

  // Mount modular API domain routers
  const apiRouter = createApiRouter(ctx);
  app.use('/api', apiRouter);

  app.use(errorHandler);

  return app;
}

// Vite Integration & Server Startup
export async function startServer(ctx: RuntimeContext = getDefaultRuntimeContext()) {
  initSessionLogger();
  initDatabase();
  ctx.scheduler.start();

  let isShuttingDown = false;
  void initEmbeddingModel().then(async () => {
    if (isShuttingDown) return;
    // Upgrade legacy/fast vectors to MiniLM before re-scoring, so track matching compares
    // like with like.
    try { await backfillModelEmbeddings(1000); } catch (err) { console.warn('[Embedding Engine] Backfill failed:', err); }
    if (isShuttingDown) return;
    try { reScoreTendersAgainstTracks(); } catch {}
  });

  const app = createApp(ctx);
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
    ctx.setShutdownHandler(null);
    console.log('\n[Tender Tracker] Shutting down cleanly...');
    ctx.scheduler.stop();

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

  ctx.setShutdownHandler(handleExit);
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
