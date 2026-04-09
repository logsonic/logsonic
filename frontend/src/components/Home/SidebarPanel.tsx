import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useSearchQueryParamsStore } from "@/stores/useSearchQueryParams";
import { useSystemInfoStore } from "@/stores/useSystemInfoStore";
import { CheckSquare2, FilterX, Loader2, Palette, Square } from "lucide-react";
import { useEffect } from "react";
import { VerticalTab } from "./Sidebar/CollapsiblePanel";
import { ColorRulesPanel } from "./Sidebar/ColorRulesPanel";

export const SidebarPanel = () => {
  const { systemInfo, refreshSystemInfo, isLoading, error } = useSystemInfoStore();
  const { sources , setSources} = useSearchQueryParamsStore();

  const allSourceNames = systemInfo?.storage_info?.source_names || [];
  const allSelected = allSourceNames.length > 0 && allSourceNames.every(s => sources.includes(s));
  const someSelected = allSourceNames.some(s => sources.includes(s)) && !allSelected;

  // Fetch system info when component mounts if it's not already loaded
  useEffect(() => {
    if (!systemInfo) {
      refreshSystemInfo();
    }
    setSources(systemInfo?.storage_info?.source_names || []);
  }, [systemInfo, refreshSystemInfo]);

  // Handle checkbox change
  const handleSourceChange = (source: string, checked: boolean) => {
    let newSources = [...sources];
    if (checked) {
      if (!newSources.includes(source)) newSources.push(source);
    } else {
      newSources = newSources.filter(s => s !== source);
    }
    setSources(newSources);
  };

  const handleSelectAll = () => {
    if (allSelected) {
      setSources([]);
    } else {
      setSources([...allSourceNames]);
    }
  };

  // Render source selection panel
  const renderSourcePanel = () => (
    <div className="space-y-1">
      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin mr-2 text-slate-400" />
          <span className="text-sm text-slate-500">Loading sources...</span>
        </div>
      ) : error ? (
        <div className="text-xs text-destructive py-2 px-1">
          Failed to load sources: {error}
        </div>
      ) : !allSourceNames.length ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center mb-2">
            <FilterX className="h-4 w-4 text-slate-400" />
          </div>
          <p className="text-xs text-slate-500">No sources available</p>
          <p className="text-[10px] text-slate-400 mt-0.5">Import logs to see sources</p>
        </div>
      ) : (
        <>
          {/* Select All header */}
          <div className="flex items-center justify-between mb-2 pb-2 border-b border-slate-100">
            <button
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition-colors"
              onClick={handleSelectAll}
              title={allSelected ? "Deselect all" : "Select all"}
            >
              {allSelected ? (
                <CheckSquare2 className="h-3.5 w-3.5 text-blue-500" />
              ) : someSelected ? (
                <CheckSquare2 className="h-3.5 w-3.5 text-slate-400" />
              ) : (
                <Square className="h-3.5 w-3.5 text-slate-400" />
              )}
              <span className={cn("font-medium", allSelected ? "text-blue-600" : "")}>
                {allSelected ? "Deselect All" : "Select All"}
              </span>
            </button>
            <span className="text-[10px] text-slate-400">
              {sources.length}/{allSourceNames.length} selected
            </span>
          </div>

          <ScrollArea className="max-h-[calc(100vh-280px)]">
            <div className="space-y-0.5 pr-1">
              {allSourceNames.map((sourceName) => {
                const isChecked = sources.includes(sourceName);
                return (
                  <div
                    key={sourceName}
                    className={cn(
                      "flex items-center gap-2 py-1.5 px-2 rounded-md cursor-pointer transition-colors",
                      isChecked ? "bg-blue-50/60 hover:bg-blue-50" : "hover:bg-slate-50"
                    )}
                    onClick={() => handleSourceChange(sourceName, !isChecked)}
                  >
                    <Checkbox
                      id={`source-${sourceName}`}
                      checked={isChecked}
                      onCheckedChange={(checked) => handleSourceChange(sourceName, checked === true)}
                      className="data-[state=checked]:bg-blue-500 data-[state=checked]:border-blue-500 pointer-events-none"
                    />
                    <Label
                      htmlFor={`source-${sourceName}`}
                      className={cn(
                        "text-xs cursor-pointer truncate flex-1",
                        isChecked ? "text-blue-700 font-medium" : "text-slate-600"
                      )}
                      title={sourceName}
                    >
                      {sourceName}
                    </Label>
                    {isChecked && (
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </>
      )}
    </div>
  );

  // Create filter tab content
  const filterContent = (
    <div className="pt-1">
      <div className="mb-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Filter by Source</p>
        {renderSourcePanel()}
      </div>
    </div>
  );

  // Create styling tab content
  const stylingContent = (
    <div className="pt-1">
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Log Coloring</p>
        <ColorRulesPanel />
      </div>
    </div>
  );

  // Define the tabs for the vertical navigation
  const tabs: VerticalTab[] = [

    {
      id: 'filter',
      icon: <FilterX className="h-4 w-4" />,
      label: 'Filter',
      content: filterContent
    },
    {
      id: 'styling',
      icon: <Palette className="h-4 w-4" />,
      label: 'Styling',
      content: stylingContent
    }
  ];

  return { tabs };
};
