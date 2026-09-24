import { ChevronDown, ChevronRight, Database, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import type { SourceEntry } from '@/lib/api-types';

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/use-toast';
import { useImportStore } from '@/stores/useImportStore';
import {
  sourceErrorMessage,
  useSourcesStore,
  type ReimportInFlight,
} from '@/stores/useSourcesStore';

const mono: React.CSSProperties = {
  fontFamily: 'var(--ls-font-mono)',
  fontVariantNumeric: 'tabular-nums',
};
const n = (v: number) => v.toLocaleString();

/** The last path segment — what a person recognises; the full path goes in the title. */
const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

const originLabel = (e: SourceEntry): string => {
  switch (e.origin.kind) {
    case 'file':
      return e.origin.path ? `From ${basename(e.origin.path)}` : 'Uploaded from the browser';
    case 'tail':
      return `Live tail of ${e.origin.path ? basename(e.origin.path) : 'a file'}`;
    case 'stdin':
      return 'Piped in on stdin';
    case 'watch':
      return `Watched folder ${e.origin.path ?? ''}`.trim();
    case 'otlp':
      return `OTLP from ${e.origin.host ?? 'a collector'}`;
    case 'case':
      return 'Case file';
    default:
      return 'Found in the index (origin unknown)';
  }
};

const daySpan = (e: SourceEntry): string => {
  if (e.days.length === 0) return 'no days';
  if (e.days.length === 1) return e.days[0];
  return `${e.days[0]} to ${e.days[e.days.length - 1]}`;
};

const lastImport = (e: SourceEntry): string | null => {
  const last = e.imports[e.imports.length - 1];
  if (!last) return null;
  const at = new Date(last.at);
  return `Last import ${at.toLocaleDateString()} ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, ${n(last.rows)} rows`;
};

/**
 * Sources panel: every source in the catalog with its row count, expandable
 * to where it came from, which pattern parsed it, and the three actions
 * (rename, re-import, delete) — each behind a confirm that names the
 * consequence. The list shows a display name when one is set; the stored
 * name (what the Filter tab, source chips and the _src facet show) is in the
 * expanded detail so the two can be matched up.
 */
export const SourcesPanel = () => {
  const {
    sources,
    isLoading,
    loaded,
    error,
    expanded,
    deleting,
    reimports,
    fetchSources,
    setExpanded,
    deleteSource,
    renameSource,
    reimportSource,
    clearReimport,
  } = useSourcesStore();
  const wizardImporting = useImportStore((s) => s.isUploading);
  const { toast } = useToast();

  const [confirmDelete, setConfirmDelete] = useState<SourceEntry | null>(null);
  const [confirmReimport, setConfirmReimport] = useState<SourceEntry | null>(null);
  const [renaming, setRenaming] = useState<SourceEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  // Refetch on every open: the wizard, the CLI and Dock drops all add
  // sources behind this panel's back, and the store keeps the previous list
  // visible while the request runs. `loaded` only gates the empty state.
  useEffect(() => {
    void fetchSources();
  }, [fetchSources]);

  const handleDelete = async () => {
    const entry = confirmDelete;
    setConfirmDelete(null);
    if (!entry) return;
    try {
      const { rowsDeleted } = await deleteSource(entry.name);
      toast({
        title: `Deleted ${entry.display_name || entry.name}`,
        description: `${n(rowsDeleted)} rows removed.`,
      });
    } catch (err) {
      toast({
        title: 'Could not delete source',
        description: sourceErrorMessage(err, 'Try again.'),
        variant: 'destructive',
      });
    }
  };

  const handleReimport = async () => {
    const entry = confirmReimport;
    setConfirmReimport(null);
    if (!entry) return;
    try {
      await reimportSource(entry.name);
      const result = useSourcesStore.getState().reimports[entry.name];
      if (result?.state === 'done') {
        toast({
          title: `Re-imported ${entry.display_name || entry.name}`,
          description: `${n(result.rowsStored)} rows.`,
        });
      } else if (result) {
        toast({
          title: `Re-import of ${entry.display_name || entry.name} ${result.state}`,
          description: result.error ?? '',
          variant: 'destructive',
        });
      }
      clearReimport(entry.name);
    } catch (err) {
      toast({
        title: 'Could not re-import',
        description: sourceErrorMessage(err, 'Try again.'),
        variant: 'destructive',
      });
    }
  };

  const openRename = (entry: SourceEntry) => {
    setRenaming(entry);
    setRenameValue(entry.display_name ?? '');
    setRenameError(null);
  };

  const handleRename = async () => {
    if (!renaming) return;
    setRenameBusy(true);
    try {
      const updated = await renameSource(renaming.name, renameValue.trim());
      setRenaming(null);
      toast({
        title: updated.display_name
          ? `Renamed to ${updated.display_name}`
          : `Cleared the display name of ${updated.name}`,
      });
    } catch (err) {
      setRenameError(sourceErrorMessage(err, 'Could not rename.'));
    } finally {
      setRenameBusy(false);
    }
  };

  const actionsBlocked = wizardImporting;
  const blockedReason = 'Wait for the import that is running in the wizard to finish.';

  const renderReimportRow = (r: ReimportInFlight) => (
    <div
      key={`reimport-${r.name}`}
      data-testid="source-reimporting"
      className="flex items-center gap-1.5 px-1 py-1.5"
      style={{ borderBottom: '1px solid var(--ls-border-subtle)' }}
    >
      <Loader2
        className="h-3 w-3 flex-shrink-0 animate-spin"
        style={{ color: 'var(--ls-accent)' }}
      />
      <span
        className="flex-1 truncate text-[12px]"
        style={{ ...mono, color: 'var(--ls-text)' }}
        title={r.name}
      >
        {r.name}
      </span>
      <span className="text-[10.5px]" style={{ ...mono, color: 'var(--ls-text-3)' }}>
        re-importing, {n(r.rowsStored)} rows
      </span>
    </div>
  );

  const renderEntry = (e: SourceEntry) => {
    const open = expanded === e.name;
    const reimporting = reimports[e.name]?.state === 'running' ? reimports[e.name] : null;
    const busy = deleting.has(e.name) || reimporting !== null;
    const label = e.display_name || e.name;
    const canReimport = Boolean(e.origin.path && e.import_options);
    return (
      <div
        key={e.name}
        data-testid="source-row"
        style={{ borderBottom: '1px solid var(--ls-border-subtle)' }}
      >
        <button
          type="button"
          onClick={() => setExpanded(open ? null : e.name)}
          aria-expanded={open}
          className="w-full flex items-center gap-1.5 px-1 py-1.5 text-left"
        >
          {reimporting ? (
            <Loader2
              data-testid="source-reimporting"
              className="h-3 w-3 flex-shrink-0 animate-spin"
              style={{ color: 'var(--ls-accent)' }}
            />
          ) : open ? (
            <ChevronDown className="h-3 w-3 flex-shrink-0" style={{ color: 'var(--ls-text-3)' }} />
          ) : (
            <ChevronRight className="h-3 w-3 flex-shrink-0" style={{ color: 'var(--ls-text-3)' }} />
          )}
          <span
            className="flex-1 truncate text-[12px]"
            style={{ ...mono, color: 'var(--ls-text)' }}
            title={label}
          >
            {label}
          </span>
          <span className="text-[10.5px]" style={{ ...mono, color: 'var(--ls-text-3)' }}>
            {reimporting
              ? `re-importing, ${n(reimporting.rowsStored)} rows`
              : deleting.has(e.name)
                ? 'deleting…'
                : `${n(e.rows)} rows`}
          </span>
        </button>
        {open && (
          <div
            className="pb-2 pl-4 pr-1 space-y-1 text-[11px]"
            style={{ color: 'var(--ls-text-2)' }}
          >
            {e.display_name && (
              <p>
                Stored as <code style={mono}>{e.name}</code>
              </p>
            )}
            <p>
              {e.days.length} {e.days.length === 1 ? 'day' : 'days'}, {daySpan(e)}
            </p>
            <p className="truncate" title={e.origin.path ?? originLabel(e)}>
              {originLabel(e)}
            </p>
            {e.pattern_name && (
              <p>
                Pattern <code style={mono}>{e.pattern_name}</code>
              </p>
            )}
            {lastImport(e) && <p>{lastImport(e)}</p>}
            <div className="flex items-center gap-1 pt-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => openRename(e)}
                disabled={busy}
              >
                Rename
              </Button>
              <TooltipProvider>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => setConfirmReimport(e)}
                        disabled={busy || actionsBlocked || !canReimport}
                      >
                        Re-import
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {(actionsBlocked || !canReimport) && (
                    <TooltipContent side="bottom" className="text-xs">
                      {actionsBlocked
                        ? blockedReason
                        : 'No file path to re-import from — this was uploaded from the browser.'}
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
              <TooltipProvider>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <span className="ml-auto">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ls-danger-btn h-6 px-2 text-[11px]"
                        onClick={() => setConfirmDelete(e)}
                        disabled={busy || actionsBlocked}
                      >
                        Delete
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {actionsBlocked && (
                    <TooltipContent side="bottom" className="text-xs">
                      {blockedReason}
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        )}
      </div>
    );
  };

  // Synthetic rows only for re-imports whose entry is not in the list.
  const inFlight = Object.values(reimports).filter(
    (r) => r.state === 'running' && !sources.some((e) => e.name === r.name)
  );
  const showEmpty = loaded && !isLoading && !error && sources.length === 0 && inFlight.length === 0;

  return (
    <div className="pt-1">
      <div
        className="flex items-center gap-1.5 pb-2 mb-2"
        style={{ borderBottom: '1px solid var(--ls-border-subtle)' }}
      >
        <Database className="h-3.5 w-3.5" style={{ color: 'var(--ls-text-2)' }} />
        <span
          className="flex-1 text-[12px] font-semibold tracking-tight"
          style={{ color: 'var(--ls-text)' }}
        >
          Sources
        </span>
        {isLoading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--ls-text-3)' }} />
        ) : (
          <button
            type="button"
            aria-label="Refresh sources"
            title="Refresh"
            className="rounded p-0.5"
            onClick={() => void fetchSources()}
          >
            <RefreshCw className="h-3 w-3" style={{ color: 'var(--ls-text-3)' }} />
          </button>
        )}
      </div>

      {error && (
        <p className="px-1 py-2 text-[11px]" style={{ color: 'var(--ls-err)' }}>
          {error}{' '}
          <button type="button" className="underline" onClick={() => void fetchSources()}>
            Try again
          </button>
        </p>
      )}

      {showEmpty && (
        <p className="px-1 py-4 text-[11px]" style={{ color: 'var(--ls-text-3)' }}>
          No sources yet.{' '}
          <Link to="/import" className="underline" style={{ color: 'var(--ls-accent-text)' }}>
            Import a log file
          </Link>{' '}
          to get started.
        </p>
      )}

      {inFlight.map(renderReimportRow)}
      {sources.map(renderEntry)}

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {confirmDelete?.display_name || confirmDelete?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete && (
                <>
                  Removes {n(confirmDelete.rows)} rows from {confirmDelete.days.length}{' '}
                  {confirmDelete.days.length === 1 ? 'day' : 'days'}.
                  {confirmDelete.origin.path && (
                    <>
                      {' '}
                      The file at <code style={mono}>{confirmDelete.origin.path}</code> is not
                      touched.
                    </>
                  )}{' '}
                  This can't be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="ls-danger-action text-white"
              onClick={() => void handleDelete()}
            >
              Delete source
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmReimport !== null}
        onOpenChange={(o) => !o && setConfirmReimport(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Re-import {confirmReimport?.display_name || confirmReimport?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmReimport && (
                <>
                  Deletes its {n(confirmReimport.rows)} rows, then imports{' '}
                  <code style={mono}>{confirmReimport.origin.path}</code> again
                  {confirmReimport.pattern_name && (
                    <>
                      {' '}
                      with the <code style={mono}>{confirmReimport.pattern_name}</code> pattern
                    </>
                  )}
                  . The rows are gone until the import finishes.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleReimport()}>Re-import</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {renaming?.name}</DialogTitle>
            <DialogDescription>
              Changes how this source is shown here. Searches by the old and new names both keep
              working; the stored name <code style={mono}>{renaming?.name}</code> stays the same.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Display name"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !renameBusy) void handleRename();
            }}
            placeholder="Display name (empty to clear)"
            autoFocus
          />
          {renameError && (
            <p className="text-[12px]" style={{ color: 'var(--ls-err)' }}>
              {renameError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)} disabled={renameBusy}>
              Cancel
            </Button>
            <Button onClick={() => void handleRename()} disabled={renameBusy}>
              {renameBusy ? 'Saving…' : 'Save name'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
