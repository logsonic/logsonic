import { Link } from 'react-router-dom';
import { Info, Trash2, Upload, Regex, BarChart, Settings, Database, PieChart, HardDrive, Sparkles, Bell, Cloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
} from "@/components/ui/navigation-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { cn } from "@/lib/utils";
import { useClearLogs } from '@/hooks/useApi';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect } from 'react';
import SystemInfoModal from './SystemInfoModal';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import { formatBytes } from '@/lib/utils';
import { Pie } from 'recharts';
import { useBackendStatus } from '@/hooks/useBackendStatus';
import { getSystemInfo } from '@/lib/api-client';

// Custom navigation menu trigger style with blue hover effect
const blueNavigationMenuTriggerStyle = cn(
  navigationMenuTriggerStyle(),
  "hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 data-[active]:bg-blue-100 data-[state=open]:bg-blue-100"
);

// Move the navigation menu list content to its own variable for readability
const NavigationMenuItems = () => (
  <NavigationMenuList className="space-x-2">
    {/* Import Logs */}
    <NavigationMenuItem>
      <NavigationMenuLink asChild>
        <Link 
          to="/import" 
          className={blueNavigationMenuTriggerStyle}
        >
          <div className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-blue-600" />
            <span>Import Logs</span>
          </div>
        </Link>
      </NavigationMenuLink>
    </NavigationMenuItem>
  </NavigationMenuList>
);

/**
 * Application header component with navigation and action buttons using Radix navigation menu
 */
export const Header = () => {
  const { execute: clearLogs, isLoading } = useClearLogs();
  const { toast } = useToast();
  const [systemInfoOpen, setSystemInfoOpen] = useState(false);
  const { systemInfo, setSystemInfo } = useSystemInfoStore();
  const { isConnected } = useBackendStatus(5000); // Check every 5 seconds
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  
  // Handle clearing all logs
  const handleClearLogs = async () => {
    try {
      await clearLogs();
      toast({
        title: "Logs cleared",
        description: "All logs have been successfully deleted.",
        variant: "default",
      });
      const data = await getSystemInfo(true);
      setSystemInfo(data);
      window.location.reload();
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
    if (!open) {
      setDeleteConfirmation('');
    }
  };

  return (
    <div className="bg-white shadow-sm">
      <div className="flex h-14 items-center justify-between px-4">
        {/* Logo and Navigation */}
        <div className="flex items-center gap-4">
          <img src="/logo.png" alt="Logo" className="h-8 w-auto" />
          

          <NavigationMenu>
            <NavigationMenuItems />
          </NavigationMenu>
        </div>
        
        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {/* Status LED */}
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <div 
                  className={`w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'} transition-colors duration-200`} 
                  aria-label="Backend status"
                />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                <p>{isConnected ? 'Backend connected' : 'Backend disconnected'}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="text-slate-600 hover:text-blue-700 hover:bg-blue-50"
                  onClick={() => window.open('https://logsonic.io', '_blank')}
                >
                  <Bell className="h-4 w-4" />
                </Button> 
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                <p>Check for updates</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button 
                  variant="ghost" 
                  className="text-slate-600 hover:text-blue-700 hover:bg-blue-50 flex items-center gap-1.5"
                  onClick={() => handleSystemInfoClick()}
                  aria-label="System Information"
                >
                  <HardDrive className="h-4 w-4" />
                  <span className="text-xs font-medium">
                    {systemInfo ? formatBytes(systemInfo.storage_info.storage_size_bytes) : 'Loading...'}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                <p>System Information</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>


          
          <AlertDialog onOpenChange={handleAlertOpenChange}>
            <TooltipProvider>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <AlertDialogTrigger asChild>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="text-slate-600 hover:text-red-600 hover:bg-red-50"
                      aria-label="Clear logs"
                    >
                      <Trash2 className="h-6 w-6" />
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
                <AlertDialogCancel className="border-slate-200 text-slate-700">Cancel</AlertDialogCancel>
                <AlertDialogAction 
                  className="bg-red-600 hover:bg-red-700 text-white" 
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