import { DocumentQueueStatus, ScanDepth, ScanStatus } from '../../shared/types.js';
import { PORTAL_DEFINITIONS } from '../domain/portalList.js';
import { getAppSetting, getDocumentQueueCounts, getPortalHealthList } from '../db/index.js';

export type ScanProgressEventType = 'scan_progress' | 'documents_updated' | 'doc_queue_progress';
export type ProgressListener = (status: ScanStatus, eventType?: ScanProgressEventType) => void;

function resolveActivePortalCount(): number {
  try {
    const len = getPortalHealthList().length;
    return len > 0 ? len : PORTAL_DEFINITIONS.length;
  } catch {
    return PORTAL_DEFINITIONS.length;
  }
}

function createInitialScanStatus(): ScanStatus {
  return {
    isScanning: false,
    currentPortal: null,
    activePortals: [],
    scanDepth: 'quick',
    progressPercent: 0,
    completedPortals: 0,
    totalPortals: resolveActivePortalCount(),
    newTendersFound: 0,
    corrigendaFound: 0,
    heldForScope: 0,
    lastScanTimestamp: null
  };
}

export class ScanStateStore {
  private state: ScanStatus = createInitialScanStatus();
  private scanStarting: boolean = false;
  private listeners: Set<ProgressListener> = new Set();
  private scanFinishedListeners: Set<() => void> = new Set();
  private activeDocFetchCounts: Map<string, number> = new Map();

  private cloneDocQueue(docQueue?: DocumentQueueStatus): DocumentQueueStatus | undefined {
    if (!docQueue) return undefined;
    return {
      ...docQueue,
      ...(docQueue.activeTenderIds !== undefined ? { activeTenderIds: [...docQueue.activeTenderIds] } : {})
    };
  }

  private cloneStatus(src: ScanStatus): ScanStatus {
    return {
      ...src,
      activePortals: [...(src.activePortals || [])],
      ...(src.docQueue !== undefined ? { docQueue: this.cloneDocQueue(src.docQueue) } : {})
    };
  }

  private readLastFullScanTimestamp(): string | null {
    try {
      return getAppSetting('last_full_scan_at') || null;
    } catch {
      return this.state.lastFullScanTimestamp ?? null;
    }
  }

  private broadcast(eventType: ScanProgressEventType = 'scan_progress'): void {
    const snapshot = this.getSnapshot();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(this.cloneStatus(snapshot), eventType);
      } catch {
        // Ignore stale subscriber errors
      }
    }
  }

  getSnapshot(): ScanStatus {
    const fullScanAt = this.readLastFullScanTimestamp();
    this.state.lastFullScanTimestamp = fullScanAt;
    return this.cloneStatus({
      ...this.state,
      lastFullScanTimestamp: fullScanAt
    });
  }

  isScanning(): boolean {
    return this.state.isScanning;
  }

  isStartingOrScanning(): boolean {
    return this.state.isScanning || this.scanStarting;
  }

  getDocQueue(): DocumentQueueStatus | undefined {
    return this.cloneDocQueue(this.state.docQueue);
  }

  getInFlightDocFetchTenderIds(): string[] {
    return Array.from(this.activeDocFetchCounts.keys());
  }

  tryAcquireStart(): boolean {
    if (this.state.isScanning || this.scanStarting) {
      return false;
    }
    this.scanStarting = true;
    return true;
  }

  releaseStartLock(): void {
    this.scanStarting = false;
  }

  beginScan(params: { depth: ScanDepth; totalPortals: number }): ScanStatus {
    this.state = {
      isScanning: true,
      currentPortal: null,
      activePortals: [],
      scanDepth: params.depth,
      progressPercent: 0,
      completedPortals: 0,
      totalPortals: params.totalPortals,
      newTendersFound: 0,
      corrigendaFound: 0,
      heldForScope: 0,
      pausedReason: null,
      lastScanTimestamp: this.state.lastScanTimestamp,
      ...(this.state.docQueue !== undefined ? { docQueue: this.cloneDocQueue(this.state.docQueue) } : {})
    };
    this.broadcast('scan_progress');
    return this.getSnapshot();
  }

  setActivePortals(active: string[]): void {
    this.state.activePortals = [...active];
    this.state.currentPortal = active[0] ?? null;
    this.broadcast('scan_progress');
  }

  syncTotalPortals(totalPortals?: number): void {
    if (!this.state.isScanning) {
      this.state.totalPortals = totalPortals ?? resolveActivePortalCount();
      this.broadcast('scan_progress');
    }
  }

  recordBudgetCounts(documentsDeferred: number, visionDeferred: number): void {
    this.state.documentsDeferred = documentsDeferred;
    this.state.visionDeferred = visionDeferred;
  }

  recordTenderResult(res: { isNew?: boolean; hasCorrigendum?: boolean; awaitingScope?: boolean }): void {
    if (res.isNew) this.state.newTendersFound++;
    if (res.hasCorrigendum) this.state.corrigendaFound++;
    if (res.awaitingScope) this.state.heldForScope = (this.state.heldForScope || 0) + 1;
  }

  completePortal(totalPortals: number, remainingActive: string[]): void {
    this.state.completedPortals++;
    this.state.progressPercent = Math.round((this.state.completedPortals / Math.max(1, totalPortals)) * 100);
    this.setActivePortals(remainingActive);
  }

  pauseScan(reason: string): ScanStatus {
    this.state.pausedReason = reason;
    this.broadcast('scan_progress');
    return this.getSnapshot();
  }

  finishScan(params: {
    documentsDeferred: number;
    visionDeferred: number;
    timestamp: string;
    pausedReason?: string | null;
  }): ScanStatus {
    this.state.documentsDeferred = params.documentsDeferred;
    this.state.visionDeferred = params.visionDeferred;
    this.state.isScanning = false;
    this.state.activePortals = [];
    this.state.currentPortal = null;
    this.state.lastScanTimestamp = params.timestamp;
    this.state.progressPercent = 100;
    if (params.pausedReason !== undefined) {
      this.state.pausedReason = params.pausedReason;
    }
    this.broadcast('scan_progress');
    for (const listener of Array.from(this.scanFinishedListeners)) {
      try {
        listener();
      } catch {
        // Ignore listener errors so scan completion stays clean
      }
    }
    return this.getSnapshot();
  }

  mergeLiveDocQueueStatus(docQueue: DocumentQueueStatus): DocumentQueueStatus {
    const inFlightManual = this.getInFlightDocFetchTenderIds();
    const activeTenderIds = Array.from(new Set([...(docQueue.activeTenderIds || []), ...inFlightManual]));
    const processing = Math.max(docQueue.processing ?? 0, inFlightManual.length);
    const processingTenders = Math.max(docQueue.processingTenders ?? 0, activeTenderIds.length);
    return {
      ...docQueue,
      isFetching: Boolean(docQueue.isFetching || activeTenderIds.length > 0),
      processing,
      processingTenders,
      activeTenderIds
    };
  }

  updateDocQueueStatus(
    docQueue: DocumentQueueStatus,
    options?: { documentsUpdated?: boolean }
  ): void {
    this.state.docQueue = this.mergeLiveDocQueueStatus(docQueue);
    this.broadcast(options?.documentsUpdated ? 'documents_updated' : 'doc_queue_progress');
  }

  refreshLiveDocQueueStatus(options?: { documentsUpdated?: boolean }): void {
    try {
      const counts = getDocumentQueueCounts();
      this.updateDocQueueStatus(
        {
          isFetching: Boolean(this.state.docQueue?.isFetching || counts.processing > 0),
          readyPending: counts.readyPending,
          readyTenders: counts.readyTenders,
          awaitingScopePending: counts.awaitingScopePending,
          awaitingScopeTenders: counts.awaitingScopeTenders,
          totalPending: counts.totalPending,
          processing: counts.processing,
          processingTenders: counts.processingTenders,
          activeTenderIds: counts.activeTenderIds,
          completedInRun: this.state.docQueue?.completedInRun ?? 0,
          lastUpdatedAt: this.state.docQueue?.lastUpdatedAt ?? null
        },
        options
      );
    } catch {
      // DB may not be initialized in unit tests
    }
  }

  beginDocFetch(tenderId: string): void {
    this.activeDocFetchCounts.set(tenderId, (this.activeDocFetchCounts.get(tenderId) || 0) + 1);
    this.refreshLiveDocQueueStatus();
  }

  endDocFetch(tenderId: string): void {
    const remaining = (this.activeDocFetchCounts.get(tenderId) || 1) - 1;
    if (remaining <= 0) {
      this.activeDocFetchCounts.delete(tenderId);
    } else {
      this.activeDocFetchCounts.set(tenderId, remaining);
    }
    this.refreshLiveDocQueueStatus();
  }

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  unsubscribe(listener: ProgressListener): void {
    this.listeners.delete(listener);
  }

  onScanFinished(listener: () => void): () => void {
    this.scanFinishedListeners.add(listener);
    return () => {
      this.scanFinishedListeners.delete(listener);
    };
  }

  setScanningForTest(isScanning: boolean): void {
    this.state.isScanning = Boolean(isScanning);
  }

  reset(options?: { clearListeners?: boolean }): void {
    this.state = createInitialScanStatus();
    this.scanStarting = false;
    this.activeDocFetchCounts.clear();
    if (options?.clearListeners) {
      this.listeners.clear();
      this.scanFinishedListeners.clear();
    }
  }
}

export const scanState = new ScanStateStore();
