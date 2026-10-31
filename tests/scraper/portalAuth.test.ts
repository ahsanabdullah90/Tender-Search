import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { authenticatePortal } from '../../src/server/scrapers/portalAuth.js';
import { initDatabase, getPortalHealthList, SESSIONS_DIR } from '../../src/server/db.js';

describe('portalAuth', () => {
  let server: http.Server;
  let serverPort: number;
  let serverLoginUrl: string;

  beforeEach(async () => {
    initDatabase();

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const email = params.get('email');
          const password = params.get('password');

          if (email === 'user@example.com' && password === 'validPass123') {
            res.writeHead(200, {
              'Set-Cookie': ['PHPSESSID=session_secret_12345; path=/', 'logged_in=1; path=/'],
              'Content-Type': 'text/html'
            });
            res.end('<html><body>Welcome to Dashboard</body></html>');
          } else if (password === 'wrong') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body>Wrong Password Given. Please try again.</body></html>');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body>Invalid credentials</body></html>');
          }
        });
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        serverLoginUrl = `http://127.0.0.1:${serverPort}/login.php`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('authenticates successfully for tender_services and persists cookies', async () => {
    const result = await authenticatePortal(
      'tender_services',
      'user@example.com',
      'validPass123',
      serverLoginUrl
    );

    expect(result.success).toBe(true);
    expect(result.cookies).toContain('PHPSESSID=session_secret_12345');

    // Verify cookies file written to SESSIONS_DIR
    const cookieFile = path.resolve(SESSIONS_DIR, 'tender_services', 'cookies.txt');
    expect(fs.existsSync(cookieFile)).toBe(true);
    expect(fs.readFileSync(cookieFile, 'utf8')).toContain('session_secret_12345');

    // Verify portal health status updated to online
    const portal = getPortalHealthList().find(p => p.portal_id === 'tender_services');
    expect(portal?.status).toBe('online');
    expect(portal?.last_error_message).toBeNull();
  });

  it('handles invalid credentials response cleanly', async () => {
    const result = await authenticatePortal(
      'tender_services',
      'user@example.com',
      'wrong',
      serverLoginUrl
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid credentials or payment missing');
  });

  it('handles network connection failures gracefully', async () => {
    const result = await authenticatePortal(
      'tender_services',
      'user@example.com',
      'pass',
      'http://127.0.0.1:1/nonexistent' // Non-listening port
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Network error reaching tenderservice.pk');
  });

  it('handles generic portal credentials saving without remote HTTP call', async () => {
    const result = await authenticatePortal('epads', 'epads_user', 'epads_pass');
    expect(result.success).toBe(true);
    expect(result.message).toContain('Credentials saved successfully');

    const epads = getPortalHealthList().find(p => p.portal_id === 'epads');
    expect(epads?.status).toBe('online');
  });
});
