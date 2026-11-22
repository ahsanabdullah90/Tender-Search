import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PORTAL_DEFINITIONS } from '../../src/server/scrapers/portalList.js';

describe('docs-consistency (QA-4 Automated Documentation Consistency)', () => {
  const rootDir = path.resolve(__dirname, '../../');
  const docsDir = path.resolve(rootDir, 'docs');

  it('proves canonical portal count in PORTAL_DEFINITIONS is exactly 19', () => {
    expect(PORTAL_DEFINITIONS).toHaveLength(19);
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

  it('proves North Star requirements register has unique IDs, existing proof files, and zero untested active rows (QA-4)', () => {
    const northStarPath = path.resolve(docsDir, '13-north-star-quality-standard.md');
    const content = fs.readFileSync(northStarPath, 'utf8');
    const sec3 = content.split('## 4.')[0];
    const rowPattern = /^\|\s*([A-Z]+-\d+)\s*\|\s*[^|]+\|\s*[^|]+\|\s*([^|]+)\|\s*([^|]+)\|/gm;

    const seenIds = new Set<string>();
    const duplicateIds: string[] = [];
    const missingProofFiles: string[] = [];
    const untestedRows: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = rowPattern.exec(sec3)) !== null) {
      const [, id, provenBy, status] = match;
      if (seenIds.has(id)) duplicateIds.push(id);
      seenIds.add(id);

      const testMatches = provenBy.match(/tests\/[A-Za-z0-9_.\-/]+/g) || [];
      for (const rel of testMatches) {
        const cleaned = rel.replace(/\/$/, '');
        if (!fs.existsSync(path.resolve(rootDir, cleaned))) {
          missingProofFiles.push(`${id}: ${cleaned}`);
        }
      }

      if (!/Withdrawn|Decision needed/i.test(status) && /\buntested\b/i.test(status)) {
        untestedRows.push(`${id}: ${status.trim()}`);
      }
    }

    expect(seenIds.size).toBeGreaterThanOrEqual(55);
    expect(duplicateIds).toEqual([]);
    expect(missingProofFiles).toEqual([]);
    expect(untestedRows).toEqual([]);
  });

  it('proves every table and column in schema.ts is documented in docs/03-database-schema.md (QA-4)', () => {
    const schemaFile = fs.readFileSync(path.resolve(rootDir, 'src/server/db/schema.ts'), 'utf8');
    const doc03 = fs.readFileSync(path.resolve(docsDir, '03-database-schema.md'), 'utf8');

    const tablePattern = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/gi;
    const schemaTables = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = tablePattern.exec(schemaFile)) !== null) {
      schemaTables.add(match[1].toLowerCase());
    }

    const createBlockPattern = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+\w+\s*\(([\s\S]*?)\);/gi;
    const schemaCols = new Set<string>();
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = createBlockPattern.exec(schemaFile)) !== null) {
      for (const line of blockMatch[1].split('\n')) {
        const colMatch = line.trim().match(/^([a-z_][a-z0-9_]*)\s+(?:TEXT|INTEGER|REAL|BLOB)\b/i);
        if (colMatch) schemaCols.add(colMatch[1]);
      }
    }
    for (const alterMatch of schemaFile.matchAll(/ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/gi)) {
      schemaCols.add(alterMatch[1]);
    }

    const undocumentedTables = [...schemaTables].filter(t => !doc03.includes(t));
    const undocumentedCols = [...schemaCols].filter(c => !doc03.includes(c));
    expect(schemaTables.size).toBeGreaterThanOrEqual(10);
    expect(undocumentedTables).toEqual([]);
    expect(undocumentedCols).toEqual([]);
  });

  it('proves every source module (server, client, shared) and script is documented (QA-4)', () => {
    const doc02 = fs.readFileSync(path.resolve(docsDir, '02-architecture-and-stack.md'), 'utf8');
    const doc11 = fs.readFileSync(path.resolve(docsDir, '11-configuration-and-env.md'), 'utf8');

    const walk = (dir: string): string[] => {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...walk(full));
        else results.push(full);
      }
      return results;
    };

    const srcRoots = ['src/server', 'src/client', 'src/shared'];
    const missingModules: string[] = [];
    for (const relRoot of srcRoots) {
      for (const absFile of walk(path.resolve(rootDir, relRoot))) {
        const rel = path.relative(rootDir, absFile).replace(/\\/g, '/');
        if (!/\.(ts|tsx|css)$/.test(rel) || rel.endsWith('.d.ts')) continue;
        const base = path.basename(rel);
        if (base === 'index.ts' && !rel.startsWith('src/client/components/inbox/')) continue;
        if (!doc02.includes(base)) {
          missingModules.push(rel);
        }
      }
    }

    const missingScripts = fs.readdirSync(path.resolve(rootDir, 'scripts'))
      .filter(f => !doc11.includes(f));

    expect(missingModules).toEqual([]);
    expect(missingScripts).toEqual([]);
  });

  it('proves canonical REST endpoints match docs/04-api-reference.md and docs/06 avoids retired EPADS (QA-4)', () => {
    const doc04 = fs.readFileSync(path.resolve(docsDir, '04-api-reference.md'), 'utf8');
    const doc06 = fs.readFileSync(path.resolve(docsDir, '06-pipeline-and-workflow.md'), 'utf8');

    const requiredEndpoints = [
      '/api/tenders',
      '/api/tenders/portal-summary',
      '/api/tenders/:id',
      '/api/portals',
      '/api/tracks',
      '/api/kpis',
      '/api/corrigenda',
      '/api/scan/start',
      '/api/scan/status',
      '/api/scan/progress',
      '/api/storage',
      '/api/system/ingest-budgets',
      '/api/system/retention',
      '/api/system/embedding-status',
      '/api/system/logs',
      '/api/system/digest',
      '/api/backups',
      '/api/dossiers/:tenderId/:filename',
      '/api/export/csv',
      '/api/ai/status',
      '/api/ai/config',
      '/api/ai/extract-file',
      '/api/system/shutdown',
      '/api/system/network'
    ];
    const missingEndpoints = requiredEndpoints.filter(ep => !doc04.includes(ep));
    expect(missingEndpoints).toEqual([]);
    expect(doc06).not.toMatch(/\bEPADS\b/);
  });

  it('proves canonical PORTAL_DEFINITIONS IDs & schema sync with docs/05 and operational docs avoid retired epads (QA-4)', () => {
    const doc01 = fs.readFileSync(path.resolve(docsDir, '01-overview.md'), 'utf8');
    const doc03 = fs.readFileSync(path.resolve(docsDir, '03-database-schema.md'), 'utf8');
    const doc04 = fs.readFileSync(path.resolve(docsDir, '04-api-reference.md'), 'utf8');
    const doc05 = fs.readFileSync(path.resolve(docsDir, '05-portals-and-scraping.md'), 'utf8');
    const doc13 = fs.readFileSync(path.resolve(docsDir, '13-north-star-quality-standard.md'), 'utf8');

    const missingFromDoc05 = PORTAL_DEFINITIONS.map(p => p.id).filter(id => !doc05.includes(`\`${id}\``));
    expect(missingFromDoc05).toEqual([]);

    expect(doc05).toContain('PortalDefinition');
    expect(doc05).not.toContain('UnifiedPortalConfig');
    expect(doc13).not.toContain('UnifiedPortalConfig');

    expect(doc01).not.toMatch(/Federal PPRA\/EPADS/i);
    expect(doc03).not.toContain('`epads`');
    expect(doc04).not.toContain('Federal PPRA (EPADS)');
  });

  it('proves baseline version matches across docs/12, docs/13, and docs/14 and bans brittle test counts (QA-4)', () => {
    const doc12 = fs.readFileSync(path.resolve(docsDir, '12-decisions-and-changelog.md'), 'utf8');
    const doc13 = fs.readFileSync(path.resolve(docsDir, '13-north-star-quality-standard.md'), 'utf8');
    const doc14 = fs.readFileSync(path.resolve(docsDir, '14-active-backlog.md'), 'utf8');

    const ver13 = doc13.match(/\*\*Applies to:\*\*\s*v(\d+\.\d+\.\d+)/)?.[1];
    const ver14 = doc14.match(/\*\*System Baseline:\*\*\s*v(\d+\.\d+\.\d+)/)?.[1];
    expect(ver13).toBeTruthy();
    expect(ver14).toBe(ver13);
    expect(doc12).toContain(`### Version ${ver13}`);

    const filesToCheck = [
      path.resolve(rootDir, 'README.md'),
      ...fs.readdirSync(docsDir)
        .filter(f => /^\d{2}-.*\.md$/.test(f))
        .map(f => path.join(docsDir, f))
    ];
    const brittleCountFiles: string[] = [];
    const currentFiles = ['README.md', '01-overview.md', '02-architecture-and-stack.md', '03-database-schema.md', '04-api-reference.md', '05-portals-and-scraping.md', '06-pipeline-and-workflow.md', '07-operations-and-backup.md', '08-testing-and-coverage.md', '09-known-bugs-and-fixes.md', '10-operator-guide.md', '11-configuration-and-env.md', '13-north-star-quality-standard.md', '14-active-backlog.md'];
    for (const filePath of filesToCheck) {
      const base = path.basename(filePath);
      if (!currentFiles.includes(base)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      if (/\b\d{3}\s+(?:passing\s+)?tests\s+across\s+\d{2}\s+(?:test\s+)?(?:files|suites)\b/i.test(content)) {
        brittleCountFiles.push(base);
      }
    }
    expect(brittleCountFiles).toEqual([]);
  });
});
