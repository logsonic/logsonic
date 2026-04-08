import { describe, it, expect, beforeEach } from "vitest";
import { useLogResultStore } from "../useLogResultStore";

beforeEach(() => {
  useLogResultStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Initial State
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("has null logData", () => {
    expect(useLogResultStore.getState().logData).toBeNull();
  });

  it("has null error", () => {
    expect(useLogResultStore.getState().error).toBeNull();
  });

  it("is not loading", () => {
    expect(useLogResultStore.getState().isLoading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe("setLogData", () => {
  it("stores log response data", () => {
    const data = {
      status: "success",
      total_count: 10,
      offset: 0,
      limit: 100,
      time_taken: 50,
      index_query_time: 10,
      count: 10,
      logs: [{ _raw: "test log" }],
      sort_by: "timestamp",
      sort_order: "desc",
      query: "",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      available_columns: ["timestamp", "message"],
      log_distribution: [],
    };
    useLogResultStore.getState().setLogData(data);
    expect(useLogResultStore.getState().logData).toEqual(data);
  });

  it("clears data with null", () => {
    useLogResultStore.getState().setLogData({
      status: "success",
      total_count: 0,
      offset: 0,
      limit: 0,
      time_taken: 0,
      index_query_time: 0,
      count: 0,
      logs: [],
      sort_by: "",
      sort_order: "",
      query: "",
      start_date: "",
      end_date: "",
      available_columns: [],
      log_distribution: [],
    });
    useLogResultStore.getState().setLogData(null);
    expect(useLogResultStore.getState().logData).toBeNull();
  });
});

describe("setError", () => {
  it("sets an error message", () => {
    useLogResultStore.getState().setError("Network failure");
    expect(useLogResultStore.getState().error).toBe("Network failure");
  });

  it("clears error with null", () => {
    useLogResultStore.getState().setError("fail");
    useLogResultStore.getState().setError(null);
    expect(useLogResultStore.getState().error).toBeNull();
  });
});

describe("setLoading", () => {
  it("sets loading to true", () => {
    useLogResultStore.getState().setLoading(true);
    expect(useLogResultStore.getState().isLoading).toBe(true);
  });

  it("sets loading to false", () => {
    useLogResultStore.getState().setLoading(true);
    useLogResultStore.getState().setLoading(false);
    expect(useLogResultStore.getState().isLoading).toBe(false);
  });
});

describe("reset", () => {
  it("resets all state to defaults", () => {
    useLogResultStore.getState().setLogData({
      status: "success",
      total_count: 5,
      offset: 0,
      limit: 100,
      time_taken: 10,
      index_query_time: 5,
      count: 5,
      logs: [{ message: "test" }],
      sort_by: "timestamp",
      sort_order: "desc",
      query: "error",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      available_columns: ["timestamp"],
      log_distribution: [],
    });
    useLogResultStore.getState().setError("some error");
    useLogResultStore.getState().setLoading(true);

    useLogResultStore.getState().reset();

    const state = useLogResultStore.getState();
    expect(state.logData).toBeNull();
    expect(state.error).toBeNull();
    expect(state.isLoading).toBe(false);
  });
});
