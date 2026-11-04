import { Router } from 'express';
import {
  getAllTenders,
  getTenderById,
  updateTenderStatus,
  updateTenderNotes,
  updateTenderResultDate,
  toggleTenderBookmark,
  updateTenderFields,
  createManualTender,
  getAllDomainTracks
} from '../db.js';
import { TENDER_STATUSES } from '../../types.js';
import { analyzeTenderById, matchTracks, parseDateString, formatClosingDate } from '../scrapers/crawlerEngine.js';
import { saveManualDossier } from '../dossierManager.js';
import { extractTenderFromImage } from '../ocrService.js';
import { getGeminiApiKey } from '../db.js';

export const tendersRouter = Router();

// 1. Tenders Listing & Filtering
tendersRouter.get('/', (req, res) => {
  try {
    const { track, status, search, bookmarkedOnly, corrigendumOnly } = req.query;
    const tenders = getAllTenders({
      track: track as string,
      status: status as string,
      search: search as string,
      bookmarkedOnly: bookmarkedOnly === 'true',
      corrigendumOnly: corrigendumOnly === 'true'
    });
    res.json(tenders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

tendersRouter.get('/:id', (req, res) => {
  const tender = getTenderById(req.params.id);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  res.json(tender);
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

const handleNotesUpdate = (req: any, res: any) => {
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

const handleBookmarkToggle = (req: any, res: any) => {
  const result = toggleTenderBookmark(req.params.id);
  res.json(result);
};
tendersRouter.patch('/:id/bookmark', handleBookmarkToggle);
tendersRouter.post('/:id/bookmark', handleBookmarkToggle);

// 3. On-Demand Tender AI Analysis & Live Refresh
tendersRouter.post('/:id/analyze', async (req, res) => {
  if (!getGeminiApiKey()) {
    return res.status(400).json({ error: 'Google AI Studio API key is not configured. Add it in Sources & Keywords > Data.' });
  }
  const tender = await analyzeTenderById(req.params.id);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  res.json({ success: true, tender, message: 'Tender analyzed with Google AI.' });
});

tendersRouter.post('/:id/refresh', async (req, res) => {
  const tender = await analyzeTenderById(req.params.id, { forceRefresh: true });
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  res.json({
    success: true,
    tender,
    message: getGeminiApiKey()
      ? 'Tender information refreshed from portal and summarized with AI.'
      : 'Tender information refreshed from portal.'
  });
});

tendersRouter.post('/:id/attachments', async (req, res) => {
  const existing = getTenderById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tender not found' });

  const { filename, mimeType, base64Data, dataBase64, label, runAi = true } = req.body || {};
  const rawBase64 = base64Data || dataBase64;
  if (!rawBase64) {
    return res.status(400).json({ error: 'base64Data is required' });
  }

  const cleanBase64 = String(rawBase64).replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
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
});

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

tendersRouter.post('/', async (req, res) => {
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
    const cleanBase64 = String(attachBase64).replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
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
