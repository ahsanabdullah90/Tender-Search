import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async Express 4 route handler so rejected promises forward cleanly to Express's
 * error-handling middleware instead of leaving requests hanging or causing unhandled rejections.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => unknown
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function maskApiKey(key?: string | null): string | null {
  if (!key) return null;
  return key.length > 8 ? `${key.slice(0, 4)}••••${key.slice(-4)}` : '••••••••';
}

export function decodeBase64Payload(raw: string): Buffer {
  const cleanBase64 = String(raw).replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(cleanBase64, 'base64');
}
