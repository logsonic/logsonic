import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown, Globe } from "lucide-react";
import { useEffect, useState } from "react";
import { findTimeZone, getZonedTime, listTimeZones } from "timezone-support";

// Function to get the GMT offset for a timezone
export const getGMTOffset = (timeZoneId: string): { offsetString: string; offsetMinutes: number } => {
  try {
    // Get timezone information
    const timeZone = findTimeZone(timeZoneId);
    
    // Create a reference date that's explicitly in UTC
    const utcDate = new Date('2025-03-23T00:00:00Z');

    // Get the zoned time for this UTC date in the target timezone
    const zonedTime = getZonedTime(utcDate, timeZone);
    
    // Extract the offset in minutes
    const offsetInMinutes = zonedTime.zone.offset;
    
    // Convert to hours and minutes
    const hours = Math.floor(Math.abs(offsetInMinutes) / 60);
    const minutes = Math.abs(offsetInMinutes) % 60;
    
    // Format the offset string
    const sign = offsetInMinutes > 0 ? '-' : offsetInMinutes < 0 ? '+' : '';
    const hourStr = hours.toString().padStart(2, '0');
    const minuteStr = minutes ? `:${minutes.toString().padStart(2, '0')}` : '';
    
    return {
      offsetString: `GMT${sign}${hourStr}${minuteStr}`,
      offsetMinutes: offsetInMinutes
    };
  } catch (error) {
    console.error(`Error getting offset for ${timeZoneId}:`, error);
    return { offsetString: '', offsetMinutes: 0 };
  }
};

// Helper function to get formatted timezone list
export const getFormattedTimezones = () => {
  // Get all available timezones
  const allTimeZoneIds = listTimeZones();
  
  // Format all timezones with their offsets
  const formattedTimezones = allTimeZoneIds.map(id => {
    const { offsetString, offsetMinutes } = getGMTOffset(id);
    return {
      id,
      displayName: `${id} (${offsetString})`,
      offsetMinutes
    };
  });
  
  // Sort by timezone ID for better organization
  formattedTimezones.sort((a, b) => a.id.localeCompare(b.id));

  // Add common timezones at the top
  const commonTimezones = [
    { id: 'auto', displayName: 'Auto-detect', offsetMinutes: 0 },
    { id: 'UTC', displayName: `UTC (${getGMTOffset('UTC').offsetString})`, offsetMinutes: 0 }
  ];
  
  // Add browser's local timezone
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { offsetString, offsetMinutes } = getGMTOffset(localTimezone);
  const localTz = {
    id: 'Local',
    displayName: `Local (${localTimezone}) (${offsetString})`,
    offsetMinutes
  };
  
  commonTimezones.push(localTz);
  
  return [...commonTimezones, ...formattedTimezones];
};

export interface TimezoneData {
  id: string;
  displayName: string;
  offsetMinutes: number;
}

interface TimezoneSelectorProps {
  selectedTimezone: string;
  onTimezoneChange: (value: string) => void;
  triggerClassName?: string;
  label?: string;
  placeholder?: string;
}

export const TimezoneSelectorCommon: React.FC<TimezoneSelectorProps> = ({
  selectedTimezone,
  onTimezoneChange,
  triggerClassName = "",
  label = "Timezone",
  placeholder = "Select timezone"
}) => {
  const [open, setOpen] = useState(false);
  const [timezones, setTimezones] = useState<TimezoneData[]>([]);

  useEffect(() => {
    setTimezones(getFormattedTimezones());
  }, []);

  // Find the selected timezone label
  const selectedTimezoneLabel = timezones.find(tz => tz.id === selectedTimezone)?.displayName || selectedTimezone || placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            triggerClassName
          )}
          role="combobox"
          aria-expanded={open}
          aria-label={`Select ${label.toLowerCase()}`}
        >
          <div className="flex items-center space-x-2">
            <Globe className="h-4 w-4 text-gray-500 flex-shrink-0" />
            <span className="truncate">{selectedTimezoneLabel}</span>
          </div>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[350px] p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}...`} className="h-9" />
          <CommandList>
            <CommandEmpty>No timezone found.</CommandEmpty>
            <CommandGroup className="max-h-[300px] overflow-auto">
              {timezones.map((timezone) => (
                <CommandItem
                  key={timezone.id}
                  value={timezone.id}
                  onSelect={(value) => {
                    onTimezoneChange(value);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      selectedTimezone === timezone.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {timezone.displayName}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

export default TimezoneSelectorCommon; 