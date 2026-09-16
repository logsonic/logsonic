import { FolderOpen, Loader2 } from 'lucide-react';
import { FC, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { SettingsLayout } from './SettingsLayout';

import type { StorageDay, StorageResponse } from '@/lib/api-types';

import { CopyableValue } from '@/components/settings/CopyableValue';
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
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/use-toast';
import { deleteStorageDay, getStorage, updateStorage } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/api-errors';
import { isNativeShell, revealStoragePath } from '@/lib/native';
import { formatBytes } from '@/lib/utils';
import { refreshAfterMutation } from '@/stores/useSourcesStore';

const MAX_RETENTION_DAYS = 3650;

const card: React.CSSProperties = {
  background: 'var(--ls-panel)',
  border: '1px solid var(--ls-border)',
  borderRadius: 'var(--ls-radius-lg)',
  boxShadow: 'var(--ls-shadow-sm)',
  padding: '6px 16px',
  marginBottom: 14,
};
const rowStyle = (first: boolean): React.CSSProperties => ({
  gap: 16,
  padding: '10px 0',
  borderTop: first ? 'none' : '1px solid var(--ls-border-subtle)',
});
const label: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  color: 'var(--ls-text)',
  flexShrink: 0,
};
const note: React.CSSProperties = { fontSize: 12, color: 'var(--ls-text-2)' };
const n = (v: number) => v.toLocaleString();

const retentionSourceLine = (s: StorageResponse): string => {
  switch (s.retention_source) {
    case 'config':
      return s.retention_default > 0
        ? `Set here, overriding the -retention-days ${s.retention_default} the server was started with.`
        : 'Set here.';
    case 'flag':
      return 'From the -retention-days flag or RETENTION_DAYS the server was started with.';
    default:
      return 'Nothing set: logs are kept until you delete them.';
  }
};

/**
 * Storage settings: how long logs are kept (saved server-side in
 * config.json, which wins over the CLI flag), what is on disk per day with
 * a delete per row, and where the index lives.
 */
const StorageSettings: FC = () => {
  const { toast } = useToast();
  const [storage, setStorage] = useState<StorageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retentionInput, setRetentionInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDay, setConfirmDay] = useState<StorageDay | null>(null);
  const [deletingDay, setDeletingDay] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await getStorage();
      setStorage(s);
      setRetentionInput(String(s.retention_days));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load storage settings.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Digits only, so "1e3" or "7.0" don't save as 1000 / 7 while the help
  // text says "a whole number".
  const parsed = /^\d+$/.test(retentionInput.trim()) ? Number(retentionInput.trim()) : NaN;
  const validRetention = Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_RETENTION_DAYS;
  const unchanged =
    storage !== null &&
    validRetention &&
    parsed === storage.retention_days &&
    storage.retention_source !== 'none';

  const saveRetention = async (days: number | null) => {
    setSaving(true);
    try {
      const s = await updateStorage({ retention_days: days });
      setStorage(s);
      setRetentionInput(String(s.retention_days));
      toast({
        title:
          days === null
            ? 'Retention override cleared'
            : days === 0
              ? 'Retention off — logs are kept forever'
              : `Retention set to ${days} ${days === 1 ? 'day' : 'days'}`,
        description: days === null ? retentionSourceLine(s) : undefined,
      });
      await refreshAfterMutation();
    } catch (err) {
      toast({
        title: 'Could not save retention',
        description: apiErrorMessage(err, 'Try again.'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const deleteDay = async () => {
    const day = confirmDay;
    setConfirmDay(null);
    if (!day) return;
    setDeletingDay(day.date);
    try {
      const resp = await deleteStorageDay(day.date);
      toast({ title: `Deleted ${day.date}`, description: `${n(resp.rows_deleted)} rows removed.` });
      await load();
      await refreshAfterMutation();
    } catch (err) {
      toast({
        title: `Could not delete ${day.date}`,
        description: apiErrorMessage(err, 'Try again.'),
        variant: 'destructive',
      });
    } finally {
      setDeletingDay(null);
    }
  };

  const reveal = () => {
    if (!revealStoragePath()) {
      toast({
        title: 'Reveal in Finder is only available in the LogSonic app',
        description: 'Copy the path instead.',
      });
    }
  };

  return (
    <SettingsLayout>
      <div style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--ls-text)' }}>
          Storage
        </h2>
        <p style={{ margin: '4px 0 14px', fontSize: 12.5, color: 'var(--ls-text-2)' }}>
          How long logs are kept, what is on disk, and where.
        </p>
      </div>

      {error && (
        <p style={{ ...note, color: 'var(--ls-err)', marginBottom: 14 }}>
          {error}{' '}
          <button type="button" className="underline" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}

      {/* Retention */}
      <div style={card} data-testid="storage-retention">
        <div className="flex items-center justify-between" style={rowStyle(true)}>
          <span style={label}>Keep logs for</span>
          <div className="flex items-center" style={{ gap: 8 }}>
            <Input
              aria-label="Retention days"
              inputMode="numeric"
              value={retentionInput}
              onChange={(e) => setRetentionInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && validRetention && !unchanged && !saving)
                  void saveRetention(parsed);
              }}
              style={{ width: 88, textAlign: 'right' }}
              disabled={storage === null || saving}
            />
            <span style={note}>days</span>
            <Button
              size="sm"
              onClick={() => void saveRetention(parsed)}
              disabled={!validRetention || unchanged || saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
        <div style={{ ...rowStyle(false), ...note }}>
          {storage ? (
            <>
              {storage.retention_days === 0 ? 'Kept forever. ' : ''}
              {retentionSourceLine(storage)}{' '}
              {storage.retention_source === 'config' && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => void saveRetention(null)}
                  disabled={saving}
                  style={{ color: 'var(--ls-accent-text)' }}
                >
                  {storage.retention_default > 0
                    ? `Clear and use ${storage.retention_default} days from the flag`
                    : 'Clear the override'}
                </button>
              )}
              {!validRetention && retentionInput.trim() !== '' && (
                <span style={{ color: 'var(--ls-err)' }}>
                  {' '}
                  Enter a whole number from 0 to {MAX_RETENTION_DAYS}.
                </span>
              )}
              <div style={{ marginTop: 4 }}>
                0 keeps everything. Older days are removed at startup, once a day, and right after
                you save.
              </div>
            </>
          ) : (
            'Loading…'
          )}
        </div>
      </div>

      {/* Days on disk */}
      <div style={card} data-testid="storage-days">
        <div className="flex items-center justify-between" style={rowStyle(true)}>
          <span style={label}>Days on disk</span>
          <span className="ls-mono-inline">
            {storage
              ? `${storage.days.length} ${storage.days.length === 1 ? 'day' : 'days'}, ${formatBytes(storage.total_bytes)}`
              : '…'}
          </span>
        </div>
        {storage && storage.days.length === 0 && (
          <div style={{ ...rowStyle(false), ...note }}>
            No logs stored yet.{' '}
            <Link to="/import" className="underline" style={{ color: 'var(--ls-accent-text)' }}>
              Import a log file
            </Link>{' '}
            to get started.
          </div>
        )}
        {storage?.days.map((d) => (
          <div
            key={d.date}
            className="flex items-center justify-between"
            style={rowStyle(false)}
            data-testid="storage-day"
          >
            <span className="ls-mono-inline">{d.date}</span>
            <div className="flex items-center" style={{ gap: 16 }}>
              <span className="ls-mono-inline" style={{ color: 'var(--ls-text-2)' }}>
                {n(d.rows)} rows
              </span>
              <span
                className="ls-mono-inline"
                style={{ color: 'var(--ls-text-2)', minWidth: 72, textAlign: 'right' }}
              >
                {formatBytes(d.bytes)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ls-danger-btn h-6 px-2 text-[11px]"
                onClick={() => setConfirmDay(d)}
                disabled={deletingDay !== null}
                aria-label={`Delete ${d.date}`}
              >
                {deletingDay === d.date ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Delete'}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Location */}
      <div style={card} data-testid="storage-location">
        <div className="flex items-center justify-between" style={rowStyle(true)}>
          <span style={label}>Index folder</span>
          <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
            {storage ? (
              <CopyableValue value={storage.path} />
            ) : (
              <span className="ls-mono-inline">…</span>
            )}
            {isNativeShell() && (
              <Button size="sm" variant="outline" onClick={reveal}>
                <FolderOpen className="h-3.5 w-3.5" /> Reveal in Finder
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between" style={rowStyle(false)}>
          <span style={label}>Settings file</span>
          {storage?.config_path ? (
            <CopyableValue value={storage.config_path} />
          ) : (
            <span className="ls-mono-inline">…</span>
          )}
        </div>
        <div style={{ ...rowStyle(false), ...note }}>
          Retention saved here wins over the command line — see the{' '}
          <a
            href="https://github.com/logsonic/logsonic/blob/main/docs/configuration.md#retention-precedence"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            precedence rules
          </a>
          .
        </div>
      </div>

      <AlertDialog open={confirmDay !== null} onOpenChange={(o) => !o && setConfirmDay(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDay?.date}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDay && (
                <>
                  Removes {n(confirmDay.rows)} rows ({formatBytes(confirmDay.bytes)}) from every
                  source for that day. This can't be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="ls-danger-action text-white"
              onClick={() => void deleteDay()}
            >
              Delete day
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsLayout>
  );
};

export default StorageSettings;
