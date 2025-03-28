import { useState, useRef, useEffect, FC } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { extractFields } from '../utils/patternUtils';
import { Pattern } from '../types';
import { Loader2, X, Plus, AlertTriangle } from 'lucide-react';
import { useImportStore } from '@/stores/useImportStore';
import { SavePatternDialog } from './SavePatternDialog';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose
} from "@/components/ui/dialog";
import {
  DndContext,
  useSensor,
  useSensors,
  PointerSensor,
  KeyboardSensor,
  DragEndEvent,
} from '@dnd-kit/core';

  
// Common Grok patterns for reuse
const COMMON_GROK_PATTERNS = [
  { name: "TIMESTAMP", description: "Common timestamp formats", key: "timestamp" },
  { name: "TIMESTAMP_ISO8601", description: "ISO8601 timestamp", key: "timestamp" },
  { name: "DATE", description: "Date formats like yyyy-MM-dd", key: "date" },
  { name: "TIME", description: "Time formats like HH:mm:ss", key: "time" },
  { name: "LOGLEVEL", description: "Log levels (INFO, WARN, ERROR, etc)", key: "level" },
  { name: "NUMBER", description: "Any number", key: "number" },
  { name: "INT", description: "Integer number", key: "int" },
  { name: "POSINT", description: "Positive integer", key: "pid" },
  { name: "WORD", description: "Word characters [a-zA-Z0-9_]", key: "word" },
  { name: "NOTSPACE", description: "Any non-whitespace character", key: "data" },
  { name: "DATA", description: "Any data until the next field", key: "data" },
  { name: "GREEDYDATA", description: "Match everything to the end", key: "message" },
  { name: "QUOTEDSTRING", description: "Quoted string", key: "string" },
  { name: "UUID", description: "UUID format", key: "uuid" },
  { name: "IP", description: "IP address (v4 or v6)", key: "clientip" },
  { name: "HOSTNAME", description: "Hostname", key: "hostname" },
  { name: "HTTPDATE", description: "HTTP date format", key: "timestamp" },
  { name: "IPORHOST", description: "IP or hostname", key: "clientip" },
];

// Draggable token component
const DraggableToken: React.FC<{
  name: string;
  keyName: string;
  description: string;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDelete?: () => void;
  isCustom?: boolean;
  isSelected?: boolean;
  onClick?: () => void;
}> = ({ name, keyName, description, onDragStart, onDragEnd, onDelete, isCustom, isSelected, onClick }) => {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div 
            className={`inline-flex items-center px-4 py-1 mr-2 mb-2 text-xs font-mono rounded cursor-grab ${
              isSelected ? "bg-blue-500 text-white" : "bg-blue-100 text-blue-800"
            }`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', `%{${name}:${keyName}}`);
              e.dataTransfer.effectAllowed = 'copy';
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            onClick={() => onClick && onClick()}
          >
            {isSelected ? (
              <>
                <span className="mr-1.5">Token</span>
                {name}
                {isCustom && (
                  <button 
                    className="ml-2 text-white"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onDelete) onDelete();
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </>
            ) : (
              name
            )}
          </div>
        </TooltipTrigger>
        
        <TooltipContent side="top">
          <div className="space-y-1">
            <p className="font-semibold">{name}</p>
            <p className="text-xs font-mono">{description}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

interface CustomPatternSelectorProps {
  previewLines: string[];
  onPatternTest?: (pattern: Pattern) => void;
  showSaveDialog?: boolean;
  onSaveDialogClose?: () => void;
}

export const CustomPatternSelector: FC<CustomPatternSelectorProps> = ({
  previewLines,
  onPatternTest,
  showSaveDialog = false,
  onSaveDialogClose
}) => {
  const { 
    selectedPattern, 
    setSelectedPattern, 
    createNewPattern, 
    setCreateNewPattern, 
    createNewPatternTokens, 
    setCreateNewPatternTokens,
    createNewPatternName,
    setCreateNewPatternName,
    createNewPatternDescription,
    setCreateNewPatternDescription
  } = useImportStore();
  
  const [isTestingPattern, setIsTestingPattern] = useState<boolean>(false);
  const [localPattern, setLocalPattern] = useState(createNewPattern.pattern || '');
  const [newTokenName, setNewTokenName] = useState('');
  const [newTokenPattern, setNewTokenPattern] = useState('');
  const patternInputRef = useRef<HTMLTextAreaElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showAddToken, setShowAddToken] = useState(false);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);

  // Initialize local name and description states
  const [patternName, setPatternName] = useState(createNewPatternName || 'Custom Pattern');
  const [patternDescription, setPatternDescription] = useState(createNewPatternDescription || 'Create your own custom pattern for parsing logs');

  // Set up DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px movement before drag starts
      },
    }),
    useSensor(KeyboardSensor)
  );

  // Function to add a custom pattern token
  const addCustomPatternToken = () => {
    if (!newTokenName || !newTokenPattern || !selectedPattern) return;
    
    // Update the custom pattern tokens
    const updatedTokens = {
      ...createNewPatternTokens,
      [newTokenName]: newTokenPattern
    };
    
    // Also update the selectedPattern.custom_patterns
    const updatedPattern = {
      ...selectedPattern,
      custom_patterns: updatedTokens
    };
    
    setCreateNewPatternTokens(updatedTokens);
    setSelectedPattern(updatedPattern);
    
    // Clear input fields
    setNewTokenName('');
    setNewTokenPattern('');
    setShowAddToken(false);
  };

  // Function to delete a custom pattern token
  const deleteCustomPatternToken = (tokenName: string) => {
    if (!selectedPattern) return;
    
    const updatedTokens = { ...createNewPatternTokens };
    delete updatedTokens[tokenName];
    
    const updatedPattern = {
      ...selectedPattern,
      custom_patterns: updatedTokens
    };
    
    setCreateNewPatternTokens(updatedTokens);
    setSelectedPattern(updatedPattern);
  };

  // Function to insert a token at cursor position
  const insertTokenAtCursor = (token: string) => {
    if (!patternInputRef.current) return;
    
    const textarea = patternInputRef.current;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    
    const beforeText = localPattern.substring(0, start);
    const afterText = localPattern.substring(end);
    
    // Add a space before the token if there isn't one already and we're not at the start
    const needsSpace = start > 0 && !beforeText.endsWith(' ');
    const newPattern = beforeText + (needsSpace ? ' ' : '') + token + afterText;
    
    setLocalPattern(newPattern);
    setCreateNewPattern({
      ...createNewPattern,
      pattern: newPattern,
      fields: extractFields(newPattern),
      custom_patterns: createNewPatternTokens || {}
    });
    
    // Update the selected pattern
    if (selectedPattern) {
      const updatedPattern = {
        ...selectedPattern,
        pattern: newPattern,
        fields: extractFields(newPattern),
        custom_patterns: selectedPattern.custom_patterns || {}
      };
      setSelectedPattern(updatedPattern);
    }
    
    // Set cursor position after the inserted token
    setTimeout(() => {
      const newCursorPos = start + token.length + (needsSpace ? 1 : 0);
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  // Helper function to calculate caret position on drop
  const getCaretPositionOnDrop = (e: React.DragEvent, textarea: HTMLTextAreaElement): number => {
    const rect = textarea.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Create a temporary range to find the caret position
    const document = textarea.ownerDocument;
    const range = document.caretRangeFromPoint(x, y);
    
    if (range) {
      const selection = document.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
        return textarea.selectionStart || 0;
      }
    }
    
    return -1;
  };

  // Function to test the current pattern
  const testPattern = () => {
    if (!localPattern || !onPatternTest) return;
    
    setIsTestingPattern(true);
    
    // Create a pattern object to pass to handlePatternChange
    const patternToTest: Pattern = {
      name: patternName,
      pattern: localPattern,
      description: patternDescription,
      fields: extractFields(localPattern),
      custom_patterns: createNewPatternTokens || {}
    };
    
    setCreateNewPattern(patternToTest);
    onPatternTest(patternToTest);
    
    // Reset testing state after a short delay to show the loading indicator
    setTimeout(() => {
      setIsTestingPattern(false);
    }, 500);
  };

  const handleSaveDialogClose = () => {
    if (onSaveDialogClose) {
      onSaveDialogClose();
    }
  };

  const handlePatternNameChange = (name: string) => {
    setPatternName(name);
    setCreateNewPatternName(name);
  };

  const handlePatternDescriptionChange = (description: string) => {
    setPatternDescription(description);
    setCreateNewPatternDescription(description);
  };

  return (
    <div className="space-y-4">
      {/* Pattern Input */}
      <div className="mb-4">
        <Label htmlFor="custom-grok-pattern" className="text-sm font-medium mb-2 block">Provide custom Grok pattern</Label>
        <div className="flex">
          <Textarea
            id="custom-grok-pattern"
            ref={patternInputRef}
            value={localPattern}
            onChange={(e) => setLocalPattern(e.target.value)}
            placeholder="%{TIMESTAMP:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}"
            className="flex-1 font-mono text-sm min-h-[40px] border-gray-500 focus:border-solid focus:border-blue-500 transition-all"
            onDragOver={(e) => {
              e.preventDefault();
              e.currentTarget.classList.add('border-primary', 'bg-primary/5');
            }}
            onDragLeave={(e) => {
              e.currentTarget.classList.remove('border-primary', 'bg-primary/5');
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('border-primary', 'bg-primary/5');
              
              const token = e.dataTransfer.getData('text/plain');
              if (!token) return;
              
              // Calculate where to insert the token based on drop position
              if (patternInputRef.current) {
                const caretPosition = getCaretPositionOnDrop(e, patternInputRef.current);
                if (caretPosition !== -1) {
                  const beforeText = localPattern.substring(0, caretPosition);
                  const afterText = localPattern.substring(caretPosition);
                  
                  // Add a space before the token if there isn't one already and we're not at the start
                  const needsSpace = caretPosition > 0 && !beforeText.endsWith(' ');
                  const newPattern = beforeText + (needsSpace ? ' ' : '') + token + afterText;
                  
                  setLocalPattern(newPattern);
                  setCreateNewPattern({
                    ...createNewPattern,
                    pattern: newPattern,
                    fields: extractFields(newPattern),
                    custom_patterns: createNewPatternTokens || {}
                  });
                  
                  if (selectedPattern) {
                    const updatedPattern = {
                      ...selectedPattern,
                      pattern: newPattern,
                      fields: extractFields(newPattern),
                      custom_patterns: selectedPattern.custom_patterns || {}
                    };
                    setSelectedPattern(updatedPattern);
                  }
                }
              }
            }}
          />

        </div>
        <p className="text-sm font-medium text-gray-600 mb-1 mt-2">
        Use the commonly used tokens below by clicking or dragging them to the input field.
      </p>

      </div>
      
      {/* Tokens Section */}
      <div className="mb-2 flex flex-wrap">
        {COMMON_GROK_PATTERNS.map((pattern, index) => (
          <DraggableToken
            key={index}
            name={pattern.name}
            keyName={pattern.key}
            description={pattern.description}
            onDragStart={() => setIsDragging(true)}
            onDragEnd={() => setIsDragging(false)}
            isSelected={selectedToken === pattern.name}
            onClick={() => {
              if (selectedToken === pattern.name) {
                setSelectedToken(null);
              } else {
                setSelectedToken(pattern.name);
                insertTokenAtCursor(`%{${pattern.name}:${pattern.key}}`);
              }
            }}
          />
        ))}
        
        {/* Display any custom tokens */}
        {Object.entries(createNewPatternTokens || {}).length > 0 && (
          Object.entries(createNewPatternTokens || {}).map(([name, pattern]) => (
            <DraggableToken
              key={name}
              name={name}
              keyName={name.toLowerCase()}
              description={pattern}
              onDragStart={() => setIsDragging(true)}
              onDragEnd={() => setIsDragging(false)}
              onDelete={() => deleteCustomPatternToken(name)}
              isCustom
              isSelected={selectedToken === name}
              onClick={() => {
                if (selectedToken === name) {
                  setSelectedToken(null);
                } else {
                  setSelectedToken(name);
                  insertTokenAtCursor(`%{${name}:${name.toLowerCase()}}`);
                }
              }}
            />
          ))
        )}


          {/* Add Tokens Button with Dialog */}
      <Dialog open={showAddToken} onOpenChange={setShowAddToken}>
        <DialogTrigger asChild>
          <Button 
            variant="outline" 
            size="sm"
            className="text-sm h-6 flex bg-green-200 items-center gap-1"
          >
            <Plus className="h-4 w-4" /> Add Custom Token
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Custom Token</DialogTitle>
            <DialogDescription>
              Create a new custom token with a name and regex pattern.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="token-name" className="text-right">
                Token Name
              </Label>
              <Input
                id="token-name"
                placeholder="e.g., CUSTOM_DATE"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                className="col-span-3"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="token-pattern" className="text-right">
                Regex Pattern
              </Label>
              <Input
                id="token-pattern"
                placeholder="e.g., \d{4}-\d{2}-\d{2}"
                value={newTokenPattern}
                onChange={(e) => setNewTokenPattern(e.target.value)}
                className="col-span-3 font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button 
              onClick={addCustomPatternToken}
              disabled={!newTokenName || !newTokenPattern}
              className="bg-blue-600 hover:bg-blue-700"
            >
              Add Token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      </div>
      
      <div className="flex items-center gap-2">
      <Button 
            id="test-button"
            variant="default" 
            className="ml-2 h-auto bg-blue-600 hover:bg-blue-700"
            disabled={isTestingPattern || !localPattern.trim()}
            onClick={testPattern}
          >
            {isTestingPattern ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Testing...
              </>
            ) : (
              'Test Pattern'
            )}
          </Button>
        {/* Hint Message */}
        <div className="ml-4 flex items-center">
          <AlertTriangle className="h-4 w-4 text-amber-500 mr-1" />
          <p className="text-sm text-blue-600">
            Hint: You'll be able to save this custom pattern in the next step.
          </p>
        </div>
        </div>

      {/* Save Pattern Dialog */}
      <SavePatternDialog
        open={showSaveDialog}
        onClose={handleSaveDialogClose}
        patternName={patternName}
        patternDescription={patternDescription}
        patternContent={localPattern}
        customPatterns={createNewPatternTokens || {}}
        onPatternNameChange={handlePatternNameChange}
        onPatternDescriptionChange={handlePatternDescriptionChange}
      />
      
   
    </div>
  );
};

export default CustomPatternSelector; 