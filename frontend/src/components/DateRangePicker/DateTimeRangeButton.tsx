import { useState, useEffect, FC } from "react";
import { Button } from "@/components/ui/button";
import { Calendar, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import DateRangePicker from "./DateRangePicker";
import { useSearchQueryParamsStore } from "@/stores/useSearchQueryParams";
import { RELATIVE_DATE_PRESETS } from "@/lib/date-utils";

export const DateTimeRangeButton: FC = () => {
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
        const startFormatted = format(startDate, "MMM d HH:mm");
        const endFormatted = format(endDate, "MMM d HH:mm");
        setDisplayText(`${startFormatted} – ${endFormatted}`);
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

  const tz = store.timeZone || "UTC";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "flex items-center gap-1.5 transition-colors whitespace-nowrap rounded-none",
            "h-full border-0"
          )}
          style={{
            background: 'var(--ls-bg-1)',
            color: 'var(--ls-text)',
            padding: '0 10px',
            fontSize: 12.5,
            fontWeight: 500,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ls-bg-2)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--ls-bg-1)')}
        >
          <Calendar className="h-3.5 w-3.5" style={{ color: 'var(--ls-text-3)' }} />
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{displayText}</span>
          <span
            style={{
              color: 'var(--ls-text-3)',
              fontFamily: 'var(--ls-font-mono)',
              fontSize: 11,
              marginLeft: 4,
            }}
          >
            {tz}
          </span>
          <ChevronDown className="h-3 w-3 ml-1" style={{ color: 'var(--ls-text-3)' }} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0"
        align="end"
        side="bottom"
        sideOffset={6}
        // Keep the picker inside the viewport — without this Radix can
        // flip the panel above the trigger and clip the upper "Last X
        // minutes" rows off-screen.
        collisionPadding={12}
        avoidCollisions
        style={{
          background: 'var(--ls-panel)',
          borderColor: 'var(--ls-border)',
          boxShadow: 'var(--ls-shadow-lg)',
          maxHeight: 'calc(100vh - 32px)',
          overflowY: 'auto',
        }}
      >
        <DateRangePicker
          onApply={handleSearchClick}
          initialActiveTab={activeTab}
        />
      </PopoverContent>
    </Popover>
  );
};

export default DateTimeRangeButton; 