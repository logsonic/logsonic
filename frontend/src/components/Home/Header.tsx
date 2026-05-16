import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { useClearLogs } from '@/hooks/useApi';
import { getSystemInfo } from '@/lib/api-client';
import { formatBytes } from "@/lib/utils";
import { useLogResultStore } from '@/stores/useLogResultStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import { useThemeStore } from '@/stores/useThemeStore';
import { ExternalLink, HardDrive, Moon, Sun, Trash2 } from 'lucide-react';
import { useState } from 'react';
import SystemInfoModal from './SystemInfoModal';

/**
 * Application header component with navigation and action buttons using Radix navigation menu
 */
export const Header = () => {
  const { execute: clearLogs, isLoading } = useClearLogs();
  const { toast } = useToast();
  const [systemInfoOpen, setSystemInfoOpen] = useState(false);
  const { systemInfo, setSystemInfo } = useSystemInfoStore();
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const resetLogResults = useLogResultStore(state => state.reset);
  const resetSearchParams = useSearchQueryParamsStore(state => state.resetStore);

  // Handle clearing all logs. The dialog is dismissed up-front so the user
  // sees the toast/refresh against the empty index rather than staring at a
  // "Deleting…" modal until the backend round-trips finish.
  const handleClearLogs = async () => {
    setDeleteDialogOpen(false);
    try {
      await clearLogs();
      toast({
        title: "Logs cleared",
        description: "All logs have been successfully deleted.",
        variant: "default",
      });
      const data = await getSystemInfo(true);
      setSystemInfo(data);
      // Reset client state instead of reloading the page so the user keeps
      // their session, sidebar width, and color rules.
      resetLogResults();
      resetSearchParams();
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to clear logs: ${error.message}`,
        variant: "destructive",
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
    <div className="h-full">
      <div
        className="flex items-center justify-between h-full px-3"
      >
        {/* Page title / breadcrumbs */}
        <div
          className="flex items-center"
          style={{ gap: 6, fontSize: 13, fontWeight: 500, color: 'var(--ls-text)' }}
        >
          <span style={{ color: 'var(--ls-text-3)' }}>LogSonic</span>
          <span style={{ color: 'var(--ls-text-4)', margin: '0 6px' }}>/</span>
          <span>Search</span>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1.5">
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  style={{ color: 'var(--ls-text-2)' }}
                  onClick={toggleTheme}
                  aria-label="Toggle theme"
                >
                  {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                <p>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  style={{ color: 'var(--ls-text-2)' }}
                  onClick={() => window.open('https://logsonic.io', '_blank', 'noopener,noreferrer')}
                  aria-label="Visit logsonic.io"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                <p>Visit logsonic.io</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-7 px-2 flex items-center gap-1.5"
                  style={{ color: 'var(--ls-text-2)' }}
                  onClick={() => handleSystemInfoClick()}
                  aria-label="System Information"
                >
                  <HardDrive className="h-3.5 w-3.5" />
                  <span className="text-[11px] font-medium" style={{ fontFamily: 'var(--ls-font-mono)' }}>
                    {systemInfo ? formatBytes(systemInfo.storage_info.storage_size_bytes) : '…'}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                <p>System Information</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <AlertDialog open={deleteDialogOpen} onOpenChange={handleAlertOpenChange}>
            <TooltipProvider>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ls-danger-btn h-7 w-7"
                      style={{ color: 'var(--ls-text-2)' }}
                      aria-label="Clear logs"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </AlertDialogTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  <p>Clear All Logs</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear All Indexes</AlertDialogTitle>
                <AlertDialogDescription>
                  This action will permanently delete all logs from storage. This action cannot be undone.
                  
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
                  {isLoading ? "Deleting..." : "Delete All"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

        </div>
      </div>

      {/* System Info Modal */}
      <SystemInfoModal
        open={systemInfoOpen}
        onOpenChange={setSystemInfoOpen}
      />
    </div>
  );
}; 