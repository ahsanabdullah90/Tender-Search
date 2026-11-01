import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { downloadAndCacheDossier } from '../../src/server/dossierManager.js';
import { DOSSIERS_DIR } from '../../src/server/db.js';

describe('dossierManager', () => {
  let server: http.Server;
  let serverPort: number;
  let serverBaseUrl: string;
  let fileContent: Buffer = Buffer.from('%PDF-1.4 Dummy PDF Tender Document');

  beforeEach(async () => {
    // Start local in-memory HTTP server for file download testing
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        if (req.url === '/download/rfp.pdf') {
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

    const expectedPath = path.resolve(DOSSIERS_DIR, tenderId, 'Tender_RFP.pdf');
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
    expect(updatedDossier?.localPath).toContain('_v2_');

    const files = fs.readdirSync(path.resolve(DOSSIERS_DIR, tenderId));
    expect(files.length).toBe(2);
    expect(files.some(f => f.includes('_v2_'))).toBe(true);
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
    if (fs.existsSync(DOSSIERS_DIR)) {
      fs.rmSync(DOSSIERS_DIR, { recursive: true, force: true });
    }
    vi.resetModules();
    await import('../../src/server/dossierManager.js');
    expect(fs.existsSync(DOSSIERS_DIR)).toBe(true);
  });
});
