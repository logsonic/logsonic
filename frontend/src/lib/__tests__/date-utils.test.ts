import { describe, it, expect } from "vitest";
import {
  calculateRelativeDate,
  calculatePresetRelativeDate,
  calculateRelativeDateRange,
  RELATIVE_DATE_PRESETS,
  TIME_UNITS,
} from "../date-utils";

// ---------------------------------------------------------------------------
// calculateRelativeDate
// ---------------------------------------------------------------------------

describe("calculateRelativeDate", () => {
  const base = new Date("2024-06-15T12:00:00Z");

  it("subtracts minutes backward", () => {
    const result = calculateRelativeDate(base, "minutes", 30, "backward");
    expect(result.getTime()).toBe(base.getTime() - 30 * 60 * 1000);
  });

  it("adds minutes forward", () => {
    const result = calculateRelativeDate(base, "minutes", 10, "forward");
    expect(result.getTime()).toBe(base.getTime() + 10 * 60 * 1000);
  });

  it("subtracts hours", () => {
    const result = calculateRelativeDate(base, "hours", 2, "backward");
    expect(result.getTime()).toBe(base.getTime() - 2 * 60 * 60 * 1000);
  });

  it("subtracts days", () => {
    const result = calculateRelativeDate(base, "days", 7, "backward");
    expect(result.getTime()).toBe(base.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  it("subtracts weeks", () => {
    const result = calculateRelativeDate(base, "weeks", 2, "backward");
    expect(result.getTime()).toBe(
      base.getTime() - 2 * 7 * 24 * 60 * 60 * 1000
    );
  });

  it("subtracts months", () => {
    const result = calculateRelativeDate(base, "months", 3, "backward");
    expect(result.getMonth()).toBe(2); // June - 3 = March (0-indexed)
  });

  it("subtracts years", () => {
    const result = calculateRelativeDate(base, "years", 1, "backward");
    expect(result.getFullYear()).toBe(2023);
  });

  it("defaults to 1 day ago for unknown units", () => {
    const result = calculateRelativeDate(base, "unknown-unit", 5, "backward");
    expect(result.getTime()).toBe(base.getTime() - 24 * 60 * 60 * 1000);
  });

  it("defaults direction to backward", () => {
    const result = calculateRelativeDate(base, "hours", 1);
    expect(result.getTime()).toBe(base.getTime() - 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// calculatePresetRelativeDate
// ---------------------------------------------------------------------------

describe("calculatePresetRelativeDate", () => {
  const now = new Date("2024-06-15T12:00:00Z");

  it("calculates last-5-minutes", () => {
    const result = calculatePresetRelativeDate(now, "last-5-minutes");
    expect(result.getTime()).toBe(now.getTime() - 5 * 60 * 1000);
  });

  it("calculates last-15-minutes", () => {
    const result = calculatePresetRelativeDate(now, "last-15-minutes");
    expect(result.getTime()).toBe(now.getTime() - 15 * 60 * 1000);
  });

  it("calculates last-24-hours", () => {
    const result = calculatePresetRelativeDate(now, "last-24-hours");
    expect(result.getTime()).toBe(now.getTime() - 24 * 60 * 60 * 1000);
  });

  it("calculates last-7-days", () => {
    const result = calculatePresetRelativeDate(now, "last-7-days");
    expect(result.getTime()).toBe(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  it("calculates last-30-days", () => {
    const result = calculatePresetRelativeDate(now, "last-30-days");
    expect(result.getTime()).toBe(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  });

  it("calculates last-quarter (3 months back)", () => {
    const result = calculatePresetRelativeDate(now, "last-quarter");
    expect(result.getMonth()).toBe(2); // June - 3 = March
    expect(result.getFullYear()).toBe(2024);
  });

  it("calculates year-to-date (Jan 1 midnight)", () => {
    const result = calculatePresetRelativeDate(now, "year-to-date");
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(1);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
  });

  it("calculates last-1-year", () => {
    const result = calculatePresetRelativeDate(now, "last-1-year");
    expect(result.getTime()).toBe(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  });

  it("calculates last-10-years", () => {
    const result = calculatePresetRelativeDate(now, "last-10-years");
    expect(result.getTime()).toBe(
      now.getTime() - 10 * 365 * 24 * 60 * 60 * 1000
    );
  });

  it("falls back to last-24-hours for invalid preset", () => {
    const result = calculatePresetRelativeDate(now, "invalid-preset");
    // Invalid presets get remapped to 'last-24-hours'
    expect(result.getTime()).toBe(now.getTime() - 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// calculateRelativeDateRange
// ---------------------------------------------------------------------------

describe("calculateRelativeDateRange", () => {
  it("returns start and end dates for a preset", () => {
    const { startDate, endDate } = calculateRelativeDateRange("last-7-days");
    // endDate should be approximately now
    expect(endDate.getTime()).toBeCloseTo(Date.now(), -3); // within 1 second
    // startDate should be ~7 days before endDate
    const diff = endDate.getTime() - startDate.getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(diff - sevenDays)).toBeLessThan(1000);
  });

  it("returns custom range for custom selection", () => {
    const { startDate, endDate } = calculateRelativeDateRange(
      "custom",
      "hours",
      6
    );
    const diff = endDate.getTime() - startDate.getTime();
    const sixHours = 6 * 60 * 60 * 1000;
    expect(Math.abs(diff - sixHours)).toBeLessThan(1000);
  });

  it("defaults to 7 days for custom without count/unit", () => {
    const { startDate, endDate } = calculateRelativeDateRange("custom");
    const diff = endDate.getTime() - startDate.getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(diff - sevenDays)).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("RELATIVE_DATE_PRESETS all have value and label", () => {
    for (const preset of RELATIVE_DATE_PRESETS) {
      expect(preset.value).toBeTruthy();
      expect(preset.label).toBeTruthy();
    }
  });

  it("TIME_UNITS contains standard units", () => {
    expect(TIME_UNITS).toContain("minutes");
    expect(TIME_UNITS).toContain("hours");
    expect(TIME_UNITS).toContain("days");
    expect(TIME_UNITS).toContain("months");
    expect(TIME_UNITS).toContain("years");
  });
});
