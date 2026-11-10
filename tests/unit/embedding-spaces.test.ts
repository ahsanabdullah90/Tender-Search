import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  EMBEDDING_DIM,
  EMBEDDING_BLOB_BYTES,
  computeFastSemanticEmbedding,
  computeTextSemanticSimilarity,
  serializeEmbedding,
  readEmbeddingBlob,
  getEmbeddingSpace,
  embedTextToBlobAsync,
  __setExtractorPipelineForTests
} from '../../src/server/embeddingService.js';
import { backfillModelEmbeddings } from '../../src/server/embeddingBackfill.js';
import {
  db,
  initDatabase,
  createManualTender,
  updateTenderFields,
  saveDomainTrack,
  getTendersNeedingModelEmbedding,
  setTenderEmbeddingIfUnchanged,
  countTenderEmbeddingsBySpace
} from '../../src/server/db.js';

/** Deterministic stand-in for the MiniLM pipeline: a character-histogram vector. */
const fakeMiniLm = async (text: string) => {
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 7 + i) % EMBEDDING_DIM] += 1;
  return { data: v };
};

const unitVector = (seed: number) => {
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = Math.sin(seed * (i + 1));
  let n = 0;
  for (const x of v) n += x * x;
  for (let i = 0; i < v.length; i++) v[i] /= Math.sqrt(n);
  return v;
};

const tenderBlob = (id: string) =>
  (db.prepare('SELECT embedding FROM tenders WHERE id = ?').get(id) as any)?.embedding as Buffer | null;

describe('Embedding vector spaces are never mixed', () => {
  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM corrigendum_logs').run();
    db.prepare('DELETE FROM pipeline_audit_logs').run();
    db.prepare('DELETE FROM tenders').run();
    db.prepare('DELETE FROM domain_tracks').run();
    __setExtractorPipelineForTests(null);
  });

  afterEach(() => {
    __setExtractorPipelineForTests(null);
  });

  it('tags stored vectors with their space and reads legacy BLOBs as unknown', () => {
    const v = unitVector(1);
    const fast = serializeEmbedding(v, 'fast')!;
    const model = serializeEmbedding(v, 'minilm')!;
    expect(fast.byteLength).toBe(EMBEDDING_BLOB_BYTES);
    expect(getEmbeddingSpace(fast)).toBe('fast');
    expect(getEmbeddingSpace(model)).toBe('minilm');

    const legacy = Buffer.from(v.buffer.slice(0));
    expect(legacy.byteLength).toBe(EMBEDDING_DIM * 4);
    const read = readEmbeddingBlob(legacy)!;
    expect(read.space).toBe('unknown');
    expect(read.vec[5]).toBeCloseTo(v[5], 6);

    expect(readEmbeddingBlob(Buffer.from([1, 2, 3]))).toBeNull();
  });

  it('does not compare a MiniLM vector with a fast or legacy vector', () => {
    const a = 'Supply of laptops for schools';
    const b = 'Construction of boundary wall at hospital';
    const fastOnly = computeTextSemanticSimilarity(a, b);
    const same = unitVector(7); // identical numbers on both sides would score 1.0 if compared

    expect(computeTextSemanticSimilarity(a, b, serializeEmbedding(same, 'minilm'), serializeEmbedding(same, 'fast'))).toBeCloseTo(fastOnly, 6);
    const legacy = Buffer.from(same.buffer.slice(0));
    expect(computeTextSemanticSimilarity(a, b, legacy, legacy)).toBeCloseTo(fastOnly, 6);
    // Two MiniLM vectors are compared in the MiniLM space
    expect(computeTextSemanticSimilarity(a, b, serializeEmbedding(same, 'minilm'), serializeEmbedding(same, 'minilm'))).toBeCloseTo(1.0, 5);
  });

  it('tags new embeddings by the engine that produced them', async () => {
    expect(getEmbeddingSpace(await embedTextToBlobAsync('Solar panels for BHUs'))).toBe('fast');
    __setExtractorPipelineForTests(fakeMiniLm);
    expect(getEmbeddingSpace(await embedTextToBlobAsync('Solar panels for BHUs'))).toBe('minilm');
  });

  it('keeps a MiniLM vector when an update does not change the embedded text', () => {
    const t = createManualTender({ title: 'Cloud servers supply', organization: 'PSEB' });
    const modelBlob = serializeEmbedding(unitVector(3), 'minilm')!;
    db.prepare('UPDATE tenders SET embedding = ? WHERE id = ?').run(modelBlob, t.id);

    updateTenderFields(t.id, { cached_dossiers: [{ label: 'x', localPath: '/x', mimeType: 'application/pdf' }], closing_date: '2026-12-01T09:00:00.000Z' });
    expect(getEmbeddingSpace(tenderBlob(t.id))).toBe('minilm');

    updateTenderFields(t.id, { description: 'Supply and installation of rack servers' });
    expect(getEmbeddingSpace(tenderBlob(t.id))).toBe('fast');
  });

  it('backfills legacy and fast vectors to MiniLM for tenders and tracks', async () => {
    const t1 = createManualTender({ title: 'Cloud servers supply', organization: 'PSEB' });
    const t2 = createManualTender({ title: 'Solar panels installation', organization: 'FDE' });
    db.prepare('UPDATE tenders SET embedding = ? WHERE id = ?').run(Buffer.from(unitVector(2).buffer.slice(0)), t1.id); // legacy
    saveDomainTrack({ name: 'IT', positive_keywords: ['servers'], negative_keywords: [] });

    expect((await backfillModelEmbeddings()).skipped).toBe(true); // no model loaded → no-op
    expect(getEmbeddingSpace(tenderBlob(t2.id))).toBe('fast');

    __setExtractorPipelineForTests(fakeMiniLm);
    const report = await backfillModelEmbeddings();
    expect(report.skipped).toBe(false);
    expect(report.tendersUpdated).toBe(2);
    expect(report.tracksUpdated).toBe(1);
    expect(getEmbeddingSpace(tenderBlob(t1.id))).toBe('minilm');
    expect(getEmbeddingSpace(tenderBlob(t2.id))).toBe('minilm');
    const trackBlob = (db.prepare('SELECT embedding FROM domain_tracks').get() as any).embedding;
    expect(getEmbeddingSpace(trackBlob)).toBe('minilm');

    expect(getTendersNeedingModelEmbedding()).toHaveLength(0);
    expect(countTenderEmbeddingsBySpace()).toEqual({ totalTenders: 2, indexedTenders: 2, modelIndexedTenders: 2 });
  });

  it('never overwrites a concurrent edit with a vector of the old text', () => {
    const t = createManualTender({ title: 'Cloud servers supply', organization: 'PSEB' });
    const [staleRow] = getTendersNeedingModelEmbedding();
    updateTenderFields(t.id, { title: 'Cloud servers and storage supply' });

    expect(setTenderEmbeddingIfUnchanged(staleRow, serializeEmbedding(unitVector(4), 'minilm')!)).toBe(false);
    expect(getEmbeddingSpace(tenderBlob(t.id))).toBe('fast');
  });

  it('legacy blobs in the database still deserialize for the fast fallback path', () => {
    const v = computeFastSemanticEmbedding('rack servers');
    const legacy = Buffer.from(v.buffer.slice(0));
    expect(readEmbeddingBlob(legacy)!.vec.length).toBe(EMBEDDING_DIM);
  });
});
