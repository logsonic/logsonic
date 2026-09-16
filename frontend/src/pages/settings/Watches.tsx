import { FolderSearch, Loader2, Pause, Play } from 'lucide-react';
import { FC, useEffect, useRef, useState } from 'react';

import { SettingsLayout } from './SettingsLayout';

import type { Watch, WatchFile, WatchRequest } from '@/lib/api-types';

import {
  settingsCard,
  settingsLabel,
  settingsNote,
  settingsRow,
} from '@/components/settings/styles';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/use-toast';
import { getGrokPatterns } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/api-errors';
import { formatBytes } from '@/lib/utils';
import { refreshAfterMutation } from '@/stores/useSourcesStore';
import { useWatchesStore } from '@/stores/useWatchesStore';

const POLL_MS = 2000;
const mono: React.CSSProperties = {
  fontFamily: 'var(--ls-font-mono)',
  fontVariantNumeric: 'tabular-nums',
};
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

const stateLabel = (f: WatchFile): string => {
  switch (f.state) {
    case 'following':
      return 'following';
    case 'ingesting':
      return 'reading…';
    case 'pending':
      return 'waiting';
    case 'done':
      return 'imported (compressed, not followed)';
    case 'skipped':
      return 'skipped';
    case 'error':
      return 'error';
    default:
      return f.state;
  }
};

const stateColor = (f: WatchFile): string => {
  switch (f.state) {
    case 'following':
      return 'var(--ls-ok)';
    case 'error':
      return 'var(--ls-err)';
    case 'skipped':
      return 'var(--ls-text-3)';
    default:
      return 'var(--ls-text-2)';
  }
};

/** Files that have finished their initial read — the rows are searchable now. */
const settledCount = (w: Watch): number =>
  w.files.filter((f) => f.state === 'following' || f.state === 'done').length;

/**
 * Watched folders: point LogSonic at a directory; matching files are read
 * when they appear and followed as they grow. The list polls while this
 * page is open (file states change on their own) and refreshes the rest of
 * the app once when files finish their first read.
 */
const WatchesSettings: FC = () => {
  const { toast } = useToast();
  const {
    watches,
    loaded,
    error,
    fetchWatches,
    createWatch,
    deleteWatch,
    pauseWatch,
    resumeWatch,
  } = useWatchesStore();
  const [form, setForm] = useState<WatchRequest>({
    dir: '',
    glob: '*.log',
    pattern: '',
    recursive: false,
  });
  const [patterns, setPatterns] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Watch | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const settledRef = useRef<Record<string, number>>({});

  useEffect(() => {
    void fetchWatches();
    getGrokPatterns()
      .then((r) =>
        setPatterns((r.patterns ?? []).map((p) => p.name).filter((n): n is string => Boolean(n)))
      )
      .catch(() => setPatterns([]));
  }, [fetchWatches]);

  // Poll while mounted; refresh the app once per tick if any file settled.
  useEffect(() => {
    const id = setInterval(() => void fetchWatches(), POLL_MS);
    return () => clearInterval(id);
  }, [fetchWatches]);
  useEffect(() => {
    let changed = false;
    for (const w of watches) {
      const n = settledCount(w);
      if (settledRef.current[w.id] !== undefined && n > settledRef.current[w.id]) changed = true;
      settledRef.current[w.id] = n;
    }
    if (changed) void refreshAfterMutation();
  }, [watches]);

  const dirBase = basename(form.dir.trim()) || '<folder>';
  const canSubmit = form.dir.trim().startsWith('/') && !creating;

  const submit = async () => {
    setFormError(null);
    setCreating(true);
    try {
      const created = await createWatch({
        dir: form.dir.trim(),
        glob: form.glob?.trim() || undefined,
        pattern: form.pattern || undefined,
        recursive: form.recursive || undefined,
      });
      settledRef.current[created.id] = 0;
      toast({
        title: `Watching ${basename(created.dir)}`,
        description: `${created.glob} files will appear under watch.${basename(created.dir)}.…`,
      });
      setForm({ dir: '', glob: '*.log', pattern: '', recursive: false });
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Could not create the watch.'));
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (w: Watch) => {
    setBusy(w.id);
    try {
      const next = w.paused ? await resumeWatch(w.id) : await pauseWatch(w.id);
      toast({ title: next.paused ? `Paused ${basename(w.dir)}` : `Resumed ${basename(w.dir)}` });
    } catch (err) {
      toast({
        title: 'Could not change the watch',
        description: apiErrorMessage(err, 'Try again.'),
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const w = confirmDelete;
    setConfirmDelete(null);
    if (!w) return;
    setBusy(w.id);
    try {
      await deleteWatch(w.id);
      delete settledRef.current[w.id];
      toast({
        title: `Stopped watching ${basename(w.dir)}`,
        description: 'Rows already indexed stay.',
      });
    } catch (err) {
      toast({
        title: 'Could not delete the watch',
        description: apiErrorMessage(err, 'Try again.'),
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsLayout>
      <div style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--ls-text)' }}>
          Watched folders
        </h2>
        <p style={{ margin: '4px 0 14px', fontSize: 12.5, color: 'var(--ls-text-2)' }}>
          Files that appear in a watched folder are read on their own and followed as they grow.
        </p>
      </div>

      {/* Add */}
      <div style={settingsCard} data-testid="watch-form">
        <div className="flex items-center justify-between" style={settingsRow(true)}>
          <span style={settingsLabel}>Folder</span>
          {/* A text input on purpose: a browser directory picker returns
              files, not a path the server could watch. The Mac app's
              native picker is macos-b2. */}
          <Input
            aria-label="Folder to watch"
            placeholder="/absolute/path/to/logs"
            value={form.dir}
            onChange={(e) => setForm({ ...form, dir: e.target.value })}
            style={{ maxWidth: 420, ...mono }}
          />
        </div>
        <div className="flex items-center justify-between" style={settingsRow(false)}>
          <span style={settingsLabel}>Files matching</span>
          <Input
            aria-label="File name pattern"
            value={form.glob ?? ''}
            onChange={(e) => setForm({ ...form, glob: e.target.value })}
            style={{ width: 160, ...mono }}
          />
        </div>
        <div className="flex items-center justify-between" style={settingsRow(false)}>
          <span style={settingsLabel}>Parse with</span>
          <select
            aria-label="Log pattern"
            value={form.pattern ?? ''}
            onChange={(e) => setForm({ ...form, pattern: e.target.value })}
            className="rounded border px-2 py-1 text-[12.5px]"
            style={{
              background: 'var(--ls-panel)',
              color: 'var(--ls-text)',
              borderColor: 'var(--ls-border)',
              maxWidth: 320,
            }}
          >
            <option value="">Auto-detect per file</option>
            {patterns.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between" style={settingsRow(false)}>
          <span style={settingsLabel}>Include subfolders</span>
          <Checkbox
            aria-label="Include subfolders"
            checked={!!form.recursive}
            onCheckedChange={(v) => setForm({ ...form, recursive: v === true })}
          />
        </div>
        <div
          className="flex items-center justify-between"
          style={{ ...settingsRow(false), ...settingsNote }}
        >
          <span>
            Rows will appear under sources named{' '}
            <code style={mono}>watch.{dirBase}.&lt;file&gt;</code>. Up to 100 files per folder; a
            file is read from where it was last left after a restart.
          </span>
          <Button size="sm" onClick={() => void submit()} disabled={!canSubmit}>
            {creating ? 'Starting…' : 'Watch folder'}
          </Button>
        </div>
        {formError && (
          <p style={{ ...settingsNote, color: 'var(--ls-err)', padding: '0 0 10px' }} role="alert">
            {formError}
          </p>
        )}
      </div>

      {error && (
        <p style={{ ...settingsNote, color: 'var(--ls-err)', marginBottom: 14 }}>
          {error}{' '}
          <button type="button" className="underline" onClick={() => void fetchWatches()}>
            Try again
          </button>
        </p>
      )}

      {loaded && !error && watches.length === 0 && (
        <p style={{ ...settingsNote, padding: '4px 2px 14px' }}>No folders watched yet.</p>
      )}

      {watches.map((w) => (
        <div key={w.id} style={settingsCard} data-testid="watch-card">
          <div className="flex items-center justify-between" style={settingsRow(true)}>
            <div className="flex items-center" style={{ gap: 8, minWidth: 0, flex: 1 }}>
              <FolderSearch
                className="h-3.5 w-3.5 flex-shrink-0"
                style={{ color: w.paused ? 'var(--ls-text-3)' : 'var(--ls-ok)' }}
              />
              <span
                className="truncate"
                style={{ ...settingsLabel, ...mono, minWidth: 0, flexShrink: 1 }}
                title={w.dir}
              >
                {w.dir}
              </span>
              {w.paused && <span style={settingsNote}>paused</span>}
            </div>
            <div className="flex items-center" style={{ gap: 4, flexShrink: 0 }}>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => void toggle(w)}
                disabled={busy === w.id}
              >
                {w.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                {w.paused ? 'Resume' : 'Pause'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="ls-danger-btn h-6 px-2 text-[11px]"
                onClick={() => setConfirmDelete(w)}
                disabled={busy === w.id}
              >
                Delete
              </Button>
            </div>
          </div>
          <div style={{ ...settingsRow(false), ...settingsNote }}>
            Files matching <code style={mono}>{w.glob}</code>, parsed with{' '}
            {w.pattern ? <code style={mono}>{w.pattern}</code> : 'auto-detection'}
            {w.recursive ? ', including subfolders' : ''}.
            {w.error && <span style={{ color: 'var(--ls-err)' }}> {w.error}</span>}
          </div>
          {w.files.length === 0 && (
            <div style={{ ...settingsRow(false), ...settingsNote }}>No matching files yet.</div>
          )}
          {w.files.map((f) => (
            <div
              key={f.path}
              className="flex items-center justify-between"
              style={settingsRow(false)}
              data-testid="watch-file"
            >
              <span
                className="truncate"
                style={{ ...mono, fontSize: 12, color: 'var(--ls-text)', minWidth: 0 }}
                title={f.path}
              >
                {basename(f.path)}
              </span>
              <div className="flex items-center" style={{ gap: 16, flexShrink: 0 }}>
                <span style={{ ...mono, fontSize: 11.5, color: 'var(--ls-text-3)' }}>
                  {formatBytes(f.size)}
                </span>
                <span style={{ fontSize: 11.5, color: stateColor(f) }} title={f.error}>
                  {f.state === 'ingesting' && (
                    <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                  )}
                  {stateLabel(f)}
                  {f.error ? ` — ${f.error}` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      ))}

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop watching {confirmDelete ? basename(confirmDelete.dir) : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete && (
                <>
                  {confirmDelete.files.filter((f) => f.state === 'following').length} file
                  {confirmDelete.files.filter((f) => f.state === 'following').length === 1
                    ? ''
                    : 's'}{' '}
                  will stop being followed. Rows already indexed stay, and their sources stay in the
                  Sources panel.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="ls-danger-action text-white"
              onClick={() => void remove()}
            >
              Stop watching
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsLayout>
  );
};

export default WatchesSettings;
