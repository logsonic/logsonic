import { useEffect, useState, FC } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import { useSearchQueryParamsStore } from "@/stores/useSearchParams";
import { calculateRelativeDate } from "@/lib/date-utils";
import { RELATIVE_DATE_OPTIONS_WITH_ICONS, TIME_UNITS } from "@/lib/date-utils";

type DateOption = {
  value: string;
  label: string;
  icon: React.ReactNode;
};

const DateOptionButton: React.FC<{
  option: DateOption;
  isSelected: boolean;
  onClick: () => void;
  className?: string;
}> = ({ option, isSelected, onClick, className }) => (
  <Button
    variant="ghost"
    onClick={onClick}
    className={cn(
      "w-full justify-start text-sm h-10 px-3 rounded-md",
      "hover:bg-gray-100 hover:text-gray-900 transition-colors",
      isSelected
        ? "bg-blue-50 text-blue-700 hover:bg-blue-100 hover:text-blue-800 font-medium border border-blue-200"
        : "text-gray-700",
      className
    )}
  >
    {option.icon}
    {option.label}
  </Button>
);

export const RelativeDateSelector: FC = () => {
  // Get the store directly using the hook
  const store = useSearchQueryParamsStore();
  
  const [selectedOption, setSelectedOption] = useState(store.relativeValue);

  const handleOptionChange = (value: string) => {
    setSelectedOption(value);
    store.relativeValue = value;
    // Set isRelative to true since we're using a relative date
    store.isRelative = true;
    store.updateRelativeValue();
    store.updateUrlParams();
  };

  const handleCustomCountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const count = parseInt(e.target.value);
    store.setCustomRelativeCount(isNaN(count) ? 1 : count);
    
    // Update the custom date range
    if (!isNaN(count)) {
      const now = new Date();
      const startDate = calculateRelativeDate(now, store.customRelativeUnit, count, "backward");
      const endDate = now;
      
      // Update the store with the new dates without triggering a search
      store.setUTCTimeSince(startDate);
      store.setUTCTimeSinceMs(startDate.getTime());
      store.setUTCTimeTo(endDate);
      store.setUTCTimeToMs(endDate.getTime());
      store.relativeValue = "custom";
      store.isRelative = true;
      // Save custom values to store
      store.setCustomRelativeCount(count);
    }
  };

  const handleCustomUnitChange = (value: string) => {
    store.setCustomRelativeUnit(value);
    
    // Update the custom date range
    const now = new Date();
    const startDate = calculateRelativeDate(now, value, store.customRelativeCount, "backward");
    const endDate = now;
    
    // Update the store with the new dates without triggering a search
    store.setUTCTimeSince(startDate);
    store.setUTCTimeSinceMs(startDate.getTime());
    store.setUTCTimeTo(endDate);
    store.setUTCTimeToMs(endDate.getTime());
    store.relativeValue = "custom";
    store.isRelative = true;
    // Save custom unit to store
    store.setCustomRelativeUnit(value);
  };

  // Convert options to include rendered icons
  const dateOptions: DateOption[] = RELATIVE_DATE_OPTIONS_WITH_ICONS.map(option => ({
    ...option,
    icon: option.value === "custom" 
      ? <ChevronRight size={16} className="mr-2 text-gray-500" />
      : <option.icon size={16} className="mr-2 text-gray-500" />
  }));

  return (
    <div className={cn("space-y-4")}>
      <div className="grid grid-cols-2 gap-2">
        {dateOptions.map((option, index) => (
          <DateOptionButton
            key={option.value}
            option={option}
            isSelected={selectedOption === option.value}
            onClick={() => handleOptionChange(option.value)}
            className={index === 0 ? "max-w-xl" : ""}
          />
        ))}
      </div>

      {selectedOption === "custom" && (
        <div className="flex flex-wrap items-center gap-2 mt-3 p-3 bg-gray-50 rounded-md border border-gray-200">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-700 font-medium">Last</span>
            <Input
              type="number"
              min="1"
              value={store.customRelativeCount} 
              onChange={handleCustomCountChange}
              className="w-20 h-9 px-2 text-sm border-gray-300 focus-visible:ring-blue-500/40 focus-visible:border-blue-500"
            />
          </div>
          
          <Select value={store.customRelativeUnit} onValueChange={handleCustomUnitChange}>
            <SelectTrigger className="w-32 h-9 text-sm border-gray-300">
              <SelectValue placeholder="Unit" />
            </SelectTrigger>
            <SelectContent>
              {TIME_UNITS.map((unit) => (
                <SelectItem key={unit} value={unit}>
                  {unit.charAt(0).toUpperCase() + unit.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label> Ago</label>
        </div>
      )}
    </div>
  );
};

export default RelativeDateSelector;    