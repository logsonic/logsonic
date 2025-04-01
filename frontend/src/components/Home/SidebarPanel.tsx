import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useSearchQueryParamsStore } from "@/stores/useSearchQueryParams";
import { useSystemInfoStore } from "@/stores/useSystemInfoStore";
import { FilterX, Loader2, Palette } from "lucide-react";
import { useEffect } from "react";
import { VerticalTab } from "./Sidebar/CollapsiblePanel";
import { ColorRulesPanel } from "./Sidebar/ColorRulesPanel";

export const SidebarPanel = () => {
  const { systemInfo, refreshSystemInfo, isLoading, error } = useSystemInfoStore();
  const { sources , setSources} = useSearchQueryParamsStore();
  

  // Fetch system info when component mounts if it's not already loaded
  useEffect(() => {
    if (!systemInfo) {
      refreshSystemInfo();
    }
    setSources(systemInfo?.storage_info?.source_names || []);
  }, [systemInfo, refreshSystemInfo]);

  // Handle checkbox change
  const handleSourceChange = (source: string, checked: boolean) => {
    // Update selectedSources in the ImportStore
    let newSources = [...sources];
    
    if (checked) {
      // Add source if not already present
      if (!newSources.includes(source)) {
        newSources.push(source);
      }
    } else {
      // Remove source if present
      newSources = newSources.filter(s => s !== source);
    }
    
    // Update the stores
    setSources(newSources);
  };

  // Render source selection panel
  const renderSourcePanel = () => (
   
      <span className="">
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span className="text-sm text-muted-foreground">Loading sources...</span>
          </div>
        ) : error ? (
          <div className="text-sm text-destructive py-2">
            Failed to load sources: {error}
          </div>
        ) : !systemInfo?.storage_info?.source_names?.length ? (
          <div className="text-sm text-muted-foreground py-2">
            No sources available
          </div>
        ) : (
          <ScrollArea className="">
            <h3 className="text-sm font-medium text-slate-600 pb-4">Filter by Source</h3>
            <div className="space-y-1">
              {systemInfo.storage_info.source_names.map((sourceName) => (
                <div key={sourceName} className="flex items-center space-x-2 group py-1 px-1 rounded-md hover:bg-slate-50">
                  <Checkbox 
                    id={`source-${sourceName}`}
                    checked={sources.includes(sourceName)}
                    onCheckedChange={(checked) => 
                      handleSourceChange(sourceName, checked === true)
                    }
                    className="data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
                  />
                  <Label 
                    htmlFor={`source-${sourceName}`}
                    className={cn(
                      "text-sm cursor-pointer w-full",
                      sources.includes(sourceName) ? "font-medium" : "text-muted-foreground"
                    )}
                  >
                    {sourceName}
                  </Label>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </span>
   );

  // Create filter tab content
  const filterContent = (
    <div className="">
      <div>

       
        {renderSourcePanel()}
      </div>
    </div>
  );

  // Create styling tab content
  const stylingContent = (
    <div className="space-y-2">
      <div>
  
        
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
