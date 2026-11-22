import type { ErrorRequestHandler, Response } from 'express';

/** Canonical machine-readable error codes returned by the API error envelope. */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNPROCESSABLE_ENTITY'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/** Field-level validation failure descriptor included in `details`. */
export interface FieldValidationIssue {
  field: string;
  message: string;
}

/** Uniform JSON error payload returned by all error responses. */
export interface ApiErrorEnvelope {
  success: false;
  error: string;
  message: string;
  code: ApiErrorCode;
  details?: FieldValidationIssue[];
}

/** Maps an HTTP status code to its default `ApiErrorCode`. */
export function statusToErrorCode(statusCode: number): ApiErrorCode {
  switch (statusCode) {
    case 400:
      return 'BAD_REQUEST';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}

/** Operational HTTP error carrying a status code, canonical `ApiErrorCode`, and optional field details. */
export class AppHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: ApiErrorCode = statusToErrorCode(statusCode),
    public readonly details?: FieldValidationIssue[]
  ) {
    super(message);
    this.name = 'AppHttpError';
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static badRequest(message: string, details?: FieldValidationIssue[]): AppHttpError {
    return new AppHttpError(400, message, 'BAD_REQUEST', details);
  }

  static validation(message: string, details: FieldValidationIssue[]): AppHttpError {
    return new AppHttpError(400, message, 'VALIDATION_ERROR', details);
  }

  static forbidden(message: string): AppHttpError {
    return new AppHttpError(403, message, 'FORBIDDEN');
  }

  static notFound(message: string): AppHttpError {
    return new AppHttpError(404, message, 'NOT_FOUND');
  }

  static unprocessable(message: string): AppHttpError {
    return new AppHttpError(422, message, 'UNPROCESSABLE_ENTITY');
  }

  static serviceUnavailable(message: string): AppHttpError {
    return new AppHttpError(503, message, 'SERVICE_UNAVAILABLE');
  }

  static internal(message: string): AppHttpError {
    return new AppHttpError(500, message, 'INTERNAL_ERROR');
  }
}

/** Sends a uniform `ApiErrorEnvelope` JSON response with the given status code. */
export function sendError(
  res: Response,
  statusCode: number,
  message: string,
  code?: ApiErrorCode,
  details?: FieldValidationIssue[]
): Response {
  const envelope: ApiErrorEnvelope = {
    success: false,
    error: message,
    message,
    code: code ?? statusToErrorCode(statusCode),
    ...(details?.length ? { details } : {})
  };
  return res.status(statusCode).json(envelope);
}

/**
 * Express error-handling middleware translating `AppHttpError`, body-parser errors,
 * HTTP-status-bearing errors, and unexpected failures into uniform `ApiErrorEnvelope` responses.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppHttpError) {
    sendError(res, err.statusCode, err.message, err.code, err.details);
    return;
  }

  const errRecord =
    err && typeof err === 'object'
      ? (err as { status?: unknown; statusCode?: unknown; type?: unknown; message?: unknown })
      : null;

  if (
    err instanceof SyntaxError &&
    (errRecord?.status === 400 || errRecord?.statusCode === 400 || errRecord?.type === 'entity.parse.failed')
  ) {
    sendError(res, 400, 'Invalid JSON request body', 'BAD_REQUEST');
    return;
  }

  if (errRecord && (errRecord.status === 413 || errRecord.statusCode === 413 || errRecord.type === 'entity.too.large')) {
    sendError(res, 413, 'Request payload exceeds limit', 'BAD_REQUEST');
    return;
  }

  if (
    errRecord &&
    typeof errRecord.statusCode === 'number' &&
    Number.isInteger(errRecord.statusCode) &&
    errRecord.statusCode >= 400 &&
    errRecord.statusCode <= 599
  ) {
    const message =
      typeof errRecord.message === 'string' && errRecord.message.trim()
        ? errRecord.message
        : errRecord.statusCode >= 500
          ? 'Internal server error'
          : 'Request failed';
    sendError(res, errRecord.statusCode, message);
    return;
  }

  const fallbackMessage = err instanceof Error && err.message ? err.message : 'Internal server error';
  sendError(res, 500, fallbackMessage, 'INTERNAL_ERROR');
};
