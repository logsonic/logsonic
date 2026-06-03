import { Download, Loader2, Pencil, Plus, Save, Search, Trash2, Upload, X } from 'lucide-react';
import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { SettingsLayout } from './SettingsLayout';

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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import {
  deleteGrokPattern,
  getGrokPatterns,
  saveGrokPattern,
  updateGrokPattern,
} from '@/lib/api-client';
import { GrokPatternRequest } from '@/lib/api-types';
import { buildPatternsExport, parsePatternsImport } from '@/lib/patternExport';

type CustomPatternRow = { key: string; value: string };

// Editable working copy of a pattern. custom_patterns is flattened to rows
// so the user can add / rename / remove keys, then folded back on save.
type PatternDraft = {
  name: string;
  description: string;
  pattern: string;
  priority: number;
  customRows: CustomPatternRow[];
};

const emptyDraft = (): PatternDraft => ({
  name: '',
  description: '',
  pattern: '',
  priority: 0,
  customRows: [],
});

const toDraft = (p: GrokPatternRequest): PatternDraft => ({
  name: p.name,
  description: p.description || '',
  pattern: p.pattern || '',
  priority: p.priority || 0,
  customRows: Object.entries(p.custom_patterns || {}).map(([key, value]) => ({ key, value })),
});

const CustomPatterns: FC = () => {
  const { toast } = useToast();
  const navigate = useNavigate();

  const [patterns, setPatterns] = useState<GrokPatternRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  // Edit/create dialog state. `isCreate` switches the dialog between editing
  // an existing pattern (name locked) and creating a new one (name editable).
  const [draft, setDraft] = useState<PatternDraft | null>(null);
  const [isCreate, setIsCreate] = useState(false);
  const [saving, setSaving] = useState(false);

  // Delete confirmation state
  const [pendingDelete, setPendingDelete] = useState<GrokPatternRequest | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Import (file upload) state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const loadPatterns = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getGrokPatterns();
      if (res.status === 'success' && res.patterns) {
        // Highest priority first, then alphabetical for a stable order.
        const sorted = [...res.patterns].sort(
          (a, b) => (b.priority || 0) - (a.priority || 0) || a.name.localeCompare(b.name)
        );
        setPatterns(sorted);
      } else {
        setLoadError(res.error || 'Failed to load patterns');
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load patterns');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPatterns();
  }, [loadPatterns]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return patterns;
    return patterns.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.pattern || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
    );
  }, [patterns, filter]);

  const openCreate = () => {
    setIsCreate(true);
    setDraft(emptyDraft());
  };

  const openEdit = (p: GrokPatternRequest) => {
    setIsCreate(false);
    setDraft(toDraft(p));
  };

  const handleSave = async () => {
    if (!draft) return;

    const name = draft.name.trim();
    if (isCreate && !name) {
      toast({
        title: 'Name required',
        description: 'Give the pattern a unique name.',
        variant: 'destructive',
      });
      return;
    }
    if (isCreate && patterns.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      toast({
        title: 'Name already exists',
        description: `A pattern named "${name}" already exists.`,
        variant: 'destructive',
      });
      return;
    }
    if (!draft.pattern.trim()) {
      toast({
        title: 'Pattern required',
        description: 'The pattern body cannot be empty.',
        variant: 'destructive',
      });
      return;
    }

    // Fold the custom-pattern rows back into a Record, skipping blank keys.
    const customPatterns: Record<string, string> = {};
    for (const row of draft.customRows) {
      const key = row.key.trim();
      if (key) customPatterns[key] = row.value;
    }

    const original = patterns.find((p) => p.name === draft.name);

    const request: GrokPatternRequest = {
      name,
      description: draft.description,
      pattern: draft.pattern,
      priority: draft.priority,
      custom_patterns: customPatterns,
      // Preserve the saved timestamp config on edit — this page doesn't edit it.
      timestamp_config: original?.timestamp_config,
    };

    setSaving(true);
    try {
      const res = isCreate ? await saveGrokPattern(request) : await updateGrokPattern(request);
      if (res.status === 'success') {
        toast({
          title: isCreate ? 'Pattern created' : 'Pattern updated',
          description: `"${name}" has been saved.`,
        });
        setDraft(null);
        await loadPatterns();
      } else {
        toast({
          title: isCreate ? 'Create failed' : 'Update failed',
          description: res.error || 'Could not save the pattern.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({
        title: isCreate ? 'Create failed' : 'Update failed',
        description: err instanceof Error ? err.message : 'Could not save the pattern.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const res = await deleteGrokPattern(pendingDelete.name);
      if (res.status === 'success') {
        toast({
          title: 'Pattern deleted',
          description: `"${pendingDelete.name}" has been removed.`,
        });
        setPendingDelete(null);
        await loadPatterns();
      } else {
        toast({
          title: 'Delete failed',
          description: res.error || 'Could not delete the pattern.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof Error ? err.message : 'Could not delete the pattern.',
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleExport = () => {
    if (patterns.length === 0) return;
    const envelope = buildPatternsExport(patterns);
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logsonic-patterns-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast({
      title: 'Patterns exported',
      description: `${patterns.length} pattern${patterns.length === 1 ? '' : 's'} written to JSON.`,
    });
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so selecting the same file again re-triggers onChange.
    e.target.value = '';
    if (!file) return;

    setImporting(true);
    try {
      const { patterns: incoming, warnings } = parsePatternsImport(await file.text());

      // Upsert: existing names are updated (PUT), new ones created (POST).
      const existing = new Set(patterns.map((p) => p.name.toLowerCase()));
      let created = 0;
      let updated = 0;
      let failed = 0;

      for (const p of incoming) {
        const key = p.name.toLowerCase();
        const isUpdate = existing.has(key);
        try {
          const res = isUpdate ? await updateGrokPattern(p) : await saveGrokPattern(p);
          if (res.status === 'success') {
            if (isUpdate) {
              updated++;
            } else {
              created++;
              existing.add(key);
            }
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }

      await loadPatterns();

      const parts: string[] = [];
      if (created) parts.push(`${created} added`);
      if (updated) parts.push(`${updated} updated`);
      if (failed) parts.push(`${failed} failed`);
      toast({
        title: failed ? 'Import finished with errors' : 'Import complete',
        description: parts.join(', ') || 'Nothing to import.',
        variant: failed ? 'destructive' : 'default',
      });
      if (warnings.length) {
        warnings.forEach((w) => console.warn('[pattern import]', w));
        toast({
          title: `${warnings.length} import note${warnings.length === 1 ? '' : 's'}`,
          description: warnings.slice(0, 3).join(' '),
        });
      }
    } catch (err) {
      toast({
        title: 'Import failed',
        description: err instanceof Error ? err.message : 'Could not read the file.',
        variant: 'destructive',
      });
    } finally {
      setImporting(false);
    }
  };

  const updateRow = (idx: number, field: keyof CustomPatternRow, value: string) => {
    setDraft((d) =>
      d
        ? {
            ...d,
            customRows: d.customRows.map((r, i) => (i === idx ? { ...r, [field]: value } : r)),
          }
        : d
    );
  };

  return (
    <SettingsLayout>
      {/* Section heading (design .settings-section) */}
      <div style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--ls-text)' }}>
          Custom patterns
        </h2>
        <p style={{ margin: '4px 0 14px', fontSize: 12.5, color: 'var(--ls-text-2)' }}>
          LogSonic uses Grok patterns to extract structured fields from raw log lines at import
          time. The best-matching pattern wins. Edit, remove, or add patterns below.
        </p>
      </div>

      {/* Toolbar: filter + import / export / add */}
      <div className="flex items-center" style={{ gap: 6, marginBottom: 12 }}>
        <div className="ls-set-search">
          <Search size={12} style={{ color: 'var(--ls-text-3)', flexShrink: 0 }} />
          <input
            placeholder="Filter patterns…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <X
              size={13}
              style={{ color: 'var(--ls-text-3)', cursor: 'pointer', flexShrink: 0 }}
              onClick={() => setFilter('')}
            />
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={onImportFile}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          title="Import patterns from a JSON file"
        >
          {importing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          Import
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleExport}
          disabled={patterns.length === 0}
          title="Export all patterns to a JSON file"
        >
          <Download className="h-3.5 w-3.5" /> Export
        </Button>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-3.5 w-3.5" /> Add pattern
        </Button>
      </div>

      {/* Content */}
      {loading ? (
        <div
          className="flex items-center justify-center"
          style={{ gap: 8, padding: '48px 0', color: 'var(--ls-text-3)', fontSize: 13 }}
        >
          <Loader2 size={16} className="animate-spin" /> Loading patterns…
        </div>
      ) : loadError ? (
        <div
          style={{
            padding: '14px 16px',
            borderRadius: 8,
            background: 'var(--ls-err-soft)',
            border: '1px solid color-mix(in srgb, var(--ls-err) 25%, transparent)',
            color: 'var(--ls-err)',
            fontSize: 13,
          }}
        >
          {loadError}
          <div style={{ marginTop: 10 }}>
            <Button variant="outline" size="sm" onClick={loadPatterns}>
              Retry
            </Button>
          </div>
        </div>
      ) : patterns.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center text-center"
          style={{
            padding: '56px 24px',
            borderRadius: 'var(--ls-radius-lg)',
            background: 'var(--ls-panel)',
            border: '1px dashed var(--ls-border)',
            color: 'var(--ls-text-3)',
          }}
        >
          <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--ls-text-2)' }}>
            No saved patterns yet
          </p>
          <p style={{ fontSize: 12.5, marginTop: 4, maxWidth: 380 }}>
            Add one here, or save a custom pattern while importing logs.
          </p>
          <div className="flex" style={{ gap: 8, marginTop: 16 }}>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" /> Add pattern
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/import')}>
              Go to Import
            </Button>
          </div>
        </div>
      ) : (
        <table className="ls-dtable">
          <thead>
            <tr>
              <th>Name</th>
              <th>Grok expression</th>
              <th style={{ width: 110 }}>Primitives</th>
              <th style={{ width: 80, textAlign: 'right' }}>Priority</th>
              <th style={{ width: 80 }} />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: '24px' }}>
                  No patterns match “{filter}”.
                </td>
              </tr>
            ) : (
              filtered.map((p) => {
                const primCount = p.custom_patterns ? Object.keys(p.custom_patterns).length : 0;
                return (
                  <tr key={p.name}>
                    <td style={{ fontWeight: 500 }}>
                      {p.name}
                      {p.description && (
                        <div
                          style={{
                            fontWeight: 400,
                            fontSize: 11.5,
                            color: 'var(--ls-text-3)',
                            marginTop: 2,
                          }}
                        >
                          {p.description}
                        </div>
                      )}
                    </td>
                    <td
                      className="mono muted"
                      style={{
                        maxWidth: 360,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={p.pattern}
                    >
                      {p.pattern}
                    </td>
                    <td className="muted">
                      {primCount > 0 ? `${primCount} primitive${primCount === 1 ? '' : 's'}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="ls-chip ls-chip-neutral ls-chip-mono">
                        {p.priority || 0}
                      </span>
                    </td>
                    <td>
                      <div
                        className="flex items-center"
                        style={{ gap: 2, justifyContent: 'flex-end' }}
                      >
                        <button
                          type="button"
                          className="ls-icon-btn"
                          aria-label={`Edit ${p.name}`}
                          title="Edit"
                          onClick={() => openEdit(p)}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="ls-icon-btn danger"
                          aria-label={`Delete ${p.name}`}
                          title="Delete"
                          onClick={() => setPendingDelete(p)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      )}

      {/* Edit / create dialog */}
      <Dialog open={!!draft} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isCreate ? 'Add pattern' : 'Edit pattern'}</DialogTitle>
            <DialogDescription>
              {isCreate
                ? 'Create a new Grok pattern. The name must be unique.'
                : "Update the Grok pattern. The name is the identifier and can't be changed."}
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="grid gap-4 py-2">
              <div className="grid gap-1.5">
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={draft.name}
                  disabled={!isCreate}
                  placeholder="my-custom-pattern"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="edit-desc">Description</Label>
                <Input
                  id="edit-desc"
                  value={draft.description}
                  placeholder="Used for parsing a specific log format"
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="edit-pattern">Grok expression</Label>
                <Textarea
                  id="edit-pattern"
                  value={draft.pattern}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder="%{IP:client} %{WORD:method} %{NUMBER:status}"
                  onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="edit-priority">Priority</Label>
                <Input
                  id="edit-priority"
                  type="number"
                  value={draft.priority}
                  className="w-28"
                  onChange={(e) =>
                    setDraft({ ...draft, priority: Number.parseInt(e.target.value, 10) || 0 })
                  }
                />
              </div>

              <div className="grid gap-1.5">
                <Label>Custom primitives</Label>
                <div className="flex flex-col gap-2">
                  {draft.customRows.length === 0 && (
                    <p className="text-xs text-muted-foreground">None defined.</p>
                  )}
                  {draft.customRows.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        value={row.key}
                        placeholder="NAME"
                        className="font-mono text-xs"
                        style={{ flex: '0 0 35%' }}
                        onChange={(e) => updateRow(idx, 'key', e.target.value)}
                      />
                      <Input
                        value={row.value}
                        placeholder="regex definition"
                        className="font-mono text-xs"
                        onChange={(e) => updateRow(idx, 'value', e.target.value)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove primitive"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            customRows: draft.customRows.filter((_, i) => i !== idx),
                          })
                        }
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          customRows: [...draft.customRows, { key: '', value: '' }],
                        })
                      }
                    >
                      <Plus className="h-3.5 w-3.5" /> Add primitive
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" /> {isCreate ? 'Create pattern' : 'Save changes'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete pattern?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove "{pendingDelete?.name}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog open while the request is in flight; we
                // close it ourselves on success.
                e.preventDefault();
                handleDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Deleting…
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsLayout>
  );
};

export default CustomPatterns;
