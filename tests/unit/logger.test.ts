import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initSessionLogger,
  closeSessionLogger,
  restoreConsole,
  stripAnsi,
  formatSessionFilename,
  formatLogEntry,
  writeToSessionLog,
  pruneOldSessionLogs,
  listSessionLogs,
  readSessionLog,
  getCurrentSessionFilename,
  requestLoggerMiddleware,
  MAX_RETAINED_SESSIONS
} from '../../src/server/logger.js';

describe('Session Logger (src/server/logger.ts)', () => {
  let tempLogsDir: string;

  beforeEach(() => {
    tempLogsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-logger-test-'));
  });

  afterEach(() => {
    closeSessionLogger('Test Cleanup');
    restoreConsole();
    try {
      fs.rmSync(tempLogsDir, { recursive: true, force: true });
    } catch {}
  });

  it('strips ANSI escape codes cleanly', () => {
    const raw = '\x1B[32m[Tender Tracker]\x1B[0m \x1B[1mSolo-Operator Console\x1B[22m';
    const clean = stripAnsi(raw);
    expect(clean).toBe('[Tender Tracker] Solo-Operator Console');
  });

  it('formats session filename properly with session- prefix and date', () => {
    const date = new Date(2026, 10, 6, 12, 30, 45); // Month 10 is November
    const filename = formatSessionFilename(date);
    expect(filename).toBe('session-2026-11-06_12-30-45.log');
  });

  it('formats log entry with ISO timestamp, level, and clean message', () => {
    const entry = formatLogEntry('INFO', ['Hello %s %d', 'World', 42]);
    expect(entry).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO\] Hello World 42\n$/);
  });

  it('initializes session logger, writes session banner, and records file', () => {
    const sessionFile = initSessionLogger({ logsDir: tempLogsDir, force: true, maxSessions: 3 });
    expect(sessionFile).toMatch(/^session-[\w.-]+\.log$/);
    expect(getCurrentSessionFilename()).toBe(sessionFile);

    const fullPath = path.resolve(tempLogsDir, sessionFile);
    expect(fs.existsSync(fullPath)).toBe(true);

    const content = fs.readFileSync(fullPath, 'utf8');
    expect(content).toContain('TENDER TRACKER - SESSION START');
    expect(content).toContain(sessionFile);
  });

  it('enforces strict retention of exactly 3 sessions by pruning oldest files', () => {
    // Create 5 dummy session files with staggered timestamps
    const now = Date.now();
    const createdFiles: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const name = `session-2026-11-0${i}_10-00-00.log`;
      const p = path.resolve(tempLogsDir, name);
      fs.writeFileSync(p, `Session ${i} content\n`, 'utf8');
      const time = new Date(now - (5 - i) * 60000);
      fs.utimesSync(p, time, time);
      createdFiles.push(name);
    }

    expect(fs.readdirSync(tempLogsDir).length).toBe(5);

    // Prune to 3
    const deleted = pruneOldSessionLogs(tempLogsDir, 3);
    expect(deleted.length).toBe(2);

    const remaining = fs.readdirSync(tempLogsDir);
    expect(remaining.length).toBe(3);
    // Oldest two (session 1 and session 2) should have been deleted
    expect(remaining).not.toContain('session-2026-11-01_10-00-00.log');
    expect(remaining).not.toContain('session-2026-11-02_10-00-00.log');
    expect(remaining).toContain('session-2026-11-03_10-00-00.log');
    expect(remaining).toContain('session-2026-11-04_10-00-00.log');
    expect(remaining).toContain('session-2026-11-05_10-00-00.log');
  });

  it('tees console.log, console.warn, and console.error into the active session file', () => {
    const sessionFile = initSessionLogger({ logsDir: tempLogsDir, force: true, maxSessions: 3 });

    console.log('[Test Log] Normal info message');
    console.warn('[Test Warn] Warning occurred');
    console.error('[Test Error] Error detected');

    const content = readSessionLog(sessionFile, tempLogsDir);
    expect(content).not.toBeNull();
    expect(content).toContain('[INFO] [Test Log] Normal info message');
    expect(content).toContain('[WARN] [Test Warn] Warning occurred');
    expect(content).toContain('[ERROR] [Test Error] Error detected');
  });

  it('lists session logs with metadata, metrics, and isCurrent flag', () => {
    const sessionFile = initSessionLogger({ logsDir: tempLogsDir, force: true, maxSessions: 3 });
    console.log('Operational heartbeat');
    console.error('Fatal database disconnect');

    const list = listSessionLogs(tempLogsDir);
    expect(list.length).toBe(1);
    expect(list[0].filename).toBe(sessionFile);
    expect(list[0].isCurrent).toBe(true);
    expect(list[0].errorCount).toBe(1);
    expect(list[0].sizeBytes).toBeGreaterThan(0);
  });

  it('guards readSessionLog against path traversal and invalid filenames', () => {
    initSessionLogger({ logsDir: tempLogsDir, force: true, maxSessions: 3 });

    // Path traversal attempts
    expect(readSessionLog('../etc/passwd', tempLogsDir)).toBeNull();
    expect(readSessionLog('..\\windows\\system32', tempLogsDir)).toBeNull();
    expect(readSessionLog('random.txt', tempLogsDir)).toBeNull();
    expect(readSessionLog('session-notfound.log', tempLogsDir)).toBeNull();
  });

  it('closes session cleanly with summary footer', () => {
    const sessionFile = initSessionLogger({ logsDir: tempLogsDir, force: true, maxSessions: 3 });
    console.error('An error was logged');
    closeSessionLogger('Clean Shutdown');

    expect(getCurrentSessionFilename()).toBeNull();

    const content = readSessionLog(sessionFile, tempLogsDir);
    expect(content).toContain('TENDER TRACKER - SESSION END');
    expect(content).toContain('Clean Shutdown');
    expect(content).toContain('Errors: 1');
  });

  it('requestLoggerMiddleware logs API requests and skips non-API requests', () => {
    const sessionFile = initSessionLogger({ logsDir: tempLogsDir, force: true, maxSessions: 3 });

    let finishCallback: () => void = () => {};
    const reqApi: any = {
      originalUrl: '/api/tenders',
      method: 'GET'
    };
    const resApi: any = {
      statusCode: 200,
      on: (event: string, cb: () => void) => {
        if (event === 'finish') finishCallback = cb;
      }
    };
    const nextApi = () => {};

    requestLoggerMiddleware(reqApi, resApi, nextApi);
    finishCallback();

    // Non-api
    let nonApiLogged = false;
    const reqStatic: any = { originalUrl: '/favicon.ico', method: 'GET' };
    const resStatic: any = { statusCode: 200, on: () => { nonApiLogged = true; } };
    requestLoggerMiddleware(reqStatic, resStatic, () => {});
    expect(nonApiLogged).toBe(false);

    const content = readSessionLog(sessionFile, tempLogsDir);
    expect(content).toContain('[HTTP] GET /api/tenders 200');
  });
});
