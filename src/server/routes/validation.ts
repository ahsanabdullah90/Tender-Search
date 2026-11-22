import type { Request, RequestHandler, Response } from 'express';
import { AppHttpError, type FieldValidationIssue } from './httpErrors.js';
import { validateExternalHttpUrl } from '../services/urlSafety.js';

/** Discriminated result returned by every schema parser. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: FieldValidationIssue[] };

/** Composable validation parser function for a typed value `T`. */
export type Schema<T> = (input: unknown, field?: string) => ParseResult<T>;

/** Extracts the parsed output type `T` from a `Schema<T>`. */
export type InferSchema<S> = S extends Schema<infer T> ? T : never;

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function fail<T = never>(field: string, message: string): ParseResult<T> {
  return { ok: false, issues: [{ field, message }] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateNonEmptyTrimmedString(
  input: unknown,
  field: string,
  opts?: { requiredMessage?: string; typeMessage?: string }
): ParseResult<string> {
  if (input === undefined || input === null) {
    return fail(field, opts?.requiredMessage ?? `${field} is required`);
  }
  if (typeof input !== 'string') {
    return fail(field, opts?.typeMessage ?? `${field} must be a string`);
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return fail(field, opts?.requiredMessage ?? `${field} is required`);
  }
  return ok(trimmed);
}

/** Composable zero-dependency schema builders for API route validation. */
export const v = {
  /** Validates a string with optional trimming and length bounds. */
  string(opts?: {
    trim?: boolean;
    minLength?: number;
    maxLength?: number;
    requiredMessage?: string;
    typeMessage?: string;
  }): Schema<string> {
    return (input, field = 'value') => {
      if (input === undefined || input === null) {
        return fail(field, opts?.requiredMessage ?? `${field} is required`);
      }
      if (typeof input !== 'string') {
        return fail(field, opts?.typeMessage ?? `${field} must be a string`);
      }
      const value = opts?.trim ? input.trim() : input;
      if (opts?.minLength !== undefined && value.length < opts.minLength) {
        if (value.length === 0 && opts.requiredMessage) {
          return fail(field, opts.requiredMessage);
        }
        return fail(
          field,
          opts.minLength === 1
            ? `${field} must not be empty`
            : `${field} must be at least ${opts.minLength} characters`
        );
      }
      if (opts?.maxLength !== undefined && value.length > opts.maxLength) {
        return fail(field, `${field} must be at most ${opts.maxLength} characters`);
      }
      return ok(value);
    };
  },

  /** Trims input and rejects missing, non-string, or whitespace-only values. */
  nonEmptyString(requiredMessage?: string): Schema<string> {
    return (input, field = 'value') =>
      validateNonEmptyTrimmedString(input, field, { requiredMessage });
  },

  /** Strictly validates a boolean primitive (rejects stringified booleans like `"false"`). */
  boolean(opts?: { typeMessage?: string }): Schema<boolean> {
    return (input, field = 'value') => {
      if (typeof input !== 'boolean') {
        return fail(field, opts?.typeMessage ?? `${field} must be a boolean`);
      }
      return ok(input);
    };
  },

  /** Parses Express query boolean flags (`true`/`'true'`/`'1'` and `false`/`'false'`/`'0'`). */
  queryBoolean(): Schema<boolean> {
    return (input, field = 'value') => {
      if (input === true || input === 'true' || input === '1') {
        return ok(true);
      }
      if (input === false || input === 'false' || input === '0') {
        return ok(false);
      }
      return fail(field, `${field} must be a boolean ('true', 'false', '1', or '0')`);
    };
  },

  /** Validates finite numbers with optional coercion, integer enforcement, and range bounds. */
  number(opts?: {
    min?: number;
    max?: number;
    integer?: boolean;
    coerce?: boolean;
    typeMessage?: string;
  }): Schema<number> {
    return (input, field = 'value') => {
      let num: number;
      if (opts?.coerce) {
        if (typeof input === 'number') {
          num = input;
        } else if (typeof input === 'string') {
          const trimmed = input.trim();
          if (!trimmed) {
            return fail(field, opts.typeMessage ?? `${field} must be a valid number`);
          }
          num = Number(trimmed);
        } else {
          return fail(field, opts.typeMessage ?? `${field} must be a valid number`);
        }
      } else {
        if (typeof input !== 'number') {
          return fail(field, opts?.typeMessage ?? `${field} must be a number`);
        }
        num = input;
      }

      if (!Number.isFinite(num)) {
        return fail(field, opts?.typeMessage ?? `${field} must be a finite number`);
      }
      if (opts?.integer && !Number.isInteger(num)) {
        return fail(field, `${field} must be an integer`);
      }
      if (opts?.min !== undefined && num < opts.min) {
        return fail(field, `${field} must be at least ${opts.min}`);
      }
      if (opts?.max !== undefined && num > opts.max) {
        return fail(field, `${field} must be at most ${opts.max}`);
      }
      return ok(num);
    };
  },

  /** Validates a string value against an allowed literal tuple/array. */
  oneOf<const T extends readonly string[]>(
    allowed: T,
    opts?: {
      requiredMessage?: string;
      invalidMessage?: (raw: unknown) => string;
      trim?: boolean;
    }
  ): Schema<T[number]> {
    return (input, field = 'value') => {
      if (typeof input === 'string') {
        const candidate = opts?.trim ? input.trim() : input;
        if ((allowed as readonly string[]).includes(candidate)) {
          return ok(candidate as T[number]);
        }
      }
      if (input === undefined || input === null || (typeof input === 'string' && !input.trim())) {
        return fail(field, opts?.requiredMessage ?? `${field} is required`);
      }
      const message = opts?.invalidMessage
        ? opts.invalidMessage(input)
        : `${field} must be one of: ${allowed.join(', ')}`;
      return fail(field, message);
    };
  },

  /** Validates an array and every element against `itemSchema`. */
  array<T>(
    itemSchema: Schema<T>,
    opts?: { maxLength?: number; typeMessage?: string }
  ): Schema<T[]> {
    return (input, field = 'value') => {
      if (!Array.isArray(input)) {
        return fail(field, opts?.typeMessage ?? `${field} must be an array`);
      }
      if (opts?.maxLength !== undefined && input.length > opts.maxLength) {
        return fail(field, `${field} must contain at most ${opts.maxLength} items`);
      }
      const values: T[] = [];
      const issues: FieldValidationIssue[] = [];
      for (let i = 0; i < input.length; i++) {
        const parsed = itemSchema(input[i], `${field}[${i}]`);
        if (parsed.ok) {
          values.push(parsed.value);
        } else {
          issues.push(...parsed.issues);
        }
      }
      return issues.length > 0 ? { ok: false, issues } : ok(values);
    };
  },

  /** Validates and trims an external HTTP(S) URL using the SEC-5 SSRF guard. */
  externalHttpUrl(opts?: { requiredMessage?: string; typeMessage?: string }): Schema<string> {
    return (input, field = 'value') => {
      const strResult = validateNonEmptyTrimmedString(input, field, opts);
      if (!strResult.ok) return strResult;
      const check = validateExternalHttpUrl(strResult.value);
      if (!check.valid) {
        return fail(field, check.reason);
      }
      return ok(strResult.value);
    };
  },

  /** Validates a non-empty trimmed string that parses into a valid `Date`. */
  isoOrParsableDate(invalidMessage?: string): Schema<string> {
    return (input, field = 'value') => {
      if (typeof input !== 'string') {
        return fail(field, invalidMessage ?? `${field} must be a valid date string`);
      }
      const trimmed = input.trim();
      if (!trimmed || Number.isNaN(new Date(trimmed).getTime())) {
        return fail(field, invalidMessage ?? `${field} must be a valid date`);
      }
      return ok(trimmed);
    };
  },

  /** Allows `undefined` without calling `schema`. */
  optional<T>(schema: Schema<T>): Schema<T | undefined> {
    return (input, field) => (input === undefined ? ok(undefined) : schema(input, field));
  },

  /** Allows `null` without calling `schema`. */
  nullable<T>(schema: Schema<T>): Schema<T | null> {
    return (input, field) => (input === null ? ok(null) : schema(input, field));
  },

  /** Allows `null` or `undefined` without calling `schema`. */
  nullish<T>(schema: Schema<T>): Schema<T | null | undefined> {
    return (input, field) => {
      if (input === undefined) return ok(undefined);
      if (input === null) return ok(null);
      return schema(input, field);
    };
  },

  /** Validates a plain JSON object against `shape`, strips unknown keys, and runs optional `refine`. */
  object<S extends Record<string, Schema<unknown>>>(
    shape: S,
    opts?: {
      refine?: (val: NoInfer<{ [K in keyof S]: InferSchema<S[K]> }>) => string | FieldValidationIssue[] | null;
    }
  ): Schema<{ [K in keyof S]: InferSchema<S[K]> }> {
    return (input, field) => {
      if (!isPlainObject(input)) {
        const targetField = field ?? 'body';
        return fail(targetField, `${targetField} must be a JSON object`);
      }
      const output: Record<string, unknown> = {};
      const issues: FieldValidationIssue[] = [];
      for (const key of Object.keys(shape)) {
        const propField = field ? `${field}.${key}` : key;
        const rawVal = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined;
        const parsed = shape[key](rawVal, propField);
        if (!parsed.ok) {
          issues.push(...parsed.issues);
        } else if (parsed.value !== undefined) {
          output[key] = parsed.value;
        }
      }
      if (issues.length > 0) {
        return { ok: false, issues };
      }
      const typedValue = output as { [K in keyof S]: InferSchema<S[K]> };
      if (opts?.refine) {
        const refined = opts.refine(typedValue);
        if (typeof refined === 'string') {
          return fail(field ?? 'body', refined);
        }
        if (Array.isArray(refined) && refined.length > 0) {
          return { ok: false, issues: refined };
        }
      }
      return ok(typedValue);
    };
  },

  /** Validates that input is a plain JSON object without restricting keys. */
  anyObject(opts?: { typeMessage?: string }): Schema<Record<string, unknown>> {
    return (input, field = 'body') => {
      if (!isPlainObject(input)) {
        return fail(field, opts?.typeMessage ?? `${field} must be a JSON object`);
      }
      return ok({ ...input });
    };
  }
};

/** Express middleware validating `req.body` against `schema` and forwarding `AppHttpError.validation` on failure. */
export function validateBody<T>(schema: Schema<T>): RequestHandler {
  return (req, res, next) => {
    const candidate = req.body === undefined ? {} : req.body;
    const parsed = schema(candidate);
    if (!parsed.ok) {
      next(AppHttpError.validation(parsed.issues[0]?.message || 'Validation failed', parsed.issues));
      return;
    }
    res.locals.validatedBody = parsed.value;
    req.body = parsed.value;
    next();
  };
}

/** Express middleware validating `req.query` against `schema` without mutating `req.query`. */
export function validateQuery<T>(schema: Schema<T>): RequestHandler {
  return (req, res, next) => {
    const parsed = schema(req.query ?? {});
    if (!parsed.ok) {
      next(AppHttpError.validation(parsed.issues[0]?.message || 'Invalid query parameters', parsed.issues));
      return;
    }
    res.locals.validatedQuery = parsed.value;
    next();
  };
}

/** Retrieves the parsed request body stored by `validateBody`, falling back to `req.body`. */
export function getValidatedBody<T>(res: Response, req?: Request): T {
  if (res.locals?.validatedBody !== undefined) {
    return res.locals.validatedBody as T;
  }
  return req?.body as T;
}

/** Retrieves the parsed query object stored by `validateQuery`. */
export function getValidatedQuery<T>(res: Response): T {
  if (res.locals?.validatedQuery !== undefined) {
    return res.locals.validatedQuery as T;
  }
  return {} as T;
}
