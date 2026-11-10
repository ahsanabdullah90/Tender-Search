import fs from 'fs';
import path from 'path';
import util from 'util';
import type { Request, Response, NextFunction } from 'express';
import { LOGS_DIR } from './db/connection.js';
import type { SessionLogMeta } from '../types.js';

export const MAX_RETAINED_SESSIONS = 3;

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'HTTP' | 'FATAL';

// Global logger state
let currentSessionFile: string | null = null;
let currentSessionFullPath: string | null = null;
let sessionStartTime: Date | null = null;
let sessionErrorCount = 0;
let sessionWarnCount = 0;
let isConsoleIntercepted = false;

// Store original console methods
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
};

/**
 * Strips ANSI terminal color and control escape sequences
 */
export function stripAnsi(str: string): string {
  // Matches 7-bit and 8-bit C1 ANSI escape sequences
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Formats a Date into a clean Windows-safe filename
 * e.g. session-2026-11-06_11-55-30.log
 */
export function formatSessionFilename(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `session-${y}-${m}-${d}_${hh}-${mm}-${ss}.log`;
}

/**
 * Formats a single log entry line with timestamp and level
 */
export function formatLogEntry(level: LogLevel, args: any[]): string {
  const timestamp = new Date().toISOString();
  const raw = util.format(...args);
  const clean = stripAnsi(raw);
  return `[${timestamp}] [${level}] ${clean}\n`;
}

/**
 * Writes directly to the active session log file
 */
export function writeToSessionLog(level: LogLevel, args: any[]): void {
  if (!currentSessionFullPath) return;
  try {
    const entry = formatLogEntry(level, args);
    fs.appendFileSync(currentSessionFullPath, entry, 'utf8');
  } catch (err) {
    // Failsafe: never crash the application if writing to the log fails
    originalConsole.error('[Logger Error] Failed writing to session log:', err);
  }
}

/**
 * Prunes session logs in the target directory, retaining only the newest `maxRetained` files
 */
export function pruneOldSessionLogs(targetDir: string = LOGS_DIR, maxRetained: number = MAX_RETAINED_SESSIONS): string[] {
  if (!fs.existsSync(targetDir)) return [];

  const files = fs.readdirSync(targetDir)
    .filter(f => f.startsWith('session-') && f.endsWith('.log'))
    .map(f => {
      const fullPath = path.resolve(targetDir, f);
      try {
        const stat = fs.statSync(fullPath);
        return { filename: f, fullPath, mtimeMs: stat.mtimeMs };
      } catch {
        return { filename: f, fullPath, mtimeMs: 0 };
      }
    });

  // Sort newest first
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const deleted: string[] = [];
  if (files.length > maxRetained) {
    const toRemove = files.slice(maxRetained);
    for (const item of toRemove) {
      try {
        fs.unlinkSync(item.fullPath);
        deleted.push(item.filename);
      } catch {
        // Ignore file lock or already removed
      }
    }
  }

  return deleted;
}

export interface InitSessionOptions {
  logsDir?: string;
  maxSessions?: number;
  force?: boolean;
}

/**
 * Initializes a new logging session, writes banner, intercepts console, and enforces 3-session retention
 */
export function initSessionLogger(options?: InitSessionOptions): string {
  // In test environment, skip hijacking console unless explicitly forced
  if (process.env.VITEST && !options?.force) {
    return 'session-test-bypassed.log';
  }

  const logsDirectory = options?.logsDir || LOGS_DIR;
  const maxRetained = options?.maxSessions ?? MAX_RETAINED_SESSIONS;

  if (!fs.existsSync(logsDirectory)) {
    fs.mkdirSync(logsDirectory, { recursive: true });
  }

  // Pre-prune to make room for the new session file
  pruneOldSessionLogs(logsDirectory, Math.max(1, maxRetained - 1));

  sessionStartTime = new Date();
  sessionErrorCount = 0;
  sessionWarnCount = 0;

  currentSessionFile = formatSessionFilename(sessionStartTime);
  currentSessionFullPath = path.resolve(logsDirectory, currentSessionFile);

  // Write Session Header Banner
  const banner = [
    '='.repeat(80),
    'TENDER TRACKER - SESSION START',
    `Timestamp  : ${sessionStartTime.toISOString()}`,
    `Session Log: ${currentSessionFile}`,
    `Node.js    : ${process.version} | Platform: ${process.platform} (${process.arch}) | PID: ${process.pid}`,
    `Environment: ${process.env.NODE_ENV || 'development'}`,
    `Retention  : Strict last ${maxRetained} sessions enforced`,
    '='.repeat(80),
    ''
  ].join('\n');

  fs.writeFileSync(currentSessionFullPath, banner, 'utf8');

  // Intercept standard console methods (Tee pattern: prints to terminal AND appends to session file)
  if (!isConsoleIntercepted) {
    console.log = (...args: any[]) => {
      originalConsole.log(...args);
      writeToSessionLog('INFO', args);
    };

    console.info = (...args: any[]) => {
      originalConsole.info(...args);
      writeToSessionLog('INFO', args);
    };

    console.warn = (...args: any[]) => {
      originalConsole.warn(...args);
      sessionWarnCount++;
      writeToSessionLog('WARN', args);
    };

    console.error = (...args: any[]) => {
      originalConsole.error(...args);
      sessionErrorCount++;
      writeToSessionLog('ERROR', args);
    };

    console.debug = (...args: any[]) => {
      originalConsole.debug(...args);
      writeToSessionLog('DEBUG', args);
    };

    isConsoleIntercepted = true;
  }

  // Final prune check
  pruneOldSessionLogs(logsDirectory, maxRetained);

  return currentSessionFile;
}

/**
 * Restores original unhooked console functions
 */
export function restoreConsole(): void {
  if (isConsoleIntercepted) {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
    isConsoleIntercepted = false;
  }
}

/**
 * Closes the active session, logs the footer banner, and cleans up
 */
export function closeSessionLogger(reason: string = 'Clean Shutdown'): void {
  if (!currentSessionFullPath || !sessionStartTime) {
    restoreConsole();
    return;
  }

  const endTime = new Date();
  const durationSec = Math.round((endTime.getTime() - sessionStartTime.getTime()) / 1000);
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;
  const durationStr = `${minutes}m ${seconds}s`;

  const footer = [
    '',
    '='.repeat(80),
    'TENDER TRACKER - SESSION END',
    `Timestamp  : ${endTime.toISOString()}`,
    `Duration   : ${durationStr}`,
    `Summary    : Errors: ${sessionErrorCount}, Warnings: ${sessionWarnCount}`,
    `Exit Status: ${reason}`,
    '='.repeat(80),
    ''
  ].join('\n');

  try {
    fs.appendFileSync(currentSessionFullPath, footer, 'utf8');
  } catch {}

  restoreConsole();
  currentSessionFile = null;
  currentSessionFullPath = null;
  sessionStartTime = null;
}

/**
 * Returns current active session filename or null if none active
 */
export function getCurrentSessionFilename(): string | null {
  return currentSessionFile;
}

/**
 * Lists the retained session log files (up to maxSessions) with metadata
 */
export function listSessionLogs(targetDir: string = LOGS_DIR): SessionLogMeta[] {
  if (!fs.existsSync(targetDir)) return [];

  const files = fs.readdirSync(targetDir)
    .filter(f => f.startsWith('session-') && f.endsWith('.log'))
    .map(f => {
      const fullPath = path.resolve(targetDir, f);
      try {
        const stat = fs.statSync(fullPath);
        return { filename: f, fullPath, stat };
      } catch {
        return null;
      }
    })
    .filter((item): item is { filename: string; fullPath: string; stat: fs.Stats } => item !== null);

  // Newest first
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  return files.slice(0, MAX_RETAINED_SESSIONS).map(file => {
    let lineCount = 0;
    let errorCount = 0;
    let warnCount = 0;

    try {
      // Quick scan of lines for metrics
      const content = fs.readFileSync(file.fullPath, 'utf8');
      const lines = content.split('\n');
      lineCount = lines.length;
      for (const line of lines) {
        if (line.includes('[ERROR]') || line.includes('[FATAL]')) {
          errorCount++;
        } else if (line.includes('[WARN]')) {
          warnCount++;
        }
      }
    } catch {}

    return {
      filename: file.filename,
      createdAt: file.stat.birthtime?.toISOString?.() || file.stat.mtime.toISOString(),
      sizeBytes: file.stat.size,
      isCurrent: file.filename === currentSessionFile,
      lineCount,
      errorCount,
      warnCount
    };
  });
}

/**
 * Safely reads a session log file preventing directory traversal
 */
export function readSessionLog(filename: string, targetDir: string = LOGS_DIR): string | null {
  // Validate filename strictly: must be session-*.log with safe chars
  if (!/^session-[a-zA-Z0-9_\-\.]+\.log$/.test(filename)) {
    return null;
  }

  const resolvedTarget = path.resolve(targetDir);
  const filePath = path.resolve(targetDir, filename);

  // Path traversal guard
  if (!filePath.startsWith(resolvedTarget + path.sep)) {
    return null;
  }

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Express middleware for logging incoming requests and responses
 */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const url = req.originalUrl || req.url;

  // Only log API requests to keep session logs focused on backend operations
  if (!url.startsWith('/api')) {
    return next();
  }

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const level: LogLevel = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'HTTP';
    const logLine = `[HTTP] ${req.method} ${url} ${status} (${duration}ms)`;

    if (level === 'ERROR') {
      sessionErrorCount++;
    } else if (level === 'WARN') {
      sessionWarnCount++;
    }

    writeToSessionLog(level, [logLine]);
  });

  next();
}
