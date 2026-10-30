import {
  Bot,
  ExternalLink,
  HardDrive,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  Sparkles,
  Sun,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import SystemInfoModal from './SystemInfoModal';

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useClearLogs } from '@/hooks/useApi';
import { getSystemInfo } from '@/lib/api-client';
import { isNativeShell } from '@/lib/native';
import { formatBytes } from '@/lib/utils';
import { useLogResultStore } from '@/stores/useLogResultStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import { useThemeStore } from '@/stores/useThemeStore';

// Mirrors SidebarTabId in SidebarPanel.tsx (kept local: this file's import
// block predates the import/order rule and any new import here fails lint).
type ActiveSection = 'filter' | 'fields' | 'sources' | 'styling' | null;

interface HeaderProps {
  activeSection?: ActiveSection;
  /** Whether the agent dock is open; the toggle is hidden when no handler is given. */
  agentOpen?: boolean;
  onToggleAgent?: () => void;
}

const SECTION_LABEL: Record<Exclude<ActiveSection, null>, string> = {
  filter: 'Filter',
  fields: 'Fields',
  sources: 'Sources',
  styling: 'Coloring',
};

/**
 * Application header component with navigation and action buttons using Radix navigation menu
 */
export const Header = ({
  activeSection = null,
  agentOpen = false,
  onToggleAgent,
}: HeaderProps = {}) => {
  const { execute: clearLogs, isLoading } = useClearLogs();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [systemInfoOpen, setSystemInfoOpen] = useState(false);
  const { systemInfo, setSystemInfo } = useSystemInfoStore();
  const theme = useThemeStore((s) => s.theme);
  const effectiveTheme = useThemeStore((s) => s.effectiveTheme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const cycleTheme = useThemeStore((s) => s.cycleTheme);
  const native = isNativeShell();
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const resetLogResults = useLogResultStore((state) => state.reset);
  const resetSearchParams = useSearchQueryParamsStore((state) => state.resetStore);

  // Handle clearing all logs. The dialog is dismissed up-front so the user
  // sees the toast/refresh against the empty index rather than staring at a
  // "Deleting…" modal until the backend round-trips finish.
  const handleClearLogs = async () => {
    setDeleteDialogOpen(false);
    try {
      await clearLogs();
      toast({
        title: 'Logs cleared',
        description: 'All logs have been successfully deleted.',
        variant: 'default',
      });
      const data = await getSystemInfo(true);
      setSystemInfo(data);
      // Reset client state instead of reloading the page so the user keeps
      // their session, sidebar width, and color rules.
      resetLogResults();
      resetSearchParams();
    } catch (error) {
      toast({
        title: 'Error',
        description: `Failed to clear logs: ${error.message}`,
        variant: 'destructive',
      });
    }
  };

  const handleSystemInfoClick = () => {
    setSystemInfoOpen(true);
  };

  // Reset delete confirmation whenever alert dialog is closed
  const handleAlertOpenChange = (open: boolean) => {
    setDeleteDialogOpen(open);
    if (!open) {
      setDeleteConfirmation('');
    }
  };

  return (
    <div className="ls-app-header">
      <div className="ls-header-identity">
        <span className="ls-header-brand">LogSonic</span>
        <span className="ls-header-divider" />
        <span className="ls-header-location">
          {activeSection ? SECTION_LABEL[activeSection] : 'Log explorer'}
        </span>
      </div>
      <div className="ls-header-actions">
        <span className="ls-workspace-location">
          <HardDrive size={13} /> Local workspace
        </span>
        <button type="button" className="ls-header-button" onClick={() => navigate('/import')}>
          <Plus size={14} /> Import
        </button>
        {onToggleAgent && (
          <button
            type="button"
            className="ls-header-button ls-header-agent"
            aria-pressed={agentOpen}
            onClick={onToggleAgent}
            title="Toggle the agent panel (⌘J)"
          >
            <Sparkles size={14} /> Agent
            <kbd aria-hidden="true">⌘J</kbd>
          </button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ls-header-icon"
          onClick={native ? cycleTheme : toggleTheme}
          aria-label={native ? 'Cycle theme (auto / light / dark)' : 'Toggle theme'}
        >
          {effectiveTheme === 'dark' ? (
            <Sun size={15} />
          ) : theme === 'auto' && native ? (
            <Monitor size={15} />
          ) : (
            <Moon size={15} />
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="ls-header-icon"
              aria-label="Workspace options"
            >
              <MoreHorizontal size={18} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem onSelect={handleSystemInfoClick}>
              <HardDrive size={14} className="mr-2" /> Storage & system{' '}
              <span className="ml-auto pl-4 text-xs opacity-60">
                {systemInfo ? formatBytes(systemInfo.storage_info.storage_size_bytes) : ''}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate('/settings/mcp')}>
              <Bot size={14} className="mr-2" /> MCP integration
            </DropdownMenuItem>
            {!native && (
              <DropdownMenuItem
                onSelect={() => window.open('https://logsonic.io', '_blank', 'noopener,noreferrer')}
              >
                <ExternalLink size={14} className="mr-2" /> LogSonic website
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setDeleteDialogOpen(true)}
              className="text-destructive"
            >
              <Trash2 size={14} className="mr-2" /> Clear logs…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AlertDialog open={deleteDialogOpen} onOpenChange={handleAlertOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear All Indexes</AlertDialogTitle>
            <AlertDialogDescription>
              This action will permanently delete all logs from storage. This action cannot be
              undone.
              <div className="mt-4">
                <div className="mb-2 text-sm font-medium">Type "delete" to confirm:</div>
                <Input
                  type="text"
                  value={deleteConfirmation}
                  onChange={(e) => setDeleteConfirmation(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && deleteConfirmation === 'delete' && !isLoading) {
                      handleClearLogs();
                    }
                  }}
                  placeholder="delete"
                  className="mb-2"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="ls-danger-action text-white"
              onClick={handleClearLogs}
              disabled={isLoading || deleteConfirmation !== 'delete'}
            >
              {isLoading ? 'Deleting...' : 'Delete All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SystemInfoModal open={systemInfoOpen} onOpenChange={setSystemInfoOpen} />
    </div>
  );
};
