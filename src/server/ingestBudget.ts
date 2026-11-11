import { getAppSetting, setAppSetting } from './db/repositories/systemRepo.js';

/**
 * Cost limits for document ingest (docs/13-ingestion-pipeline-plan.md, §3.2).
 *
 * Downloads and local text reading use no Gemini quota, so a scan is limited by TIME (how long
 * it may spend fetching documents before deferring the rest to the background queue) and by
 * file size. Only Gemini Vision calls (scanned documents/images) have a call budget: per scan,
 * and per day for the background worker.
 */

export const INGEST_DEFAULTS = {
  upfrontTimeBudgetSec: 300,
  maxFileMb: 25,
  visionCallsPerScan: 20,
  visionCallsPerDay: 100,
  aiTextCallsPerDay: 150,
  perTenderBudgetMs: 20000
};

function intSetting(key: string, fallback: number): number {
  const v = parseInt(getAppSetting(key) || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export interface ScanIngestBudget {
  deadlineMs: number;
  visionLeft: number;
  maxFileBytes: number;
  documentsDeferred: number;
  visionDeferred: number;
}

let activeBudget: ScanIngestBudget | null = null;

/** Starts a scan's budget. Outside a scan (tests, manual calls) no budget applies. */
export function beginScanBudget(): ScanIngestBudget {
  activeBudget = {
    deadlineMs: Date.now() + intSetting('ingest_upfront_time_budget_sec', INGEST_DEFAULTS.upfrontTimeBudgetSec) * 1000,
    visionLeft: intSetting('ingest_vision_calls_per_scan', INGEST_DEFAULTS.visionCallsPerScan),
    maxFileBytes: maxFileBytes(),
    documentsDeferred: 0,
    visionDeferred: 0
  };
  return activeBudget;
}

export function endScanBudget(): ScanIngestBudget | null {
  const finished = activeBudget;
  activeBudget = null;
  return finished;
}

export function getActiveScanBudget(): ScanIngestBudget | null {
  return activeBudget;
}

export function maxFileBytes(): number {
  return intSetting('ingest_max_file_mb', INGEST_DEFAULTS.maxFileMb) * 1024 * 1024;
}

/** True while the current scan may still fetch documents before inserting tenders. */
export function hasUpfrontTime(): boolean {
  return !activeBudget || Date.now() < activeBudget.deadlineMs;
}

export function noteDeferredDocuments(count: number): void {
  if (activeBudget && count > 0) activeBudget.documentsDeferred += count;
}

/** Spends one Vision call from the current scan's budget (or daily budget if outside a scan); false once used up. */
export function tryConsumeScanVision(): boolean {
  if (!activeBudget) return tryConsumeDailyVision();
  if (activeBudget.visionLeft <= 0) {
    activeBudget.visionDeferred++;
    return false;
  }
  if (!tryConsumeDailyVision()) {
    activeBudget.visionDeferred++;
    return false;
  }
  activeBudget.visionLeft--;
  return true;
}

function pktDayString(): string {
  return new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
}

function todayKey(): string {
  return `ingest_vision_calls_${pktDayString()}`; // PKT day
}

function todayAiTextKey(): string {
  return `ingest_ai_text_calls_${pktDayString()}`;
}

/**
 * Spends one Gemini text call (document cross-check, on-demand Analyze summary) from the daily
 * budget; false once it is used up (docs/16 C3).
 */
export function tryConsumeDailyAiText(): boolean {
  const limit = intSetting('ingest_ai_text_calls_per_day', INGEST_DEFAULTS.aiTextCallsPerDay);
  const key = todayAiTextKey();
  const used = parseInt(getAppSetting(key) || '0', 10) || 0;
  if (used >= limit) return false;
  setAppSetting(key, String(used + 1));
  return true;
}

export function getDailyAiTextUsage(): { used: number; limit: number } {
  return {
    used: parseInt(getAppSetting(todayAiTextKey()) || '0', 10) || 0,
    limit: intSetting('ingest_ai_text_calls_per_day', INGEST_DEFAULTS.aiTextCallsPerDay)
  };
}

/** Spends one Vision call from the background worker's daily budget; false once it is used up. */
export function tryConsumeDailyVision(): boolean {
  const limit = intSetting('ingest_vision_calls_per_day', INGEST_DEFAULTS.visionCallsPerDay);
  const key = todayKey();
  const used = parseInt(getAppSetting(key) || '0', 10) || 0;
  if (used >= limit) return false;
  setAppSetting(key, String(used + 1));
  return true;
}

export function getDailyVisionUsage(): { used: number; limit: number } {
  return {
    used: parseInt(getAppSetting(todayKey()) || '0', 10) || 0,
    limit: intSetting('ingest_vision_calls_per_day', INGEST_DEFAULTS.visionCallsPerDay)
  };
}

export interface IngestBudgetSettings {
  upfrontTimeBudgetSec: number;
  maxFileMb: number;
  visionCallsPerScan: number;
  visionCallsPerDay: number;
  dailyVisionUsed: number;
  aiTextCallsPerDay: number;
  dailyAiTextUsed: number;
}

export function getIngestBudgetSettings(): IngestBudgetSettings {
  const daily = getDailyVisionUsage();
  const aiText = getDailyAiTextUsage();
  return {
    upfrontTimeBudgetSec: intSetting('ingest_upfront_time_budget_sec', INGEST_DEFAULTS.upfrontTimeBudgetSec),
    maxFileMb: intSetting('ingest_max_file_mb', INGEST_DEFAULTS.maxFileMb),
    visionCallsPerScan: intSetting('ingest_vision_calls_per_scan', INGEST_DEFAULTS.visionCallsPerScan),
    visionCallsPerDay: daily.limit,
    dailyVisionUsed: daily.used,
    aiTextCallsPerDay: aiText.limit,
    dailyAiTextUsed: aiText.used
  };
}

export function updateIngestBudgetSettings(input: Partial<{
  upfrontTimeBudgetSec: number;
  maxFileMb: number;
  visionCallsPerScan: number;
  visionCallsPerDay: number;
  aiTextCallsPerDay: number;
}>): IngestBudgetSettings {
  if (input.aiTextCallsPerDay !== undefined) {
    const val = Math.max(0, Math.min(5000, Math.round(Number(input.aiTextCallsPerDay))));
    if (Number.isFinite(val)) setAppSetting('ingest_ai_text_calls_per_day', String(val));
  }
  if (input.upfrontTimeBudgetSec !== undefined) {
    const val = Math.max(0, Math.min(3600, Math.round(Number(input.upfrontTimeBudgetSec))));
    if (Number.isFinite(val)) setAppSetting('ingest_upfront_time_budget_sec', String(val));
  }
  if (input.maxFileMb !== undefined) {
    const val = Math.max(1, Math.min(200, Math.round(Number(input.maxFileMb))));
    if (Number.isFinite(val)) setAppSetting('ingest_max_file_mb', String(val));
  }
  if (input.visionCallsPerScan !== undefined) {
    const val = Math.max(0, Math.min(500, Math.round(Number(input.visionCallsPerScan))));
    if (Number.isFinite(val)) setAppSetting('ingest_vision_calls_per_scan', String(val));
  }
  if (input.visionCallsPerDay !== undefined) {
    const val = Math.max(0, Math.min(5000, Math.round(Number(input.visionCallsPerDay))));
    if (Number.isFinite(val)) setAppSetting('ingest_vision_calls_per_day', String(val));
  }
  return getIngestBudgetSettings();
}
