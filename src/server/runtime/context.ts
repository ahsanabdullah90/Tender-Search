import { ScanDepth, ScanStatus } from '../../shared/types.js';
import { ScanStateStore, scanState } from '../scrapers/scanState.js';
import { startCrawlerScan } from '../scrapers/crawlerEngine.js';
import { PlaywrightManager, defaultPlaywrightManager } from '../scrapers/playwrightEngine.js';
import { NetworkMonitor, defaultNetworkMonitor } from '../services/networkMonitor.js';
import {
  drainDocumentQueue,
  processDocumentQueue,
  type IngestWorkerContext
} from './ingestWorker.js';
import { SchedulerController, defaultScheduler } from './scheduler.js';

export interface RuntimeContext {
  scanState: ScanStateStore;
  networkMonitor: NetworkMonitor;
  playwright: PlaywrightManager;
  scheduler: SchedulerController;
  startCrawlerScan: (
    portalId?: string,
    awaitCompletion?: boolean,
    options?: { depth?: ScanDepth }
  ) => Promise<ScanStatus>;
  drainDocumentQueue: typeof drainDocumentQueue;
  processDocumentQueue: typeof processDocumentQueue;
  getShutdownHandler: () => (() => void) | null;
  setShutdownHandler: (handler: (() => void) | null) => void;
}

export function createRuntimeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const localScanState = overrides.scanState ?? new ScanStateStore();
  const localNetworkMonitor = overrides.networkMonitor ?? new NetworkMonitor();
  const localPlaywright = overrides.playwright ?? new PlaywrightManager();

  const workerCtx: IngestWorkerContext = {
    scanState: localScanState,
    networkMonitor: localNetworkMonitor
  };

  const localStartCrawlerScan: RuntimeContext['startCrawlerScan'] =
    overrides.startCrawlerScan ??
    ((portalId?: string, awaitCompletion?: boolean, options?: { depth?: ScanDepth }) =>
      startCrawlerScan(portalId, awaitCompletion, {
        ...options,
        scanState: localScanState,
        networkMonitor: localNetworkMonitor,
        playwright: localPlaywright
      }));

  const localDrainDocumentQueue: typeof drainDocumentQueue =
    overrides.drainDocumentQueue ??
    ((opts, ctx) =>
      drainDocumentQueue(opts, {
        ...workerCtx,
        ...ctx
      }));

  const localProcessDocumentQueue: typeof processDocumentQueue =
    overrides.processDocumentQueue ??
    ((limit, concurrency, ctx) =>
      processDocumentQueue(limit, concurrency, {
        ...workerCtx,
        ...ctx
      }));

  const localScheduler =
    overrides.scheduler ??
    new SchedulerController({
      scanState: localScanState,
      networkMonitor: localNetworkMonitor,
      ports: {
        startCrawlerScan: (portalId, awaitCompletion, opts) =>
          localStartCrawlerScan(portalId, awaitCompletion, opts),
        drainDocumentQueue: opts => localDrainDocumentQueue(opts)
      }
    });

  let shutdownHandler: (() => void) | null = null;
  const getShutdownHandler = overrides.getShutdownHandler ?? (() => shutdownHandler);
  const setShutdownHandler =
    overrides.setShutdownHandler ??
    ((handler: (() => void) | null) => {
      shutdownHandler = handler;
    });

  return {
    scanState: localScanState,
    networkMonitor: localNetworkMonitor,
    playwright: localPlaywright,
    scheduler: localScheduler,
    startCrawlerScan: localStartCrawlerScan,
    drainDocumentQueue: localDrainDocumentQueue,
    processDocumentQueue: localProcessDocumentQueue,
    getShutdownHandler,
    setShutdownHandler
  };
}

let defaultRuntimeContext: RuntimeContext | null = null;

export function getDefaultRuntimeContext(): RuntimeContext {
  if (!defaultRuntimeContext) {
    let defaultShutdownHandler: (() => void) | null = null;
    defaultRuntimeContext = {
      scanState,
      networkMonitor: defaultNetworkMonitor,
      playwright: defaultPlaywrightManager,
      scheduler: defaultScheduler,
      startCrawlerScan: (portalId?: string, awaitCompletion?: boolean, options?: { depth?: ScanDepth }) =>
        startCrawlerScan(portalId, awaitCompletion, {
          ...options,
          scanState,
          networkMonitor: defaultNetworkMonitor,
          playwright: defaultPlaywrightManager
        }),
      drainDocumentQueue: (opts, ctx) =>
        drainDocumentQueue(opts, {
          scanState,
          networkMonitor: defaultNetworkMonitor,
          ...ctx
        }),
      processDocumentQueue: (limit, concurrency, ctx) =>
        processDocumentQueue(limit, concurrency, {
          scanState,
          networkMonitor: defaultNetworkMonitor,
          ...ctx
        }),
      getShutdownHandler: () => defaultShutdownHandler,
      setShutdownHandler: (handler: (() => void) | null) => {
        defaultShutdownHandler = handler;
      }
    };
  }
  return defaultRuntimeContext;
}
