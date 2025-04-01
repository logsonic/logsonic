import { TimezoneSelectorCommon } from "@/components/common/TimezoneSelectorCommon";
import { useSearchQueryParamsStore } from "@/stores/useSearchQueryParams";
import { FC } from "react";

export const TimezoneSelector: FC = () => {
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
