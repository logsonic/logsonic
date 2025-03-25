import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Calendar, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import DateRangePicker from "./DateRangePicker";
import { DateRangeType } from "./types";
import { useSearchQueryParamsStore } from "@/stores/useSearchParams";
import { RELATIVE_DATE_PRESETS } from "@/lib/date-utils";

export const DateTimeRangeButton: React.FC = () => {
  const store = useSearchQueryParamsStore();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(store.isRelative ? "relative" : "absolute");
  const [displayText, setDisplayText] = useState<string>("");

  // Update active tab when popover opens
  const handleOpenChange = (openState: boolean) => {
    setOpen(openState);
    if (openState) {
      // When opening the popover, update the active tab based on store's isRelative value
      setActiveTab(store.isRelative ? "relative" : "absolute");
    }
  };

  // Update display text based on current date selection
  useEffect(() => {
    if (store.isRelative) {
      // For relative dates
      if (store.relativeValue === "custom") {
        // For custom relative dates, display with the count and unit
        setDisplayText(`Last ${store.customRelativeCount} ${store.customRelativeUnit}`);
      } else {
        const option = RELATIVE_DATE_PRESETS.find(opt => opt.value === store.relativeValue);
        setDisplayText(option ? option.label : "Select time range");
      }
    } else {
      // For absolute dates
      const startDate = store.UTCTimeSince;
      const endDate = store.UTCTimeTo;
      
      if (startDate && endDate) {
        const startFormatted = format(startDate, "MMM d, yyyy HH:mm");
        const endFormatted = format(endDate, "MMM d, yyyy HH:mm");
        
        // Add timezone information if available
        const timezone = store.timeZone || "UTC";
        setDisplayText(`${startFormatted} - ${endFormatted} (${timezone})`);
      } else {
        setDisplayText("Select time range");
      }
    }
  }, [
    store.isRelative, 
    store.relativeValue, 
    store.customRelativeCount,
    store.customRelativeUnit,
    store.UTCTimeSince, 
    store.UTCTimeTo,
    store.timeZone
  ]);

  // Handle tab change
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    store.isRelative = value === "relative";
  };

  // Handle search button click
  const handleSearchClick = () => {
    // Close the popover
    setOpen(false);
    
    // Trigger the search
    store.triggerSearch();
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button 
          variant="outline" 
          className={cn(
            "flex items-center gap-1 h-9 px-3 border-gray-300 bg-white hover:bg-gray-50",
            "transition-colors duration-200 whitespace-nowrap",
            "h-full border-none border-r border-gray-300 hover:bg-gray-100 hover:text-gray-900 rounded-none"
            
          )}
        >
          <div className="flex items-center gap-1 text-gray-600">
            <Calendar className="h-4 w-4" />
          </div>
          <span className="text-sm font-medium">{displayText}</span>
          <ChevronDown className="h-3.5 w-3.5 ml-1 text-gray-500" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0 shadow-lg border-gray-200" align="end">
        <DateRangePicker 
          onApply={handleSearchClick}
          initialActiveTab={activeTab}
        />
      </PopoverContent>
    </Popover>
  );
};

export default DateTimeRangeButton; 