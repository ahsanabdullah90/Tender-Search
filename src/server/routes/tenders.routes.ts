import { Request, Response, Router } from 'express';
import { asyncHandler, decodeBase64Payload } from './routeUtils.js';
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
import { drainDocumentQueue } from '../services/ingestWorker.js';
import { TENDER_STATUSES } from '../../shared/types.js';
import { analyzeTenderById, fetchDocumentsForTender, matchTracks, parseDateString, formatClosingDate } from '../scrapers/crawlerEngine.js';
import { saveManualDossier } from '../services/dossierManager.js';
import { extractTenderFromImage } from '../services/ocrService.js';

export const tendersRouter = Router();

// 1. Tenders Listing & Filtering
tendersRouter.get('/', (req, res) => {
  try {
    const { track, portal, portalId, status, search, bookmarkedOnly, corrigendumOnly, unreadOnly, excludeExpired } = req.query;
    const tenders = getAllTenders({
      track: track as string,
      portalId: (portal || portalId) as string,
      status: status as string,
      search: search as string,
      bookmarkedOnly: bookmarkedOnly === 'true',
      corrigendumOnly: corrigendumOnly === 'true',
      unreadOnly: unreadOnly === 'true',
      excludeExpired: excludeExpired === 'true'
    });
    res.json(tenders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

tendersRouter.get('/portal-summary', (_req, res) => {
  try {
    const summary = getPortalTenderSummary();
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

tendersRouter.get('/:id', (req, res) => {
  const tender = getTenderById(req.params.id);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  res.json(tender);
});

tendersRouter.delete('/:id', (req, res) => {
  const tender = getTenderById(req.params.id);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  const result = deleteTenders([req.params.id], 'user');
  res.json({ success: true, deleted: result.deletedCount, id: req.params.id });
});

// 2. Status & Pipeline Updates
tendersRouter.patch('/:id/status', (req, res) => {
  const { status, notes } = req.body;
  if (!status) return res.status(400).json({ error: 'Status is required' });
  if (!TENDER_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Invalid status: "${status}". Valid statuses are: ${TENDER_STATUSES.join(', ')}`
    });
  }
  const success = updateTenderStatus(req.params.id, status, notes);
  if (!success) return res.status(404).json({ error: 'Tender not found' });
  res.json({ success: true, status });
});

const handleNotesUpdate = (req: Request, res: Response) => {
  const { notes } = req.body;
  const success = updateTenderNotes(req.params.id, notes || '');
  if (!success) {
    return res.status(404).json({ success: false, error: 'Tender not found' });
  }
  res.json({ success: true, notes });
};
tendersRouter.patch('/:id/notes', handleNotesUpdate);
tendersRouter.post('/:id/notes', handleNotesUpdate);

tendersRouter.patch('/:id/result-date', (req, res) => {
  const { date } = req.body;
  if (date && Number.isNaN(new Date(date).getTime())) {
    return res.status(400).json({ error: 'Invalid date' });
  }
  if (!updateTenderResultDate(req.params.id, date || null)) {
    return res.status(404).json({ error: 'Tender not found' });
  }
  res.json({ success: true, result_expected_date: date || null });
});

const handleBookmarkToggle = (req: Request, res: Response) => {
  const result = toggleTenderBookmark(req.params.id);
  res.json(result);
};
tendersRouter.patch('/:id/bookmark', handleBookmarkToggle);
tendersRouter.post('/:id/bookmark', handleBookmarkToggle);

const handleViewedUpdate = (req: Request, res: Response) => {
  const viewed = req.body?.viewed !== undefined ? Boolean(req.body.viewed) : true;
  const success = markTenderViewed(req.params.id, viewed);
  if (!success) {
    return res.status(404).json({ success: false, error: 'Tender not found' });
  }
  res.json({ success: true, viewed: viewed ? 1 : 0 });
};
tendersRouter.patch('/:id/viewed', handleViewedUpdate);

// 3. On-Demand Tender AI Analysis & Live Refresh
// When analysis finds the deadline has passed, the tender is auto-expired (deleted). Report that
// explicitly so the Inbox removes the row, rather than a 404 that left a ghost row behind.
const EXPIRED_MESSAGE = 'Deadline has passed: tender removed from the Inbox.';

tendersRouter.post('/:id/analyze', asyncHandler(async (req, res) => {
  if (!getGeminiApiKey()) {
    return res.status(400).json({ error: 'Google AI Studio API key is not configured. Add it in Sources & Keywords > Data.' });
  }
  if (!getTenderById(req.params.id)) return res.status(404).json({ error: 'Tender not found' });
  const tender = await analyzeTenderById(req.params.id);
  if (!tender) return res.json({ success: true, expired: true, id: req.params.id, message: EXPIRED_MESSAGE });
  res.json({ success: true, tender, message: 'Tender analyzed with Google AI.' });
}));

tendersRouter.post('/:id/refresh', asyncHandler(async (req, res) => {
  if (!getTenderById(req.params.id)) return res.status(404).json({ error: 'Tender not found' });
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

tendersRouter.post('/:id/fetch-documents', async (req, res) => {
  try {
    const existing = getTenderById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Tender not found' });
    const forceRefresh = req.body?.forceRefresh !== false;
    const result = await fetchDocumentsForTender(req.params.id, { forceRefresh });
    if (result.expired) {
      return res.json({ success: true, expired: true, id: req.params.id, newlyFetched: result.newlyFetched, message: EXPIRED_MESSAGE });
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Operator confirms a tender flagged for review (e.g. a corrigendum moved the deadline earlier).
tendersRouter.patch('/:id/review', (req, res) => {
  const existing = getTenderById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tender not found' });
  const action = req.body?.action;
  if (action !== 'confirm') return res.status(400).json({ error: 'Unsupported review action. Use { "action": "confirm" }.' });
  clearTenderReviewFlag(existing.id);
  res.json({ success: true, tender: getTenderById(existing.id) });
});

// Re-queue a tender's failed document downloads and run the worker now.
tendersRouter.post('/:id/retry-documents', (req, res) => {
  const existing = getTenderById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tender not found' });
  const requeued = requeueFailedJobs(existing.id);
  refreshTenderDocFetchStatus(existing.id);
  if (requeued > 0) {
    void drainDocumentQueue({ maxBatches: 3, batchSize: 10 }).catch(err =>
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

tendersRouter.post('/:id/attachments', asyncHandler(async (req, res) => {
  const existing = getTenderById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tender not found' });

  const { filename, mimeType, base64Data, dataBase64, label, runAi = true } = req.body || {};
  const rawBase64 = base64Data || dataBase64;
  if (!rawBase64) {
    return res.status(400).json({ error: 'base64Data is required' });
  }

  const buffer = decodeBase64Payload(rawBase64);
  const doc = saveManualDossier(existing.id, filename || 'notice.png', buffer, label, mimeType);
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

tendersRouter.patch('/:id', (req, res) => {
  const existing = getTenderById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tender not found' });

  const { title, organization, reference_no, closing_date, estimated_value, description, direct_url, location } = req.body || {};
  const updates: Parameters<typeof updateTenderFields>[1] = {};

  if (title !== undefined) updates.title = String(title).trim() || existing.title;
  if (organization !== undefined) updates.organization = String(organization).trim() || existing.organization;
  if (reference_no !== undefined) updates.reference_no = reference_no ? String(reference_no).trim() : null;
  if (estimated_value !== undefined) updates.estimated_value = estimated_value ? String(estimated_value).trim() : null;
  if (description !== undefined) updates.description = String(description);
  if (direct_url !== undefined) updates.direct_url = String(direct_url).trim() || existing.direct_url;
  if (location !== undefined) updates.location = location ? String(location).trim() : null;
  if (closing_date !== undefined) {
    const parsedIso = closing_date ? (parseDateString(String(closing_date)) || String(closing_date)) : null;
    updates.closing_date = parsedIso;
    updates.closing_date_formatted = formatClosingDate(parsedIso);
  }

  const tender = updateTenderFields(existing.id, updates);
  res.json({ success: true, tender });
});

tendersRouter.post('/', (req, res) => {
  const {
    title,
    organization,
    reference_no,
    portal_name,
    direct_url,
    closing_date,
    estimated_value,
    location,
    description,
    attachment,
    fileBase64,
    filename,
    mimeType
  } = req.body || {};

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  const orgName = organization && String(organization).trim() ? String(organization).trim() : 'Not Specified';

  const parsedClosing = closing_date ? (parseDateString(String(closing_date)) || String(closing_date)) : null;
  const activeTracks = getAllDomainTracks().filter(t => t.is_active === 1);
  const { matchedTracks, matchedKeywords, matchScore } = matchTracks(
    {
      title: String(title),
      organization: orgName,
      referenceNo: reference_no ? String(reference_no) : undefined,
      description: description ? String(description) : '',
      directUrl: direct_url ? String(direct_url) : '#'
    },
    activeTracks
  );

  let created = createManualTender({
    title: String(title).trim(),
    organization: orgName,
    reference_no: reference_no ? String(reference_no).trim() : null,
    portal_name: portal_name ? String(portal_name).trim() : 'Manual Entry',
    direct_url: direct_url ? String(direct_url).trim() : '#',
    closing_date: parsedClosing,
    closing_date_formatted: formatClosingDate(parsedClosing),
    estimated_value: estimated_value ? String(estimated_value).trim() : null,
    location: location ? String(location).trim() : 'Pakistan',
    description: description ? String(description).trim() : '',
    domain_tracks: matchedTracks,
    matched_keywords: Array.from(new Set(matchedKeywords)),
    match_score: matchScore || 80
  });

  const attachBase64 = attachment?.base64Data || attachment?.dataBase64 || fileBase64;
  if (attachBase64) {
    const buffer = decodeBase64Payload(attachBase64);
    const doc = saveManualDossier(
      created.id,
      attachment?.filename || filename || 'notice.png',
      buffer,
      attachment?.label || filename || 'Tender Notice',
      attachment?.mimeType || mimeType
    );
    created = updateTenderFields(created.id, { cached_dossiers: [doc] }) || created;
  }

  res.status(201).json({ success: true, tender: created });
});
