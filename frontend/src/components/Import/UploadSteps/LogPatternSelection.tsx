import type { LogPatternSelectionProps, Pattern } from '../types';
import { Label } from '../../../components/ui/label';
import { Loader2, Copy, PlayCircle, ChevronsUpDown, Check, Search } from 'lucide-react';
import { useImportStore } from '@/stores/useImportStore';
import { IngestSessionOptions } from './IngestSessionOptions';
import { Button } from '../../../components/ui/button';
import { useEffect, useState, FC, useRef } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';

export const LogPatternSelection: FC<LogPatternSelectionProps> = ({
  onPatternChange,

}) => {
  const {
    selectedPattern, 
    availablePatterns, 
    isTestingPattern, 
    testPattern, 
  } = useImportStore();
  
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Handle outside clicks to close dropdown
  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, []);

  const handlePatternSelect = (value: string) => {
    // Find the selected pattern from available patterns
    const patternFromAvailable = availablePatterns.find(p => p.name === value);
    
    if (patternFromAvailable) {
        // Make sure custom_patterns is included
        const patternWithCustomPatterns = {
            ...patternFromAvailable,
            custom_patterns: patternFromAvailable.custom_patterns || {}
        };
        onPatternChange(patternWithCustomPatterns);
        setOpen(false);
        setSearchQuery('');
    }
  };

  // Handlers for search input focus/blur
  const handleSearchFocus = () => {
    setOpen(true);
  };

  const handleSearchInputChange = (value: string) => {
    setSearchQuery(value);
    setOpen(true); // Always show dropdown when typing
  };

  // Get the currently selected pattern
  const currentPattern = availablePatterns.find(p => p.name === selectedPattern?.name);
  const { isCreateNewPatternSelected } = useImportStore();
 
  // Function to copy pattern to clipboard
  const copyPattern = () => {
    if (currentPattern?.pattern) {
      navigator.clipboard.writeText(currentPattern.pattern);
    }
  };

  return (
    <div className="space-y-4">
      
      
      <div>
       <h2 className="text-md font-medium text-gray-600 mb-2">Select a decoding pattern</h2>
        {availablePatterns.length === 0 ? (
          <div className="flex items-center space-x-2 py-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-sm text-gray-500">Loading available patterns...</span>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <div className="w-full">
                <div className="relative" ref={searchContainerRef}>
                  <div 
                    className="flex items-center border-2 border-gray-600 rounded-md h-12 px-3 justify-between bg-white cursor-pointer"
                    onClick={() => {
                      setOpen(!open);
                      if (!open) {
                        setTimeout(() => {
                          const input = searchContainerRef.current?.querySelector('input');
                          if (input) input.focus();
                        }, 0);
                      }
                    }}
                  >
                    {selectedPattern ? (
                      <span className="truncate">
                        <b>{selectedPattern.name}</b>
                        {selectedPattern.description && `: ${selectedPattern.description}`}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Select a pattern</span>
                    )}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </div>
                  
                  {open && (
                    <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg shadow-md mt-1">
                      <Command className="rounded-lg">
                        <CommandInput 
                          placeholder="Search patterns by name or description..." 
                          className="h-10 border-none focus-visible:ring-0"
                          value={searchQuery}
                          onValueChange={handleSearchInputChange}
                          autoFocus
                        />
                        <CommandList className="p-1">
                          <CommandEmpty>No pattern found.</CommandEmpty>
                          <CommandGroup className="max-h-[300px] overflow-auto">
                            {availablePatterns
                              .filter(pattern => 
                                pattern.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                                (pattern.description && pattern.description.toLowerCase().includes(searchQuery.toLowerCase()))
                              )
                              .map((pattern) => (
                                <CommandItem
                                  key={pattern.name}
                                  value={pattern.name}
                                  onSelect={handlePatternSelect}
                                  className="flex items-center px-2 py-2 hover:bg-gray-100 cursor-pointer rounded"
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-4 w-4",
                                      selectedPattern?.name === pattern.name ? "opacity-100" : "opacity-0"
                                    )}
                                  />
                                  <span><b>{pattern.name}</b>{pattern.description ? ` : ${pattern.description}` : ''}</span>
                                </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </div>
                  )}
                </div>
              </div>

              { !isCreateNewPatternSelected &&(  
                 <Button 
                  onClick={testPattern}
                  disabled={!selectedPattern || isTestingPattern}
                  className="h-12 bg-primary text-white"
                  variant="outline"
              >
                {isTestingPattern ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <PlayCircle className="h-4 w-4 mr-2" />
                )}
                Test Pattern
              </Button>
              )}
            </div>


            {currentPattern?.pattern && !isCreateNewPatternSelected && (
              
              <div className="mt-3 p-3 bg-gray-10 rounded-md border border-gray-300 relative">
                <Label className="text-sm text-gray-500 mt-1">Pattern definition:</Label>
                <pre className="text-sm font-mono overflow-x-auto">
                  {currentPattern.pattern}
                </pre>

                <button 
                  onClick={copyPattern}
                  className="absolute top-2 right-2 p-1 rounded-md hover:bg-gray-200"
                  title="Copy pattern"
                >
                  <Copy className="h-4 w-4" />
                </button>
                {currentPattern.custom_patterns && (
                  <div className="mt-2">
                    {Object.entries(currentPattern.custom_patterns).length > 0 && (
                      <Label className="text-sm text-gray-500">Custom patterns:</Label>
                    )}
                    {Object.entries(currentPattern.custom_patterns).map(([key, value]) => (
                      <pre key={key} className="text-sm font-mono overflow-x-auto">
                        {key}: {value}
                      </pre>
                    ))}
                    
                  </div>
                )}
              </div>  
              
            )}
            <IngestSessionOptions />
            {!currentPattern?.pattern && (
              <span className="text-sm text-gray-500 mt-1">
                No pattern found.
              </span>
            )}
          </>
        )}
      </div>


    </div>
  );
};

export default LogPatternSelection; 