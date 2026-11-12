import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { extractFromDocument } from '../../src/server/documentExtractor.js';

describe('DOC-10: Local Document Reading & Two-Stage Extraction Benchmark', () => {
  const DOSSIERS_DIR = path.resolve(process.cwd(), 'data', 'dossiers');

  it('evaluates at least 15 real cached PDFs and verifies two-stage routing and latency', async () => {
    if (!fs.existsSync(DOSSIERS_DIR)) {
      console.warn('data/dossiers directory not found, skipping live PDF benchmark');
      return;
    }

    const folders = fs.readdirSync(DOSSIERS_DIR);
    const pdfFiles: { name: string; fullPath: string }[] = [];

    for (const f of folders) {
      const fPath = path.join(DOSSIERS_DIR, f);
      if (fs.statSync(fPath).isDirectory()) {
        const files = fs.readdirSync(fPath).filter(x => x.toLowerCase().endsWith('.pdf'));
        for (const file of files) {
          pdfFiles.push({ name: file, fullPath: path.join(fPath, file) });
        }
      }
    }

    expect(pdfFiles.length).toBeGreaterThanOrEqual(15);
    const sample = pdfFiles.slice(0, 20);

    let digitalCount = 0;
    let scannedCount = 0;
    let totalTimeMs = 0;

    for (const item of sample) {
      const buf = fs.readFileSync(item.fullPath);
      const start = performance.now();
      const res = await extractFromDocument(buf, 'application/pdf', item.name, {
        allowVisionCall: () => false,
        allowAiCrossCheck: false
      });
      const elapsed = performance.now() - start;
      totalTimeMs += elapsed;

      if (res.textChars >= 200) {
        digitalCount++;
        expect(res.extractionMethod).toBe('local_text_regex');
      } else {
        scannedCount++;
        expect(res.extractionMethod).toBe('none');
      }
    }

    const avgTimeMs = totalTimeMs / sample.length;
    console.log(`\n--- DOC-10 Benchmark Summary ---`);
    console.log(`- Evaluated Real PDFs: ${sample.length}`);
    console.log(`- Digital Text Layer Extracted Locally: ${digitalCount}/${sample.length} (${Math.round((digitalCount / sample.length) * 100)}%)`);
    console.log(`- Scanned / Needs Vision Fallback: ${scannedCount}/${sample.length} (${Math.round((scannedCount / sample.length) * 100)}%)`);
    console.log(`- Average Extraction Latency: ${avgTimeMs.toFixed(1)} ms per document (Target < 500ms)`);

    // Architectural targets:
    // 1. Digital extraction rate >= 60%
    expect(digitalCount / sample.length).toBeGreaterThanOrEqual(0.60);
    // 2. Average local latency < 500 ms (zero API cost)
    expect(avgTimeMs).toBeLessThan(500);
  });
});
