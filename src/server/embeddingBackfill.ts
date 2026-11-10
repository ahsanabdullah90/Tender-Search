import {
  buildTenderEmbeddingText,
  buildTrackEmbeddingText,
  embedWithModelAsync,
  isModelEmbeddingAvailable,
  serializeEmbedding
} from './embeddingService.js';
import {
  getTendersNeedingModelEmbedding,
  setTenderEmbeddingIfUnchanged
} from './db/repositories/tendersRepo.js';
import {
  getTracksNeedingModelEmbedding,
  setTrackEmbeddingIfUnchanged
} from './db/repositories/tracksRepo.js';
import { safeJsonParse } from './db/connection.js';

export interface EmbeddingBackfillReport {
  skipped: boolean;
  tendersUpdated: number;
  tracksUpdated: number;
}

let inFlight: Promise<EmbeddingBackfillReport> | null = null;

/**
 * Upgrades stored embeddings to the MiniLM space: tenders and tracks whose vector is missing,
 * legacy-untagged (written before vectors were tagged) or fast-space (written while the model
 * was not loaded, or after an edit). Runs only when the model is loaded; otherwise it is a no-op,
 * and similarity keeps using the fast space for those rows, which is always safe.
 *
 * Only one backfill runs at a time; concurrent callers share the in-flight run.
 */
export function backfillModelEmbeddings(tenderLimit: number = 100): Promise<EmbeddingBackfillReport> {
  if (inFlight) return inFlight;
  inFlight = runBackfill(tenderLimit).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runBackfill(tenderLimit: number): Promise<EmbeddingBackfillReport> {
  const report: EmbeddingBackfillReport = { skipped: false, tendersUpdated: 0, tracksUpdated: 0 };
  if (!isModelEmbeddingAvailable()) {
    report.skipped = true;
    return report;
  }

  for (const track of getTracksNeedingModelEmbedding()) {
    const text = buildTrackEmbeddingText({
      name: track.name,
      positive_keywords: safeJsonParse<string[]>(track.positive_keywords, [])
    });
    const vec = await embedWithModelAsync(text);
    const blob = vec ? serializeEmbedding(vec, 'minilm') : null;
    if (blob && setTrackEmbeddingIfUnchanged(track, blob)) report.tracksUpdated++;
  }

  for (const tender of getTendersNeedingModelEmbedding(tenderLimit)) {
    const vec = await embedWithModelAsync(buildTenderEmbeddingText(tender));
    const blob = vec ? serializeEmbedding(vec, 'minilm') : null;
    if (blob && setTenderEmbeddingIfUnchanged(tender, blob)) report.tendersUpdated++;
  }

  if (report.tendersUpdated || report.tracksUpdated) {
    console.log(`[Embedding Engine] Backfilled MiniLM vectors: ${report.tendersUpdated} tenders, ${report.tracksUpdated} tracks.`);
  }
  return report;
}
