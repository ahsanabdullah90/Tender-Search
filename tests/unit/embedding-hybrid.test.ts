import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import {
  EMBEDDING_DIM,
  MODEL_ID,
  computeFastSemanticEmbedding,
  computeTextSemanticSimilarity,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
  initEmbeddingModel,
  getEmbeddingEngineStatus
} from '../../src/server/services/embeddingService.js';
import { matchTracks } from '../../src/server/scrapers/crawlerEngine.js';
import { findCanonicalMatch, calculateStringSimilarity } from '../../src/server/services/deduplicator.js';
import {
  db,
  initDatabase,
  getAllTenders,
  saveDomainTrack,
  createManualTender
} from '../../src/server/db/index.js';
import { createApp } from '../../server.js';

describe('Local Hybrid Semantic & Keyword Engine', () => {
  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM corrigendum_logs').run();
    db.prepare('DELETE FROM pipeline_audit_logs').run();
    db.prepare('DELETE FROM tenders').run();
  });

  describe('1. Vector Math & SQLite BLOB Serialization', () => {
    it('generates L2-normalized 384-dimensional vectors', () => {
      const vec = computeFastSemanticEmbedding('Supply and installation of 100kW solar photovoltaic panels');
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(EMBEDDING_DIM);

      // Verify L2 norm is 1.0
      const simSelf = cosineSimilarity(vec, vec);
      expect(simSelf).toBeCloseTo(1.0, 4);
    });

    it('serializes and deserializes 384-dim Float32Array to a tagged 1,540-byte Buffer losslessly', () => {
      const original = computeFastSemanticEmbedding('Enterprise datacenter rack servers and SAN storage');
      const buf = serializeEmbedding(original);

      expect(buf).not.toBeNull();
      expect(buf!.byteLength).toBe(4 + EMBEDDING_DIM * 4); // 4-byte space header + 1,536 bytes

      const restored = deserializeEmbedding(buf);
      expect(restored).not.toBeNull();
      expect(restored!.length).toBe(EMBEDDING_DIM);
      expect(cosineSimilarity(original, restored)).toBeCloseTo(1.0, 5);
    });

    it('gracefully handles null or malformed buffers and empty text', () => {
      expect(serializeEmbedding(null)).toBeNull();
      expect(deserializeEmbedding(null)).toBeNull();
      expect(deserializeEmbedding(Buffer.from([1, 2, 3]))).toBeNull();

      const emptyVec = computeFastSemanticEmbedding('   ');
      expect(emptyVec.length).toBe(EMBEDDING_DIM);
      expect(cosineSimilarity(emptyVec, emptyVec)).toBe(0);
    });
  });

  describe('2. Semantic Concept Alignment & Synonym Discovery', () => {
    it('scores synonymous procurement terminology high even with zero shared keywords', () => {
      const tenderTitle = 'Commissioning of 150kW Rooftop Photovoltaic Array and Net Metering';
      const trackDefinition = 'Solar Panels Renewable Green Energy';

      const sim = computeTextSemanticSimilarity(tenderTitle, trackDefinition);
      expect(sim).toBeGreaterThanOrEqual(0.65);
    });

    it('scores unrelated procurement domains near zero', () => {
      const itTender = 'Supply of High-Performance Laptops, Rack Servers, and Network Switches';
      const medicalTrack = 'Surgical Instruments, Hospital Ventilators, and Pathology Reagents';

      const sim = computeTextSemanticSimilarity(itTender, medicalTrack);
      expect(sim).toBeLessThan(0.15);
    });

    it('rescues zero-keyword tenders via Semantic Discovery in matchTracks', () => {
      const item = {
        title: 'Supply and Commissioning of 200kW Rooftop Photovoltaic Array with Lithium Battery Bank',
        organization: 'Alternate Energy Development Board',
        referenceNo: 'AEDB-2026-104',
        description: 'Turnkey grid-tied kWp inverter installation.',
        directUrl: 'https://example.gov.pk/tender/104',
        closingDate: '2026-12-15T14:00:00+05:00'
      };

      // Notice: track only has 'solar panels' and 'clean energy' — neither phrase appears verbatim in the tender!
      const tracks = [
        {
          id: 'track-solar-minimal',
          name: 'Solar & Clean Energy',
          positive_keywords: ['solar panels', 'clean energy'],
          negative_keywords: ['janitorial', 'catering'],
          is_active: 1
        }
      ];

      const result = matchTracks(item, tracks);
      expect(result.matchedTracks).toEqual(['Solar & Clean Energy']);
      expect(result.matchedKeywords.length).toBe(1);
      expect(result.matchedKeywords[0]).toMatch(/^✨ Semantic \(\d+%\)$/);
      expect(result.matchScore).toBeGreaterThanOrEqual(60);
    });

    it('strictly enforces the Negative Keyword Gate over semantic similarity', () => {
      const itemWithNegative = {
        title: 'Hiring of Janitorial Staff for 200kW Solar Photovoltaic Power Complex',
        organization: 'WAPDA',
        referenceNo: 'WAPDA-JAN-09',
        description: 'Solar panels cleaning and janitorial services.',
        directUrl: 'https://example.gov.pk/tender/105',
        closingDate: '2026-12-15T14:00:00+05:00'
      };

      const tracks = [
        {
          id: 'track-solar',
          name: 'Solar & Clean Energy',
          positive_keywords: ['solar', 'photovoltaic', 'solar panels'],
          negative_keywords: ['janitorial'],
          is_active: 1
        }
      ];

      const result = matchTracks(itemWithNegative, tracks);
      expect(result.matchedTracks).toEqual([]);
      expect(result.matchedKeywords).toEqual([]);
      expect(result.matchScore).toBe(0);
    });
  });

  describe('3. Tier-3 Cross-Portal Semantic Deduplication', () => {
    it('identifies cross-posted duplicate tenders with reworded titles from the same organization', () => {
      const closingDate = '2026-12-20T11:00:00+05:00';
      const existingTitle = 'Supply of Laptop Computers, Rack Servers and SAN Storage';
      const candidateTitle = 'Procurement of Notebook PCs, Blade Servers and NAS Datacenter Storage';

      // Verify lexical Dice similarity is below the 0.85 threshold
      const lexicalSim = calculateStringSimilarity(
        'Higher Education Commission ' + existingTitle,
        'Higher Education Commission ' + candidateTitle
      );
      expect(lexicalSim).toBeLessThan(0.85);

      const embBuf = serializeEmbedding(computeFastSemanticEmbedding(existingTitle));
      db.prepare(`
        INSERT INTO tenders (
          id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, closing_date, embedding
        ) VALUES ('t-epads-1', 'canon-hec-it', 'epads', 'Federal PPRA', 'HEC-REF-01', ?, 'Higher Education Commission', 'https://epads.gov.pk/1', ?, ?)
      `).run(existingTitle, closingDate, embBuf);

      // Re-posted on Punjab PPRA with a different portal reference number and reworded title
      const match = findCanonicalMatch({
        referenceNo: 'PPRA-998877',
        title: candidateTitle,
        organization: 'Higher Education Commission',
        closingDate,
        embedding: serializeEmbedding(computeFastSemanticEmbedding(candidateTitle))
      });

      expect(match.isDuplicate).toBe(true);
      expect(match.canonicalId).toBe('canon-hec-it');
      expect(match.similarity).toBeGreaterThanOrEqual(0.88);
    });
  });

  describe('4. Hybrid Inbox Search & Track Re-Scoring', () => {
    it('retrieves tenders matching natural-language semantic queries in getAllTenders', () => {
      createManualTender({
        title: 'Installation of 100kW Rooftop Photovoltaic Array & Net Metering',
        organization: 'Pakistan Engineering Council',
        reference_no: 'PEC-PV-2026'
      });

      createManualTender({
        title: 'Supply of Hospital Surgical Ventilators and X-Ray Machines',
        organization: 'PIMS Islamabad',
        reference_no: 'PIMS-MED-2026'
      });

      // Search using natural-language phrase not verbatim in the first tender's title
      const solarResults = getAllTenders({ search: 'solar panels clean energy' });
      expect(solarResults.length).toBe(1);
      expect(solarResults[0].reference_no).toBe('PEC-PV-2026');
    });

    it('re-scores existing tenders using hybrid matching when a domain track is saved', () => {
      const created = createManualTender({
        title: 'Turnkey Commissioning of 250kW Grid-Tied Photovoltaic Array',
        organization: 'NUST Islamabad',
        reference_no: 'NUST-PV-99'
      });

      saveDomainTrack({
        id: 'track-custom-solar',
        name: 'Custom Solar Track',
        positive_keywords: ['solar panels', 'renewable energy'],
        negative_keywords: ['janitorial']
      });

      const updated = getAllTenders().find(t => t.id === created.id);
      expect(updated).toBeDefined();
      expect(updated!.domain_tracks).toContain('Custom Solar Track');
    });
  });

  describe('5. System Status API (/api/system/embedding-status)', () => {
    it('reports local embedding engine status and indexed tender count', async () => {
      await initEmbeddingModel();
      createManualTender({
        title: 'Construction of Concrete Bridge and Culverts',
        organization: 'National Highway Authority'
      });

      const app = createApp();
      const res = await request(app).get('/api/system/embedding-status');

      expect(res.status).toBe(200);
      expect(res.body.modelId).toBe(MODEL_ID);
      expect(res.body.dimensions).toBe(EMBEDDING_DIM);
      expect(res.body.state).toBe('ready');
      expect(res.body.indexedTenders).toBe(1);
      expect(getEmbeddingEngineStatus().dimensions).toBe(384);
    });
  });
});
