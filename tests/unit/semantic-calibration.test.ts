import { describe, it, expect } from 'vitest';
import { computeTextSemanticSimilarity, buildTrackEmbeddingText } from '../../src/server/embeddingService.js';
import { matchTracks } from '../../src/server/scrapers/crawlerEngine.js';
import { calculateStringSimilarity, titlesAreDistinguishable } from '../../src/server/deduplicator.js';
import { TRACK_MATCH_CALIBRATION_SET } from '../fixtures/calibration/trackMatchPairs.js';
import { DUPLICATE_CALIBRATION_SET } from '../fixtures/calibration/duplicatePairs.js';

describe('Semantic Similarity Calibration & Metric Verification (MATCH-5 & DED-7)', () => {
  describe('MATCH-5: Track-Match Threshold (0.58) Calibration on 50 Labelled Pairs', () => {
    it('evaluates at least 50 labelled tender-track pairs and verifies F1 >= 0.90', () => {
      expect(TRACK_MATCH_CALIBRATION_SET.length).toBeGreaterThanOrEqual(50);

      let tp = 0;
      let fp = 0;
      let tn = 0;
      let fn = 0;

      for (const pair of TRACK_MATCH_CALIBRATION_SET) {
        const track = {
          id: 'calib-track',
          name: pair.trackName,
          positive_keywords: pair.trackKeywords,
          negative_keywords: [],
          is_active: 1
        };

        const item = {
          title: pair.tenderTitle,
          organization: '',
          directUrl: 'https://example.gov.pk/tender',
          referenceNo: 'REF-CALIB',
          description: pair.tenderDescription || ''
        };

        const match = matchTracks(item, [track]);
        const predicted = match.matchedTracks.length > 0;

        if (pair.isMatch && predicted) tp++;
        else if (!pair.isMatch && predicted) fp++;
        else if (!pair.isMatch && !predicted) tn++;
        else if (pair.isMatch && !predicted) fn++;
      }

      const precision = tp / (tp + fp) || 0;
      const recall = tp / (tp + fn) || 0;
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

      console.log('\n--- MATCH-5 Track Matching Evaluation Summary ---');
      console.log(`- Evaluated Pairs: ${TRACK_MATCH_CALIBRATION_SET.length} (25 Positive, 25 Negative)`);
      console.log(`- Confusion Matrix: TP=${tp}, FP=${fp}, TN=${tn}, FN=${fn}`);
      console.log(`- Precision: ${(precision * 100).toFixed(2)}%`);
      console.log(`- Recall: ${(recall * 100).toFixed(2)}%`);
      console.log(`- F1-Score: ${(f1 * 100).toFixed(2)}% (Target >= 90.0%)`);

      // MATCH-5 North-Star Target: F1 >= 0.90
      expect(f1).toBeGreaterThanOrEqual(0.90);
      expect(fp).toBe(0); // Zero false-positive track matches
    });
  });

  describe('DED-7: Duplicate Detection Threshold (0.88) Calibration on 30 Labelled Pairs', () => {
    it('evaluates at least 30 labelled duplicate pairs and verifies 0% false-merge rate', () => {
      expect(DUPLICATE_CALIBRATION_SET.length).toBeGreaterThanOrEqual(30);

      const THRESHOLD = 0.88;
      let tp = 0;
      let fp = 0;
      let tn = 0;
      let fn = 0;

      for (const pair of DUPLICATE_CALIBRATION_SET) {
        const distinguishable = titlesAreDistinguishable(pair.titleA, pair.titleB);
        const lexicalSim = calculateStringSimilarity(pair.titleA, pair.titleB);
        const semanticSim = computeTextSemanticSimilarity(pair.titleA, pair.titleB);

        // Deduplication rule: Distinguishable titles are never merged (0% false merge)
        let isMatch = false;
        if (!distinguishable) {
          if (lexicalSim >= 0.85 || semanticSim >= THRESHOLD) {
            isMatch = true;
          }
        }

        if (pair.isDuplicate && isMatch) tp++;
        else if (!pair.isDuplicate && isMatch) fp++;
        else if (!pair.isDuplicate && !isMatch) tn++;
        else if (pair.isDuplicate && !isMatch) fn++;
      }

      const falseMergeRate = fp / (fp + tn);
      const precision = tp / (tp + fp) || 0;
      const recall = tp / (tp + fn) || 0;
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

      console.log('\n--- DED-7 Duplicate Detection Evaluation Summary ---');
      console.log(`- Evaluated Pairs: ${DUPLICATE_CALIBRATION_SET.length} (15 Duplicates, 15 Distinct)`);
      console.log(`- Threshold: ${THRESHOLD}`);
      console.log(`- Confusion Matrix: TP=${tp}, FP=${fp}, TN=${tn}, FN=${fn}`);
      console.log(`- Precision: ${(precision * 100).toFixed(2)}%`);
      console.log(`- False-Merge Rate: ${(falseMergeRate * 100).toFixed(2)}% (Target = 0.0%)`);

      // DED-7 North-Star Targets:
      // 1. False-Merge Rate = 0% (zero distinct tenders falsely merged!)
      expect(falseMergeRate).toBe(0);
      expect(fp).toBe(0);
      expect(precision).toBe(1.0);
    });
  });
});
