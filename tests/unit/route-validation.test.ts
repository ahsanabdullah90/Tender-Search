import { describe, it, expect, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import {
  AppHttpError,
  errorHandler,
  sendError,
  statusToErrorCode
} from '../../src/server/routes/httpErrors.js';
import {
  getValidatedBody,
  getValidatedQuery,
  v,
  validateBody,
  validateQuery,
  type InferSchema
} from '../../src/server/routes/validation.js';
import * as routeUtils from '../../src/server/routes/routeUtils.js';
import { validateExternalHttpUrl } from '../../src/server/services/urlSafety.js';

function createMockResponse() {
  const res: Partial<Response> & {
    statusCodeValue?: number;
    jsonBody?: unknown;
    headersSent: boolean;
    locals: Record<string, unknown>;
  } = {
    headersSent: false,
    locals: {},
    status(code: number) {
      this.statusCodeValue = code;
      return this as Response;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this as Response;
    }
  };
  return res as Response & { statusCodeValue?: number; jsonBody?: unknown };
}

describe('httpErrors & uniform API error handling', () => {
  it('maps standard HTTP statuses to canonical ApiErrorCode values', () => {
    expect(statusToErrorCode(400)).toBe('BAD_REQUEST');
    expect(statusToErrorCode(403)).toBe('FORBIDDEN');
    expect(statusToErrorCode(404)).toBe('NOT_FOUND');
    expect(statusToErrorCode(422)).toBe('UNPROCESSABLE_ENTITY');
    expect(statusToErrorCode(503)).toBe('SERVICE_UNAVAILABLE');
    expect(statusToErrorCode(500)).toBe('INTERNAL_ERROR');
    expect(statusToErrorCode(418)).toBe('INTERNAL_ERROR');
  });

  it('constructs AppHttpError instances and convenience factory variants', () => {
    const bad = AppHttpError.badRequest('Bad payload', [{ field: 'id', message: 'Invalid id' }]);
    expect(bad).toBeInstanceOf(Error);
    expect(bad).toBeInstanceOf(AppHttpError);
    expect(bad.name).toBe('AppHttpError');
    expect(bad.statusCode).toBe(400);
    expect(bad.code).toBe('BAD_REQUEST');
    expect(bad.details).toEqual([{ field: 'id', message: 'Invalid id' }]);

    const val = AppHttpError.validation('Title is required', [{ field: 'title', message: 'Title is required' }]);
    expect(val.statusCode).toBe(400);
    expect(val.code).toBe('VALIDATION_ERROR');
    expect(val.details).toEqual([{ field: 'title', message: 'Title is required' }]);

    expect(AppHttpError.forbidden('Denied')).toMatchObject({ statusCode: 403, code: 'FORBIDDEN', message: 'Denied' });
    expect(AppHttpError.notFound('Missing')).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', message: 'Missing' });
    expect(AppHttpError.unprocessable('Invalid entity')).toMatchObject({
      statusCode: 422,
      code: 'UNPROCESSABLE_ENTITY',
      message: 'Invalid entity'
    });
    expect(AppHttpError.serviceUnavailable('Unavailable')).toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Unavailable'
    });
    expect(AppHttpError.internal('Crash')).toMatchObject({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Crash'
    });
  });

  it('sendError writes uniform ApiErrorEnvelope and omits empty details', () => {
    const res1 = createMockResponse();
    sendError(res1, 404, 'Tender not found');
    expect(res1.statusCodeValue).toBe(404);
    expect(res1.jsonBody).toEqual({
      success: false,
      error: 'Tender not found',
      message: 'Tender not found',
      code: 'NOT_FOUND'
    });

    const res2 = createMockResponse();
    sendError(res2, 400, 'Validation failed', 'VALIDATION_ERROR', []);
    expect(res2.jsonBody).toEqual({
      success: false,
      error: 'Validation failed',
      message: 'Validation failed',
      code: 'VALIDATION_ERROR'
    });

    const res3 = createMockResponse();
    sendError(res3, 400, 'Validation failed', 'VALIDATION_ERROR', [{ field: 'name', message: 'Required' }]);
    expect(res3.jsonBody).toEqual({
      success: false,
      error: 'Validation failed',
      message: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: [{ field: 'name', message: 'Required' }]
    });
  });

  it('errorHandler forwards to next(err) when headersSent is true', () => {
    const res = createMockResponse();
    res.headersSent = true;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error('late failure');

    errorHandler(err, {} as Request, res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.statusCodeValue).toBeUndefined();
  });

  it('errorHandler handles AppHttpError, malformed JSON SyntaxError, 413, statusCode errors, and generic Errors', () => {
    const next = vi.fn() as unknown as NextFunction;

    // AppHttpError
    const resApp = createMockResponse();
    errorHandler(
      AppHttpError.validation('Status is required', [{ field: 'status', message: 'Status is required' }]),
      {} as Request,
      resApp,
      next
    );
    expect(resApp.statusCodeValue).toBe(400);
    expect(resApp.jsonBody).toEqual({
      success: false,
      error: 'Status is required',
      message: 'Status is required',
      code: 'VALIDATION_ERROR',
      details: [{ field: 'status', message: 'Status is required' }]
    });

    // Body-parser malformed JSON SyntaxError (status === 400)
    const resJsonStatus = createMockResponse();
    const syntaxErr1 = Object.assign(new SyntaxError('Unexpected token } in JSON'), { status: 400 });
    errorHandler(syntaxErr1, {} as Request, resJsonStatus, next);
    expect(resJsonStatus.statusCodeValue).toBe(400);
    expect(resJsonStatus.jsonBody).toEqual({
      success: false,
      error: 'Invalid JSON request body',
      message: 'Invalid JSON request body',
      code: 'BAD_REQUEST'
    });

    // Body-parser malformed JSON SyntaxError (type === 'entity.parse.failed')
    const resJsonType = createMockResponse();
    const syntaxErr2 = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      type: 'entity.parse.failed'
    });
    errorHandler(syntaxErr2, {} as Request, resJsonType, next);
    expect(resJsonType.statusCodeValue).toBe(400);
    expect(resJsonType.jsonBody).toMatchObject({ code: 'BAD_REQUEST', error: 'Invalid JSON request body' });

    // Non-body-parser SyntaxError should NOT be masked as 400 BAD_REQUEST
    const resInternalSyntax = createMockResponse();
    errorHandler(new SyntaxError('Internal regex failure'), {} as Request, resInternalSyntax, next);
    expect(resInternalSyntax.statusCodeValue).toBe(500);
    expect(resInternalSyntax.jsonBody).toMatchObject({
      code: 'INTERNAL_ERROR',
      error: 'Internal regex failure'
    });

    // Payload too large (413 / entity.too.large)
    const resTooLarge = createMockResponse();
    errorHandler({ status: 413, type: 'entity.too.large', message: 'request entity too large' }, {} as Request, resTooLarge, next);
    expect(resTooLarge.statusCodeValue).toBe(413);
    expect(resTooLarge.jsonBody).toEqual({
      success: false,
      error: 'Request payload exceeds limit',
      message: 'Request payload exceeds limit',
      code: 'BAD_REQUEST'
    });

    // Generic object with numeric statusCode 400..599
    const resStatusObj = createMockResponse();
    errorHandler({ statusCode: 422, message: 'Cannot process entity' }, {} as Request, resStatusObj, next);
    expect(resStatusObj.statusCodeValue).toBe(422);
    expect(resStatusObj.jsonBody).toEqual({
      success: false,
      error: 'Cannot process entity',
      message: 'Cannot process entity',
      code: 'UNPROCESSABLE_ENTITY'
    });

    // Generic Error -> 500 INTERNAL_ERROR
    const resGeneric = createMockResponse();
    errorHandler(new Error('Database disk is full'), {} as Request, resGeneric, next);
    expect(resGeneric.statusCodeValue).toBe(500);
    expect(resGeneric.jsonBody).toEqual({
      success: false,
      error: 'Database disk is full',
      message: 'Database disk is full',
      code: 'INTERNAL_ERROR'
    });

    // Unknown thrown non-Error -> 500 fallback message
    const resUnknown = createMockResponse();
    errorHandler('unexpected string throw', {} as Request, resUnknown, next);
    expect(resUnknown.statusCodeValue).toBe(500);
    expect(resUnknown.jsonBody).toEqual({
      success: false,
      error: 'Internal server error',
      message: 'Internal server error',
      code: 'INTERNAL_ERROR'
    });
  });
});

describe('zero-dependency validation engine (v.*)', () => {
  it('validates v.string with trim, minLength, maxLength, and custom messages', () => {
    const basic = v.string();
    expect(basic('hello')).toEqual({ ok: true, value: 'hello' });
    expect(basic('')).toEqual({ ok: true, value: '' });
    expect(basic(undefined, 'notes')).toEqual({
      ok: false,
      issues: [{ field: 'notes', message: 'notes is required' }]
    });
    expect(basic(123, 'notes')).toEqual({
      ok: false,
      issues: [{ field: 'notes', message: 'notes must be a string' }]
    });

    const bounded = v.string({
      trim: true,
      minLength: 3,
      maxLength: 6,
      requiredMessage: 'Code required',
      typeMessage: 'Code must be text'
    });
    expect(bounded('  abc  ', 'code')).toEqual({ ok: true, value: 'abc' });
    expect(bounded(42, 'code')).toEqual({
      ok: false,
      issues: [{ field: 'code', message: 'Code must be text' }]
    });
    expect(bounded('   ', 'code')).toEqual({
      ok: false,
      issues: [{ field: 'code', message: 'Code required' }]
    });
    expect(bounded('ab', 'code')).toEqual({
      ok: false,
      issues: [{ field: 'code', message: 'code must be at least 3 characters' }]
    });
    expect(bounded('abcdefg', 'code')).toEqual({
      ok: false,
      issues: [{ field: 'code', message: 'code must be at most 6 characters' }]
    });
  });

  it('validates v.nonEmptyString by trimming and rejecting missing/empty/non-string inputs', () => {
    const schema = v.nonEmptyString('Title is required');
    expect(schema('  Solar Inverter Tender  ', 'title')).toEqual({
      ok: true,
      value: 'Solar Inverter Tender'
    });
    expect(schema(undefined, 'title')).toEqual({
      ok: false,
      issues: [{ field: 'title', message: 'Title is required' }]
    });
    expect(schema(null, 'title')).toEqual({
      ok: false,
      issues: [{ field: 'title', message: 'Title is required' }]
    });
    expect(schema('   \t\n ', 'title')).toEqual({
      ok: false,
      issues: [{ field: 'title', message: 'Title is required' }]
    });
    expect(schema(999, 'title')).toEqual({
      ok: false,
      issues: [{ field: 'title', message: 'title must be a string' }]
    });

    const defaultMsg = v.nonEmptyString();
    expect(defaultMsg('', 'name')).toEqual({
      ok: false,
      issues: [{ field: 'name', message: 'name is required' }]
    });
  });

  it('validates v.boolean strictly and rejects stringified booleans like "false"', () => {
    const strictBool = v.boolean({ typeMessage: 'unreviewedOnly must be a boolean' });
    expect(strictBool(true, 'unreviewedOnly')).toEqual({ ok: true, value: true });
    expect(strictBool(false, 'unreviewedOnly')).toEqual({ ok: true, value: false });

    for (const bad of ['false', 'true', '1', '0', 1, 0, null, undefined, {}, []]) {
      const res = strictBool(bad, 'unreviewedOnly');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues[0].message).toBe('unreviewedOnly must be a boolean');
      }
    }
  });

  it('validates v.queryBoolean for Express query strings and rejects arbitrary strings', () => {
    const qb = v.queryBoolean();
    expect(qb(true, 'bookmarkedOnly')).toEqual({ ok: true, value: true });
    expect(qb('true', 'bookmarkedOnly')).toEqual({ ok: true, value: true });
    expect(qb('1', 'bookmarkedOnly')).toEqual({ ok: true, value: true });
    expect(qb(false, 'bookmarkedOnly')).toEqual({ ok: true, value: false });
    expect(qb('false', 'bookmarkedOnly')).toEqual({ ok: true, value: false });
    expect(qb('0', 'bookmarkedOnly')).toEqual({ ok: true, value: false });

    for (const bad of ['yes', 'no', '2', '', 'TRUE', 1, 0, null, ['true']]) {
      expect(qb(bad, 'bookmarkedOnly').ok).toBe(false);
    }
  });

  it('validates v.number with finite, integer, min/max, and safe coercion guards', () => {
    const strictNum = v.number({ min: 1, max: 100, integer: true });
    expect(strictNum(10, 'graceDays')).toEqual({ ok: true, value: 10 });
    expect(strictNum('10', 'graceDays').ok).toBe(false);
    expect(strictNum(NaN, 'graceDays').ok).toBe(false);
    expect(strictNum(Infinity, 'graceDays').ok).toBe(false);
    expect(strictNum(-Infinity, 'graceDays').ok).toBe(false);
    expect(strictNum(3.5, 'graceDays')).toEqual({
      ok: false,
      issues: [{ field: 'graceDays', message: 'graceDays must be an integer' }]
    });
    expect(strictNum(0, 'graceDays')).toEqual({
      ok: false,
      issues: [{ field: 'graceDays', message: 'graceDays must be at least 1' }]
    });
    expect(strictNum(101, 'graceDays')).toEqual({
      ok: false,
      issues: [{ field: 'graceDays', message: 'graceDays must be at most 100' }]
    });

    const coerced = v.number({ coerce: true, min: 1, max: 168 });
    expect(coerced('48', 'withinHours')).toEqual({ ok: true, value: 48 });
    expect(coerced(' 12.5 ', 'withinHours')).toEqual({ ok: true, value: 12.5 });
    expect(coerced(24, 'withinHours')).toEqual({ ok: true, value: 24 });

    // Crucial JS Number() coercion pitfalls must be rejected
    for (const bad of ['', '   ', 'abc', null, undefined, true, false, [5], {}, NaN, Infinity]) {
      expect(coerced(bad, 'withinHours').ok).toBe(false);
    }
  });

  it('validates v.oneOf against allowed string literals with custom messages', () => {
    const depthSchema = v.oneOf(['quick', 'deep']);
    expect(depthSchema('quick', 'depth')).toEqual({ ok: true, value: 'quick' });
    expect(depthSchema('deep', 'depth')).toEqual({ ok: true, value: 'deep' });
    expect(depthSchema('full', 'depth')).toEqual({
      ok: false,
      issues: [{ field: 'depth', message: 'depth must be one of: quick, deep' }]
    });

    const statusSchema = v.oneOf(['New Opportunity', 'Preparing Bid'] as const, {
      requiredMessage: 'Status is required',
      invalidMessage: (raw) => `Invalid status: "${raw}"`,
      trim: true
    });
    expect(statusSchema('  Preparing Bid  ', 'status')).toEqual({
      ok: true,
      value: 'Preparing Bid'
    });
    expect(statusSchema(undefined, 'status')).toEqual({
      ok: false,
      issues: [{ field: 'status', message: 'Status is required' }]
    });
    expect(statusSchema('   ', 'status')).toEqual({
      ok: false,
      issues: [{ field: 'status', message: 'Status is required' }]
    });
    expect(statusSchema('Bogus', 'status')).toEqual({
      ok: false,
      issues: [{ field: 'status', message: 'Invalid status: "Bogus"' }]
    });
    expect(statusSchema(123, 'status')).toEqual({
      ok: false,
      issues: [{ field: 'status', message: 'Invalid status: "123"' }]
    });
  });

  it('validates v.array elements with indexed field paths and maxLength', () => {
    const tags = v.array(v.nonEmptyString(), { maxLength: 3 });
    expect(tags(['solar', '  grid  '], 'keywords')).toEqual({
      ok: true,
      value: ['solar', 'grid']
    });
    expect(tags('not-an-array', 'keywords')).toEqual({
      ok: false,
      issues: [{ field: 'keywords', message: 'keywords must be an array' }]
    });
    expect(tags(['a', 'b', 'c', 'd'], 'keywords')).toEqual({
      ok: false,
      issues: [{ field: 'keywords', message: 'keywords must contain at most 3 items' }]
    });
    expect(tags(['valid', '  ', 42], 'keywords')).toEqual({
      ok: false,
      issues: [
        { field: 'keywords[1]', message: 'keywords[1] is required' },
        { field: 'keywords[2]', message: 'keywords[2] must be a string' }
      ]
    });
  });

  it('validates v.externalHttpUrl against SEC-5 SSRF rules and preserves exact reason', () => {
    const urlSchema = v.externalHttpUrl({ requiredMessage: 'Portal URL is required.' });
    expect(urlSchema('  https://epms.ppra.gov.pk/public/tenders  ', 'tenders_url')).toEqual({
      ok: true,
      value: 'https://epms.ppra.gov.pk/public/tenders'
    });
    expect(urlSchema('', 'tenders_url')).toEqual({
      ok: false,
      issues: [{ field: 'tenders_url', message: 'Portal URL is required.' }]
    });
    expect(urlSchema(123, 'tenders_url')).toEqual({
      ok: false,
      issues: [{ field: 'tenders_url', message: 'tenders_url must be a string' }]
    });

    const ssrfInputs = [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:3000/api/system/reset',
      'http://localhost:8080/hook',
      'http://10.0.0.1/admin',
      'http://[::1]/internal',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pass@example.gov.pk/tenders',
      'http://2130706433/'
    ];
    for (const candidate of ssrfInputs) {
      const expected = validateExternalHttpUrl(candidate);
      expect(expected.valid).toBe(false);
      const actual = urlSchema(candidate, 'webhookUrl');
      expect(actual.ok).toBe(false);
      if (!actual.ok && !expected.valid) {
        expect(actual.issues).toEqual([{ field: 'webhookUrl', message: expected.reason }]);
      }
    }
  });

  it('validates v.isoOrParsableDate and rejects numbers, arrays, objects, and invalid strings', () => {
    const dateSchema = v.isoOrParsableDate('Invalid date');
    expect(dateSchema('  2026-12-15  ', 'date')).toEqual({ ok: true, value: '2026-12-15' });
    expect(dateSchema('2026-06-30T14:00:00+05:00', 'date')).toEqual({
      ok: true,
      value: '2026-06-30T14:00:00+05:00'
    });

    for (const bad of ['', '   ', 'not-a-date', 1700000000000, ['2026-12-15'], {}, new Date(), null, undefined, true]) {
      expect(dateSchema(bad, 'date')).toEqual({
        ok: false,
        issues: [{ field: 'date', message: 'Invalid date' }]
      });
    }
  });

  it('supports v.optional, v.nullable, v.nullish, v.anyObject, and nested v.object', () => {
    const optStr = v.optional(v.nonEmptyString());
    expect(optStr(undefined, 'label')).toEqual({ ok: true, value: undefined });
    expect(optStr('  Notice  ', 'label')).toEqual({ ok: true, value: 'Notice' });
    expect(optStr('', 'label').ok).toBe(false);

    const nullStr = v.nullable(v.string());
    expect(nullStr(null, 'ref')).toEqual({ ok: true, value: null });
    expect(nullStr(undefined, 'ref').ok).toBe(false);

    const nullishDate = v.nullish(v.isoOrParsableDate('Invalid date'));
    expect(nullishDate(undefined, 'date')).toEqual({ ok: true, value: undefined });
    expect(nullishDate(null, 'date')).toEqual({ ok: true, value: null });
    expect(nullishDate('2026-08-15', 'date')).toEqual({ ok: true, value: '2026-08-15' });
    expect(nullishDate('bad', 'date').ok).toBe(false);

    const anyObj = v.anyObject();
    expect(anyObj({ a: 1, b: 'x' })).toEqual({ ok: true, value: { a: 1, b: 'x' } });
    expect(anyObj(null).ok).toBe(false);
    expect(anyObj([]).ok).toBe(false);
    expect(anyObj(new Date()).ok).toBe(false);

    // Optional wrapping nested v.object preserves clean nested field path without 'value.'
    const wrapper = v.object({
      title: v.nonEmptyString('Title is required'),
      attachment: v.optional(
        v.object({
          filename: v.nonEmptyString('Filename is required')
        })
      )
    });
    const parsedOk = wrapper({ title: '  RFP  ', extraUnknownKey: 'should-strip' });
    expect(parsedOk).toEqual({ ok: true, value: { title: 'RFP' } });
    if (parsedOk.ok) {
      expect(Object.keys(parsedOk.value)).toEqual(['title']);
    }

    const parsedNestedErr = wrapper({ title: 'RFP', attachment: { filename: '  ' } });
    expect(parsedNestedErr).toEqual({
      ok: false,
      issues: [{ field: 'attachment.filename', message: 'Filename is required' }]
    });

    // Rejects non-plain objects
    expect(wrapper(null).ok).toBe(false);
    expect(wrapper(['RFP']).ok).toBe(false);
    expect(wrapper('RFP').ok).toBe(false);
    expect(wrapper(new Date()).ok).toBe(false);
  });

  it('supports cross-field object refine returning string, FieldValidationIssue[], or null', () => {
    const portalSchema = v.object(
      {
        portal_name: v.nonEmptyString('Portal name is required.'),
        tenders_url: v.optional(v.externalHttpUrl()),
        base_url: v.optional(v.externalHttpUrl())
      },
      {
        refine: (val) => {
          if (!val.tenders_url && !val.base_url) {
            return 'Portal website or tenders URL is required.';
          }
          return null;
        }
      }
    );

    type PortalInput = InferSchema<typeof portalSchema>;
    const validSample: PortalInput = {
      portal_name: 'WAPDA',
      tenders_url: 'https://wapda.gov.pk/tenders',
      base_url: undefined
    };
    expect(validSample.portal_name).toBe('WAPDA');

    expect(portalSchema({ portal_name: 'WAPDA' })).toEqual({
      ok: false,
      issues: [{ field: 'body', message: 'Portal website or tenders URL is required.' }]
    });
    expect(
      portalSchema({ portal_name: 'WAPDA', tenders_url: 'https://wapda.gov.pk/tenders' })
    ).toEqual({
      ok: true,
      value: { portal_name: 'WAPDA', tenders_url: 'https://wapda.gov.pk/tenders' }
    });

    const multiIssueSchema = v.object(
      {
        base64Data: v.optional(v.nonEmptyString()),
        dataBase64: v.optional(v.nonEmptyString())
      },
      {
        refine: (val) =>
          !val.base64Data && !val.dataBase64
            ? [{ field: 'base64Data', message: 'base64Data is required' }]
            : null
      }
    );
    expect(multiIssueSchema({})).toEqual({
      ok: false,
      issues: [{ field: 'base64Data', message: 'base64Data is required' }]
    });
    expect(multiIssueSchema({ dataBase64: 'ZmFrZQ==' })).toEqual({
      ok: true,
      value: { dataBase64: 'ZmFrZQ==' }
    });
  });
});

describe('Express validation middlewares & routeUtils re-exports', () => {
  it('validateBody treats undefined body as {}, updates req.body & res.locals.validatedBody, and passes errors to next', () => {
    const schema = v.object({
      status: v.oneOf(['New Opportunity', 'Preparing Bid'] as const, {
        requiredMessage: 'Status is required'
      }),
      notes: v.optional(v.string({ trim: true }))
    });
    const mw = validateBody(schema);

    // Missing req.body (undefined) -> treated as {} -> clean field error
    const nextFail = vi.fn();
    const resFail = createMockResponse();
    mw({ body: undefined } as Request, resFail, nextFail as unknown as NextFunction);
    expect(nextFail).toHaveBeenCalledTimes(1);
    const err = nextFail.mock.calls[0][0] as AppHttpError;
    expect(err).toBeInstanceOf(AppHttpError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Status is required');
    expect(err.details).toEqual([{ field: 'status', message: 'Status is required' }]);

    // Valid body -> strips unknown keys, trims notes, sets res.locals.validatedBody and req.body
    const nextOk = vi.fn();
    const reqOk = {
      body: { status: 'Preparing Bid', notes: '  Shortlisted  ', extra: 'drop-me' }
    } as Request;
    const resOk = createMockResponse();
    mw(reqOk, resOk, nextOk as unknown as NextFunction);
    expect(nextOk).toHaveBeenCalledWith();
    expect(reqOk.body).toEqual({ status: 'Preparing Bid', notes: 'Shortlisted' });
    expect(getValidatedBody(resOk)).toEqual({ status: 'Preparing Bid', notes: 'Shortlisted' });

    // getValidatedBody falls back to req.body when middleware did not populate res.locals
    const emptyLocalsRes = createMockResponse();
    expect(getValidatedBody(emptyLocalsRes, { body: { raw: true } } as Request)).toEqual({ raw: true });
  });

  it('validateQuery populates res.locals.validatedQuery without mutating req.query', () => {
    const querySchema = v.object({
      bookmarkedOnly: v.optional(v.queryBoolean()),
      hours: v.optional(v.number({ coerce: true, min: 1, max: 720 }))
    });
    const mw = validateQuery(querySchema);

    const rawQuery = { bookmarkedOnly: '1', hours: '48', ignored: 'x' };
    const reqOk = { query: rawQuery } as unknown as Request;
    const resOk = createMockResponse();
    const nextOk = vi.fn();
    mw(reqOk, resOk, nextOk as unknown as NextFunction);
    expect(nextOk).toHaveBeenCalledWith();
    expect(reqOk.query).toBe(rawQuery);
    expect(getValidatedQuery(resOk)).toEqual({ bookmarkedOnly: true, hours: 48 });

    // Invalid query forwards AppHttpError.validation
    const reqBad = { query: { bookmarkedOnly: 'maybe' } } as unknown as Request;
    const resBad = createMockResponse();
    const nextBad = vi.fn();
    mw(reqBad, resBad, nextBad as unknown as NextFunction);
    expect(nextBad).toHaveBeenCalledTimes(1);
    const err = nextBad.mock.calls[0][0] as AppHttpError;
    expect(err).toBeInstanceOf(AppHttpError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details?.[0].field).toBe('bookmarkedOnly');

    // getValidatedQuery fallback when middleware not run
    expect(getValidatedQuery(createMockResponse())).toEqual({});
  });

  it('integrates end-to-end with Express json parser, validateBody, validateQuery, and errorHandler', async () => {
    const app = express();
    app.use(express.json({ limit: '100b' }));

    app.get(
      '/items',
      validateQuery(v.object({ active: v.optional(v.queryBoolean()), limit: v.optional(v.number({ coerce: true, integer: true, min: 1 })) })),
      (_req, res) => {
        res.json({ query: getValidatedQuery(res) });
      }
    );

    app.post(
      '/items',
      validateBody(v.object({ name: v.nonEmptyString('Name is required'), enabled: v.boolean() })),
      (req, res) => {
        res.status(201).json({ body: getValidatedBody(res, req) });
      }
    );

    app.use(errorHandler);

    // Valid query + body
    const getOk = await request(app).get('/items?active=true&limit=10');
    expect(getOk.status).toBe(200);
    expect(getOk.body).toEqual({ query: { active: true, limit: 10 } });

    // Invalid query
    const getBad = await request(app).get('/items?active=nope');
    expect(getBad.status).toBe(400);
    expect(getBad.body.code).toBe('VALIDATION_ERROR');
    expect(getBad.body.success).toBe(false);

    // Valid body
    const postOk = await request(app).post('/items').send({ name: '  Tender A  ', enabled: false, unknown: 1 });
    expect(postOk.status).toBe(201);
    expect(postOk.body).toEqual({ body: { name: 'Tender A', enabled: false } });

    // Strict boolean rejects stringified "false"
    const postBadBool = await request(app).post('/items').send({ name: 'Tender A', enabled: 'false' });
    expect(postBadBool.status).toBe(400);
    expect(postBadBool.body.code).toBe('VALIDATION_ERROR');
    expect(postBadBool.body.details).toEqual([{ field: 'enabled', message: 'enabled must be a boolean' }]);

    // Malformed JSON -> 400 BAD_REQUEST
    const malformed = await request(app)
      .post('/items')
      .set('Content-Type', 'application/json')
      .send('{"name": "broken"');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({
      success: false,
      error: 'Invalid JSON request body',
      message: 'Invalid JSON request body',
      code: 'BAD_REQUEST'
    });

    // Oversized JSON (>100b) -> 413 BAD_REQUEST
    const oversized = await request(app)
      .post('/items')
      .send({ name: 'x'.repeat(200), enabled: true });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({
      success: false,
      error: 'Request payload exceeds limit',
      message: 'Request payload exceeds limit',
      code: 'BAD_REQUEST'
    });
  });

  it('re-exports validation, HTTP errors, and utility helpers cleanly from routeUtils', () => {
    expect(routeUtils.AppHttpError).toBe(AppHttpError);
    expect(routeUtils.sendError).toBe(sendError);
    expect(routeUtils.errorHandler).toBe(errorHandler);
    expect(routeUtils.statusToErrorCode).toBe(statusToErrorCode);
    expect(routeUtils.v).toBe(v);
    expect(routeUtils.validateBody).toBe(validateBody);
    expect(routeUtils.validateQuery).toBe(validateQuery);
    expect(routeUtils.getValidatedBody).toBe(getValidatedBody);
    expect(routeUtils.getValidatedQuery).toBe(getValidatedQuery);
    expect(typeof routeUtils.asyncHandler).toBe('function');
    expect(typeof routeUtils.maskApiKey).toBe('function');
    expect(typeof routeUtils.decodeBase64Payload).toBe('function');
  });
});
