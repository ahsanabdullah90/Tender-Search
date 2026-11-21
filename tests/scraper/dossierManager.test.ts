import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import https from 'https';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import {
  downloadAndCacheDossier,
  deriveDossierLabel,
  isHtmlContent,
  detectExtensionAndMime,
  fetchFileBuffer,
  saveManualDossier
} from '../../src/server/services/dossierManager.js';
import { fetchHtmlWithMetadata } from '../../src/server/scrapers/crawlerEngine.js';
import { sslTolerantAgent, legacySslTolerantAgent } from '../../src/server/scrapers/baseScraper.js';
import { db, initDatabase, DOSSIERS_DIR, setAppSetting } from '../../src/server/db/index.js';
import { maxFileBytes } from '../../src/server/services/ingestBudget.js';

describe('dossierManager', () => {
  let server: http.Server;
  let serverPort: number;
  let serverBaseUrl: string;
  let fileContent: Buffer = Buffer.from('%PDF-1.4 Dummy PDF Tender Document');

  beforeEach(async () => {
    // Start local in-memory HTTP server for file download testing
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        if (req.url === '/download/rfp.pdf' || req.url?.startsWith('/BiddingDocuments/')) {
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          res.end(fileContent);
        } else if (req.url === '/redirect') {
          res.writeHead(302, { Location: '/download/rfp.pdf' });
          res.end();
        } else if (req.url === '/infinite-redirect') {
          res.writeHead(302, { Location: '/infinite-redirect' });
          res.end();
        } else if (req.url?.startsWith('/download/file.')) {
          res.writeHead(200);
          res.end(Buffer.from('dummy file'));
        } else if (req.url === '/html-page') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!DOCTYPE html><html><body><h1>Notice Board</h1></body></html>');
        } else if (req.url === '/split-utf8') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          // Split Urdu string "ٹیلی کام" across chunks:
          // Buffer for "ٹیلی کام": \xd9\xb9\xdb\x8c\xd9\x84\xdb\x8c \xda\xa9\xd8\xa7\xd9\x85
          const fullBuf = Buffer.from('<html><body>ٹیلی کام ٹینڈرز</body></html>', 'utf8');
          // Split halfway through a multi-byte char
          res.write(fullBuf.subarray(0, 15));
          setTimeout(() => {
            res.write(fullBuf.subarray(15));
            res.end();
          }, 10);
        } else if (req.url === '/error500') {
          res.writeHead(500);
          res.end('Server Error');
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        serverBaseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('downloads remote file, saves to DOSSIERS_DIR, and computes sha256', async () => {
    const tenderId = 'tender-test-dossier-1';
    const remoteUrl = `${serverBaseUrl}/download/rfp.pdf`;

    const dossier = await downloadAndCacheDossier(tenderId, remoteUrl, 'Tender RFP');

    expect(dossier).not.toBeNull();
    expect(dossier?.label).toBe('Tender RFP');
    expect(dossier?.mimeType).toBe('application/pdf');
    expect(dossier?.sizeBytes).toBe(fileContent.length);
    expect(dossier?.sha256).toBeDefined();

    const expectedPath = path.resolve(DOSSIERS_DIR, tenderId, 'GEN_Tender-RFP_RFP-1.pdf');
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.readFileSync(expectedPath)).toEqual(fileContent);
  });

  it('detects file change and creates versioned v2 file (corrigendum update)', async () => {
    const tenderId = 'tender-test-dossier-v2';
    const remoteUrl = `${serverBaseUrl}/download/rfp.pdf`;

    // First download
    await downloadAndCacheDossier(tenderId, remoteUrl, 'specs.pdf');

    // Update server content
    fileContent = Buffer.from('%PDF-1.4 UPDATED Corrigendum Specs');

    // Second download of updated document
    const updatedDossier = await downloadAndCacheDossier(tenderId, remoteUrl, 'specs.pdf');

    expect(updatedDossier).not.toBeNull();
    expect(updatedDossier?.localPath).toContain('-v2.pdf');

    const files = fs.readdirSync(path.resolve(DOSSIERS_DIR, tenderId));
    expect(files.length).toBe(2);
    expect(files.some(f => f.includes('-v2.pdf'))).toBe(true);
  });

  it('follows HTTP redirects to final destination', async () => {
    const tenderId = 'tender-test-redirect';
    const redirectUrl = `${serverBaseUrl}/redirect`;

    const dossier = await downloadAndCacheDossier(tenderId, redirectUrl, 'redirected_doc.pdf');
    expect(dossier).not.toBeNull();
    expect(dossier?.sizeBytes).toBe(fileContent.length);
  });

  it('returns null when server responds with 404 or 500', async () => {
    const dossier404 = await downloadAndCacheDossier('t-fail', `${serverBaseUrl}/missing.pdf`, 'Missing');
    expect(dossier404).toBeNull();

    const dossier500 = await downloadAndCacheDossier('t-fail', `${serverBaseUrl}/error500`, 'Error');
    expect(dossier500).toBeNull();
  });

  it('returns null on invalid URL', async () => {
    const dossier = await downloadAndCacheDossier('t-fail', 'invalid-not-a-url', 'Invalid');
    expect(dossier).toBeNull();
  });

  it('handles infinite redirects and aborts after 5 redirects', async () => {
    const dossier = await downloadAndCacheDossier('t-redirect-loop', `${serverBaseUrl}/infinite-redirect`, 'Loop');
    expect(dossier).toBeNull();
  });

  it('handles timeout when download times out', async () => {
    const origGet = http.get;
    const spy = vi.spyOn(http, 'get').mockImplementationOnce((url: any, opts: any, cb: any) => {
      const req = origGet(url, opts, cb);
      setImmediate(() => req.emit('timeout'));
      return req;
    });

    const dossier = await downloadAndCacheDossier('t-timeout', `${serverBaseUrl}/download/rfp.pdf`, 'TimeoutDoc');
    expect(dossier).toBeNull();
    spy.mockRestore();
  });

  it('determines appropriate MIME types for various file formats', async () => {
    const tenderId = 't-mime-types';
    const formats = ['jpg', 'png', 'doc', 'docx', 'xls', 'xlsx', 'bin'];

    for (const fmt of formats) {
      const dossier = await downloadAndCacheDossier(tenderId, `${serverBaseUrl}/download/file.${fmt}`, `document.${fmt}`);
      expect(dossier).not.toBeNull();
      if (fmt === 'jpg') expect(dossier?.mimeType).toBe('image/jpeg');
      if (fmt === 'png') expect(dossier?.mimeType).toBe('image/png');
      if (fmt === 'doc') expect(dossier?.mimeType).toBe('application/msword');
      if (fmt === 'docx') expect(dossier?.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      if (fmt === 'xls') expect(dossier?.mimeType).toBe('application/vnd.ms-excel');
      if (fmt === 'xlsx') expect(dossier?.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      if (fmt === 'bin') expect(dossier?.mimeType).toBe('application/octet-stream');
    }
  });

  it('creates DOSSIERS_ROOT directory if it does not exist on module load', async () => {
    expect(fs.existsSync(DOSSIERS_DIR)).toBe(true);
  });
  it('DOC-5: does not create an empty tender folder on failed download, aborts on AbortSignal, and enforces maxBytes cap (P2-1, P2-3)', async () => {
    const failedId = 't-no-empty-dir';
    const failRes = await downloadAndCacheDossier(failedId, `${serverBaseUrl}/not-found-404.pdf`, 'MissingDoc');
    expect(failRes).toBeNull();
    expect(fs.existsSync(path.resolve(DOSSIERS_DIR, failedId))).toBe(false);

    // AbortSignal already aborted
    const controller = new AbortController();
    controller.abort();
    const abortedRes = await downloadAndCacheDossier(
      't-aborted-dir',
      `${serverBaseUrl}/download/rfp.pdf`,
      'AbortedDoc',
      undefined,
      undefined,
      { signal: controller.signal }
    );
    expect(abortedRes).toBeNull();
    expect(fs.existsSync(path.resolve(DOSSIERS_DIR, 't-aborted-dir'))).toBe(false);

    // Streaming maxBytes cap and ingestBudget maxFileBytes default setting (DOC-4)
    setAppSetting('ingest_max_file_mb', '15');
    expect(maxFileBytes()).toBe(15 * 1024 * 1024);
    const oversizedRes = await downloadAndCacheDossier(
      't-oversized-dir',
      `${serverBaseUrl}/download/rfp.pdf`,
      'OversizedDoc',
      undefined,
      undefined,
      { maxBytes: 5 }
    );
    expect(oversizedRes).toBeNull();
    expect(fs.existsSync(path.resolve(DOSSIERS_DIR, 't-oversized-dir'))).toBe(false);
  });

  describe('deriveDossierLabel', () => {
    it('decodes Laravel/Filament base64 meta filenames into clean titles', () => {
      const url = 'https://gbppra.gov.pk/storage/proc_files/9Kl6Xm1MJWugaECLMKzqJ2HuzevxzQ-metaQWR2ZXJ0aXNlbWVudCBGYWJyaWNhdGlvbiBvZiBBbWJ1bGFuY2UgRC5wZGY=-.pdf';
      expect(deriveDossierLabel(url)).toBe('Advertisement Fabrication of Ambulance D');
    });

    it('humanizes standard descriptive file slugs', () => {
      const url = 'https://techdestination.com/wp-content/uploads/2026/10/RFP-for-Purchase-of-Stationery-Computer-Stationery-Items.pdf';
      expect(deriveDossierLabel(url)).toBe('RFP for Purchase of Stationery Computer Stationery Items');
    });

    it('falls back to default label for opaque hashes or IDs', () => {
      const url = 'https://portal.gov.pk/files/48309f6c2890af4d900c718e7c9ee4bc23b00725b.pdf';
      expect(deriveDossierLabel(url, 'Bidding Document', 1)).toBe('Bidding Document');
      expect(deriveDossierLabel(url, 'Bidding Document', 2)).toBe('Bidding Document 2');
    });

    it('derives folder-aware labels for EPMS PPRA numeric ?file=<base64> PDFs', () => {
      const advertUrl = `https://epms.ppra.gov.pk/pdf?file=${Buffer.from('advertisement_docs/12674.pdf', 'utf8').toString('base64')}`;
      const attachUrl = `https://epms.ppra.gov.pk/pdf?file=${Buffer.from('tender_attachments/12674.pdf', 'utf8').toString('base64')}`;
      const corrUrl = `https://epms.ppra.gov.pk/pdf?file=${Buffer.from('corrigendum_docs/991.pdf', 'utf8').toString('base64')}`;
      expect(deriveDossierLabel(advertUrl)).toBe('Tender Notice');
      expect(deriveDossierLabel(attachUrl)).toBe('Bidding Document');
      expect(deriveDossierLabel(corrUrl)).toBe('Corrigendum');
    });
  });

  describe('B4 File Validation & Magic Bytes & C4 HTML UTF-8 Decoding', () => {
    it('B4: isHtmlContent detects HTML by header and doctype prefix', () => {
      expect(isHtmlContent(Buffer.from('binary-data'), 'text/html')).toBe(true);
      expect(isHtmlContent(Buffer.from('binary-data'), 'application/xhtml+xml')).toBe(true);
      expect(isHtmlContent(Buffer.from('<!doctype html><html><body>Error</body></html>'))).toBe(true);
      expect(isHtmlContent(Buffer.from('<html><head></head></html>'))).toBe(true);

      // Binary document buffers are not HTML
      expect(isHtmlContent(Buffer.from('%PDF-1.4 binary data'), 'application/pdf')).toBe(false);
      expect(isHtmlContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), 'image/png')).toBe(false);
    });

    it('B4: detectExtensionAndMime derives format from magic bytes over misleading filename or label', () => {
      // PDF magic bytes even if URL says .jpg
      const pdfBuf = Buffer.from('%PDF-1.5 test document');
      const det1 = detectExtensionAndMime(pdfBuf, undefined, 'https://example.com/fake.jpg');
      expect(det1.ext).toBe('.pdf');
      expect(det1.mimeType).toBe('application/pdf');

      // PNG magic bytes
      const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const det2 = detectExtensionAndMime(pngBuf);
      expect(det2.ext).toBe('.png');
      expect(det2.mimeType).toBe('image/png');

      // JPEG magic bytes
      const jpgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const det3 = detectExtensionAndMime(jpgBuf);
      expect(det3.ext).toBe('.jpg');
      expect(det3.mimeType).toBe('image/jpeg');
    });

    it('B4: downloadAndCacheDossier rejects HTML content sent as download', async () => {
      const res = await downloadAndCacheDossier('t-html-reject', `${serverBaseUrl}/html-page`, 'NoticeDocument');
      expect(res).toBeNull();
      expect(fs.existsSync(path.resolve(DOSSIERS_DIR, 't-html-reject'))).toBe(false);
    });

    it('C4: fetchHtmlWithMetadata decodes multi-byte UTF-8 split chunks cleanly without corruption', async () => {
      const res = await fetchHtmlWithMetadata(`${serverBaseUrl}/split-utf8`);
      expect(res.html).toContain('ٹیلی کام ٹینڈرز');
      // No Unicode replacement character (\uFFFD)
      expect(res.html).not.toContain('\uFFFD');
    });

    it('retries HTTPS with legacySslTolerantAgent on ERR_SSL_WRONG_VERSION_NUMBER without http:// redirect loops', async () => {
      const agentsUsed: any[] = [];
      const httpSpy = vi.spyOn(http, 'get').mockImplementation((_url: any, _opts: any, cb: any) => {
        const req = new EventEmitter() as any;
        req.destroy = vi.fn();
        const res = new EventEmitter() as any;
        res.statusCode = 302;
        res.headers = { location: 'https://eproc.example.gov.pk/ActiveTenders.aspx' };
        res.resume = vi.fn();
        setImmediate(() => cb(res));
        return req;
      });
      const httpsSpy = vi.spyOn(https, 'get').mockImplementation((_url: any, opts: any, cb: any) => {
        agentsUsed.push(opts.agent);
        const req = new EventEmitter() as any;
        req.destroy = vi.fn();
        if (opts.agent === sslTolerantAgent) {
          setImmediate(() => {
            const err: any = new Error('ssl3_get_record:wrong version number');
            err.code = 'ERR_SSL_WRONG_VERSION_NUMBER';
            req.emit('error', err);
          });
        } else {
          const res = new EventEmitter() as any;
          res.statusCode = 200;
          res.headers = { 'content-type': 'text/html; charset=utf-8' };
          setImmediate(() => {
            cb(res);
            res.emit('data', Buffer.from('<html><body>OK via legacy TLS</body></html>'));
            res.emit('end');
          });
        }
        return req;
      });

      try {
        const result = await fetchHtmlWithMetadata('http://eproc.example.gov.pk/ActiveTenders.aspx');
        expect(result.html).toContain('OK via legacy TLS');
        expect(result.finalUrl).toBe('https://eproc.example.gov.pk/ActiveTenders.aspx');
        expect(httpSpy).toHaveBeenCalledTimes(1);
        expect(agentsUsed).toEqual([sslTolerantAgent, legacySslTolerantAgent]);
      } finally {
        httpSpy.mockRestore();
        httpsSpy.mockRestore();
      }
    });

    it('fetchFileBuffer retries HTTPS PDF downloads with legacySslTolerantAgent on ERR_SSL_WRONG_VERSION_NUMBER', async () => {
      const agentsUsed: any[] = [];
      const httpsSpy = vi.spyOn(https, 'get').mockImplementation((_url: any, opts: any, cb: any) => {
        agentsUsed.push(opts.agent);
        const req = new EventEmitter() as any;
        req.destroy = vi.fn();
        if (opts.agent === sslTolerantAgent) {
          setImmediate(() => {
            const err: any = new Error('ssl3_get_record:wrong version number');
            err.code = 'ERR_SSL_WRONG_VERSION_NUMBER';
            req.emit('error', err);
          });
        } else {
          const res = new EventEmitter() as any;
          res.statusCode = 200;
          res.headers = { 'content-type': 'application/pdf' };
          setImmediate(() => {
            cb(res);
            res.emit('data', Buffer.from('%PDF-1.4 Legacy TLS PDF'));
            res.emit('end');
          });
        }
        return req;
      });

      try {
        const buf = await fetchFileBuffer('https://eproc.example.gov.pk/Tenders/doc.pdf');
        expect(buf.toString()).toContain('%PDF-1.4 Legacy TLS PDF');
        expect(agentsUsed).toEqual([sslTolerantAgent, legacySslTolerantAgent]);
      } finally {
        httpsSpy.mockRestore();
      }
    });

    it('rejects truncated file downloads where Content-Length exceeds received bytes and creates no folder', async () => {
      const httpsSpy = vi.spyOn(https, 'get').mockImplementation((_url: any, _opts: any, cb: any) => {
        const req = new EventEmitter() as any;
        req.destroy = vi.fn();
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.complete = true;
        res.headers = { 'content-type': 'application/pdf', 'content-length': '2048' };
        setImmediate(() => {
          cb(res);
          res.emit('data', Buffer.from('%PDF-1.4 short'));
          res.emit('end');
        });
        return req;
      });

      try {
        const tenderId = 't-truncated-content-length';
        const res = await downloadAndCacheDossier(tenderId, 'https://example.gov.pk/partial.pdf', 'Partial');
        expect(res).toBeNull();
        expect(fs.existsSync(path.resolve(DOSSIERS_DIR, tenderId))).toBe(false);
      } finally {
        httpsSpy.mockRestore();
      }
    });

    it('rejects file downloads when res.complete === false (aborted HTTP stream)', async () => {
      const httpsSpy = vi.spyOn(https, 'get').mockImplementation((_url: any, _opts: any, cb: any) => {
        const req = new EventEmitter() as any;
        req.destroy = vi.fn();
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.complete = false;
        res.headers = { 'content-type': 'application/pdf' };
        setImmediate(() => {
          cb(res);
          res.emit('data', Buffer.from('%PDF-1.4 incomplete'));
          res.emit('end');
        });
        return req;
      });

      try {
        await expect(fetchFileBuffer('https://example.gov.pk/aborted.pdf')).rejects.toThrow(/truncated/i);
      } finally {
        httpsSpy.mockRestore();
      }
    });

    it('rejects truncated portal HTML when res.complete === false', async () => {
      const httpsSpy = vi.spyOn(https, 'get').mockImplementation((_url: any, _opts: any, cb: any) => {
        const req = new EventEmitter() as any;
        req.destroy = vi.fn();
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.complete = false;
        res.headers = { 'content-type': 'text/html; charset=utf-8' };
        setImmediate(() => {
          cb(res);
          res.emit('data', Buffer.from('<html><body><table><tr><td>Partial'));
          res.emit('end');
        });
        return req;
      });

      try {
        await expect(fetchHtmlWithMetadata('https://example.gov.pk/tenders')).rejects.toThrow(/truncated/i);
      } finally {
        httpsSpy.mockRestore();
      }
    });

    it('uses DB tender metadata and URL clues in downloadAndCacheDossier and saveManualDossier', async () => {
      initDatabase();
      const tenderId = 'tender-punjab_eproc-naming-1';
      db.prepare('DELETE FROM tenders WHERE id = ?').run(tenderId);
      const tDir = path.resolve(DOSSIERS_DIR, tenderId);
      if (fs.existsSync(tDir)) fs.rmSync(tDir, { recursive: true, force: true });
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url)
        VALUES (?, ?, 'punjab_eproc', 'Punjab PPRA', 'REF-MAN-1', 'PEIMA School Rehabilitation', 'SED', 'https://eproc.punjab.gov.pk/d/1')
      `).run(tenderId, tenderId);

      const downloaded = await downloadAndCacheDossier(
        tenderId,
        `${serverBaseUrl}/BiddingDocuments/5048/11112026122547.pdf`,
        'PEIMA School Rehabilitation_Doc'
      );
      expect(downloaded?.docType).toBe('bidding-document');
      expect(downloaded?.localPath).toContain('/PPPRA_REF-MAN-1_Bidding-Document-1.pdf');

      const manual = saveManualDossier(tenderId, 'Corrigendum Notice.pdf', Buffer.from('%PDF-1.4 manual'), 'Corrigendum Notice');
      expect(manual.docType).toBe('corrigendum');
      expect(manual.localPath).toContain('/PPPRA_REF-MAN-1_Corrigendum-1.pdf');
    });
  });
});