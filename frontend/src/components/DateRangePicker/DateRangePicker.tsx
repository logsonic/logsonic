import { useState, useEffect, useCallback, FC } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { format, isSameDay, isAfter, parseISO, subHours, subDays, subMonths, subYears, startOfYear, startOfQuarter } from "date-fns";
import { cn } from "@/lib/utils";
import { RelativeDateSelector } from "@/components/DateRangePicker/RelativeDateSelector";
import { AbsoluteDateSelector } from "@/components/DateRangePicker/AbsoluteDateSelector";  
import { TimezoneSelector } from "@/components/DateRangePicker/TimezoneSelector";
import { DateRangeType } from "./types";
import { Check, X } from "lucide-react";
import { useSearchQueryParamsStore } from "@/stores/useSearchParams";

export interface DateRangePickerProps {
  onApply: () => void;
  initialActiveTab?: string;
}
// Allows relative and absolute date range selection with timezone support

export const DateRangePicker: FC<DateRangePickerProps> = ({
  onApply,
  initialActiveTab,
}) => {
  // Get the store directly using the hook
  const store = useSearchQueryParamsStore();
  
  const [activeTab, setActiveTab] = useState<"relative" | "absolute">(
    initialActiveTab ? (initialActiveTab as "relative" | "absolute") : (store.isRelative ? "relative" : "absolute"),
  );

  // Update active tab when initialActiveTab changes
  useEffect(() => {
    if (initialActiveTab) {
      setActiveTab(initialActiveTab as "relative" | "absolute");
    }
  }, [initialActiveTab]);

  const handleTabChange = (value: string) => {
    store.isRelative = value === "relative";
  };

  const formatDateRange = useCallback(() => {
      return `${format(store.UTCTimeSince, "MMM d, yyyy (HH:mm:ss)")} - ${format(store.UTCTimeTo, "MMM d, yyyy (HH:mm:ss)")}`;
  }, [store.UTCTimeSince, store.UTCTimeTo]);

  return (
    <Card className={cn("w-[540px] max-w-2xl bg-white shadow-lg border-gray-200")}>
      <CardContent className="p-4">
        <div className="space-y-4">
          <Tabs defaultValue={store.isRelative ? "relative" : "absolute"} onValueChange={handleTabChange} className="w-full">
            <TabsList className="w-full grid grid-cols-2 mb-2 bg-gray-100 p-1 rounded-md">
              <TabsTrigger 
                value="relative" 
                className={cn(
                  "text-sm font-medium rounded-md data-[state=active]:bg-white data-[state=active]:shadow-sm",
                  "transition-all duration-200 data-[state=active]:text-blue-600"
                )}
              >
                Relative
              </TabsTrigger>
              <TabsTrigger 
                value="absolute"
                className={cn(
                  "text-sm font-medium rounded-md data-[state=active]:bg-white data-[state=active]:shadow-sm",
                  "transition-all duration-200 data-[state=active]:text-blue-600"
                )}
              >
                Absolute
              </TabsTrigger>
            </TabsList>

            <TabsContent value="relative" className="mt-2 focus-visible:outline-none focus-visible:ring-0">
              <RelativeDateSelector />
            </TabsContent>

            <TabsContent value="absolute" className="mt-2 focus-visible:outline-none focus-visible:ring-0">
              <AbsoluteDateSelector />
            </TabsContent>
          </Tabs>

          <div className="border-t pt-3">
            <TimezoneSelector
            />
          </div>

          <div className="flex flex-col sm:flex-row justify-between items-center gap-2 border-t pt-3">
            <div className="text-sm">
              <div className="font-medium text-gray-700">Selected Range:</div>
              <div className="text-gray-800">{formatDateRange()}</div>
              <div className="text-xs text-gray-500 mt-1">Timezone: {store.timeZone}</div>
            </div>
            <div className="flex gap-2">
              <Button 
                onClick={onApply} 
                size="sm"
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default DateRangePicker;
