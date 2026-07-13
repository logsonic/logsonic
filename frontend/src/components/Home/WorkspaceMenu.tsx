import { Bookmark, Copy, Loader2, Save, Star, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
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
          className="inline-flex h-6 max-w-[220px] items-center gap-1.5 rounded-[5px] border border-transparent px-2 text-xs font-medium transition-colors"
          style={{ color: dirty ? 'var(--ls-warn)' : 'var(--ls-text-2)' }}
          title={dirty ? `${triggerLabel} has unsaved changes` : triggerLabel}
        >
          <Bookmark size={13} />
          <span className="truncate">{triggerLabel}</span>
          {dirty && (
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--ls-warn)' }} />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="end">
        <div
          className="flex items-center justify-between px-3 py-2"
          style={{ borderBottom: '1px solid var(--ls-border)' }}
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold" style={{ color: 'var(--ls-text)' }}>
              {activeWorkspace?.name || 'Workspaces'}
            </div>
            {activeWorkspace && (
              <div
                className="text-[11px]"
                style={{ color: dirty ? 'var(--ls-warn)' : 'var(--ls-text-3)' }}
              >
                {dirty ? 'Unsaved changes' : 'Saved'}
              </div>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!activeWorkspace || !dirty || isLoading}
            onClick={handleUpdateActive}
            className="h-7 gap-1.5 px-2 text-xs"
          >
            {isLoading && activeWorkspace ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Update
          </Button>
        </div>

        <div className="space-y-2 p-3">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Workspace name"
              className="h-8 text-xs"
            />
            <Button
              type="button"
              size="sm"
              disabled={isLoading || !name.trim()}
              onClick={handleSaveNew}
              className="h-8 gap-1.5 px-2 text-xs"
            >
              {isLoading && !activeWorkspace ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </Button>
          </div>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description"
            className="min-h-[54px] resize-none text-xs"
          />
        </div>

        <Separator />

        <ScrollArea className="max-h-[280px]">
          <div className="p-2">
            {workspaces.length === 0 ? (
              <div className="px-2 py-5 text-center text-xs" style={{ color: 'var(--ls-text-3)' }}>
                No saved workspaces
              </div>
            ) : (
              <div className="space-y-1">
                {workspaces.map((workspace) => {
                  const selected = workspace.id === activeWorkspaceId;
                  return (
                    <div
                      key={workspace.id}
                      className="group grid grid-cols-[1fr_auto] items-center gap-2 rounded-md px-2 py-1.5"
                      style={{
                        background: selected ? 'var(--ls-accent-softer)' : 'transparent',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => handleLoad(workspace.id)}
                        className="min-w-0 text-left"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className="truncate text-xs font-medium"
                            style={{ color: selected ? 'var(--ls-accent-text)' : 'var(--ls-text)' }}
                          >
                            {workspace.name}
                          </span>
                          {workspace.favorite && (
                            <Star
                              className="h-3 w-3 fill-current"
                              style={{ color: 'var(--ls-warn)' }}
                            />
                          )}
                        </div>
                        <div className="truncate text-[11px]" style={{ color: 'var(--ls-text-3)' }}>
                          {workspace.query || 'No query'} · {(workspace.sources ?? []).length || 0}{' '}
                          sources
                        </div>
                      </button>

                      <div className="flex items-center gap-0.5">
                        <IconButton
                          title={workspace.favorite ? 'Unfavorite' : 'Favorite'}
                          onClick={() => handleFavorite(workspace.id)}
                        >
                          <Star
                            className={`h-3.5 w-3.5 ${workspace.favorite ? 'fill-current' : ''}`}
                          />
                        </IconButton>
                        <IconButton title="Duplicate" onClick={() => handleDuplicate(workspace.id)}>
                          <Copy className="h-3.5 w-3.5" />
                        </IconButton>
                        <IconButton
                          title="Delete"
                          onClick={() => handleDelete(workspace.id, workspace.name)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconButton>
                      </div>
                    </div>
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

const IconButton = ({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
    style={{ color: 'var(--ls-text-3)' }}
    onMouseEnter={(event) => {
      event.currentTarget.style.background = 'var(--ls-bg-2)';
      event.currentTarget.style.color = 'var(--ls-text)';
    }}
    onMouseLeave={(event) => {
      event.currentTarget.style.background = 'transparent';
      event.currentTarget.style.color = 'var(--ls-text-3)';
    }}
  >
    {children}
  </button>
);
