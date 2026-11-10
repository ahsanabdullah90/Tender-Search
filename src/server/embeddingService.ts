import { MODELS_DIR } from './db/connection.js';

export const EMBEDDING_DIM = 384;
export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export type EmbeddingModelState = 'uninitialized' | 'initializing' | 'ready' | 'fallback_keyword_only';

let modelState: EmbeddingModelState = 'uninitialized';
let lastModelError: string | null = null;
let extractorPipeline: any = null;
let initPromise: Promise<boolean> | null = null;

// In-memory LRU cache for ONNX embeddings (maps normalized text -> 384-dim Float32Array)
const MAX_CACHE_ENTRIES = 2500;
const onnxEmbeddingCache = new Map<string, Float32Array>();

// In-memory LRU cache for Fast Concept & Subword embeddings
const fastEmbeddingCache = new Map<string, Float32Array>();

/**
 * Procurement concept synonym clusters for Pakistani & international public tenders.
 * Projects semantically identical industry terminology onto shared concept dimensions (dims 0..63),
 * while dims 64..383 capture morphological stems, word bigrams, and character n-grams.
 */
const PROCUREMENT_CONCEPT_CLUSTERS: { id: number; weight: number; terms: string[] }[] = [
  {
    id: 0,
    weight: 2.6,
    terms: [
      'solar', 'solarization', 'photovoltaic', 'pv system', 'pv array', 'pv module', 'pv panel',
      'rooftop pv', 'inverter', 'net metering', 'hybrid solar', 'clean energy', 'renewable energy',
      'green energy', 'battery bank', 'lithium battery', 'tubewell solar', 'off grid', 'grid tied',
      'sunlight', 'solar powered', 'solar street light', 'bifacial', 'monocrystalline', 'kilowatt peak', 'kwp'
    ]
  },
  {
    id: 1,
    weight: 2.5,
    terms: [
      'construction', 'civil works', 'civil engineering', 'renovation', 'rehabilitation', 'refurbishment',
      'infrastructure', 'masonry', 'building repair', 'prefabricated', 'asphalt', 'earthwork', 'excavation',
      'concreting', 'rcc', 'pcc', 'road construction', 'highway', 'pavement', 'bridge', 'culvert',
      'drainage', 'sewerage', 'boundary wall', 'tiling', 'plastering', 'waterproofing', 'steel structure'
    ]
  },
  {
    id: 2,
    weight: 2.5,
    terms: [
      'it hardware', 'computer', 'laptop', 'notebook', 'desktop', 'workstation', 'all in one pc',
      'server', 'rack server', 'blade server', 'datacenter', 'data center', 'storage area network',
      'san', 'nas', 'ups', 'network switch', 'router', 'firewall', 'access point', 'wifi',
      'fiber optic', 'peripherals', 'printer', 'scanner', 'multimedia projector', 'led display', 'computing'
    ]
  },
  {
    id: 3,
    weight: 2.5,
    terms: [
      'software', 'erp', 'enterprise resource planning', 'cloud', 'saas', 'database', 'application development',
      'web portal', 'mobile app', 'management information system', 'mis', 'hmis', 'lmis', 'cybersecurity',
      'information security', 'siem', 'antivirus', 'endpoint protection', 'license renewal', 'microsoft',
      'oracle', 'sap', 'digitization', 'automation system', 'artificial intelligence', 'gis'
    ]
  },
  {
    id: 4,
    weight: 2.5,
    terms: [
      'medical', 'hospital', 'healthcare', 'clinical', 'surgical', 'diagnostic', 'laboratory equipment',
      'biomedical', 'radiology', 'xray', 'x ray', 'ultrasound', 'ct scan', 'mri', 'ventilator',
      'defibrillator', 'patient monitor', 'anesthesia', 'autoclave', 'dialysis', 'endoscopy',
      'pathology', 'reagents', 'pharmaceutical', 'medicine', 'drugs', 'vaccine', 'surgical instruments', 'icu'
    ]
  },
  {
    id: 5,
    weight: 2.4,
    terms: [
      'electrical', 'transformer', 'substation', 'grid station', 'switchgear', 'circuit breaker',
      'transmission line', 'distribution line', 'ht cable', 'lt cable', 'conductor', 'insulator',
      'generator', 'genset', 'diesel generator', 'avr', 'control panel', 'electrification',
      'energy meter', 'ami meter', 'smart meter', 'power system'
    ]
  },
  {
    id: 6,
    weight: 2.4,
    terms: [
      'hvac', 'air conditioning', 'chiller', 'cooling tower', 'air handling unit', 'ahu',
      'vrf', 'split ac', 'inverter ac', 'ventilation', 'ducting', 'heating system', 'refrigeration', 'cold storage'
    ]
  },
  {
    id: 7,
    weight: 2.4,
    terms: [
      'cctv', 'surveillance', 'ip camera', 'nvr', 'dvr', 'video wall', 'access control',
      'biometric', 'turnstile', 'walkthrough gate', 'metal detector', 'baggage scanner',
      'fire alarm', 'firefighting', 'fire suppression', 'smoke detector', 'intrusion detection'
    ]
  },
  {
    id: 8,
    weight: 2.4,
    terms: [
      'water supply', 'filtration plant', 'reverse osmosis', 'ro plant', 'water treatment',
      'wastewater', 'effluent treatment', 'submersible pump', 'centrifugal pump', 'pumping machinery',
      'tubewell', 'borehole', 'hdpe pipe', 'pprc pipe', 'pipeline', 'irrigation', 'canal', 'dam'
    ]
  },
  {
    id: 9,
    weight: 2.3,
    terms: [
      'vehicle', 'automobile', 'pickup', 'double cabin', 'suv', 'sedan', 'motorcycle', 'ambulance',
      'bus', 'coaster', 'truck', 'tractor', 'excavator', 'backhoe loader', 'crane', 'forklift',
      'spare parts', 'tyres', 'tires', 'fleet', 'lubricants'
    ]
  },
  {
    id: 10,
    weight: 2.3,
    terms: [
      'consultancy', 'consultant', 'advisory', 'feasibility study', 'design and supervision',
      'third party validation', 'tpv', 'audit', 'financial audit', 'technical evaluation',
      'environmental impact assessment', 'eia', 'master plan', 'survey', 'topographic', 'geotechnical'
    ]
  },
  {
    id: 11,
    weight: 2.3,
    terms: [
      'training', 'capacity building', 'skill development', 'vocational', 'curriculum',
      'educational equipment', 'science lab', 'teaching aids', 'smart classroom', 'scholarship'
    ]
  },
  {
    id: 12,
    weight: 2.2,
    terms: [
      'furniture', 'office furniture', 'workstation desk', 'executive chair', 'revolving chair',
      'classroom furniture', 'almirah', 'racking', 'shelving', 'interior fitout', 'furnishing'
    ]
  },
  {
    id: 13,
    weight: 2.2,
    terms: [
      'telecom', 'telecommunication', 'pabx', 'ip pbx', 'voip', 'call center', 'radio communication',
      'vhf', 'uhf', 'microwave link', 'satellite', 'vsat', 'optical fiber'
    ]
  }
];

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'under', 'into', 'near', 'of', 'in', 'on', 'at', 'to', 'by',
  'as', 'is', 'are', 'be', 'or', 'an', 'a', 'tender', 'notice', 'inviting', 'invitation', 'bids',
  'bid', 'bidding', 'sealed', 'quotations', 'quotation', 'rfp', 'rfq', 'eoi', 'prequalification',
  'pakistan', 'government', 'ministry', 'department', 'authority', 'directorate', 'office', 'project',
  'limited', 'ltd', 'pvt', 'public', 'sector', 'year', 'fy', '2025', '2026', '2027'
]);

/**
 * Normalizes text for embedding and token extraction.
 */
export function normalizeEmbeddingText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lightweight morphological stemmer for English procurement terms.
 */
function stemToken(word: string): string {
  if (word.length <= 2) {
    if (word === 'pv') return 'solar';
    if (word === 'pc') return 'computer';
    return word;
  }
  // Canonical procurement root synonyms
  if (word === 'procurement' || word === 'supply' || word === 'provision' || word === 'delivery') return 'supply';
  if (word === 'notebook' || word === 'notebooks' || word.startsWith('laptop')) return 'laptop';
  if (word === 'pcs' || word === 'desktop' || word === 'desktops' || word.startsWith('comput')) return 'computer';
  if (word === 'san' || word === 'nas' || word === 'datacenter') return 'storage';
  if (word === 'rack' || word === 'blade') return 'server';
  if (word.startsWith('solar') || word.startsWith('photovolt')) return 'solar';
  if (word.startsWith('construct')) return 'construct';
  if (word.startsWith('renovat') || word.startsWith('rehabilitat') || word.startsWith('refurbish')) return 'renovat';
  if (word.startsWith('medic') || word.startsWith('hospital') || word.startsWith('clinic')) return 'medic';
  if (word.startsWith('surgic')) return 'surgic';
  if (word.startsWith('diagnost')) return 'diagnost';
  if (word.startsWith('electr')) return 'electr';
  if (word.startsWith('consult') || word.startsWith('advis')) return 'consult';
  if (word.startsWith('netw')) return 'network';
  if (word.startsWith('workstation')) return 'workstation';

  return word
    .replace(/(ization|isation|ational|fulness|ousness|iveness)$/, '')
    .replace(/(ments|ment|tions|tion|ings|ing|ance|ence|able|ible)$/, '')
    .replace(/(ies)$/, 'y')
    .replace(/(es|ed|s)$/, '');
}

/**
 * Fast FNV-1a 32-bit hash for deterministic feature projection.
 */
function fnv1aHash(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * L2-normalizes a Float32Array in place and returns it.
 */
export function normalizeVectorL2(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  if (sumSq > 1e-12) {
    const invNorm = 1.0 / Math.sqrt(sumSq);
    for (let i = 0; i < vec.length; i++) {
      vec[i] *= invNorm;
    }
  }
  return vec;
}

/**
 * Vector spaces. Both produce 384-dim vectors, but their coordinates mean entirely different
 * things: a cosine between a 'fast' vector and a 'minilm' vector is meaningless noise. Every
 * stored BLOB therefore carries a 4-byte header naming its space, and similarity is only ever
 * computed between two vectors of the same space.
 */
export type EmbeddingSpace = 'fast' | 'minilm';
export type StoredEmbeddingSpace = EmbeddingSpace | 'unknown';

const BLOB_MAGIC = [0x45, 0x56]; // "EV"
const BLOB_VERSION = 1;
const BLOB_HEADER_BYTES = 4;
const SPACE_CODES: Record<EmbeddingSpace, number> = { fast: 1, minilm: 2 };
export const EMBEDDING_BLOB_BYTES = BLOB_HEADER_BYTES + EMBEDDING_DIM * 4; // 1,540
/** SQLite hex literal of the header of a MiniLM-tagged BLOB, for repository queries. */
export const MINILM_BLOB_HEADER_HEX = '45560102';

/**
 * Serializes a 384-dimensional Float32Array into a tagged 1,540-byte SQLite BLOB
 * (4-byte header naming the vector space + 1,536 bytes of float32 data).
 */
export function serializeEmbedding(vec: Float32Array | null | undefined, space: EmbeddingSpace = 'fast'): Buffer | null {
  if (!vec || vec.length !== EMBEDDING_DIM) return null;
  const out = Buffer.alloc(EMBEDDING_BLOB_BYTES);
  out[0] = BLOB_MAGIC[0];
  out[1] = BLOB_MAGIC[1];
  out[2] = BLOB_VERSION;
  out[3] = SPACE_CODES[space];
  Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).copy(out, BLOB_HEADER_BYTES);
  return out;
}

/**
 * Reads a stored embedding BLOB. Legacy untagged 1,536-byte BLOBs (written before tagging) are
 * returned with space 'unknown': they may be MiniLM or fast vectors and must not be compared.
 */
export function readEmbeddingBlob(
  buf: Buffer | Uint8Array | null | undefined
): { vec: Float32Array; space: StoredEmbeddingSpace } | null {
  if (!buf) return null;
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 0;
  let space: StoredEmbeddingSpace = 'unknown';

  if (
    bytes.byteLength === EMBEDDING_BLOB_BYTES &&
    bytes[0] === BLOB_MAGIC[0] && bytes[1] === BLOB_MAGIC[1] && bytes[2] === BLOB_VERSION
  ) {
    offset = BLOB_HEADER_BYTES;
    space = bytes[3] === SPACE_CODES.minilm ? 'minilm' : bytes[3] === SPACE_CODES.fast ? 'fast' : 'unknown';
  } else if (bytes.byteLength !== EMBEDDING_DIM * 4) {
    return null;
  }

  const copy = new Uint8Array(EMBEDDING_DIM * 4);
  copy.set(bytes.subarray(offset, offset + EMBEDDING_DIM * 4));
  return { vec: new Float32Array(copy.buffer), space };
}

/**
 * Deserializes a stored BLOB (tagged or legacy) back into a 384-dimensional Float32Array.
 */
export function deserializeEmbedding(buf: Buffer | Uint8Array | null | undefined): Float32Array | null {
  return readEmbeddingBlob(buf)?.vec ?? null;
}

/** Returns the vector space a stored BLOB belongs to, or null for a missing/malformed BLOB. */
export function getEmbeddingSpace(buf: Buffer | Uint8Array | null | undefined): StoredEmbeddingSpace | null {
  return readEmbeddingBlob(buf)?.space ?? null;
}

/**
 * Computes Cosine Similarity between two 384-dimensional vectors in [-1.0, 1.0].
 * Returns 0 if either vector is null, mismatched, or zero-norm.
 */
export function cosineSimilarity(
  a: Float32Array | null | undefined,
  b: Float32Array | null | undefined
): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA <= 1e-12 || normB <= 1e-12) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Synchronous, deterministic 384-dimensional Semantic & Subword Embedder (< 0.1ms).
 * Projects domain concept clusters onto dims [0..63] and stemmed unigrams/bigrams/char-ngrams
 * onto dims [64..383] using signed random projection, followed by L2 unit normalization.
 */
export function computeFastSemanticEmbedding(rawText: string): Float32Array {
  const norm = normalizeEmbeddingText(rawText);
  if (!norm) return new Float32Array(EMBEDDING_DIM);

  const cached = fastEmbeddingCache.get(norm);
  if (cached) return cached;

  const vec = new Float32Array(EMBEDDING_DIM);
  const padded = ` ${norm} `;

  // 1. Project Domain Concept Clusters onto dimensions 0..63 (multi-index spread per cluster)
  for (const cluster of PROCUREMENT_CONCEPT_CLUSTERS) {
    let hits = 0;
    for (const term of cluster.terms) {
      if (padded.includes(` ${term} `) || (term.length >= 5 && norm.includes(term))) {
        hits++;
      }
    }
    if (hits > 0) {
      // Saturating log boost so 1 hit gives strong concept activation and multiple hits reinforce it
      const mag = cluster.weight * (1 + Math.log1p(hits));
      const baseDim = (cluster.id * 4) % 64;
      vec[baseDim] += mag;
      vec[baseDim + 1] += mag * 0.85;
      vec[baseDim + 2] += mag * 0.7;
      vec[baseDim + 3] += mag * 0.55;
    }
  }

  // 2. Project Stemmed Tokens & Word Bigrams onto dimensions 64..383
  const rawTokens = norm.split(' ').filter(t => t.length >= 2 && !STOP_WORDS.has(t));
  const stemmedTokens = rawTokens.map(stemToken);

  for (let i = 0; i < stemmedTokens.length; i++) {
    const stem = stemmedTokens[i];
    const h1 = fnv1aHash(stem, 0x811c9dc5);
    const h2 = fnv1aHash(stem, 0x9e3779b9);

    const idx1 = 64 + (h1 % 320);
    const sign1 = (h1 & 1) === 0 ? 1.0 : -1.0;
    vec[idx1] += sign1 * 1.25;

    const idx2 = 64 + (h2 % 320);
    const sign2 = (h2 & 1) === 0 ? 1.0 : -1.0;
    vec[idx2] += sign2 * 0.9;

    // Word bigram projection
    if (i < stemmedTokens.length - 1) {
      const bigram = `${stem}_${stemmedTokens[i + 1]}`;
      const hb = fnv1aHash(bigram, 0x85ebca6b);
      const idxB = 64 + (hb % 320);
      const signB = (hb & 1) === 0 ? 1.0 : -1.0;
      vec[idxB] += signB * 0.85;
    }

    // Character 4-grams for typo & transliteration resilience
    if (stem.length >= 4) {
      for (let c = 0; c <= stem.length - 4; c++) {
        const cgram = stem.slice(c, c + 4);
        const hc = fnv1aHash(cgram, 0xc2b2ae35);
        const idxC = 64 + (hc % 320);
        const signC = (hc & 1) === 0 ? 1.0 : -1.0;
        vec[idxC] += signC * 0.25;
      }
    }
  }

  normalizeVectorL2(vec);

  if (fastEmbeddingCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = fastEmbeddingCache.keys().next().value;
    if (oldestKey !== undefined) fastEmbeddingCache.delete(oldestKey);
  }
  fastEmbeddingCache.set(norm, vec);

  return vec;
}

/**
 * Initializes the local ONNX `Xenova/all-MiniLM-L6-v2` pipeline in the background.
 * Never throws; gracefully transitions to `fallback_keyword_only` if offline or in test mode.
 */
export async function initEmbeddingModel(forceInitInTest = false): Promise<boolean> {
  if (modelState === 'ready' && extractorPipeline) return true;
  if (initPromise) return initPromise;

  // In automated unit/integration tests, skip downloading 23MB unless explicitly testing ONNX loader
  if ((process.env.VITEST || process.env.NODE_ENV === 'test') && !forceInitInTest) {
    modelState = 'ready';
    return true;
  }

  modelState = 'initializing';
  initPromise = (async () => {
    try {
      const transformers = await import('@huggingface/transformers');
      transformers.env.cacheDir = MODELS_DIR;
      transformers.env.allowLocalModels = true;

      extractorPipeline = await transformers.pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8'
      });
      modelState = 'ready';
      lastModelError = null;
      return true;
    } catch (err: any) {
      lastModelError = err?.message || 'ONNX model initialization failed';
      modelState = 'fallback_keyword_only';
      extractorPipeline = null;
      console.warn(`[Embedding Engine] Local ONNX pipeline unavailable (${lastModelError}). Using built-in concept & keyword hybrid engine.`);
      return false;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Generates a 384-dimensional neural ONNX embedding asynchronously if the ONNX pipeline is loaded,
 * or falls back seamlessly to `computeFastSemanticEmbedding`.
 */
export async function generateEmbeddingAsync(rawText: string): Promise<Float32Array> {
  return (await generateEmbeddingWithSpaceAsync(rawText)).vec;
}

/**
 * Like generateEmbeddingAsync, but also reports which vector space the result is in, so callers
 * that persist it can tag the BLOB correctly. Falls back to the fast space when the model is
 * not loaded (e.g. during startup) or inference fails.
 */
export async function generateEmbeddingWithSpaceAsync(rawText: string): Promise<{ vec: Float32Array; space: EmbeddingSpace }> {
  const norm = normalizeEmbeddingText(rawText);
  if (!norm) return { vec: new Float32Array(EMBEDDING_DIM), space: 'fast' };
  const modelVec = await embedWithModelAsync(norm);
  if (modelVec) return { vec: modelVec, space: 'minilm' };
  return { vec: computeFastSemanticEmbedding(norm), space: 'fast' };
}

/** Embeds text and returns a correctly tagged BLOB ready to store. */
export async function embedTextToBlobAsync(rawText: string): Promise<Buffer | null> {
  const { vec, space } = await generateEmbeddingWithSpaceAsync(rawText);
  return serializeEmbedding(vec, space);
}

/** True when the MiniLM pipeline is loaded and can produce 'minilm' vectors. */
export function isModelEmbeddingAvailable(): boolean {
  return Boolean(extractorPipeline);
}

/**
 * Returns a MiniLM vector for the text, or null when the model is unavailable. Never falls back
 * to the fast space, so the result is always safe to tag as 'minilm'.
 */
export async function embedWithModelAsync(rawText: string): Promise<Float32Array | null> {
  const norm = normalizeEmbeddingText(rawText);
  if (!norm) return null;

  const cachedOnnx = onnxEmbeddingCache.get(norm);
  if (cachedOnnx) return cachedOnnx;
  if (!extractorPipeline) return null;

  try {
    const output = await extractorPipeline(norm, { pooling: 'mean', normalize: true });
    if (output && output.data && output.data.length === EMBEDDING_DIM) {
      const vec = new Float32Array(output.data);
      normalizeVectorL2(vec);
      if (onnxEmbeddingCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = onnxEmbeddingCache.keys().next().value;
        if (oldest !== undefined) onnxEmbeddingCache.delete(oldest);
      }
      onnxEmbeddingCache.set(norm, vec);
      return vec;
    }
  } catch (err: any) {
    console.warn('[Embedding Engine] ONNX inference warning, using fast semantic fallback:', err?.message);
  }
  return null;
}

/**
 * Test seam: installs a fake feature-extraction pipeline (or removes it with null) so the
 * MiniLM code paths can be exercised without loading the 22 MB model.
 */
export function __setExtractorPipelineForTests(pipeline: any): void {
  extractorPipeline = pipeline;
  onnxEmbeddingCache.clear();
}

/**
 * Computes semantic similarity between two texts in [0.0, 1.0].
 * The fast concept-space similarity is always computed from the texts themselves. A MiniLM
 * similarity is added only when BOTH sides have a MiniLM vector (a 'minilm'-tagged BLOB or the
 * in-memory model cache). Fast-tagged and legacy untagged BLOBs are never compared against
 * MiniLM vectors, because the two coordinate spaces are unrelated.
 */
export function computeTextSemanticSimilarity(
  textA: string,
  textB: string,
  precomputedBlobA?: Buffer | Uint8Array | null,
  precomputedBlobB?: Buffer | Uint8Array | null
): number {
  const normA = normalizeEmbeddingText(textA);
  const normB = normalizeEmbeddingText(textB);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1.0;

  // 1. Always compute Concept & Subword 384-dim similarity (same coordinate space)
  const fastA = computeFastSemanticEmbedding(normA);
  const fastB = computeFastSemanticEmbedding(normB);
  const fastSim = Math.max(0, cosineSimilarity(fastA, fastB));

  // 2. If both sides have a MiniLM vector, also compute similarity in the MiniLM space.
  // A stored BLOB is preferred over the cache because it describes the stored record's full text.
  const vecA = minilmVectorFor(normA, precomputedBlobA);
  const vecB = minilmVectorFor(normB, precomputedBlobB);
  if (vecA && vecB) {
    const blobSim = Math.max(0, cosineSimilarity(vecA, vecB));
    return Math.max(fastSim, blobSim);
  }

  return fastSim;
}

function minilmVectorFor(norm: string, blob?: Buffer | Uint8Array | null): Float32Array | null {
  const stored = readEmbeddingBlob(blob);
  if (stored && stored.space === 'minilm') return stored.vec;
  return onnxEmbeddingCache.get(norm) || null;
}

/**
 * Builds the canonical text representation of a Domain Track for semantic embedding.
 */
export function buildTrackEmbeddingText(track: { name: string; positive_keywords: string[] }): string {
  return `${track.name} ${(track.positive_keywords || []).join(' ')}`;
}

/**
 * Builds the canonical text representation of a Tender for semantic embedding.
 */
export function buildTenderEmbeddingText(tender: {
  title: string;
  description?: string | null;
  organization?: string | null;
}): string {
  return `${tender.title || ''} ${tender.description || ''} ${tender.organization || ''}`.trim();
}

/**
 * Returns the current operational status of the embedding engine.
 */
export function getEmbeddingEngineStatus() {
  return {
    modelId: MODEL_ID,
    dimensions: EMBEDDING_DIM,
    state: modelState,
    onnxPipelineLoaded: Boolean(extractorPipeline),
    cachedOnnxVectors: onnxEmbeddingCache.size,
    cachedConceptVectors: fastEmbeddingCache.size,
    lastError: lastModelError
  };
}
