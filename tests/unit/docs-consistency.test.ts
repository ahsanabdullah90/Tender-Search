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

  it('proves every table in schema.ts is documented in docs/03-database-schema.md (QA-4)', () => {
    const schemaFile = fs.readFileSync(path.resolve(rootDir, 'src/server/db/schema.ts'), 'utf8');
    const doc03 = fs.readFileSync(path.resolve(docsDir, '03-database-schema.md'), 'utf8');

    const tablePattern = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/gi;
    const schemaTables = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = tablePattern.exec(schemaFile)) !== null) {
      schemaTables.add(match[1].toLowerCase());
    }

    const undocumented = [...schemaTables].filter(t => !doc03.includes(t));
    expect(schemaTables.size).toBeGreaterThanOrEqual(10);
    expect(undocumented).toEqual([]);
  });

  it('proves every server module under src/server/ is documented in docs/02-architecture-and-stack.md (QA-4)', () => {
    const doc02 = fs.readFileSync(path.resolve(docsDir, '02-architecture-and-stack.md'), 'utf8');
    const dirsToCheck = [
      'src/server/db',
      'src/server/db/repositories',
      'src/server/routes',
      'src/server/scrapers',
      'src/server/services'
    ];

    const missingModules: string[] = [];
    for (const relDir of dirsToCheck) {
      const fullDir = path.resolve(rootDir, relDir);
      const files = fs.readdirSync(fullDir)
        .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts') && f !== 'index.ts');
      for (const file of files) {
        if (!doc02.includes(file)) {
          missingModules.push(`${relDir}/${file}`);
        }
      }
    }

    expect(missingModules).toEqual([]);
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
