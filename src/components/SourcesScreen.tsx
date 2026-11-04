import React, { useCallback, useEffect, useState } from 'react';
import { Download, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { DomainTrack, PortalHealth } from '../types';
import { Button, Chip, Dialog, EmptyState, Panel, Tabs } from '../ui';
import { PortalCredentialsModal } from './PortalCredentialsModal';

type Tab = 'keywords' | 'portals' | 'data';

interface SourcesScreenProps {
  tracks: DomainTrack[];
  portals: PortalHealth[];
  onSaveTrack: (track: { id?: string; name: string; positive_keywords: string[]; negative_keywords: string[] }) => void;
  onDeleteTrack: (id: string) => void;
  onUpdatePortal: (portalId: string, updates: Partial<PortalHealth>) => void;
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

function PortalsTab(props: Pick<SourcesScreenProps, 'portals' | 'onUpdatePortal' | 'onLaunchHitl' | 'onVerifyHitl' | 'onScanSinglePortal'>) {
  const { portals } = props;
  const [editing, setEditing] = useState<PortalHealth | null>(null);
  const [form, setForm] = useState({ portal_name: '', tenders_url: '', base_url: '' });
  const [credentialsFor, setCredentialsFor] = useState<PortalHealth | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);

  const working = portals.filter(p => portalState(p) === 'working').length;

  const startEdit = (p: PortalHealth) => {
    setEditing(p);
    setForm({ portal_name: p.portal_name, tenders_url: p.tenders_url, base_url: p.base_url });
  };

  return (
    <div className="space-y-4">
      <p className="text-ink-muted">
        <span className="font-semibold text-ink">{working} of {portals.length} portals are working.</span>{' '}
        Portals that need a person (a CAPTCHA or a login) are listed first.
      </p>

      <Panel>
        {[...portals]
          .sort((a, b) => ['verify', 'offline', 'working'].indexOf(portalState(a)) - ['verify', 'offline', 'working'].indexOf(portalState(b)))
          .map(p => {
            const state = portalState(p);
            return (
              <div key={p.portal_id} className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5 last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{p.portal_name}</div>
                  <div className="text-[13px] text-ink-muted">{p.category} · {lastChecked(p.last_scan_at)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {state === 'working' && <Chip tone="ok">Working</Chip>}
                  {state === 'verify' && <Chip tone="warn">Needs verification</Chip>}
                  {state === 'offline' && <Chip tone="danger">Offline</Chip>}

                  {state === 'verify' && verifying !== p.portal_id && (
                    <Button size="sm" variant="primary" onClick={() => { props.onLaunchHitl(p.portal_id); setVerifying(p.portal_id); }}>Verify now</Button>
                  )}
                  {state === 'verify' && verifying === p.portal_id && (
                    <Button size="sm" variant="primary" onClick={() => { props.onVerifyHitl(p.portal_id); setVerifying(null); }}>I've finished</Button>
                  )}
                  {state === 'offline' && <Button size="sm" onClick={() => props.onScanSinglePortal(p.portal_id)}>Retry</Button>}
                  <Button size="sm" variant="ghost" aria-label={`Edit ${p.portal_name}`} onClick={() => startEdit(p)}>
                    <Pencil className="h-4 w-4" />
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
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => { if (editing) props.onUpdatePortal(editing.portal_id, form); setEditing(null); }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <input value={form.portal_name} onChange={e => setForm({ ...form, portal_name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Tenders page address">
            <input value={form.tenders_url} onChange={e => setForm({ ...form, tenders_url: e.target.value })} className={`${inputClass} font-mono text-[13px]`} />
          </Field>
          <Field label="Website address">
            <input value={form.base_url} onChange={e => setForm({ ...form, base_url: e.target.value })} className={`${inputClass} font-mono text-[13px]`} />
          </Field>
          <Button onClick={() => { setCredentialsFor(editing); setEditing(null); }}>
            <KeyRound className="h-4 w-4" /> Login details
          </Button>
        </div>
      </Dialog>

      <PortalCredentialsModal
        portal={credentialsFor}
        isOpen={Boolean(credentialsFor)}
        onClose={() => setCredentialsFor(null)}
        onSuccess={() => { if (credentialsFor) props.onUpdatePortal(credentialsFor.portal_id, { status: 'online' }); }}
      />
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
  ai_configured?: boolean;
  ai_masked_key?: string | null;
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
  const [storage, setStorage] = useState<Storage | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiKeyInput, setAiKeyInput] = useState('');
  const [aiSaving, setAiSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'inbox' | 'prune' | 'erase' | null>(null);
  const [typed, setTyped] = useState('');

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([fetch('/api/backups'), fetch('/api/storage')]);
      if (b.ok) setBackups(await b.json());
      if (s.ok) setStorage(await s.json());
    } catch (err) {
      console.error('Failed to load data settings:', err);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

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
              <Chip tone="ok">Connected ({storage.ai_masked_key || 'Active'}) · Gemini Flash</Chip>
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

      <DataSection title="Backups" description="A backup is made automatically every day. Backups older than 14 days are removed.">
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
        title="Saved documents"
        description={storage ? `${bytes(storage.total_bytes)} used across ${storage.tenders_with_documents} tenders.` : 'Checking…'}
      >
        <Button onClick={() => setConfirm('prune')} disabled={!storage || storage.passed_bytes === 0}>
          Delete files for passed tenders{storage && storage.passed_bytes > 0 ? ` (${bytes(storage.passed_bytes)})` : ''}
        </Button>
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
    </div>
  );
}

/* --------------------------------- Page --------------------------------- */

export function SourcesScreen(props: SourcesScreenProps) {
  const [tab, setTab] = useState<Tab>('keywords');
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
          onLaunchHitl={props.onLaunchHitl}
          onVerifyHitl={props.onVerifyHitl}
          onScanSinglePortal={props.onScanSinglePortal}
        />
      )}
      {tab === 'data' && <DataTab onClearInbox={props.onClearInbox} onEraseAll={props.onEraseAll} />}
    </div>
  );
}
