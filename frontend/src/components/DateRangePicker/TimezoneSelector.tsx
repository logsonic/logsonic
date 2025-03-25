import React from "react";
import { TimezoneSelectorCommon } from "@/components/common/TimezoneSelectorCommon";
import { useSearchQueryParamsStore } from "@/stores/useSearchParams";

export const TimezoneSelector: React.FC = () => {
  const { timeZone, setTimeZone } = useSearchQueryParamsStore();

  return (
    <div className={"space-y-1"}>
      <label className="text-sm font-medium">Timezone</label>
      <TimezoneSelectorCommon 
        selectedTimezone={timeZone} 
        onTimezoneChange={setTimeZone}
      />
    </div>
  );
};

export default TimezoneSelector;
