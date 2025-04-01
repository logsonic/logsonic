/**
 * Date utility functions for handling relative and absolute date calculations.
 */
import { Calendar, Clock } from "lucide-react";

/**
 * Common date-related constants for reuse across components
 */

/**
 * Available relative date presets for time range selection
 */
export const RELATIVE_DATE_PRESETS = [
  { value: "last-5-minutes", label: "Last 5 minutes" },
  { value: "last-15-minutes", label: "Last 15 minutes" },
  { value: "last-30-minutes", label: "Last 30 minutes" },
  { value: "last-60-minutes", label: "Last 60 minutes" },
  { value: "last-24-hours", label: "Last 24 hours" },
  { value: "last-7-days", label: "Last 7 days" },
  { value: "last-30-days", label: "Last 30 days" },
  { value: "last-quarter", label: "Last quarter" },
  { value: "year-to-date", label: "Year to date" },
  { value: "last-1-year", label: "Last year" },
  { value: "last-10-years", label: "Last 10 years" },
];

/**
 * Available relative date presets with icons for UI components
 */
export const RELATIVE_DATE_OPTIONS_WITH_ICONS = [
  { value: "last-5-minutes", label: "Last 5 minutes", icon: Clock },
  { value: "last-15-minutes", label: "Last 15 minutes", icon: Clock },
  { value: "last-30-minutes", label: "Last 30 minutes", icon: Clock },
  { value: "last-60-minutes", label: "Last 60 minutes", icon: Clock },
  { value: "last-24-hours", label: "Last 24 hours", icon: Clock },
  { value: "last-7-days", label: "Last 7 days", icon: Calendar },
  { value: "last-30-days", label: "Last 30 days", icon: Calendar },
  { value: "last-quarter", label: "Last quarter", icon: Calendar },
  { value: "year-to-date", label: "Year to date", icon: Calendar },
  { value: "last-1-year", label: "Last year", icon: Calendar },
  { value: "last-10-years", label: "Last 10 years", icon: Calendar },
  { value: "custom", label: "Custom", icon: Calendar },
];

/**
 * Available time units for custom relative dates
 */
export const TIME_UNITS = ["minutes", "hours", "days", "weeks", "months", "years"];

/**
 * Time unit options for select component (with capitalized labels)
 */
export const TIME_UNIT_OPTIONS = TIME_UNITS.map(unit => ({
  value: unit,
  label: unit.charAt(0).toUpperCase() + unit.slice(1)
})); 
/**
 * Calculate a relative date based on a base date, unit, and count.
 * 
 * @param baseDate - The reference date to calculate from
 * @param unit - The time unit (minutes, hours, days, weeks, months, years)
 * @param count - The number of units
 * @param direction - The direction ('forward' or 'backward')
 * @returns A new Date object calculated relative to the base date
 */
export const calculateRelativeDate = (
  baseDate: Date,
  unit: string,
  count: number,
  direction: "forward" | "backward" = "backward"
): Date => {
  const multiplier = direction === "backward" ? -1 : 1;
  const value = count * multiplier;
  let result: Date;

  switch (unit) {
    case "minutes":
      return new Date(baseDate.getTime() + value * 60 * 1000);
    case "hours":
      return new Date(baseDate.getTime() + value * 60 * 60 * 1000);
    case "days":
      return new Date(baseDate.getTime() + value * 24 * 60 * 60 * 1000);
    case "weeks":
      return new Date(baseDate.getTime() + value * 7 * 24 * 60 * 60 * 1000);
    case "months": {
      result = new Date(baseDate);
      result.setMonth(result.getMonth() + value);
      return result;
    }
    case "years": {
      result = new Date(baseDate);
      result.setFullYear(result.getFullYear() + value);
      return result;
    }
    default:
      return new Date(baseDate.getTime() - 24 * 60 * 60 * 1000); // Default to 1 day ago
  }
};

/**
 * Calculate a date from a preset relative value.
 * 
 * @param now - The reference date (usually current date)
 * @param presetValue - The preset value (e.g., 'last-24-hours', 'last-7-days')
 * @returns A new Date object calculated based on the preset
 */
export const calculatePresetRelativeDate = (
  now: Date,
  presetValue: string
): Date => {
  let result: Date;
  
  // Ensure presetValue is valid
  const validPresets = RELATIVE_DATE_PRESETS.map(p => p.value);
  if (!validPresets.includes(presetValue) && presetValue !== 'custom') {
    console.warn(`Invalid preset value: ${presetValue}. Using default 'last-24-hours'.`);
    presetValue = 'last-24-hours';
  }

  switch (presetValue) {
    case "last-5-minutes":
      return new Date(now.getTime() - 5 * 60 * 1000);
    case "last-15-minutes":
      return new Date(now.getTime() - 15 * 60 * 1000);
    case "last-30-minutes":
      return new Date(now.getTime() - 30 * 60 * 1000);  
    case "last-60-minutes":
      return new Date(now.getTime() - 60 * 60 * 1000);
    case "last-24-hours":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case "last-7-days":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "last-30-days":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "last-quarter": {
      result = new Date(now);
      result.setMonth(result.getMonth() - 3);
      return result;
    }
    case "year-to-date": {
      result = new Date(now);
      result.setMonth(0);
      result.setDate(1);
      result.setHours(0, 0, 0, 0);
      return result;
    }
    case "last-1-year":
      return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    case "last-10-years":
      return new Date(now.getTime() - 10 * 365 * 24 * 60 * 60 * 1000);
    default:
      return new Date(now.getTime() - 24 * 60 * 60 * 1000); // Default to 1 day ago
  }
};

/**
 * Calculate a date range (start and end dates) based on a preset or custom selection.
 * 
 * @param value - The preset value or 'custom'
 * @param unit - The time unit (for custom selections)
 * @param count - The number of units (for custom selections)
 * @returns An object with startDate and endDate properties
 */
export const calculateRelativeDateRange = (
  value: string,
  unit?: string,
  count?: number
): { startDate: Date; endDate: Date } => {
  const now = new Date();
  let start: Date;
  const end: Date = now;

  // For presets, use the preset relative date calculator
  if (value !== 'custom') {
    start = calculatePresetRelativeDate(now, value);
  } else {
    // For custom selections
    if (count && unit) {
      start = calculateRelativeDate(now, unit, count, "backward");
    } else {
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // Default to last 7 days
    }
  }

  return { startDate: start, endDate: end };
}; 