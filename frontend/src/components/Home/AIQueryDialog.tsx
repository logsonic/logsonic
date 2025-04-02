import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { translateQuery } from "@/services/aiService";
import { useSearchQueryParamsStore } from "@/stores/useSearchQueryParams";
import { AlertCircle, Check, Copy, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";

const EXAMPLE_QUERIES = [
  "all logs with error or warning",
  "api service",
  "pid more than 2000",
  "response time more than 1000ms",
  "'connection timeout' errors",
  "hostname is Quantcast and service is api",
  "message like '%error%'",
  
];

// Styled code example component, similar to QueryHelperPopover
function CodeExample({ content, confidence }: { content: string; confidence?: number }) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-gray-50 border border-gray-200 p-3 rounded-lg text-sm relative group hover:border-gray-300 transition-colors min-h-[120px]">
      <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button 
          variant="ghost" 
          size="icon" 
          className="h-6 w-6 bg-white hover:bg-gray-50 rounded-md shadow-sm border border-gray-200" 
          onClick={copyToClipboard}
          title="Copy to clipboard"
        >
          {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
        </Button>
      </div>
      {confidence !== undefined && (
        <div className="absolute left-3 top-3 text-xs text-gray-500">
          Confidence: {Math.round(confidence * 100)}%
        </div>
      )}
      <code className="text-gray-800 block mt-6 whitespace-pre-wrap">{content}</code>
    </div>
  );
}

interface AIQueryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AIQueryDialog({ open, onOpenChange }: AIQueryDialogProps) {
  const [inputQuery, setInputQuery] = useState("");
  const [translatedQuery, setTranslatedQuery] = useState("");
  const [confidence, setConfidence] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const store = useSearchQueryParamsStore();

  const handleExampleClick = useCallback((example: string) => {
    setInputQuery(example);
    setErrorMessage("");
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputQuery(e.target.value);
    setErrorMessage("");
  }, []);

  const handleTranslate = useCallback(async () => {
    if (!inputQuery.trim()) {
      setErrorMessage("Please enter a query to translate");
      return;
    }

    setIsLoading(true);
    setErrorMessage("");
    
    try {
      // Get the available columns from the store or use defaults
      const columns = store.availableColumns.length > 0 
        ? store.availableColumns 
        : ["timestamp", "message", "level", "service", "host"];

      const response = await translateQuery({
        columns,
        query: inputQuery,
      });

      setTranslatedQuery(response.query);
      setConfidence(response.confidence);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to translate query");
    } finally {
      setIsLoading(false);
    }
  }, [inputQuery, store.availableColumns]);

  // Handle Enter key press in the input field
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !isLoading && inputQuery.trim()) {
      e.preventDefault();
      handleTranslate();
    }
  }, [handleTranslate, inputQuery, isLoading]);

  const handleApplyQuery = useCallback(() => {
    if (translatedQuery) {
        store.resetPagination();
        // Apply the trimmed query
      store.setSearchQuery(translatedQuery.trim());
      // Close the dialog
      onOpenChange(false);
    }
  }, [translatedQuery, store, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[800px] p-0 border-0 shadow-2xl bg-white rounded-xl overflow-hidden">
        <div className="p-6 border-b bg-gradient-to-r from-blue-50 to-white">
          <div className="flex justify-between items-start">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-gray-900 flex items-center">
                <Sparkles className="h-5 w-5 mr-2 text-yellow-500" />
                AI Query Builder
              </h2>
              <p className="text-sm text-gray-600">
                Describe what you're looking for in plain English and we'll convert it to Logsonic search query.
              </p>
            </div>
          </div>
        </div>

        <div className="p-6">
          <div className="">
            <div>
              <label className="text-md font-medium leading-none mb-4 block text-gray-700">Example Queries</label>
              <div className="flex flex-wrap gap-2 mb-3">
                {EXAMPLE_QUERIES.map((example, i) => (
                  <button
                    key={i}
                    onClick={() => handleExampleClick(example)}
                    className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-sm font-medium text-blue-700 hover:bg-blue-100"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-md font-medium leading-none mb-1 block text-gray-700">Describe what you're looking for</label>
              <div className="flex gap-2">
                <Input
                  placeholder="Describe what you're looking for in plain English..."
                  value={inputQuery}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  className="h-12 border-gray-300 text-md flex-1"
                />
                <Button
                  onClick={handleTranslate}
                  disabled={isLoading || !inputQuery.trim()}
                  className="bg-blue-600 hover:bg-blue-700 text-white h-12"
                >
                  {isLoading ? "Translating..." : "Translate"}
                </Button>
              </div>

              {errorMessage && (
                <div className="flex items-center text-red-500 text-sm mt-1">
                  <AlertCircle className="h-4 w-4 mr-1 flex-shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              )}
            </div>

            {translatedQuery && (
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none m-4 block text-gray-700">
                  Translated Logsonic Query
                </label>
                <CodeExample content={translatedQuery} confidence={confidence} />
              </div>
            )}
          </div>
        </div>

        <div className="border-t p-4 bg-gray-50 flex justify-end space-x-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-gray-300"
          >
            Cancel
          </Button>
          <Button
            onClick={handleApplyQuery}
            disabled={!translatedQuery}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            Apply Query
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
} 