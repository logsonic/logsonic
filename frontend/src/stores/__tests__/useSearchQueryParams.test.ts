import { describe, it, expect, beforeEach } from "vitest";
import { useSearchQueryParamsStore } from "../useSearchQueryParams";

/**
 * Tests for useSearchQueryParamsStore (Zustand store)
 *
 * These tests exercise the store's pure logic (actions + state transitions)
 * without rendering React components. Zustand stores can be tested by
 * calling getState() and setState() directly.
 */

// Reset store to default state before each test
beforeEach(() => {
  useSearchQueryParamsStore.getState().resetStore();
});

// ---------------------------------------------------------------------------
// Initial State
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("has empty search query", () => {
    const state = useSearchQueryParamsStore.getState();
    expect(state.searchQuery).toBe("");
  });

  it("defaults to firstLoad=true", () => {
    const state = useSearchQueryParamsStore.getState();
    expect(state.firstLoad).toBe(true);
  });

  it("defaults to relative time mode with last-10-years", () => {
    const state = useSearchQueryParamsStore.getState();
    expect(state.isRelative).toBe(true);
    expect(state.relativeValue).toBe("last-10-years");
  });

  it("defaults to descending timestamp sort", () => {
    const state = useSearchQueryParamsStore.getState();
    expect(state.sortBy).toBe("timestamp");
    expect(state.sortOrder).toBe("desc");
  });

  it("defaults to page 1 with 100 page size", () => {
    const state = useSearchQueryParamsStore.getState();
    expect(state.currentPage).toBe(1);
    expect(state.pageSize).toBe(100);
  });

  it("has empty selected/available columns", () => {
    const state = useSearchQueryParamsStore.getState();
    expect(state.availableColumns).toEqual([]);
    expect(state.selectedColumns).toEqual([]);
    expect(state.mandatoryColumns).toEqual(["timestamp"]);
  });
});

// ---------------------------------------------------------------------------
// Search Query Actions
// ---------------------------------------------------------------------------

describe("search query actions", () => {
  it("setSearchQuery updates the query", () => {
    useSearchQueryParamsStore.getState().setSearchQuery("level:error");
    expect(useSearchQueryParamsStore.getState().searchQuery).toBe(
      "level:error"
    );
  });

  it("setSearchQuery does not re-set identical values", () => {
    useSearchQueryParamsStore.getState().setSearchQuery("test");
    const firstState = useSearchQueryParamsStore.getState();
    useSearchQueryParamsStore.getState().setSearchQuery("test");
    const secondState = useSearchQueryParamsStore.getState();
    // Zustand reuses the same reference when value unchanged
    expect(firstState).toBe(secondState);
  });

  it("clearSearchQuery resets to empty string", () => {
    useSearchQueryParamsStore.getState().setSearchQuery("level:error");
    useSearchQueryParamsStore.getState().clearSearchQuery();
    expect(useSearchQueryParamsStore.getState().searchQuery).toBe("");
  });

  it("triggerSearch sets hasSearched=true", () => {
    expect(useSearchQueryParamsStore.getState().hasSearched).toBe(false);
    useSearchQueryParamsStore.getState().triggerSearch();
    expect(useSearchQueryParamsStore.getState().hasSearched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Time Range Actions
// ---------------------------------------------------------------------------

describe("time range actions", () => {
  it("setUTCTimeSince updates both Date and ms", () => {
    const date = new Date("2024-01-15T10:00:00Z");
    useSearchQueryParamsStore.getState().setUTCTimeSince(date);
    const state = useSearchQueryParamsStore.getState();
    expect(state.UTCTimeSince.getTime()).toBe(date.getTime());
    expect(state.UTCTimeSinceMs).toBe(date.getTime());
  });

  it("setUTCTimeTo updates both Date and ms", () => {
    const date = new Date("2024-01-15T23:59:59Z");
    useSearchQueryParamsStore.getState().setUTCTimeTo(date);
    const state = useSearchQueryParamsStore.getState();
    expect(state.UTCTimeTo.getTime()).toBe(date.getTime());
    expect(state.UTCTimeToMs).toBe(date.getTime());
  });

  it("setUTCTimeSinceMs updates both ms and Date", () => {
    const ms = new Date("2024-03-01T00:00:00Z").getTime();
    useSearchQueryParamsStore.getState().setUTCTimeSinceMs(ms);
    const state = useSearchQueryParamsStore.getState();
    expect(state.UTCTimeSinceMs).toBe(ms);
    expect(state.UTCTimeSince.getTime()).toBe(ms);
  });

  it("setIsRelative toggles relative mode", () => {
    useSearchQueryParamsStore.getState().setIsRelative(false);
    expect(useSearchQueryParamsStore.getState().isRelative).toBe(false);
    useSearchQueryParamsStore.getState().setIsRelative(true);
    expect(useSearchQueryParamsStore.getState().isRelative).toBe(true);
  });

  it("setRelativeValue updates preset", () => {
    useSearchQueryParamsStore.getState().setRelativeValue("last-7-days");
    expect(useSearchQueryParamsStore.getState().relativeValue).toBe(
      "last-7-days"
    );
  });
});

// ---------------------------------------------------------------------------
// Sorting & Pagination
// ---------------------------------------------------------------------------

describe("sorting and pagination", () => {
  it("setSortBy changes sort field", () => {
    useSearchQueryParamsStore.getState().setSortBy("level");
    expect(useSearchQueryParamsStore.getState().sortBy).toBe("level");
  });

  it("setSortOrder changes sort direction", () => {
    useSearchQueryParamsStore.getState().setSortOrder("asc");
    expect(useSearchQueryParamsStore.getState().sortOrder).toBe("asc");
  });

  it("setPageSize updates page size", () => {
    useSearchQueryParamsStore.getState().setPageSize(50);
    expect(useSearchQueryParamsStore.getState().pageSize).toBe(50);
  });

  it("setCurrentPage updates page number", () => {
    useSearchQueryParamsStore.getState().setCurrentPage(3);
    expect(useSearchQueryParamsStore.getState().currentPage).toBe(3);
  });

  it("resetPagination resets to page 1", () => {
    useSearchQueryParamsStore.getState().setCurrentPage(5);
    useSearchQueryParamsStore.getState().resetPagination();
    expect(useSearchQueryParamsStore.getState().currentPage).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Column Management
// ---------------------------------------------------------------------------

describe("column management", () => {
  it("setAvailableColumns initializes selected columns on first call", () => {
    useSearchQueryParamsStore
      .getState()
      .setAvailableColumns([
        "timestamp",
        "message",
        "level",
        "host",
        "_raw",
        "_src",
      ]);
    const state = useSearchQueryParamsStore.getState();
    // Available should have all columns
    expect(state.availableColumns).toContain("_raw");
    expect(state.availableColumns).toContain("message");
    // Selected should have timestamp (mandatory) + up to 5 non-underscore columns
    expect(state.selectedColumns).toContain("timestamp");
    // _raw and _src should be excluded from initial selection
    expect(state.selectedColumns).not.toContain("_raw");
    expect(state.selectedColumns).not.toContain("_src");
  });

  it("deduplicates available columns", () => {
    useSearchQueryParamsStore
      .getState()
      .setAvailableColumns(["timestamp", "message", "message", "level"]);
    const state = useSearchQueryParamsStore.getState();
    const msgCount = state.availableColumns.filter(
      (c) => c === "message"
    ).length;
    expect(msgCount).toBe(1);
  });

  it("setSelectedColumns always includes mandatory columns", () => {
    useSearchQueryParamsStore
      .getState()
      .setSelectedColumns(["message", "level"]);
    const state = useSearchQueryParamsStore.getState();
    expect(state.selectedColumns).toContain("timestamp"); // mandatory
    expect(state.selectedColumns).toContain("message");
  });

  it("updateColumnWidth updates a single column width", () => {
    useSearchQueryParamsStore.getState().updateColumnWidth("message", 300);
    const state = useSearchQueryParamsStore.getState();
    expect(state.columnWidths["message"]).toBe(300);
  });

  it("setColumnLocked toggles lock state", () => {
    useSearchQueryParamsStore.getState().setColumnLocked(true);
    expect(useSearchQueryParamsStore.getState().isColumnLocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Performance Metrics
// ---------------------------------------------------------------------------

describe("performance metrics", () => {
  it("setPerformanceMetrics stores all three values", () => {
    useSearchQueryParamsStore.getState().setPerformanceMetrics(100, 50, 25);
    const state = useSearchQueryParamsStore.getState();
    expect(state.apiExecutionTime).toBe(100);
    expect(state.backendLatency).toBe(50);
    expect(state.indexQueryTime).toBe(25);
  });

  it("setPerformanceMetrics accepts null values", () => {
    useSearchQueryParamsStore.getState().setPerformanceMetrics(null, null, null);
    const state = useSearchQueryParamsStore.getState();
    expect(state.apiExecutionTime).toBeNull();
    expect(state.backendLatency).toBeNull();
    expect(state.indexQueryTime).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resetStore
// ---------------------------------------------------------------------------

describe("resetStore", () => {
  it("resets all state to defaults", () => {
    // Modify state
    useSearchQueryParamsStore.getState().setSearchQuery("test");
    useSearchQueryParamsStore.getState().setSortOrder("asc");
    useSearchQueryParamsStore.getState().setCurrentPage(5);
    useSearchQueryParamsStore.getState().setPageSize(50);

    // Reset
    useSearchQueryParamsStore.getState().resetStore();

    const state = useSearchQueryParamsStore.getState();
    expect(state.searchQuery).toBe("");
    expect(state.sortOrder).toBe("desc");
    expect(state.currentPage).toBe(1);
    expect(state.pageSize).toBe(100);
    expect(state.firstLoad).toBe(true);
    expect(state.isRelative).toBe(true);
    expect(state.relativeValue).toBe("last-10-years");
  });
});
