import React, { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, KeyRound, Pencil, Plus, RotateCw, Trash2 } from 'lucide-react';
import { DomainTrack, PortalHealth, SessionLogMeta } from '../../shared/types';
import { Button, Chip, Dialog, EmptyState, Panel, Tabs } from '../ui';
import { PortalCredentialsModal } from './PortalCredentialsModal';

type Tab = 'keywords' | 'portals' | 'data';

interface SourcesScreenProps {
  initialTab?: Tab;
  tracks: DomainTrack[];
  portals: PortalHealth[];
  onSaveTrack: (track: { id?: string; name: string; positive_keywords: string[]; negative_keywords: string[] }) => void;
  onDeleteTrack: (id: string) => void;
  onUpdatePortal: (portalId: string, updates: Partial<PortalHealth>) => void;
  onAddPortal?: (portal: { portal_name: string; tenders_url: string; base_url?: string; category?: string; tier?: string; access_mode?: string; login_url?: string }) => Promise<boolean> | void;
  onDeletePortal?: (portalId: string) => Promise<boolean> | void;
  onLaunchHitl: (portalId: string) => void;
  onVerifyHitl: (portalId: string) => void;
  onScanSinglePortal: (portalId: string) => void;
  onClearInbox: () => void;
  onEraseAll: () => void;
}

const splitWords = (text: string) => text.split(/[,\n]/).map(s => s.trim()).filter(Boolean);

const inputClass = 'w-full rounded-lg border border-line bg-surface px-3 py-2 placeholder:text-ink-muted';

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}

/* ------------------------------ Keywords ------------------------------ */

function KeywordsTab({ tracks, onSaveTrack, onDeleteTrack }: Pick<SourcesScreenProps, 'tracks' | 'onSaveTrack' | 'onDeleteTrack'>) {
  const [editing, setEditing] = useState<{ id?: string; name: string; positive: string; negative: string } | null>(null);
  const [deleting, setDeleting] = useState<DomainTrack | null>(null);

  const save = () => {
    if (!editing || !editing.name.trim()) return;
    onSaveTrack({
      id: editing.id,
      name: editing.name.trim(),
      positive_keywords: splitWords(editing.positive),
      negative_keywords: splitWords(editing.negative),
    });
    setEditing(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-xl text-ink-muted">
          A tender is tagged with a domain when its text contains one of the domain's words. Words in the Ignore list rule a tender out.
        </p>
        <Button variant="primary" onClick={() => setEditing({ name: '', positive: '', negative: '' })}>
          <Plus className="h-4 w-4" /> Add domain
        </Button>
      </div>

      {tracks.length === 0 ? (
        <Panel><EmptyState title="No domains yet" body="Add a domain to start tagging tenders." /></Panel>
      ) : (
        <Panel>
          {tracks.map(t => (
            <div key={t.id} className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 last:border-b-0">
              <div className="min-w-0 space-y-2">
                <div className="font-semibold">{t.name}</div>
                <div className="flex flex-wrap gap-1.5">
                  {t.positive_keywords.map(k => <Chip key={k} tone="accent">{k}</Chip>)}
                </div>
                {t.negative_keywords.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-ink-muted">Ignore:</span>
                    {t.negative_keywords.map(k => <Chip key={k}>{k}</Chip>)}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${t.name}`}
                  onClick={() => setEditing({ id: t.id, name: t.name, positive: t.positive_keywords.join(', '), negative: t.negative_keywords.join(', ') })}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => setDeleting(t)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </Panel>
      )}

      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit domain' : 'Add domain'}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={!editing?.name.trim()}>Save</Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label="Domain name">
              <input autoFocus value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Words to look for" hint="Separate with commas.">
              <textarea rows={3} value={editing.positive} onChange={e => setEditing({ ...editing, positive: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Ignore list" hint="Tenders containing these words are left out.">
              <textarea rows={2} value={editing.negative} onChange={e => setEditing({ ...editing, negative: e.target.value })} className={inputClass} />
            </Field>
          </div>
        )}
      </Dialog>

      <Dialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this domain?"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Keep it</Button>
            <Button variant="danger" onClick={() => { if (deleting) onDeleteTrack(deleting.id); setDeleting(null); }}>Delete</Button>
          </>
        }
      >
        <p>"{deleting?.name}" will stop tagging new tenders. Tenders already tagged stay as they are.</p>
      </Dialog>
    </div>
  );
}

/* ------------------------------- Portals ------------------------------- */

type PortalState = 'working' | 'verify' | 'offline';

function portalState(p: PortalHealth): PortalState {
  if (p.status === 'hitl_required') return 'verify';
  if (p.status === 'selector_broken' || p.status === 'error' || p.access_mode === 'offline_broken') return 'offline';
  return 'working';
}

function lastChecked(iso: string | null) {
  if (!iso) return 'Never checked';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Checked just now';
  if (mins < 60) return `Checked ${mins} min ago`;
  if (mins < 1440) return `Checked ${Math.round(mins / 60)} h ago`;
  return `Checked ${Math.round(mins / 1440)} days ago`;
}

function PortalsTab(props: Pick<SourcesScreenProps, 'portals' | 'onUpdatePortal' | 'onAddPortal' | 'onDeletePortal' | 'onLaunchHitl' | 'onVerifyHitl' | 'onScanSinglePortal'>) {
  const { portals } = props;
  const [editing, setEditing] = useState<PortalHealth | null>(null);
  const [form, setForm] = useState({ portal_name: '', website_url: '' });
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({
    portal_name: '',
    website_url: '',
    category: 'Provincial',
    tier: 'cheerio',
    access_mode: 'public',
    login_url: ''
  });
  const [addError, setAddError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<PortalHealth | null>(null);
  const [credentialsFor, setCredentialsFor] = useState<PortalHealth | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [healing, setHealing] = useState(false);
  const [healMessage, setHealMessage] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const working = portals.filter(p => portalState(p) === 'working').length;

  const startEdit = (p: PortalHealth) => {
    setEditing(p);
    setHealMessage(null);
    setForm({
      portal_name: p.portal_name,
      website_url: p.tenders_url || p.base_url || ''
    });
  };

  const runAutoHealInDialog = async () => {
    if (!editing) return;
    setHealing(true);
    setHealMessage(null);
    try {
      const res = await fetch(`/api/portals/${editing.portal_id}/heal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: form.website_url.trim() })
      });
      const data = await res.json();
      if (res.ok && data.success && data.tendersUrl) {
        setForm(prev => ({ ...prev, website_url: data.tendersUrl }));
        setHealMessage(data.message || `Found tender page: ${data.tendersUrl}`);
      } else {
        setHealMessage(data.message || 'Could not auto-detect tender page from this address.');
      }
    } catch {
      setHealMessage('Auto-discovery request failed.');
    } finally {
      setHealing(false);
    }
  };

  const resetToDefaultUrl = async () => {
    if (!editing) return;
    setResetting(true);
    setHealMessage(null);
    try {
      const res = await fetch(`/api/portals/${editing.portal_id}/reset-default`, {
        method: 'POST'
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setForm({
          portal_name: data.portal_name || form.portal_name,
          website_url: data.tenders_url || form.website_url
        });
        setHealMessage(data.message || 'Restored official default URL.');
        props.onUpdatePortal(editing.portal_id, {
          tenders_url: data.tenders_url,
          base_url: data.base_url,
          status: 'online',
          last_error_message: null
        });
      } else {
        setHealMessage(data.message || 'Could not reset portal to default URL.');
      }
    } catch {
      setHealMessage('Failed to reset default URL.');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-line bg-surface p-4">
        <div>
          <h2 className="text-base font-bold text-ink flex items-center gap-2">
            Procurement Portals
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-ink-muted">{portals.length}</span>
          </h2>
          <p className="text-xs text-ink-muted mt-0.5">
            <span className="font-semibold text-ink">{working} of {portals.length} portals are working.</span>{' '}
            Automated crawlers monitor these endpoints. Add new provincial/federal portals or delete portals at any time.
          </p>
        </div>
        <Button variant="primary" className="shrink-0" onClick={() => { setAdding(true); setAddError(null); }}>
          <Plus className="h-4 w-4" /> Add portal
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
        <div>
          <span className="font-semibold text-ink">{portals.filter(p => p.status === 'online').length} of {portals.length}</span> sources checked successfully
          {(() => {
            const latestSuccess = portals.map(p => p.last_success_at).filter((x): x is string => Boolean(x)).sort().reverse()[0];
            return latestSuccess ? <span> · Last success {lastChecked(latestSuccess)}</span> : null;
          })()}
        </div>
      </div>

      <Panel>
        {[...portals]
          .sort((a, b) => ['verify', 'offline', 'working'].indexOf(portalState(a)) - ['verify', 'offline', 'working'].indexOf(portalState(b)))
          .map(p => {
            const state = portalState(p);
            const website = p.tenders_url || p.base_url;
            const isAutoHealed = Boolean(p.verified_status && p.verified_status.startsWith('Auto-healed'));
            return (
              <div key={p.portal_id} className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{p.portal_name}</span>
                    {isAutoHealed && <Chip tone="accent">Auto-healed</Chip>}
                    {p.consecutive_zero_yields > 0 && p.status === 'online' && (
                      <Chip tone="warn">0 tenders — check URL</Chip>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px]">
                    {website ? (
                      <a
                        href={website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-[12px] text-accent hover:underline"
                        onClick={e => e.stopPropagation()}
                      >
                        <span className="truncate max-w-[280px] sm:max-w-[420px]">{website}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
                      </a>
                    ) : (
                      <span className="font-mono text-[12px] font-medium text-danger">⚠️ Missing website address</span>
                    )}
                    <span className="text-ink-muted">
                      · {p.category} · {lastChecked(p.last_scan_at)}
                      {p.last_items_found > 0 ? ` · ${p.last_items_found} matched` : ''}
                    </span>
                  </div>
                  {(p.last_error_message || p.last_error_code) && (
                    <div className={`mt-1 flex flex-wrap items-center gap-1.5 text-[12px] ${state === 'working' ? 'text-amber-700 dark:text-amber-400' : 'text-danger'}`}>
                      {p.last_error_code && (
                        <Chip tone={state === 'working' ? 'warn' : 'danger'}>{p.last_error_code}</Chip>
                      )}
                      {p.last_error_message && (
                        <>
                          <span className="font-semibold">{state === 'working' ? 'Notice:' : 'Reason:'}</span>
                          <span className="truncate max-w-[500px]">{p.last_error_message}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {p.status === 'scanning' ? (
                    <Chip tone="accent">Scanning…</Chip>
                  ) : (
                    <>
                      {state === 'working' && <Chip tone="ok">Working</Chip>}
                      {state === 'verify' && <Chip tone="warn">Needs verification</Chip>}
                      {state === 'offline' && <Chip tone="danger">Offline</Chip>}
                    </>
                  )}

                  {state === 'verify' && verifying !== p.portal_id && (
                    <Button size="sm" variant="primary" onClick={() => { props.onLaunchHitl(p.portal_id); setVerifying(p.portal_id); }}>Verify now</Button>
                  )}
                  {state === 'verify' && verifying === p.portal_id && (
                    <Button size="sm" variant="primary" onClick={() => { props.onVerifyHitl(p.portal_id); setVerifying(null); }}>I've finished</Button>
                  )}
                  {state === 'offline' && <Button size="sm" onClick={() => props.onScanSinglePortal(p.portal_id)}>Retry</Button>}
                  {state === 'working' && p.status !== 'scanning' && (
                    <Button size="sm" variant="ghost" onClick={() => props.onScanSinglePortal(p.portal_id)}>Scan</Button>
                  )}
                  <Button size="sm" variant="ghost" aria-label={`Edit ${p.portal_name}`} onClick={() => startEdit(p)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title={`Delete ${p.portal_name}`}
                    aria-label={`Delete ${p.portal_name}`}
                    className="text-ink-muted hover:bg-danger-soft hover:text-danger"
                    onClick={() => setDeleting(p)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
      </Panel>

      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.portal_name}` : ''}
        footer={
          <div className="flex w-full items-center justify-between">
            <Button
              variant="danger"
              onClick={() => {
                const toDel = editing;
                setEditing(null);
                setDeleting(toDel);
              }}
            >
              <Trash2 className="h-4 w-4" /> Delete portal
            </Button>
            <div className="flex items-center gap-2">
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  if (editing) {
                    const url = form.website_url.trim();
                    props.onUpdatePortal(editing.portal_id, {
                      portal_name: form.portal_name.trim(),
                      tenders_url: url,
                      base_url: url
                    });
                  }
                  setEditing(null);
                }}
              >
                Save
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label="Portal name">
            <input
              value={form.portal_name}
              onChange={e => setForm({ ...form, portal_name: e.target.value })}
              className={inputClass}
              placeholder="e.g. Punjab PPRA"
            />
          </Field>
          <Field label="Website address">
            <input
              value={form.website_url}
              onChange={e => setForm({ ...form, website_url: e.target.value })}
              className={`${inputClass} font-mono text-[13px]`}
              placeholder="https://..."
            />
          </Field>
          {healMessage && (
            <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-muted">
              {healMessage}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={healing || !form.website_url.trim()} onClick={() => void runAutoHealInDialog()}>
              {healing ? 'Searching website…' : 'Auto-find tender page'}
            </Button>
            <Button disabled={resetting} variant="ghost" onClick={() => void resetToDefaultUrl()}>
              {resetting ? 'Resetting…' : 'Reset to default URL'}
            </Button>
            <Button onClick={() => { setCredentialsFor(editing); setEditing(null); }}>
              <KeyRound className="h-4 w-4" /> Login details
            </Button>
          </div>
        </div>
      </Dialog>

      <PortalCredentialsModal
        portal={credentialsFor}
        isOpen={Boolean(credentialsFor)}
        onClose={() => setCredentialsFor(null)}
        onSuccess={() => { if (credentialsFor) props.onUpdatePortal(credentialsFor.portal_id, { status: 'online' }); }}
      />

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add procurement portal"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!addForm.portal_name.trim() || !addForm.website_url.trim()}
              onClick={async () => {
                if (!addForm.portal_name.trim() || !addForm.website_url.trim()) return;
                try {
                  if (props.onAddPortal) {
                    await props.onAddPortal({
                      portal_name: addForm.portal_name.trim(),
                      tenders_url: addForm.website_url.trim(),
                      base_url: addForm.website_url.trim(),
                      category: addForm.category,
                      tier: addForm.tier,
                      access_mode: addForm.access_mode,
                      login_url: addForm.login_url.trim() || undefined
                    });
                  } else {
                    await fetch('/api/portals', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        portal_name: addForm.portal_name.trim(),
                        tenders_url: addForm.website_url.trim(),
                        category: addForm.category,
                        tier: addForm.tier,
                        access_mode: addForm.access_mode,
                        login_url: addForm.login_url.trim() || undefined
                      })
                    });
                  }
                  setAdding(false);
                  setAddForm({
                    portal_name: '',
                    website_url: '',
                    category: 'Provincial',
                    tier: 'cheerio',
                    access_mode: 'public',
                    login_url: ''
                  });
                } catch (err: any) {
                  setAddError(err?.message || 'Failed to add portal');
                }
              }}
            >
              Add portal
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Portal name">
            <input
              autoFocus
              value={addForm.portal_name}
              onChange={e => setAddForm({ ...addForm, portal_name: e.target.value })}
              className={inputClass}
              placeholder="e.g. Sindh Irrigation Department"
            />
          </Field>
          <Field label="Tenders website address">
            <input
              value={addForm.website_url}
              onChange={e => setAddForm({ ...addForm, website_url: e.target.value })}
              className={`${inputClass} font-mono text-[13px]`}
              placeholder="https://example.gov.pk/tenders"
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Category">
              <select
                value={addForm.category}
                onChange={e => setAddForm({ ...addForm, category: e.target.value })}
                className={inputClass}
              >
                <option value="Federal">Federal</option>
                <option value="Provincial">Provincial</option>
                <option value="Regulatory">Regulatory</option>
                <option value="Energy & Power">Energy & Power</option>
                <option value="Education & Skills">Education & Skills</option>
                <option value="Autonomous">Autonomous</option>
                <option value="Multilateral">Multilateral</option>
              </select>
            </Field>
            <Field label="Access type">
              <select
                value={addForm.access_mode}
                onChange={e => setAddForm({ ...addForm, access_mode: e.target.value })}
                className={inputClass}
              >
                <option value="public">Public / Open</option>
                <option value="login_required">Login Required</option>
                <option value="cloudflare">Cloudflare / CAPTCHA</option>
              </select>
            </Field>
          </div>
          {addForm.access_mode === 'login_required' && (
            <Field label="Login page URL (optional)">
              <input
                value={addForm.login_url}
                onChange={e => setAddForm({ ...addForm, login_url: e.target.value })}
                className={`${inputClass} font-mono text-[13px]`}
                placeholder="https://example.gov.pk/login"
              />
            </Field>
          )}
          {addError && (
            <div className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
              {addError}
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this portal?"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Keep it</Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (deleting) {
                  if (props.onDeletePortal) {
                    await props.onDeletePortal(deleting.portal_id);
                  } else {
                    await fetch(`/api/portals/${deleting.portal_id}`, { method: 'DELETE' });
                  }
                }
                setDeleting(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-ink-muted">
          Are you sure you want to remove <span className="font-semibold text-ink">{deleting?.portal_name}</span>?
          This will exclude it from future scans and crawler runs.
        </p>
      </Dialog>
    </div>
  );
}

/* --------------------------------- Data -------------------------------- */

interface Backup { name: string; created_at: string; size_bytes: number }
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
    summary: {
      closingSoonCount: number;
      unacknowledgedCorrigendaCount: number;
      newMatchesLast24hCount: number;
    };
  };
}

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
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

function DataTab({ onClearInbox, onEraseAll }: Pick<SourcesScreenProps, 'onClearInbox' | 'onEraseAll'>) {
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
  const [digestSummary, setDigestSummary] = useState<{
    closingSoonCount: number;
    unacknowledgedCorrigendaCount: number;
    newMatchesLast24hCount: number;
  } | null>(null);
  const [digestSaving, setDigestSaving] = useState(false);
  const [digestRefreshing, setDigestRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'inbox' | 'prune' | 'erase' | null>(null);
  const [typed, setTyped] = useState('');

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([fetch('/api/backups'), fetch('/api/storage')]);
      if (b.ok) setBackups(await b.json());
      if (s.ok) {
        const sData = await s.json();
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
      }
    } catch (err) {
      console.error('Failed to load data settings:', err);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const viewLog = async (filename: string) => {
    setLoadingLog(true);
    try {
      const res = await fetch(`/api/system/logs/${filename}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedLog(data);
      } else {
        setMessage('Could not load session log content.');
      }
    } catch {
      setMessage('Failed to fetch session log.');
    } finally {
      setLoadingLog(false);
    }
  };

  const closeConfirm = () => { setConfirm(null); setTyped(''); };

  const saveAiKey = async (keyToSave: string) => {
    setAiSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: keyToSave.trim() })
      });
      if (res.ok) {
        const data = await res.json();
        setStorage(prev => prev ? { ...prev, ai_configured: Boolean(data.configured), ai_masked_key: data.maskedKey } : prev);
        setAiKeyInput('');
        setMessage(data.message || 'Google AI Studio settings updated.');
      } else {
        setMessage('Could not save API key.');
      }
    } catch {
      setMessage('Could not save API key.');
    } finally {
      setAiSaving(false);
    }
  };

  const backUp = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/backups', { method: 'POST' });
      setMessage(res.ok ? 'Backup created.' : 'Backup failed. Please try again.');
    } finally {
      setBusy(false);
      void load();
    }
  };

  const prune = async () => {
    closeConfirm();
    const res = await fetch('/api/dossiers/prune-passed', { method: 'POST' });
    if (res.ok) {
      const r = await res.json();
      setMessage(`Deleted files for ${r.tenders} passed ${r.tenders === 1 ? 'tender' : 'tenders'} and freed ${bytes(r.freed_bytes)}.`);
    } else {
      setMessage('Could not delete the files.');
    }
    void load();
  };

  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionRunning, setRetentionRunning] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  const saveRetentionSettings = async (newSettings: { autoClean?: boolean; graceDays?: number; passedRetentionDays?: number }) => {
    setRetentionSaving(true);
    try {
      const res = await fetch('/api/system/retention/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      });
      if (res.ok) {
        setMessage('Retention settings saved.');
        void load();
      } else {
        setMessage('Failed to save retention settings.');
      }
    } catch {
      setMessage('Error updating retention settings.');
    } finally {
      setRetentionSaving(false);
    }
  };

  const runRetentionCleanup = async () => {
    setRetentionRunning(true);
    try {
      const res = await fetch('/api/system/retention/run', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setMessage(`Retention cycle complete: slimmed ${data.summary.slimmed} passed tenders, deleted ${data.summary.expiredUnreviewed} expired unreviewed tenders, and purged ${data.summary.agedOutPassed} aged-out records.`);
        void load();
      } else {
        setMessage('Failed to execute retention cycle.');
      }
    } catch {
      setMessage('Error executing retention cycle.');
    } finally {
      setRetentionRunning(false);
    }
  };

  const runReconcileFiles = async () => {
    setReconciling(true);
    try {
      const res = await fetch('/api/system/dossiers/reconcile', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setMessage(`File reconciliation complete: removed ${data.reconciliation.orphanFoldersDeleted} orphan folders, pruned ${data.reconciliation.missingMetadataPruned} missing DB records, cleaned ${data.reconciliation.trashPurged} trash items.`);
        void load();
      } else {
        setMessage('Failed to reconcile dossier files.');
      }
    } catch {
      setMessage('Error reconciling dossier files.');
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
                  className={`${inputClass} font-mono text-[13px]`}
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
                className={inputClass}
              />
            </Field>
            <Field label="Max file size (MB)">
              <input
                type="number"
                min={1}
                max={200}
                value={budgetsForm.maxFileMb}
                onChange={e => setBudgetsForm(f => ({ ...f, maxFileMb: Number(e.target.value) }))}
                className={inputClass}
              />
            </Field>
            <Field label="Vision calls per scan">
              <input
                type="number"
                min={0}
                max={500}
                value={budgetsForm.visionCallsPerScan}
                onChange={e => setBudgetsForm(f => ({ ...f, visionCallsPerScan: Number(e.target.value) }))}
                className={inputClass}
              />
            </Field>
            <Field label="Vision calls per day">
              <input
                type="number"
                min={0}
                max={5000}
                value={budgetsForm.visionCallsPerDay}
                onChange={e => setBudgetsForm(f => ({ ...f, visionCallsPerDay: Number(e.target.value) }))}
                className={inputClass}
              />
            </Field>
            <Field label="AI-text calls per day">
              <input
                type="number"
                min={0}
                max={5000}
                value={budgetsForm.aiTextCallsPerDay}
                onChange={e => setBudgetsForm(f => ({ ...f, aiTextCallsPerDay: Number(e.target.value) }))}
                className={inputClass}
              />
            </Field>
          </div>
          <Button
            variant="primary"
            disabled={budgetsSaving}
            onClick={async () => {
              setBudgetsSaving(true);
              try {
                const res = await fetch('/api/system/ingest-budgets', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(budgetsForm)
                });
                if (res.ok) {
                  setMessage('Document ingest budgets saved.');
                  void load();
                } else {
                  setMessage('Could not save ingest budgets.');
                }
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
                className={inputClass}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Webhook URL (Slack / Teams / Discord / HTTP)">
                <input
                  type="url"
                  placeholder="https://hooks.slack.com/services/..."
                  value={digestForm.webhookUrl}
                  onChange={e => setDigestForm(f => ({ ...f, webhookUrl: e.target.value }))}
                  className={inputClass}
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
                  const res = await fetch('/api/system/digest/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(digestForm)
                  });
                  if (res.ok) {
                    setMessage('Daily digest settings saved.');
                    void load();
                  } else {
                    setMessage('Could not save daily digest settings.');
                  }
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
                  const res = await fetch(`/api/system/digest?hours=${digestForm.withinHours}`);
                  if (res.ok) {
                    const data = await res.json();
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
                <span className="font-mono text-[13px] text-ink-muted">{bytes(b.size_bytes)}</span>
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
                      {new Date(log.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · {bytes(log.sizeBytes)}
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
        description={storage ? `${bytes(storage.total_bytes)} used across ${storage.tenders_with_documents} tenders.` : 'Checking…'}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => setConfirm('prune')} disabled={!storage || storage.passed_bytes === 0}>
              Delete files for passed tenders{storage && storage.passed_bytes > 0 ? ` (${bytes(storage.passed_bytes)})` : ''}
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
        <input value={typed} onChange={e => setTyped(e.target.value)} aria-label="Type CLEAR to confirm" className={`${inputClass} font-mono`} />
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

/* --------------------------------- Page --------------------------------- */

export function SourcesScreen(props: SourcesScreenProps) {
  const [tab, setTab] = useState<Tab>(props.initialTab || 'keywords');

  useEffect(() => {
    if (props.initialTab) {
      setTab(props.initialTab);
    }
  }, [props.initialTab]);
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-6">
      <h1 className="text-xl font-bold">Sources & Keywords</h1>
      <Tabs
        label="Sources and keywords"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'keywords', label: 'Keywords', count: props.tracks.length },
          { id: 'portals', label: 'Portals', count: props.portals.length },
          { id: 'data', label: 'Data' },
        ]}
      />
      {tab === 'keywords' && <KeywordsTab tracks={props.tracks} onSaveTrack={props.onSaveTrack} onDeleteTrack={props.onDeleteTrack} />}
      {tab === 'portals' && (
        <PortalsTab
          portals={props.portals}
          onUpdatePortal={props.onUpdatePortal}
          onAddPortal={props.onAddPortal}
          onDeletePortal={props.onDeletePortal}
          onLaunchHitl={props.onLaunchHitl}
          onVerifyHitl={props.onVerifyHitl}
          onScanSinglePortal={props.onScanSinglePortal}
        />
      )}
      {tab === 'data' && <DataTab onClearInbox={props.onClearInbox} onEraseAll={props.onEraseAll} />}
    </div>
  );
}
