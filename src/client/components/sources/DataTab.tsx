import React, { useCallback, useEffect, useState } from 'react';
import { Download, FileText, RotateCw } from 'lucide-react';
import type { DigestSummary, SessionLogMeta } from '../../../shared/types';
import { Button, Chip, Dialog, FIELD_INPUT_CLASS, Panel } from '../../ui';
import { apiJson, apiMutate } from '../../utils/apiClient';
import { formatBytes } from '../../utils/format';
import { Field, SourcesScreenProps } from './shared';

type DigestAlertCounts = Pick<
  DigestSummary,
  'closingSoonCount' | 'unacknowledgedCorrigendaCount' | 'newMatchesLast24hCount'
>;

interface Backup {
  name: string;
  created_at: string;
  size_bytes: number;
}

interface Storage {
  total_bytes: number;
  passed_bytes: number;
  passed_tenders: number;
  tenders_with_documents: number;
  awaiting_scope_count?: number;
  ai_configured?: boolean;
  ai_masked_key?: string | null;
  session_logs?: SessionLogMeta[];
  retention?: {
    settings: {
      retention_auto_clean: boolean;
      retention_grace_days: number;
      retention_passed_days: number;
    };
    status: {
      pendingSlimCount: number;
      expiredUnreviewedCount: number;
      agedOutPassedCount: number;
      awaitingScopeCount?: number;
    };
  };
  ingest_budgets?: {
    upfrontTimeBudgetSec: number;
    maxFileMb: number;
    visionCallsPerScan: number;
    visionCallsPerDay: number;
    dailyVisionUsed: number;
    aiTextCallsPerDay?: number;
    dailyAiTextUsed?: number;
  };
  digest?: {
    settings: {
      enabled: boolean;
      webhookUrl: string;
      withinHours: number;
      lastSentDatePkt: string | null;
    };
    summary: DigestAlertCounts;
  };
}

function DataSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Panel className="p-5">
      <h2 className="text-base font-bold">{title}</h2>
      {description && <p className="mt-1 text-ink-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </Panel>
  );
}

export function DataTab({ onClearInbox, onEraseAll }: Pick<SourcesScreenProps, 'onClearInbox' | 'onEraseAll'>) {
  const [scope, setScope] = useState('all');
  const [backups, setBackups] = useState<Backup[]>([]);
  const [sessionLogs, setSessionLogs] = useState<SessionLogMeta[]>([]);
  const [selectedLog, setSelectedLog] = useState<{ filename: string; content: string } | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiKeyInput, setAiKeyInput] = useState('');
  const [aiSaving, setAiSaving] = useState(false);
  const [budgetsForm, setBudgetsForm] = useState({
    upfrontTimeBudgetSec: 300,
    maxFileMb: 25,
    visionCallsPerScan: 20,
    visionCallsPerDay: 100,
    aiTextCallsPerDay: 150
  });
  const [budgetsSaving, setBudgetsSaving] = useState(false);
  const [digestForm, setDigestForm] = useState({
    enabled: false,
    webhookUrl: '',
    withinHours: 48
  });
  const [digestSummary, setDigestSummary] = useState<DigestAlertCounts | null>(null);
  const [digestSaving, setDigestSaving] = useState(false);
  const [digestRefreshing, setDigestRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'inbox' | 'prune' | 'erase' | null>(null);
  const [typed, setTyped] = useState('');

  const load = useCallback(async () => {
    try {
      const [bData, sData] = await Promise.all([
        apiJson<Backup[]>('/api/backups'),
        apiJson<Storage>('/api/storage')
      ]);
      setBackups(bData);
      setStorage(sData);
      if (sData.ingest_budgets) {
        setBudgetsForm({
          upfrontTimeBudgetSec: sData.ingest_budgets.upfrontTimeBudgetSec,
          maxFileMb: sData.ingest_budgets.maxFileMb,
          visionCallsPerScan: sData.ingest_budgets.visionCallsPerScan,
          visionCallsPerDay: sData.ingest_budgets.visionCallsPerDay,
          aiTextCallsPerDay: sData.ingest_budgets.aiTextCallsPerDay ?? 150
        });
      }
      if (Array.isArray(sData.session_logs)) {
        setSessionLogs(sData.session_logs);
      }
      if (sData.digest) {
        setDigestForm({
          enabled: Boolean(sData.digest.settings.enabled),
          webhookUrl: sData.digest.settings.webhookUrl ?? '',
          withinHours: sData.digest.settings.withinHours ?? 48
        });
        setDigestSummary(sData.digest.summary);
      }
    } catch (err) {
      console.error('Failed to load data settings:', err);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const viewLog = async (filename: string) => {
    setLoadingLog(true);
    try {
      const data = await apiJson<{ filename: string; content: string }>(`/api/system/logs/${filename}`);
      setSelectedLog(data);
    } catch (err) {
      const isHttpError = (err as { name?: string } | null)?.name === 'ApiError';
      setMessage(isHttpError ? 'Could not load session log content.' : 'Failed to fetch session log.');
    } finally {
      setLoadingLog(false);
    }
  };

  const closeConfirm = () => { setConfirm(null); setTyped(''); };

  const saveAiKey = async (keyToSave: string) => {
    setAiSaving(true);
    try {
      const data = await apiMutate<{ configured?: boolean; maskedKey?: string | null; message?: string }>(
        '/api/ai/config',
        'POST',
        { apiKey: keyToSave.trim() }
      );
      setStorage(prev =>
        prev ? { ...prev, ai_configured: Boolean(data.configured), ai_masked_key: data.maskedKey } : prev
      );
      setAiKeyInput('');
      setMessage(data.message || 'Google AI Studio settings updated.');
    } catch {
      setMessage('Could not save API key.');
    } finally {
      setAiSaving(false);
    }
  };

  const backUp = async () => {
    setBusy(true);
    try {
      await apiMutate('/api/backups', 'POST');
      setMessage('Backup created.');
    } catch {
      setMessage('Backup failed. Please try again.');
    } finally {
      setBusy(false);
      void load();
    }
  };

  const prune = async () => {
    closeConfirm();
    try {
      const r = await apiMutate<{ tenders: number; freed_bytes: number }>('/api/dossiers/prune-passed', 'POST');
      setMessage(`Deleted files for ${r.tenders} passed ${r.tenders === 1 ? 'tender' : 'tenders'} and freed ${formatBytes(r.freed_bytes)}.`);
    } catch {
      setMessage('Could not delete the files.');
    }
    void load();
  };

  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionRunning, setRetentionRunning] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  const saveRetentionSettings = async (newSettings: { autoClean: boolean }) => {
    setRetentionSaving(true);
    try {
      await apiMutate('/api/system/retention/settings', 'POST', newSettings);
      setMessage('Retention settings saved.');
      void load();
    } catch (err) {
      const isHttpError = (err as { name?: string } | null)?.name === 'ApiError';
      setMessage(isHttpError ? 'Failed to save retention settings.' : 'Error updating retention settings.');
    } finally {
      setRetentionSaving(false);
    }
  };

  const runRetentionCleanup = async () => {
    setRetentionRunning(true);
    try {
      const data = await apiMutate<{
        summary: { slimmed: number; expiredUnreviewed: number; agedOutPassed: number };
      }>('/api/system/retention/run', 'POST');
      setMessage(`Retention cycle complete: slimmed ${data.summary.slimmed} passed tenders, deleted ${data.summary.expiredUnreviewed} expired unreviewed tenders, and purged ${data.summary.agedOutPassed} aged-out records.`);
      void load();
    } catch (err) {
      const isHttpError = (err as { name?: string } | null)?.name === 'ApiError';
      setMessage(isHttpError ? 'Failed to execute retention cycle.' : 'Error executing retention cycle.');
    } finally {
      setRetentionRunning(false);
    }
  };

  const runReconcileFiles = async () => {
    setReconciling(true);
    try {
      const data = await apiMutate<{
        reconciliation: { orphanFoldersDeleted: number; missingMetadataPruned: number; trashPurged: number };
      }>('/api/system/dossiers/reconcile', 'POST');
      setMessage(`File reconciliation complete: removed ${data.reconciliation.orphanFoldersDeleted} orphan folders, pruned ${data.reconciliation.missingMetadataPruned} missing DB records, cleaned ${data.reconciliation.trashPurged} trash items.`);
      void load();
    } catch (err) {
      const isHttpError = (err as { name?: string } | null)?.name === 'ApiError';
      setMessage(isHttpError ? 'Failed to reconcile dossier files.' : 'Error reconciling dossier files.');
    } finally {
      setReconciling(false);
    }
  };

  return (
    <div className="space-y-4">
      {message && (
        <div role="status" className="flex items-center justify-between rounded-lg bg-accent-soft px-4 py-3 font-medium text-accent">
          {message}
          <button onClick={() => setMessage(null)} className="cursor-pointer text-sm font-semibold underline">Dismiss</button>
        </div>
      )}

      <DataSection
        title="Google AI Studio (Gemini API)"
        description="Extracts clean First-Look summaries, deadlines, and scope from tender notice images, PDFs, and portal pages."
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink-muted">Status:</span>
            {storage?.ai_configured ? (
              <Chip tone="ok">Connected ({storage.ai_masked_key || 'Active'}) · Gemini Flash (Multi-Model Failover)</Chip>
            ) : (
              <Chip>Not configured</Chip>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[260px] flex-1">
              <Field label="Gemini API key">
                <input
                  type="password"
                  value={aiKeyInput}
                  onChange={e => setAiKeyInput(e.target.value)}
                  placeholder={storage?.ai_configured ? 'Enter a new key to replace current key…' : 'Paste AIzaSy… key from aistudio.google.com'}
                  className={`${FIELD_INPUT_CLASS} font-mono text-[13px]`}
                />
              </Field>
            </div>
            <Button
              variant="primary"
              disabled={aiSaving || !aiKeyInput.trim()}
              onClick={() => void saveAiKey(aiKeyInput)}
            >
              {aiSaving ? 'Saving…' : 'Save API key'}
            </Button>
            {storage?.ai_configured && (
              <Button disabled={aiSaving} onClick={() => void saveAiKey('')}>
                Remove key
              </Button>
            )}
          </div>
        </div>
      </DataSection>

      <DataSection
        title="Document Ingest & Vision Budgets"
        description="Controls how long scans spend fetching documents upfront, maximum file size, and Gemini Vision OCR caps per scan and per day."
      >
        <div className="space-y-3">
          {storage?.ingest_budgets && (
            <div className="flex flex-wrap gap-4 text-xs text-ink-muted">
              <div>
                Daily Vision usage today: <span className="font-mono font-semibold text-ink">{storage.ingest_budgets.dailyVisionUsed} / {storage.ingest_budgets.visionCallsPerDay}</span> calls
              </div>
              <div>
                Daily AI-text usage today: <span className="font-mono font-semibold text-ink">{storage.ingest_budgets.dailyAiTextUsed ?? 0} / {storage.ingest_budgets.aiTextCallsPerDay ?? 150}</span> calls
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Upfront scan budget (sec)">
              <input
                type="number"
                min={0}
                max={3600}
                value={budgetsForm.upfrontTimeBudgetSec}
                onChange={e => setBudgetsForm(f => ({ ...f, upfrontTimeBudgetSec: Number(e.target.value) }))}
                className={FIELD_INPUT_CLASS}
              />
            </Field>
            <Field label="Max file size (MB)">
              <input
                type="number"
                min={1}
                max={200}
                value={budgetsForm.maxFileMb}
                onChange={e => setBudgetsForm(f => ({ ...f, maxFileMb: Number(e.target.value) }))}
                className={FIELD_INPUT_CLASS}
              />
            </Field>
            <Field label="Vision calls per scan">
              <input
                type="number"
                min={0}
                max={500}
                value={budgetsForm.visionCallsPerScan}
                onChange={e => setBudgetsForm(f => ({ ...f, visionCallsPerScan: Number(e.target.value) }))}
                className={FIELD_INPUT_CLASS}
              />
            </Field>
            <Field label="Vision calls per day">
              <input
                type="number"
                min={0}
                max={5000}
                value={budgetsForm.visionCallsPerDay}
                onChange={e => setBudgetsForm(f => ({ ...f, visionCallsPerDay: Number(e.target.value) }))}
                className={FIELD_INPUT_CLASS}
              />
            </Field>
            <Field label="AI-text calls per day">
              <input
                type="number"
                min={0}
                max={5000}
                value={budgetsForm.aiTextCallsPerDay}
                onChange={e => setBudgetsForm(f => ({ ...f, aiTextCallsPerDay: Number(e.target.value) }))}
                className={FIELD_INPUT_CLASS}
              />
            </Field>
          </div>
          <Button
            variant="primary"
            disabled={budgetsSaving}
            onClick={async () => {
              setBudgetsSaving(true);
              try {
                await apiMutate('/api/system/ingest-budgets', 'POST', budgetsForm);
                setMessage('Document ingest budgets saved.');
                void load();
              } catch {
                setMessage('Could not save ingest budgets.');
              } finally {
                setBudgetsSaving(false);
              }
            }}
          >
            {budgetsSaving ? 'Saving…' : 'Save ingest budgets'}
          </Button>
        </div>
      </DataSection>

      <DataSection
        title="Daily Digest & Closing Alerts"
        description="Track bids closing soon and unacknowledged corrigenda, with optional daily 08:00 PKT webhook delivery."
      >
        <div className="space-y-4">
          {digestSummary && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Chip tone={digestSummary.closingSoonCount > 0 ? 'warn' : 'ok'}>
                {digestSummary.closingSoonCount} closing within {digestForm.withinHours}h
              </Chip>
              <Chip tone={digestSummary.unacknowledgedCorrigendaCount > 0 ? 'warn' : 'neutral'}>
                {digestSummary.unacknowledgedCorrigendaCount} unread corrigenda
              </Chip>
              <Chip tone="neutral">
                {digestSummary.newMatchesLast24hCount} new in 24h
              </Chip>
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
            <input
              type="checkbox"
              checked={digestForm.enabled}
              onChange={e => setDigestForm(f => ({ ...f, enabled: e.target.checked }))}
              className="h-4 w-4 rounded border-line"
            />
            <span>Enable daily digest webhook (08:00 PKT)</span>
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Alert window (hours)">
              <input
                type="number"
                min={6}
                max={336}
                value={digestForm.withinHours}
                onChange={e => setDigestForm(f => ({ ...f, withinHours: Number(e.target.value) }))}
                className={FIELD_INPUT_CLASS}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Webhook URL (Slack / Teams / Discord / HTTP)">
                <input
                  type="url"
                  placeholder="https://hooks.slack.com/services/..."
                  value={digestForm.webhookUrl}
                  onChange={e => setDigestForm(f => ({ ...f, webhookUrl: e.target.value }))}
                  className={FIELD_INPUT_CLASS}
                />
              </Field>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={digestSaving}
              onClick={async () => {
                setDigestSaving(true);
                try {
                  await apiMutate('/api/system/digest/settings', 'POST', digestForm);
                  setMessage('Daily digest settings saved.');
                  void load();
                } catch {
                  setMessage('Could not save daily digest settings.');
                } finally {
                  setDigestSaving(false);
                }
              }}
            >
              {digestSaving ? 'Saving…' : 'Save digest settings'}
            </Button>
            <Button
              variant="ghost"
              disabled={digestRefreshing}
              onClick={async () => {
                setDigestRefreshing(true);
                try {
                  const data = await apiJson<
                    DigestAlertCounts & {
                      settings?: { enabled?: boolean; webhookUrl?: string; withinHours?: number };
                    }
                  >(`/api/system/digest?hours=${digestForm.withinHours}`);
                  setDigestSummary({
                    closingSoonCount: data.closingSoonCount ?? 0,
                    unacknowledgedCorrigendaCount: data.unacknowledgedCorrigendaCount ?? 0,
                    newMatchesLast24hCount: data.newMatchesLast24hCount ?? 0
                  });
                  if (data.settings) {
                    setDigestForm({
                      enabled: Boolean(data.settings.enabled),
                      webhookUrl: data.settings.webhookUrl ?? '',
                      withinHours: data.settings.withinHours ?? 48
                    });
                  }
                } catch {
                  setMessage('Could not refresh digest status.');
                } finally {
                  setDigestRefreshing(false);
                }
              }}
            >
              <RotateCw className={`h-4 w-4 ${digestRefreshing ? 'animate-spin' : ''}`} />
              {digestRefreshing ? 'Refreshing…' : 'Refresh digest'}
            </Button>
          </div>
        </div>
      </DataSection>

      <DataSection title="Export to Excel" description="Downloads a spreadsheet file you can open in Excel.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="What to include">
            <select value={scope} onChange={e => setScope(e.target.value)} className="h-10 rounded-lg border border-line bg-surface px-3">
              <option value="all">Everything</option>
              <option value="inbox">Inbox only</option>
              <option value="pipeline">Pipeline only</option>
            </select>
          </Field>
          <Button variant="primary" onClick={() => { window.location.href = `/api/export/csv?scope=${scope}`; }}>
            <Download className="h-4 w-4" /> Export
          </Button>
        </div>
      </DataSection>

      <DataSection title="Backups" description="A backup is made automatically every day. Backups older than 15 days are removed.">
        <Button onClick={backUp} disabled={busy}>{busy ? 'Backing up…' : 'Back up now'}</Button>
        <div className="mt-4 divide-y divide-line rounded-lg border border-line">
          {backups.length === 0 ? (
            <div className="px-4 py-3 text-ink-muted">No backups yet.</div>
          ) : (
            backups.map(b => (
              <div key={b.name} className="flex items-center justify-between px-4 py-2.5">
                <span>{new Date(b.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                <span className="font-mono text-[13px] text-ink-muted">{formatBytes(b.size_bytes)}</span>
              </div>
            ))
          )}
        </div>
      </DataSection>

      <DataSection
        title="Session Execution Logs (Last 3 Runs)"
        description="Preserves full terminal console outputs, API requests, and crawler errors for the last 3 sessions to enable easy troubleshooting."
      >
        <div className="divide-y divide-line rounded-lg border border-line">
          {sessionLogs.length === 0 ? (
            <div className="px-4 py-3 text-ink-muted">No session logs recorded yet.</div>
          ) : (
            sessionLogs.map(log => (
              <div key={log.filename} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-ink-muted shrink-0" />
                  <div>
                    <div className="flex items-center gap-2 font-mono text-[13px] font-medium">
                      <span>{log.filename}</span>
                      {log.isCurrent ? (
                        <Chip tone="ok">Active Session</Chip>
                      ) : (
                        <Chip>Past Session</Chip>
                      )}
                      {Boolean(log.errorCount && log.errorCount > 0) && (
                        <Chip tone="warn">{log.errorCount} Errors</Chip>
                      )}
                    </div>
                    <div className="text-xs text-ink-muted">
                      {new Date(log.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · {formatBytes(log.sizeBytes)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => void viewLog(log.filename)} disabled={loadingLog}>
                    View
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      window.location.href = `/api/system/logs/${log.filename}?download=true`;
                    }}
                  >
                    <Download className="h-3.5 w-3.5" /> Download
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </DataSection>

      <DataSection
        title="Saved documents"
        description={storage ? `${formatBytes(storage.total_bytes)} used across ${storage.tenders_with_documents} tenders.` : 'Checking…'}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => setConfirm('prune')} disabled={!storage || storage.passed_bytes === 0}>
              Delete files for passed tenders{storage && storage.passed_bytes > 0 ? ` (${formatBytes(storage.passed_bytes)})` : ''}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void runReconcileFiles()}
              disabled={reconciling}
              title="Audit disk files against cached_dossiers, prune orphan folders, and clean old trash"
            >
              <FileText className="h-4 w-4" />
              {reconciling ? 'Reconciling…' : 'Reconcile files on disk'}
            </Button>
          </div>

          {storage?.retention && (
            <div className="rounded-lg border border-line p-4 space-y-3">
              <div className="font-semibold text-sm">Automated Retention & Cleanup Policy</div>
              <p className="text-xs text-ink-muted">
                Passed tenders are slimmed 2 minutes after passing (purging dossier files while keeping pipeline records for 10 days post-closing).
                Unreviewed closed opportunities are automatically cleaned after the deadline grace period. Backups are retained for 15 days.
              </p>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 pt-2">
                <div className="rounded-lg bg-surface-2 p-2.5">
                  <div className="text-xs text-ink-muted">Pending Passed Slim</div>
                  <div className="mt-0.5 font-mono text-sm font-bold">{storage.retention.status.pendingSlimCount}</div>
                </div>
                <div className="rounded-lg bg-surface-2 p-2.5">
                  <div className="text-xs text-ink-muted">Expired Unreviewed</div>
                  <div className="mt-0.5 font-mono text-sm font-bold">{storage.retention.status.expiredUnreviewedCount}</div>
                </div>
                <div className="rounded-lg bg-surface-2 p-2.5">
                  <div className="text-xs text-ink-muted">Aged-out Passed</div>
                  <div className="mt-0.5 font-mono text-sm font-bold">{storage.retention.status.agedOutPassedCount}</div>
                </div>
                <div className="rounded-lg bg-surface-2 p-2.5">
                  <div className="text-xs text-ink-muted">Awaiting Scope</div>
                  <div className="mt-0.5 font-mono text-sm font-bold">{storage.retention.status.awaitingScopeCount ?? storage.awaiting_scope_count ?? 0}</div>
                </div>
              </div>

              <div className="pt-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={storage.retention.settings.retention_auto_clean}
                    onChange={e => void saveRetentionSettings({ autoClean: e.target.checked })}
                    disabled={retentionSaving}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  <span>Enable background automatic cleanup (runs every 5 minutes)</span>
                </label>
              </div>

              <div className="pt-2">
                <Button
                  onClick={() => void runRetentionCleanup()}
                  disabled={retentionRunning}
                >
                  <RotateCw className={`h-4 w-4 ${retentionRunning ? 'animate-spin' : ''}`} />
                  {retentionRunning ? 'Running cleanup…' : 'Run retention cleanup now'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DataSection>

      <section className="rounded-xl border border-danger p-5">
        <h2 className="text-base font-bold text-danger">Danger zone</h2>
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-semibold">Clear Inbox</div>
              <p className="text-ink-muted">Removes unreviewed opportunities from the inbox. Active bid pursuits, bookmarks, and pipeline records are preserved.</p>
            </div>
            <Button variant="danger" onClick={() => setConfirm('inbox')}>Clear Inbox</Button>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
            <div>
              <div className="font-semibold">Erase all data</div>
              <p className="text-ink-muted">Removes every tender, including your pipeline and notes. This cannot be undone.</p>
            </div>
            <Button variant="danger" onClick={() => setConfirm('erase')}>Erase all data</Button>
          </div>
        </div>
      </section>

      <Dialog
        open={confirm === 'inbox'}
        onClose={closeConfirm}
        title="Clear the Inbox?"
        footer={<><Button onClick={closeConfirm}>Cancel</Button><Button variant="danger" onClick={() => { closeConfirm(); onClearInbox(); setMessage('Inbox cleared.'); }}>Clear Inbox</Button></>}
      >
        <p>Unreviewed opportunities in the inbox will be cleared. Tenders in your pipeline and bookmarks are preserved.</p>
      </Dialog>

      <Dialog
        open={confirm === 'prune'}
        onClose={closeConfirm}
        title="Delete files for passed tenders?"
        footer={<><Button onClick={closeConfirm}>Cancel</Button><Button variant="danger" onClick={prune}>Delete files</Button></>}
      >
        <p>The saved documents for tenders you passed will be deleted. The tenders stay listed, and the originals remain on the portals.</p>
      </Dialog>

      <Dialog
        open={confirm === 'erase'}
        onClose={closeConfirm}
        title="Erase all data?"
        footer={
          <>
            <Button onClick={closeConfirm}>Cancel</Button>
            <Button variant="danger" disabled={typed !== 'CLEAR'} onClick={() => { closeConfirm(); onEraseAll(); setMessage('All tender data erased.'); }}>
              Erase everything
            </Button>
          </>
        }
      >
        <p className="mb-3">Every tender and note will be removed. Type <span className="font-mono font-bold">CLEAR</span> to confirm.</p>
        <input value={typed} onChange={e => setTyped(e.target.value)} aria-label="Type CLEAR to confirm" className={`${FIELD_INPUT_CLASS} font-mono`} />
      </Dialog>

      <Dialog
        open={Boolean(selectedLog)}
        onClose={() => setSelectedLog(null)}
        title={selectedLog ? `Session Log: ${selectedLog.filename}` : 'Session Log'}
        footer={
          <div className="flex w-full items-center justify-between">
            {selectedLog && (
              <Button
                size="sm"
                onClick={() => {
                  window.location.href = `/api/system/logs/${selectedLog.filename}?download=true`;
                }}
              >
                <Download className="h-4 w-4" /> Download File
              </Button>
            )}
            <Button onClick={() => setSelectedLog(null)}>Close</Button>
          </div>
        }
      >
        {selectedLog && (
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-3 font-mono text-xs select-text text-ink">
            {selectedLog.content}
          </pre>
        )}
      </Dialog>
    </div>
  );
}
