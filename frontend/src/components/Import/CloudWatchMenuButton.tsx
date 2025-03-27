import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Cloud } from 'lucide-react';
import CloudWatchImport from './CloudWatchImport';
import { cn } from '@/lib/utils';

interface CloudWatchMenuButtonProps {
  className?: string;
}

const CloudWatchMenuButton: React.FC<CloudWatchMenuButtonProps> = ({ className }) => {
  const [open, setOpen] = useState(false);

  const handleOpen = () => {
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  return (
    <>
      <Button 
        variant="ghost" 
        size="sm" 
        className={cn(className, "flex items-center text-sm")}
        onClick={handleOpen}
      >
        <div className="flex items-center gap-2">
          <Cloud className="h-4 w-4 text-blue-600" />
          <span>CloudWatch Import</span>
        </div>
      </Button>
      
      {open && <CloudWatchImport open={open} onClose={handleClose} />}
    </>
  );
};

export default CloudWatchMenuButton; 