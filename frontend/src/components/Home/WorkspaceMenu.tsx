import { Check, Copy, LayoutDashboard, Loader2, Save, Search, Star, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { Workspace } from '@/lib/api-types';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { useColorRuleStore } from '@/stores/useColorRuleStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { isWorkspaceDirty, useWorkspaceStore } from '@/stores/useWorkspaceStore';

export const WorkspaceMenu = () => {
  const {
    workspaces,
    activeWorkspaceId,
    isLoading,
    error,
    refreshWorkspaces,
    saveCurrentWorkspace,
    updateActiveWorkspace,
    loadWorkspace,
    deleteWorkspace,
    duplicateWorkspace,
    toggleFavorite,
    clearError,
  } = useWorkspaceStore();
  const search = useSearchQueryParamsStore();
  const colorRules = useColorRuleStore((state) => state.colorRules);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState('');

  useEffect(() => {
    if (open) {
      refreshWorkspaces();
    }
  }, [open, refreshWorkspaces]);

  useEffect(() => {
    if (!error) return;
    toast({ title: 'Workspace error', description: error, variant: 'destructive' });
    clearError();
  }, [error, toast, clearError]);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId]
  );
  const dirty = isWorkspaceDirty(activeWorkspace, search, colorRules);
  const triggerLabel = activeWorkspace?.name || 'Workspace';
  const filteredWorkspaces = useMemo(() => {
    const filter = workspaceFilter.trim().toLowerCase();
    if (!filter) return workspaces;
    return workspaces.filter((workspace) => {
      const searchable = [
        workspace.name,
        workspace.description,
        workspace.query,
        ...(workspace.sources ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchable.includes(filter);
    });
  }, [workspaceFilter, workspaces]);

  const handleSaveNew = async () => {
    if (!name.trim()) {
      toast({ title: 'Name required', variant: 'destructive' });
      return;
    }
    try {
      const saved = await saveCurrentWorkspace(name, description);
      setName('');
      setDescription('');
      toast({ title: `Saved ${saved.name}` });
    } catch {
      // useWorkspaceStore surfaces the error toast via error state.
    }
  };

  const handleUpdateActive = async () => {
    if (!activeWorkspace) return;
    try {
      const saved = await updateActiveWorkspace();
      toast({ title: `Updated ${saved.name}` });
    } catch {
      // handled via error state
    }
  };

  const handleLoad = async (id?: string) => {
    if (!id) return;
    try {
      const workspace = await loadWorkspace(id);
      setOpen(false);
      toast({ title: `Loaded ${workspace.name}` });
    } catch {
      // handled via error state
    }
  };

  const handleDelete = async (id?: string, workspaceName?: string) => {
    if (!id) return;
    if (!window.confirm(`Delete "${workspaceName || 'workspace'}"?`)) return;
    try {
      await deleteWorkspace(id);
      toast({ title: 'Workspace deleted' });
    } catch {
      // handled via error state
    }
  };

  const handleDuplicate = async (id?: string) => {
    if (!id) return;
    try {
      const workspace = await duplicateWorkspace(id);
      toast({ title: `Duplicated ${workspace.name}` });
    } catch {
      // handled via error state
    }
  };

  const handleFavorite = async (id?: string) => {
    if (!id) return;
    try {
      await toggleFavorite(id);
    } catch {
      // handled via error state
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 max-w-[240px] items-center gap-1.5 rounded-[5px] border px-2 text-xs font-medium transition-colors"
          style={{
            background: open ? 'var(--ls-bg-2)' : 'transparent',
            borderColor: open ? 'var(--ls-border)' : 'transparent',
            color: dirty ? 'var(--ls-warn)' : 'var(--ls-text-2)',
          }}
          title={dirty ? `${triggerLabel} has unsaved changes` : triggerLabel}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = 'var(--ls-bg-2)';
            event.currentTarget.style.borderColor = 'var(--ls-border)';
            event.currentTarget.style.color = dirty ? 'var(--ls-warn)' : 'var(--ls-text)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = open ? 'var(--ls-bg-2)' : 'transparent';
            event.currentTarget.style.borderColor = open ? 'var(--ls-border)' : 'transparent';
            event.currentTarget.style.color = dirty ? 'var(--ls-warn)' : 'var(--ls-text-2)';
          }}
        >
          <LayoutDashboard className="h-3.5 w-3.5" />
          <span className="truncate">{triggerLabel}</span>
          {dirty && (
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--ls-warn)' }} />
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-[460px] overflow-hidden rounded-lg p-0"
        style={{
          background: 'var(--ls-panel)',
          borderColor: 'var(--ls-border)',
          boxShadow: 'var(--ls-shadow-lg)',
        }}
      >
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md"
              style={{
                background: 'var(--ls-accent-soft)',
                border: '1px solid var(--ls-accent-border)',
                color: 'var(--ls-accent)',
              }}
            >
              <LayoutDashboard className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold" style={{ color: 'var(--ls-text)' }}>
                {activeWorkspace?.name || 'Workspaces'}
              </div>
              <div
                className="mt-0.5 inline-flex h-5 items-center rounded px-1.5 text-[10px] font-semibold uppercase"
                style={{
                  background: activeWorkspace
                    ? dirty
                      ? 'var(--ls-warn-soft)'
                      : 'var(--ls-bg-2)'
                    : 'var(--ls-bg-2)',
                  border: `1px solid ${
                    dirty
                      ? 'color-mix(in srgb, var(--ls-warn) 28%, transparent)'
                      : 'var(--ls-border)'
                  }`,
                  color: activeWorkspace
                    ? dirty
                      ? 'var(--ls-warn)'
                      : 'var(--ls-text-3)'
                    : 'var(--ls-text-3)',
                }}
              >
                {activeWorkspace ? (dirty ? 'Unsaved' : 'Saved') : 'No active workspace'}
              </div>
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!activeWorkspace || !dirty || isLoading}
            onClick={handleUpdateActive}
            className="h-7 shrink-0 gap-1.5 px-2 text-xs"
            style={{
              background: 'var(--ls-bg-1)',
              borderColor: 'var(--ls-border)',
              color: 'var(--ls-text-2)',
            }}
          >
            {isLoading && activeWorkspace ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Update
          </Button>
        </div>

        <div
          className="space-y-2 px-3 py-3"
          style={{
            background: 'var(--ls-bg-1)',
            borderTop: '1px solid var(--ls-border)',
            borderBottom: '1px solid var(--ls-border)',
          }}
        >
          <div className="flex items-center justify-between">
            <span className="ls-meta-label">Save Current View</span>
            <span className="text-[11px]" style={{ color: 'var(--ls-text-3)' }}>
              {search.selectedColumns.length.toLocaleString()} columns
            </span>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Workspace name"
              className="h-8 text-xs"
              style={{
                background: 'var(--ls-panel)',
                borderColor: 'var(--ls-border-strong)',
                color: 'var(--ls-text)',
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={isLoading || !name.trim()}
              onClick={handleSaveNew}
              className="h-8 gap-1.5 px-2.5 text-xs text-white"
              style={{ background: 'var(--ls-accent)' }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--ls-accent-hover)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'var(--ls-accent)';
              }}
            >
              {isLoading && !activeWorkspace ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save as
            </Button>
          </div>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description"
            className="min-h-[56px] resize-none text-xs"
            style={{
              background: 'var(--ls-panel)',
              borderColor: 'var(--ls-border-strong)',
              color: 'var(--ls-text)',
            }}
          />
        </div>

        <div className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--ls-border)' }}>
          <div className="mb-2 flex items-center justify-between">
            <span className="ls-meta-label">Saved Workspaces</span>
            <span className="ls-chip ls-chip-neutral">{workspaces.length.toLocaleString()}</span>
          </div>
          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
              style={{ color: 'var(--ls-text-3)' }}
            />
            <Input
              value={workspaceFilter}
              onChange={(event) => setWorkspaceFilter(event.target.value)}
              placeholder="Filter workspaces"
              className="h-8 pl-8 text-xs"
              style={{
                background: 'var(--ls-bg-1)',
                borderColor: 'var(--ls-border)',
                color: 'var(--ls-text)',
              }}
            />
          </div>
        </div>

        <ScrollArea className="max-h-[310px]">
          <div className="p-2">
            {workspaces.length === 0 ? (
              <EmptyState>No saved workspaces</EmptyState>
            ) : filteredWorkspaces.length === 0 ? (
              <EmptyState>No matching workspaces</EmptyState>
            ) : (
              <div className="space-y-1">
                {filteredWorkspaces.map((workspace) => {
                  const selected = workspace.id === activeWorkspaceId;
                  return (
                    <WorkspaceRow
                      key={workspace.id}
                      workspace={workspace}
                      selected={selected}
                      onLoad={() => handleLoad(workspace.id)}
                      onFavorite={() => handleFavorite(workspace.id)}
                      onDuplicate={() => handleDuplicate(workspace.id)}
                      onDelete={() => handleDelete(workspace.id, workspace.name)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
};

const WorkspaceRow = ({
  workspace,
  selected,
  onLoad,
  onFavorite,
  onDuplicate,
  onDelete,
}: {
  workspace: Workspace;
  selected: boolean;
  onLoad: () => void;
  onFavorite: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) => {
  const queryLabel = workspace.query?.trim() || 'Empty query';
  const sourceCount = (workspace.sources ?? []).length;

  return (
    <div
      className="group grid grid-cols-[1fr_auto] items-center gap-2 rounded-md border px-2 py-2 transition-colors"
      style={{
        background: selected ? 'var(--ls-accent-softer)' : 'transparent',
        borderColor: selected ? 'var(--ls-accent-border)' : 'transparent',
        boxShadow: selected ? 'inset 2px 0 0 var(--ls-accent)' : 'none',
      }}
      onMouseEnter={(event) => {
        if (selected) return;
        event.currentTarget.style.background = 'var(--ls-bg-2)';
        event.currentTarget.style.borderColor = 'var(--ls-border)';
      }}
      onMouseLeave={(event) => {
        if (selected) return;
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.borderColor = 'transparent';
      }}
    >
      <button type="button" onClick={onLoad} className="min-w-0 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="grid h-6 w-6 shrink-0 place-items-center rounded"
            style={{
              background: selected ? 'var(--ls-accent-soft)' : 'var(--ls-bg-2)',
              border: `1px solid ${selected ? 'var(--ls-accent-border)' : 'var(--ls-border)'}`,
              color: selected ? 'var(--ls-accent)' : 'var(--ls-text-3)',
            }}
          >
            {selected ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <LayoutDashboard className="h-3.5 w-3.5" />
            )}
          </span>
          <span
            className="truncate text-xs font-semibold"
            style={{ color: selected ? 'var(--ls-accent-text)' : 'var(--ls-text)' }}
          >
            {workspace.name}
          </span>
          {workspace.favorite && (
            <Star className="h-3 w-3 shrink-0 fill-current" style={{ color: 'var(--ls-warn)' }} />
          )}
        </div>
        <div className="mt-1 truncate pl-8 text-[11px]" style={{ color: 'var(--ls-text-3)' }}>
          {workspace.description?.trim() || queryLabel}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-8">
          <span className="ls-chip ls-chip-neutral max-w-[210px] truncate">{queryLabel}</span>
          <span className="text-[11px]" style={{ color: 'var(--ls-text-4)' }}>
            {sourceCount.toLocaleString()} {sourceCount === 1 ? 'source' : 'sources'}
          </span>
        </div>
      </button>

      <div className="flex items-center gap-0.5">
        <IconButton title={workspace.favorite ? 'Unfavorite' : 'Favorite'} onClick={onFavorite}>
          <Star className={`h-3.5 w-3.5 ${workspace.favorite ? 'fill-current' : ''}`} />
        </IconButton>
        <IconButton title="Duplicate" onClick={onDuplicate}>
          <Copy className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton title="Delete" onClick={onDelete} tone="danger">
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  );
};

const EmptyState = ({ children }: { children: ReactNode }) => (
  <div className="px-2 py-8 text-center text-xs" style={{ color: 'var(--ls-text-3)' }}>
    {children}
  </div>
);

const IconButton = ({
  title,
  onClick,
  children,
  tone = 'default',
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  tone?: 'default' | 'danger';
}) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
    style={{ color: tone === 'danger' ? 'var(--ls-err)' : 'var(--ls-text-3)' }}
    onMouseEnter={(event) => {
      event.currentTarget.style.background =
        tone === 'danger' ? 'var(--ls-err-soft)' : 'var(--ls-bg-2)';
      event.currentTarget.style.color = tone === 'danger' ? 'var(--ls-err)' : 'var(--ls-text)';
    }}
    onMouseLeave={(event) => {
      event.currentTarget.style.background = 'transparent';
      event.currentTarget.style.color = tone === 'danger' ? 'var(--ls-err)' : 'var(--ls-text-3)';
    }}
  >
    {children}
  </button>
);

export default WorkspaceMenu;
