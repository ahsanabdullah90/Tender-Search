import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PORTAL_DEFINITIONS } from '../../src/server/scrapers/portalList.js';

describe('docs-consistency (QA-4 Automated Documentation Consistency)', () => {
  const rootDir = path.resolve(__dirname, '../../');
  const docsDir = path.resolve(rootDir, 'docs');

  it('proves canonical portal count in PORTAL_DEFINITIONS is exactly 18', () => {
    expect(PORTAL_DEFINITIONS).toHaveLength(18);
  });

  it('proves all source files quoted in active docs exist on disk (QA-4)', () => {
    const activeDocFiles = fs.readdirSync(docsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(docsDir, f));

    // Regex to match backticked paths starting with src/, public/, scripts/
    const pathPattern = /`((?:src|public|scripts)\/[^`#\s?]+)`/g;
    const checkedPaths = new Set<string>();
    const missingPaths: { doc: string; file: string }[] = [];

    for (const docPath of activeDocFiles) {
      const content = fs.readFileSync(docPath, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = pathPattern.exec(content)) !== null) {
        let cleanPath = match[1];
        // Strip trailing punctuation if matched inside backticks
        cleanPath = cleanPath.replace(/[),;:]+$/, '');
        // If it's a directory (ends with /), remove trailing slash
        cleanPath = cleanPath.replace(/\/$/, '');

        // Skip wildcards or placeholder templates like <portalId> or <tenderId>
        if (cleanPath.includes('<') || cleanPath.includes('*') || cleanPath.includes('[')) continue;

        checkedPaths.add(cleanPath);
        const resolved = path.resolve(rootDir, cleanPath);
        if (!fs.existsSync(resolved)) {
          missingPaths.push({ doc: path.basename(docPath), file: cleanPath });
        }
      }
    }

    expect(checkedPaths.size).toBeGreaterThan(15);
    expect(missingPaths).toEqual([]);
  });

  it('proves documented database tables exist in the schema DDL', () => {
    const schemaFile = fs.readFileSync(path.resolve(rootDir, 'src/server/db/schema.ts'), 'utf8');
    const documentedTables = [
      'tenders',
      'portal_health',
      'domain_tracks',
      'corrigendum_logs',
      'document_ingest_jobs',
      'app_settings',
      'deleted_portals',
      'deleted_tenders',
      'pending_file_purges'
    ];

    for (const table of documentedTables) {
      expect(schemaFile).toContain(table);
    }
  });
});
