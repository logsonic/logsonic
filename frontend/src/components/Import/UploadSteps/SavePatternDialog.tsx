import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/use-toast';
import { getGrokPatterns, saveGrokPattern } from '@/lib/api-client';
import { GrokPatternRequest } from '@/lib/api-types';
import { useImportStore } from '@/stores/useImportStore';
import { Save } from 'lucide-react';
import { FC, useEffect, useState } from 'react';
import StatusBanner from './StatusBanner';
interface SavePatternDialogProps {
  open: boolean;
  onClose: () => void;
}

export const SavePatternDialog: FC<SavePatternDialogProps> = ({
  open,
  onClose,
}) => {

  const { 
    selectedPattern,
    setSelectedPattern,
    
  } = useImportStore();
  const [isLoading, setIsLoading] = useState(false);
  const [existingPatterns, setExistingPatterns] = useState<GrokPatternRequest[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showErrorBanner, setShowErrorBanner] = useState(true);

  // Fetch existing patterns when dialog opens
  useEffect(() => {
    const fetchPatterns = async () => {
      if (open) {
        try {
          const response = await getGrokPatterns();
          if (response.status === 'success' && response.patterns) {
            setExistingPatterns(response.patterns);
          }
        } catch (error) {
          console.error('Failed to fetch patterns:', error);
        }
      }
    };

    fetchPatterns();
  }, [open]);

  // Validate pattern name when it changes
  useEffect(() => {
    if (selectedPattern && existingPatterns.length > 0) {
      const patternExists = existingPatterns.some(pattern => 
        pattern.name.toLowerCase() === selectedPattern.name.toLowerCase()
      );
      
      if (patternExists) {
        setValidationError(`Pattern name '${selectedPattern.name}' already exists`);
      } else {
        setValidationError(null);
      }
    } else {
      setValidationError(null);
    }
  }, [selectedPattern, existingPatterns]);

  const savePattern = async () => {
    if (!selectedPattern) return;
    
    // Check for existing pattern name
    const patternExists = existingPatterns.some(pattern => 
      pattern.name.toLowerCase() === selectedPattern.name.toLowerCase()
    );
    
    if (patternExists) {
      setValidationError(`Pattern name '${selectedPattern.name}' already exists`);
      setShowErrorBanner(true);
      return;
    }
    
    setIsLoading(true);
    
    const pattern: GrokPatternRequest = {
      name: selectedPattern.name,
      pattern: selectedPattern.pattern,
      description: selectedPattern.description,
      custom_patterns: selectedPattern.custom_patterns || {},
      priority: 0
    };

    try {
      const response = await saveGrokPattern(pattern);
      if (response.status === 'success') {  
          toast({
            title: 'Pattern saved',
            description: 'Pattern saved successfully',
            variant: 'default'
          });
          onClose();
      }
      else {
        setValidationError(response.error || 'Failed to save pattern');
        setShowErrorBanner(true);
      }
    } catch (error) {
      setValidationError('An unexpected error occurred');
      setShowErrorBanner(true);
    } finally {
      setIsLoading(false);
    }
  };

  // Function to skip saving and continue
  const skipSaveAndContinue = () => {
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save Custom Pattern</DialogTitle>
          <DialogDescription>
            Would you like to save this pattern for future use? This is optional.
          </DialogDescription>
        </DialogHeader>
        
        {validationError && showErrorBanner && (
          <StatusBanner
            type="error"
            title="Validation Error"
            message={validationError}
            onClose={() => setShowErrorBanner(false)}
          />
        )}
        
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="pattern-name" className="text-right">
              Pattern Name
            </Label>
            <Input
              id="pattern-name"
              value={selectedPattern?.name || ''}
              onChange={(e) => setSelectedPattern({ ...selectedPattern, name: e.target.value })}
              placeholder="My Custom Pattern"
              className={`col-span-3 ${validationError ? 'border-red-500' : ''}`}
            />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="pattern-desc" className="text-right">
              Description
            </Label>
            <Input
              id="pattern-desc"
              value={selectedPattern?.description || ''}
              onChange={(e) => setSelectedPattern({ ...selectedPattern, description: e.target.value })}
              placeholder="Used for parsing specific log format"  
              className="col-span-3"
            />
          </div>
        </div>
        <DialogFooter className="flex justify-between">
          <Button 
            variant="outline" 
            onClick={skipSaveAndContinue}
          >
            Skip & Continue
          </Button>
          <Button 
            onClick={savePattern}
            disabled={!selectedPattern?.name.trim() || isLoading || !!validationError}
            className="bg-green-600 hover:bg-green-700"
          >
            {isLoading ? (
              <>
                <span className="animate-spin mr-2">⌛</span> Saving...
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" /> Save Pattern
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SavePatternDialog; 