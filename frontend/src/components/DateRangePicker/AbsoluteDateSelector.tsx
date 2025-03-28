import { useState, useEffect, FC } from "react";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { format, isSameDay, isAfter } from "date-fns";
import { cn } from "@/lib/utils";
import { useSearchQueryParamsStore } from "@/stores/useSearchParams";

export const AbsoluteDateSelector: FC = () => {
  // Get the store directly using the hook
  const store = useSearchQueryParamsStore();

  const [startDate, setStartDate] = useState(store.UTCTimeSince || new Date());
  const [endDate, setEndDate] = useState(store.UTCTimeTo || new Date());
  const [startTime, setStartTime] = useState(format(store.UTCTimeSince, "HH:mm:ss"));
  const [endTime, setEndTime] = useState(format(store.UTCTimeTo, "HH:mm:ss"));

  // Parse time string to hours, minutes and seconds
  const parseTime = (timeString: string): { hours: number; minutes: number; seconds: number } => {
    const [hoursStr, minutesStr, secondsStr = "00"] = timeString.split(':');
    // Ensure we're parsing as integers with explicit radix to avoid issues
    const hours = parseInt(hoursStr, 10);
    const minutes = parseInt(minutesStr, 10);
    const seconds = parseInt(secondsStr, 10);
    
    return { hours, minutes, seconds };
  };

  // We need to ensure that end date doesnt exceeds start date. 
  // If the user selects a start date after end date, we update the end date to the start date.
  // If the user selects a start date on the same day as the end date, we ensure that the end time is after the start time.
  const handleStartDateTimeChange = useEffect(() => {
    // Parse the start date and time
    const startTimeParts = parseTime(startTime);
    
    // Create a new date with the selected date and time
    // First create a new date to avoid modifying the original
    const startDateTime = new Date(startDate);
    // Set hours, minutes, and seconds explicitly
    startDateTime.setHours(startTimeParts.hours);
    startDateTime.setMinutes(startTimeParts.minutes);
    startDateTime.setSeconds(startTimeParts.seconds);
    
    if (isAfter(startDateTime, endDate)) {
      setEndDate(startDateTime);
      setEndTime(format(startDateTime, "HH:mm:ss"));
    }
    
    // Call the callback with the new date
    store.setUTCTimeSince(startDateTime);
    store.setUTCTimeSinceMs(startDateTime.getTime());
  
  }, [startTime,startDate]);

  const handleEndDateTimeChange = useEffect(() => {
    // Parse the start date and time
    const endTimeParts = parseTime(endTime);
    const startTimeParts = parseTime(startTime);
    
    // Create a new date with the selected date and time
    // First create a new date to avoid modifying the original
    const endDateTime = new Date(endDate);
    
    // If same day and end time is before start time, adjust end time
    if (isSameDay(startDate, endDate) && 
        (endTimeParts.hours < startTimeParts.hours || 
         (endTimeParts.hours === startTimeParts.hours && endTimeParts.minutes < startTimeParts.minutes) ||
         (endTimeParts.hours === startTimeParts.hours && endTimeParts.minutes === startTimeParts.minutes && endTimeParts.seconds < startTimeParts.seconds))) {
      // Set end time to start time + 1 second
      let newEndSeconds = startTimeParts.seconds + 1;
      let newEndMinutes = startTimeParts.minutes;
      let newEndHour = startTimeParts.hours;
      
      if (newEndSeconds >= 60) {
        newEndSeconds = 0;
        newEndMinutes += 1;
        if (newEndMinutes >= 60) {
          newEndMinutes = 0;
          newEndHour = (newEndHour + 1) % 24;
        }
      }
      
      const newEndTime = `${newEndHour.toString().padStart(2, '0')}:${newEndMinutes.toString().padStart(2, '0')}:${newEndSeconds.toString().padStart(2, '0')}`;
      setEndTime(newEndTime);
      
      // Update end time parts
      endTimeParts.hours = newEndHour;
      endTimeParts.minutes = newEndMinutes;
      endTimeParts.seconds = newEndSeconds;
    }
    
    // Set hours, minutes, and seconds explicitly
    endDateTime.setHours(endTimeParts.hours);
    endDateTime.setMinutes(endTimeParts.minutes);
    endDateTime.setSeconds(endTimeParts.seconds);
    
    // Call the callback with the new date
    store.setUTCTimeTo(endDateTime);
    store.setUTCTimeToMs(endDateTime.getTime());
    
  }, [endTime, endDate]);

  return (
    <div className={cn("bg-white p-2 rounded-md space-y-4")}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {/* Start Date Section */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Start Date</h3>
          <div className="border rounded-md p-0 max-w-[240px]">
            <Calendar
              mode="single"
              selected={startDate}
              onSelect={(date) => date ? setStartDate(date) : setStartDate(startDate)}
              initialFocus
              className="p-4"
            />
          </div>
          <div className="flex items-center space-x-1">
          
            <Input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-[240px] h-8 px-2 text-sm mt-1"
              step="1"
            />
          </div>
          <div className="text-sm text-gray-500">
            {startDate ? format(startDate, "PPP") : "Select a date"} at{" "}
            {startTime}
          </div>
        </div>

        {/* End Date Section */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">End Date</h3>
          <div className="border rounded-md p-0 max-w-[240px]">
            <Calendar
              mode="single"
              selected={endDate}
              onSelect={(date) => date ? setEndDate(date) : setEndDate(endDate)}
              initialFocus
              disabled={(date) => date < startDate}
              className="p-4"
            />
          </div>
          <div className="flex items-center space-x-1">
            
            <Input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              min={isSameDay(startDate, endDate) ? startTime : undefined}
              className="w-[240px] h-8 px-2 text-sm mt-1"
              step="1"
            />
          </div>
          <div className="text-sm text-gray-500">
            {endDate ? format(endDate, "PPP") : "Select a date"} at {endTime}
            {isSameDay(startDate, endDate) && 
              (parseTime(endTime).hours * 3600 + parseTime(endTime).minutes * 60 + parseTime(endTime).seconds) <= 
              (parseTime(startTime).hours * 3600 + parseTime(startTime).minutes * 60 + parseTime(startTime).seconds) && (
              <div className="text-xs text-amber-600">
                End time must be after {startTime}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AbsoluteDateSelector;
