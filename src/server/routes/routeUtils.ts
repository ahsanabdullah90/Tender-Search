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
