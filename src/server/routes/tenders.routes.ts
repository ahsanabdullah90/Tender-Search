import { Request, Response, Router } from 'express';
import {
  asyncHandler,
  decodeBase64Payload,
  getValidatedBody,
  getValidatedQuery,
  sendError,
  v,
  validateBody,
  validateQuery,
  type InferSchema
} from './routeUtils.js';
import {
  getAllTenders,
  getTenderById,
  updateTenderStatus,
  updateTenderNotes,
  updateTenderResultDate,
  toggleTenderBookmark,
  markTenderViewed,
  updateTenderFields,
  createManualTender,
  getAllDomainTracks,
  deleteTenders,
  getPortalTenderSummary,
  clearTenderReviewFlag,
  requeueFailedJobs,
  refreshTenderDocFetchStatus,
  getGeminiApiKey
} from '../db/index.js';
import { getDefaultRuntimeContext, type RuntimeContext } from '../runtime/context.js';
import { TENDER_STATUSES } from '../../shared/types.js';
import {
  analyzeTenderById,
  fetchDocumentsForTender,
  matchTracks,
  parseDateString,
  formatClosingDate
} from '../scrapers/crawlerEngine.js';
import { saveManualDossier } from '../services/dossierManager.js';
import { extractTenderFromImage } from '../services/ocrService.js';

const EXPIRED_MESSAGE = 'Deadline has passed: tender removed from the Inbox.';

const listTendersQuerySchema = v.object({
  track: v.optional(v.string()),
  portal: v.optional(v.string()),
  portalId: v.optional(v.string()),
  status: v.optional(v.string()),
  search: v.optional(v.string()),
  bookmarkedOnly: v.optional(v.queryBoolean()),
  corrigendumOnly: v.optional(v.queryBoolean()),
  unreadOnly: v.optional(v.queryBoolean()),
  excludeExpired: v.optional(v.queryBoolean())
});

const updateStatusSchema = v.object({
  status: v.oneOf(TENDER_STATUSES, {
    requiredMessage: 'Status is required',
    invalidMessage: raw => `Invalid status: "${String(raw)}". Must be one of: ${TENDER_STATUSES.join(', ')}`
  }),
  notes: v.nullish(v.string())
});

const updateNotesSchema = v.object({
  notes: v.nullish(v.string())
});

const updateResultDateSchema = v.object({
  date: v.nullish(v.isoOrParsableDate('Invalid date'))
});

const updateViewedSchema = v.object({
  viewed: v.optional(v.boolean())
});

const fetchDocumentsSchema = v.object({
  forceRefresh: v.optional(v.boolean())
});

const reviewTenderSchema = v.object({
  action: v.oneOf(['confirm'] as const, {
    requiredMessage: 'Unsupported review action. Use { "action": "confirm" }.',
    invalidMessage: () => 'Unsupported review action. Use { "action": "confirm" }.'
  })
});

const addAttachmentSchema = v.object(
  {
    filename: v.optional(v.string({ trim: true })),
    mimeType: v.optional(v.string({ trim: true })),
    base64Data: v.optional(v.nonEmptyString()),
    dataBase64: v.optional(v.nonEmptyString()),
    label: v.optional(v.string({ trim: true })),
    runAi: v.optional(v.boolean())
  },
  {
    refine: val =>
      !val.base64Data && !val.dataBase64
        ? [{ field: 'base64Data', message: 'base64Data is required' }]
        : null
  }
);

const updateTenderSchema = v.object({
  title: v.nullish(v.string()),
  organization: v.nullish(v.string()),
  reference_no: v.nullish(v.string()),
  closing_date: v.nullish(v.string()),
  estimated_value: v.nullish(v.string()),
  description: v.nullish(v.string()),
  direct_url: v.nullish(v.string()),
  location: v.nullish(v.string())
});

const manualAttachmentSchema = v.object({
  base64Data: v.optional(v.nonEmptyString()),
  dataBase64: v.optional(v.nonEmptyString()),
  filename: v.optional(v.string({ trim: true })),
  mimeType: v.optional(v.string({ trim: true })),
  label: v.optional(v.string({ trim: true }))
});

const createManualTenderSchema = v.object({
  title: v.nonEmptyString('Title is required'),
  organization: v.nullish(v.string()),
  reference_no: v.nullish(v.string()),
  portal_name: v.nullish(v.string()),
  direct_url: v.nullish(v.string()),
  closing_date: v.nullish(v.string()),
  estimated_value: v.nullish(v.string()),
  location: v.nullish(v.string()),
  description: v.nullish(v.string()),
  attachment: v.nullish(manualAttachmentSchema),
  fileBase64: v.nullish(v.string()),
  filename: v.nullish(v.string()),
  mimeType: v.nullish(v.string())
});

export function createTendersRouter(ctx: RuntimeContext = getDefaultRuntimeContext()): Router {
  const router = Router();

  // 1. Tenders Listing & Filtering
  router.get('/', validateQuery(listTendersQuerySchema), asyncHandler(async (_req, res) => {
    const query = getValidatedQuery<InferSchema<typeof listTendersQuerySchema>>(res);
    const tenders = getAllTenders({
      track: query.track,
      portalId: query.portal || query.portalId,
      status: query.status,
      search: query.search,
      bookmarkedOnly: query.bookmarkedOnly,
      corrigendumOnly: query.corrigendumOnly,
      unreadOnly: query.unreadOnly,
      excludeExpired: query.excludeExpired
    });
    res.json(tenders);
  }));

  router.get('/portal-summary', asyncHandler(async (_req, res) => {
    const summary = getPortalTenderSummary();
    res.json(summary);
  }));

  router.get('/:id', (req, res) => {
    const tender = getTenderById(req.params.id);
    if (!tender) return sendError(res, 404, 'Tender not found', 'NOT_FOUND');
    res.json(tender);
  });

  router.delete('/:id', (req, res) => {
    const tender = getTenderById(req.params.id);
    if (!tender) return sendError(res, 404, 'Tender not found', 'NOT_FOUND');
    const result = deleteTenders([req.params.id], 'user');
    res.json({ success: true, deleted: result.deletedCount, id: req.params.id });
  });

  // 2. Status & Pipeline Updates
  router.patch('/:id/status', validateBody(updateStatusSchema), (req, res) => {
    const { status, notes } = getValidatedBody<InferSchema<typeof updateStatusSchema>>(res, req);
    const success = updateTenderStatus(req.params.id, status, notes ?? undefined);
    if (!success) return sendError(res, 404, 'Tender not found', 'NOT_FOUND');
    res.json({ success: true, status });
  });

  const handleNotesUpdate = (req: Request, res: Response) => {
    const { notes } = getValidatedBody<InferSchema<typeof updateNotesSchema>>(res, req);
    const normalizedNotes = notes ?? '';
    const success = updateTenderNotes(req.params.id, normalizedNotes);
    if (!success) {
      return sendError(res, 404, 'Tender not found', 'NOT_FOUND');
    }
    res.json({ success: true, notes: normalizedNotes });
  };
  router.patch('/:id/notes', validateBody(updateNotesSchema), handleNotesUpdate);
  router.post('/:id/notes', validateBody(updateNotesSchema), handleNotesUpdate);

  router.patch('/:id/result-date', validateBody(updateResultDateSchema), (req, res) => {
    const { date } = getValidatedBody<InferSchema<typeof updateResultDateSchema>>(res, req);
    const normalizedDate = date ?? null;
    if (!updateTenderResultDate(req.params.id, normalizedDate)) {
      return sendError(res, 404, 'Tender not found', 'NOT_FOUND');
    }
    res.json({ success: true, result_expected_date: normalizedDate });
  });

  const handleBookmarkToggle = (req: Request, res: Response) => {
    const result = toggleTenderBookmark(req.params.id);
    res.json(result);
  };
  router.patch('/:id/bookmark', handleBookmarkToggle);
  router.post('/:id/bookmark', handleBookmarkToggle);

  router.patch('/:id/viewed', validateBody(updateViewedSchema), (req, res) => {
    const body = getValidatedBody<InferSchema<typeof updateViewedSchema>>(res, req);
    const viewed = body.viewed ?? true;
    const success = markTenderViewed(req.params.id, viewed);
    if (!success) {
      return sendError(res, 404, 'Tender not found', 'NOT_FOUND');
    }
    res.json({ success: true, viewed: viewed ? 1 : 0 });
  });

  // 3. On-Demand Tender AI Analysis & Live Refresh
  // When analysis finds the deadline has passed, the tender is auto-expired (deleted). Report that
  // explicitly so the Inbox removes the row, rather than a 404 that left a ghost row behind.
  router.post('/:id/analyze', asyncHandler(async (req, res) => {
    if (!getGeminiApiKey()) {
      return sendError(
        res,
        400,
        'Google AI Studio API key is not configured. Add it in Sources & Keywords > Data.',
        'BAD_REQUEST'
      );
    }
    if (!getTenderById(req.params.id)) return sendError(res, 404, 'Tender not found', 'NOT_FOUND');
    const tender = await analyzeTenderById(req.params.id);
    if (!tender) return res.json({ success: true, expired: true, id: req.params.id, message: EXPIRED_MESSAGE });
    res.json({ success: true, tender, message: 'Tender analyzed with Google AI.' });
  }));

  router.post('/:id/refresh', asyncHandler(async (req, res) => {
    if (!getTenderById(req.params.id)) return sendError(res, 404, 'Tender not found', 'NOT_FOUND');
    const tender = await analyzeTenderById(req.params.id, { forceRefresh: true });
    if (!tender) return res.json({ success: true, expired: true, id: req.params.id, message: EXPIRED_MESSAGE });
    res.json({
      success: true,
      tender,
      message: getGeminiApiKey()
        ? 'Tender information refreshed from portal and summarized with AI.'
        : 'Tender information refreshed from portal.'
    });
  }));

  router.post('/:id/fetch-documents', validateBody(fetchDocumentsSchema), asyncHandler(async (req, res) => {
    const existing = getTenderById(req.params.id);
    if (!existing) return sendError(res, 404, 'Tender not found', 'NOT_FOUND');
    const body = getValidatedBody<InferSchema<typeof fetchDocumentsSchema>>(res, req);
    const forceRefresh = body.forceRefresh !== false;
    const result = await fetchDocumentsForTender(req.params.id, {
      forceRefresh,
      scanState: ctx.scanState
    });
    if (result.expired) {
      return res.json({
        success: true,
        expired: true,
        id: req.params.id,
        newlyFetched: result.newlyFetched,
        message: EXPIRED_MESSAGE
      });
    }
    res.json({
      success: true,
      tender: result.tender,
      dossiers: result.dossiers,
      newlyFetched: result.newlyFetched,
      message: result.newlyFetched > 0
        ? `Successfully fetched ${result.newlyFetched} document(s) from portal.`
        : result.dossiers.length > 0
          ? 'Documents already downloaded and up to date.'
          : 'Checked portal; no new documents found.'
    });
  }));

  // Operator confirms a tender flagged for review (e.g. a corrigendum moved the deadline earlier).
  router.patch('/:id/review', validateBody(reviewTenderSchema), (req, res) => {
    const existing = getTenderById(req.params.id);
    if (!existing) return sendError(res, 404, 'Tender not found', 'NOT_FOUND');
    clearTenderReviewFlag(existing.id);
    res.json({ success: true, tender: getTenderById(existing.id) });
  });

  // Re-queue a tender's failed document downloads and run the worker now.
  router.post('/:id/retry-documents', (req, res) => {
    const existing = getTenderById(req.params.id);
    if (!existing) return sendError(res, 404, 'Tender not found', 'NOT_FOUND');
    const requeued = requeueFailedJobs(existing.id);
    refreshTenderDocFetchStatus(existing.id);
    if (requeued > 0) {
      void ctx.drainDocumentQueue({ maxBatches: 3, batchSize: 10 }).catch(err =>
        console.warn('[Tenders] Document retry worker error:', err)
      );
    }
    res.json({
      success: true,
      requeued,
      tender: getTenderById(existing.id),
      message: requeued > 0 ? `Retrying ${requeued} document(s) in the background.` : 'No failed documents to retry.'
    });
  });

  router.post('/:id/attachments', validateBody(addAttachmentSchema), asyncHandler(async (req, res) => {
    const existing = getTenderById(req.params.id);
    if (!existing) return sendError(res, 404, 'Tender not found', 'NOT_FOUND');

    const { filename, mimeType, base64Data, dataBase64, label, runAi = true } =
      getValidatedBody<InferSchema<typeof addAttachmentSchema>>(res, req);
    const rawBase64 = base64Data || dataBase64!;

    const buffer = decodeBase64Payload(rawBase64);
    const doc = saveManualDossier(
      existing.id,
      filename || 'notice.png',
      buffer,
      label || undefined,
      mimeType || undefined
    );
    const updatedDossiers = [...(Array.isArray(existing.cached_dossiers) ? existing.cached_dossiers : []), doc];

    const fieldUpdates: Parameters<typeof updateTenderFields>[1] = {
      cached_dossiers: updatedDossiers
    };

    let aiExtracted = false;
    if (runAi && getGeminiApiKey() && (doc.mimeType.startsWith('image/') || doc.mimeType === 'application/pdf')) {
      const aiRes = await extractTenderFromImage(buffer, doc.mimeType);
      if (aiRes) {
        aiExtracted = true;
        if (aiRes.summaryScope) fieldUpdates.description = aiRes.summaryScope;
        if (aiRes.referenceNo && !existing.reference_no) fieldUpdates.reference_no = aiRes.referenceNo;
        if (aiRes.estimatedValue && !existing.estimated_value) fieldUpdates.estimated_value = aiRes.estimatedValue;
        if (aiRes.closingDateISO && !existing.closing_date) {
          const iso = parseDateString(aiRes.closingDateISO) || aiRes.closingDateISO;
          fieldUpdates.closing_date = iso;
          fieldUpdates.closing_date_formatted = aiRes.closingDateFormatted || formatClosingDate(iso);
        }
      }
    }

    const tender = updateTenderFields(existing.id, fieldUpdates);
    res.json({ success: true, tender, attachment: doc, aiExtracted });
  }));

  router.patch('/:id', validateBody(updateTenderSchema), (req, res) => {
    const existing = getTenderById(req.params.id);
    if (!existing) return sendError(res, 404, 'Tender not found', 'NOT_FOUND');

    const body = getValidatedBody<InferSchema<typeof updateTenderSchema>>(res, req);
    const updates: Parameters<typeof updateTenderFields>[1] = {};

    if (body.title !== undefined) updates.title = (body.title ?? '').trim() || existing.title;
    if (body.organization !== undefined) updates.organization = (body.organization ?? '').trim() || existing.organization;
    if (body.reference_no !== undefined) updates.reference_no = body.reference_no?.trim() || null;
    if (body.estimated_value !== undefined) updates.estimated_value = body.estimated_value?.trim() || null;
    if (body.description !== undefined) updates.description = body.description ?? '';
    if (body.direct_url !== undefined) updates.direct_url = (body.direct_url ?? '').trim() || existing.direct_url;
    if (body.location !== undefined) updates.location = body.location?.trim() || null;
    if (body.closing_date !== undefined) {
      const rawClosing = body.closing_date?.trim() || '';
      const parsedIso = rawClosing ? (parseDateString(rawClosing) || rawClosing) : null;
      updates.closing_date = parsedIso;
      updates.closing_date_formatted = formatClosingDate(parsedIso);
    }

    const tender = updateTenderFields(existing.id, updates);
    res.json({ success: true, tender });
  });

  router.post('/', validateBody(createManualTenderSchema), (req, res) => {
    const body = getValidatedBody<InferSchema<typeof createManualTenderSchema>>(res, req);
    const orgName = body.organization?.trim() || 'Not Specified';
    const rawClosing = body.closing_date?.trim() || '';
    const parsedClosing = rawClosing ? (parseDateString(rawClosing) || rawClosing) : null;
    const activeTracks = getAllDomainTracks().filter(t => t.is_active === 1);
    const { matchedTracks, matchedKeywords, matchScore } = matchTracks(
      {
        title: body.title,
        organization: orgName,
        referenceNo: body.reference_no?.trim() || undefined,
        description: body.description?.trim() || '',
        directUrl: body.direct_url?.trim() || '#'
      },
      activeTracks
    );

    let created = createManualTender({
      title: body.title,
      organization: orgName,
      reference_no: body.reference_no?.trim() || null,
      portal_name: body.portal_name?.trim() || 'Manual Entry',
      direct_url: body.direct_url?.trim() || '#',
      closing_date: parsedClosing,
      closing_date_formatted: formatClosingDate(parsedClosing),
      estimated_value: body.estimated_value?.trim() || null,
      location: body.location?.trim() || 'Pakistan',
      description: body.description?.trim() || '',
      domain_tracks: matchedTracks,
      matched_keywords: Array.from(new Set(matchedKeywords)),
      match_score: matchScore || 80
    });

    const attachBase64 =
      body.attachment?.base64Data || body.attachment?.dataBase64 || body.fileBase64?.trim() || undefined;
    if (attachBase64) {
      const buffer = decodeBase64Payload(attachBase64);
      const doc = saveManualDossier(
        created.id,
        body.attachment?.filename || body.filename?.trim() || 'notice.png',
        buffer,
        body.attachment?.label || body.filename?.trim() || 'Tender Notice',
        body.attachment?.mimeType || body.mimeType?.trim() || undefined
      );
      created = updateTenderFields(created.id, { cached_dossiers: [doc] }) || created;
    }

    res.status(201).json({ success: true, tender: created });
  });

  return router;
}

export const tendersRouter = createTendersRouter();
