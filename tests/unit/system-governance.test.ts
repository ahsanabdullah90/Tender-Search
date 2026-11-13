import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db, initDatabase } from '../../src/server/db/index.js';
import { getPortalHealthList, savePortalCredentials } from '../../src/server/db/repositories/portalsRepo.js';
import { tryConsumeDailyAiText, getDailyAiTextUsage } from '../../src/server/services/ingestBudget.js';
import { setAppSetting, getAppSetting } from '../../src/server/db/repositories/systemRepo.js';
import { findDedupCandidates } from '../../src/server/db/repositories/tendersRepo.js';
import { processDocumentQueue } from '../../src/server/services/ingestWorker.js';
import { currentScanStatus } from '../../src/server/scrapers/crawlerEngine.js';
import { hasProcurementSignals } from '../../src/server/scrapers/portalParsers.js';
import { PORTAL_DEFINITIONS } from '../../src/server/scrapers/portalList.js';
import { isValidHealedTendersUrl } from '../../src/server/scrapers/healer.js';

describe('System Governance, Security & Operational Invariants', () => {
  beforeEach(() => {
    initDatabase();
  });

  describe('GOV-2: server.ts architectural boundary', () => {
    it('contains no direct API route handlers and delegates all /api endpoints to apiRouter', () => {
      const serverSource = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');

      // server.ts must mount /api with apiRouter
      expect(serverSource).toContain("app.use('/api', apiRouter);");

      // server.ts must not register inline API routes
      expect(serverSource).not.toMatch(/app\.(get|post|put|delete|patch)\(['"]\/api/);
    });
  });

  describe('SEC-1: Default loopback binding', () => {
    it('defaults HOST to 127.0.0.1 when process.env.HOST is unset', () => {
      const serverSource = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');
      expect(serverSource).toMatch(/const HOST = process\.env\.HOST \|\| '127\.0\.0\.1';/);
    });
  });

  describe('SEC-4: Secret redaction in responses and logs', () => {
    it('never exposes auth_password or API secrets in portal health API models', () => {
      // Save credentials for an existing portal
      savePortalCredentials('pseb', {
        username: 'operator_user',
        password: 'SuperSecretPassword123!',
        loginUrl: 'https://example.com/login'
      });

      const portals = getPortalHealthList();
      const portal = portals.find(p => p.portal_id === 'pseb');

      expect(portal).toBeDefined();
      expect(portal?.has_credentials).toBe(true);
      // Ensure auth_password property is completely omitted from the health response model
      expect((portal as any).auth_password).toBeUndefined();
      expect((portal as any).password).toBeUndefined();
    });

    it('request logger middleware logs only method, path, status, and duration without headers or request body', async () => {
      const loggerSource = fs.readFileSync(path.resolve(__dirname, '../../src/server/services/logger.ts'), 'utf8');
      // Verifies format: [HTTP] ${req.method} ${url} ${status} (${duration}ms)
      expect(loggerSource).toContain('[HTTP] ${req.method} ${url} ${status} (${duration}ms)');
      // Logger middleware must never serialize req.body or req.headers into the log line
      expect(loggerSource).not.toMatch(/writeToSessionLog\([^)]*req\.body/);
      expect(loggerSource).not.toMatch(/writeToSessionLog\([^)]*req\.headers/);
    });
  });

  describe('DOC-3: Gemini text calls daily budget cap (C3)', () => {
    it('enforces ingest_ai_text_calls_per_day ceiling and halts consumption once exhausted', () => {
      setAppSetting('ingest_ai_text_calls_per_day', '2');
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const todayKey = `ingest_ai_text_calls_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      setAppSetting(todayKey, '0');

      expect(tryConsumeDailyAiText()).toBe(true);
      expect(tryConsumeDailyAiText()).toBe(true);
      // 3rd call exceeds limit of 2
      expect(tryConsumeDailyAiText()).toBe(false);

      const usage = getDailyAiTextUsage();
      expect(usage.used).toBe(2);
      expect(usage.limit).toBe(2);
    });
  });

  describe('DED-3: Cross-portal isolation for Tiers 2 & 3 deduplication (A3)', () => {
    it('findDedupCandidates strictly excludes tenders from the candidate portal itself', () => {
      const closingDate = '2026-12-15T14:00:00+05:00';
      const tenderSamePortal = 'tender-ded3-same-portal';
      const tenderOtherPortal = 'tender-ded3-other-portal';

      db.prepare(`
        INSERT OR REPLACE INTO tenders (id, canonical_id, title, organization, portal_id, portal_name, direct_url, closing_date)
        VALUES (?, ?, 'IT Hardware Supply', 'Gov Department', 'punjab_ppra', 'Punjab PPRA', 'https://a.pk/1', ?)
      `).run(tenderSamePortal, tenderSamePortal, closingDate);

      db.prepare(`
        INSERT OR REPLACE INTO tenders (id, canonical_id, title, organization, portal_id, portal_name, direct_url, closing_date)
        VALUES (?, ?, 'IT Hardware Supply', 'Gov Department', 'sppra', 'Sindh PPRA', 'https://b.pk/1', ?)
      `).run(tenderOtherPortal, tenderOtherPortal, closingDate);

      // Query dedup candidates for a new tender arriving from punjab_ppra
      const candidates = findDedupCandidates(closingDate, 'punjab_ppra');

      const candidateIds = candidates.map(c => c.id);
      expect(candidateIds).toContain(tenderOtherPortal);
      expect(candidateIds).not.toContain(tenderSamePortal);

      // Clean up
      db.prepare('DELETE FROM tenders WHERE id IN (?, ?)').run(tenderSamePortal, tenderOtherPortal);
    });
  });

  describe('HEAL-2 & SCR-1: Scraper fallbacks and yield gating', () => {
    it('SCR-1: hasProcurementSignals recognizes tender board terms and rejects non-procurement pages', () => {
      const procurementHtml = '<html><body><h1>Active Bids and Tender Opportunities</h1><p>Government Procurement Agency of Pakistan announces competitive bidding for goods and infrastructure services. Submission deadline is 25-Dec-2026.</p></body></html>';
      const aboutUsHtml = '<html><body><h1>About Our Organization</h1><p>Our history and mission since 1995. We operate several community programs and outreach centers across the region for youth development.</p></body></html>';
      const shortHtml = '<html><body><p>Tenders</p></body></html>';

      expect(hasProcurementSignals(procurementHtml)).toBe(true);
      expect(hasProcurementSignals(aboutUsHtml)).toBe(false);
      expect(hasProcurementSignals(shortHtml)).toBe(false);
    });

    it('HEAL-2: in-memory URL replacement requires verified yield and non-downgrade path', () => {
      const portal = PORTAL_DEFINITIONS.find(p => p.id === 'punjab_eproc')!;
      // Valid listing path
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/ActiveTenders2026.aspx', portal)).toBe(true);
      // Downgrade to root or static file is rejected
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/', portal)).toBe(false);
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/bidding_doc.pdf', portal)).toBe(false);
    });
  });

  describe('OPS-2 & OPS-4: Scheduling invariants', () => {
    it('OPS-4: background document worker skips processing while a crawl scan is active', async () => {
      currentScanStatus.isScanning = true;
      try {
        const report = await processDocumentQueue(5);
        expect(report.skipped).toBe('scan_running');
        expect(report.claimed).toBe(0);
      } finally {
        currentScanStatus.isScanning = false;
      }
    });

    it('OPS-2: catch-up scan timestamp tracks last_full_scan_at', () => {
      const nowIso = new Date().toISOString();
      setAppSetting('last_full_scan_at', nowIso);
      const recorded = getAppSetting('last_full_scan_at');
      expect(recorded).toBe(nowIso);
    });

    it('OPS-6: scripts/install-startup-task.ps1 configures Windows logon scheduled task', () => {
      const scriptPath = path.resolve(__dirname, '../../scripts/install-startup-task.ps1');
      expect(fs.existsSync(scriptPath)).toBe(true);
      const scriptContent = fs.readFileSync(scriptPath, 'utf8');
      expect(scriptContent).toContain('TenderTrackerAutoStart');
      expect(scriptContent).toContain('-AtLogOn');
      expect(scriptContent).toContain('launch.cmd');
    });

    it('Plan E (#6): production launchers build dist/ + dist-server/ and run compiled npm start rather than npm run dev', () => {
      const launchCmd = fs.readFileSync(path.resolve(__dirname, '../../scripts/launch.cmd'), 'utf8');
      const rootBat = fs.readFileSync(path.resolve(__dirname, '../../start-tender-tracker.bat'), 'utf8');
      const serverTs = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');

      expect(launchCmd).toContain('npm start');
      expect(launchCmd).not.toContain('call npm run dev');
      expect(rootBat).toContain('npm start');
      expect(rootBat).not.toContain('call npm run dev');
      expect(serverTs).toContain("path.basename(__dirname) === 'dist-server'");
      expect(serverTs).toContain("process.argv.includes('--production')");
    });
  });
});
