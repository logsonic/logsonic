export interface DateRangeType {
  type: "relative" | "absolute";
  startDate?: Date;
  endDate?: Date;
  startTime?: string;
  endTime?: string;
  timezone: string;
  relativeValue?: string;
  relativeUnit?: string;
  relativeCount?: number;
  relativeDirection?: "ago" | "from now";
  // Unix timestamp in milliseconds for the start date/time
  startTimestamp?: number;
  // Unix timestamp in milliseconds for the end date/time
  endTimestamp?: number;
  // For relative dates, these are the calculated actual dates
  calculatedStartDate?: Date;
  calculatedEndDate?: Date;
} 