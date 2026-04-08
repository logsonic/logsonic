import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useImportStore,
  DEFAULT_PATTERN,
  DEFAULT_SESSION_OPTIONS,
} from "../useImportStore";

// Mock api-client to prevent real network calls
vi.mock("@/lib/api-client", () => ({
  parseLogs: vi.fn().mockResolvedValue({ logs: [{ message: "parsed" }] }),
}));

// Reset store before each test
beforeEach(() => {
  useImportStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Initial State
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("starts at step 1", () => {
    expect(useImportStore.getState().currentStep).toBe(1);
  });

  it("has no import source", () => {
    expect(useImportStore.getState().importSource).toBeNull();
  });

  it("has default pattern selected", () => {
    const state = useImportStore.getState();
    expect(state.selectedPattern).toEqual(DEFAULT_PATTERN);
  });

  it("has no files", () => {
    expect(useImportStore.getState().files).toEqual([]);
  });

  it("has no active file", () => {
    expect(useImportStore.getState().activeFileId).toBeNull();
  });

  it("is not uploading", () => {
    const state = useImportStore.getState();
    expect(state.isUploading).toBe(false);
    expect(state.uploadProgress).toBe(0);
  });

  it("has no error", () => {
    expect(useImportStore.getState().error).toBeNull();
  });

  it("has smart decoder enabled by default", () => {
    expect(useImportStore.getState().sessionOptionsSmartDecoder).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step Management
// ---------------------------------------------------------------------------

describe("step management", () => {
  it("setCurrentStep changes the step", () => {
    useImportStore.getState().setCurrentStep(2);
    expect(useImportStore.getState().currentStep).toBe(2);
  });

  it("setCurrentStep to step 3", () => {
    useImportStore.getState().setCurrentStep(3);
    expect(useImportStore.getState().currentStep).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Import Source
// ---------------------------------------------------------------------------

describe("import source", () => {
  it("setImportSource sets the source", () => {
    useImportStore.getState().setImportSource("local-file");
    expect(useImportStore.getState().importSource).toBe("local-file");
  });

  it("setImportSource to null", () => {
    useImportStore.getState().setImportSource("cloudwatch");
    useImportStore.getState().setImportSource(null);
    expect(useImportStore.getState().importSource).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-file Management
// ---------------------------------------------------------------------------

describe("multi-file management", () => {
  const makeFile = (name: string) =>
    new File(["content"], name, { type: "text/plain" });

  it("addFiles adds files to the list", () => {
    useImportStore.getState().addFiles([makeFile("a.log"), makeFile("b.log")]);
    const files = useImportStore.getState().files;
    expect(files).toHaveLength(2);
    expect(files[0].fileName).toBe("a.log");
    expect(files[1].fileName).toBe("b.log");
  });

  it("addFiles assigns unique IDs", () => {
    useImportStore.getState().addFiles([makeFile("a.log"), makeFile("b.log")]);
    const files = useImportStore.getState().files;
    expect(files[0].id).not.toBe(files[1].id);
  });

  it("addFiles initializes default session options", () => {
    useImportStore.getState().addFiles([makeFile("test.log")]);
    const file = useImportStore.getState().files[0];
    expect(file.sessionOptions).toEqual(DEFAULT_SESSION_OPTIONS);
  });

  it("addFiles sets detection status to pending", () => {
    useImportStore.getState().addFiles([makeFile("test.log")]);
    expect(useImportStore.getState().files[0].detectionStatus).toBe("pending");
  });

  it("removeFile removes the file by ID", () => {
    useImportStore.getState().addFiles([makeFile("a.log"), makeFile("b.log")]);
    const fileId = useImportStore.getState().files[0].id;
    useImportStore.getState().removeFile(fileId);
    expect(useImportStore.getState().files).toHaveLength(1);
    expect(useImportStore.getState().files[0].fileName).toBe("b.log");
  });

  it("removeFile clears activeFileId if it matches", () => {
    useImportStore.getState().addFiles([makeFile("a.log")]);
    const fileId = useImportStore.getState().files[0].id;
    useImportStore.getState().setActiveFileId(fileId);
    useImportStore.getState().removeFile(fileId);
    expect(useImportStore.getState().activeFileId).toBeNull();
  });

  it("removeFile preserves activeFileId if different", () => {
    useImportStore
      .getState()
      .addFiles([makeFile("a.log"), makeFile("b.log")]);
    const [fileA, fileB] = useImportStore.getState().files;
    useImportStore.getState().setActiveFileId(fileB.id);
    useImportStore.getState().removeFile(fileA.id);
    expect(useImportStore.getState().activeFileId).toBe(fileB.id);
  });

  it("setActiveFileId sets the active file", () => {
    useImportStore.getState().addFiles([makeFile("a.log")]);
    const fileId = useImportStore.getState().files[0].id;
    useImportStore.getState().setActiveFileId(fileId);
    expect(useImportStore.getState().activeFileId).toBe(fileId);
  });

  it("getActiveFile returns the active file", () => {
    useImportStore.getState().addFiles([makeFile("a.log")]);
    const fileId = useImportStore.getState().files[0].id;
    useImportStore.getState().setActiveFileId(fileId);
    const active = useImportStore.getState().getActiveFile();
    expect(active).not.toBeNull();
    expect(active!.fileName).toBe("a.log");
  });

  it("getActiveFile returns null when no active file", () => {
    expect(useImportStore.getState().getActiveFile()).toBeNull();
  });

  it("updateFile updates specific file properties", () => {
    useImportStore.getState().addFiles([makeFile("a.log")]);
    const fileId = useImportStore.getState().files[0].id;
    useImportStore.getState().updateFile(fileId, {
      approxLines: 500,
      detectionStatus: "detected",
    });
    const file = useImportStore.getState().files[0];
    expect(file.approxLines).toBe(500);
    expect(file.detectionStatus).toBe("detected");
  });

  it("updateFilePattern updates pattern for specific file", () => {
    useImportStore.getState().addFiles([makeFile("a.log")]);
    const fileId = useImportStore.getState().files[0].id;
    const pattern = {
      name: "syslog",
      pattern: "%{SYSLOGTIMESTAMP:ts} %{GREEDYDATA:msg}",
      description: "Syslog",
      fields: ["ts", "msg"],
      custom_patterns: {},
      priority: 1,
    };
    useImportStore.getState().updateFilePattern(fileId, pattern);
    const file = useImportStore.getState().files[0];
    expect(file.selectedPattern).toEqual(pattern);
    expect(file.isCustomPattern).toBe(false);
  });

  it("updateFilePattern marks custom pattern correctly", () => {
    useImportStore.getState().addFiles([makeFile("a.log")]);
    const fileId = useImportStore.getState().files[0].id;
    useImportStore.getState().updateFilePattern(fileId, DEFAULT_PATTERN);
    expect(useImportStore.getState().files[0].isCustomPattern).toBe(true);
  });

  it("updateFileSessionOptions merges session options", () => {
    useImportStore.getState().addFiles([makeFile("a.log")]);
    const fileId = useImportStore.getState().files[0].id;
    useImportStore
      .getState()
      .updateFileSessionOptions(fileId, { timezone: "UTC", year: "2024" });
    const opts = useImportStore.getState().files[0].sessionOptions;
    expect(opts.timezone).toBe("UTC");
    expect(opts.year).toBe("2024");
    expect(opts.smartDecoder).toBe(true); // unchanged
  });

  it("setAllFilesPattern applies pattern to all files", () => {
    useImportStore
      .getState()
      .addFiles([makeFile("a.log"), makeFile("b.log")]);
    const pattern = {
      name: "apache",
      pattern: "%{COMBINEDAPACHELOG}",
      description: "Apache",
      fields: [],
      custom_patterns: {},
      priority: 2,
    };
    useImportStore.getState().setAllFilesPattern(pattern);
    const files = useImportStore.getState().files;
    expect(files[0].selectedPattern).toEqual(pattern);
    expect(files[1].selectedPattern).toEqual(pattern);
    expect(files[0].isCustomPattern).toBe(false);
    expect(files[1].isCustomPattern).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pattern Management
// ---------------------------------------------------------------------------

describe("pattern management", () => {
  it("setSelectedPattern updates pattern", () => {
    const pattern = {
      name: "test",
      pattern: "%{IP:ip}",
      description: "IP",
      fields: ["ip"],
      custom_patterns: {},
      priority: 1,
    };
    useImportStore.getState().setSelectedPattern(pattern);
    expect(useImportStore.getState().selectedPattern).toEqual(pattern);
    expect(useImportStore.getState().isCreateNewPatternSelected).toBe(false);
  });

  it("setSelectedPattern with default name sets isCreateNewPatternSelected", () => {
    useImportStore.getState().setSelectedPattern(DEFAULT_PATTERN);
    expect(useImportStore.getState().isCreateNewPatternSelected).toBe(true);
  });

  it("setAvailablePatterns always includes default", () => {
    useImportStore.getState().setAvailablePatterns([
      {
        name: "syslog",
        pattern: "%{SYSLOGTIMESTAMP:ts}",
        priority: 1,
      },
    ]);
    const patterns = useImportStore.getState().availablePatterns;
    expect(patterns[0].name).toBe(DEFAULT_PATTERN.name);
    expect(patterns).toHaveLength(2);
  });

  it("setAvailablePatterns deduplicates default pattern", () => {
    useImportStore.getState().setAvailablePatterns([
      {
        name: DEFAULT_PATTERN.name,
        pattern: DEFAULT_PATTERN.pattern,
        priority: 0,
      },
    ]);
    const patterns = useImportStore.getState().availablePatterns;
    // Should only have one instance of the default
    const defaultCount = patterns.filter(
      (p) => p.name === DEFAULT_PATTERN.name
    ).length;
    expect(defaultCount).toBe(1);
  });

  it("setCreateNewPattern sets pattern and marks as custom", () => {
    const custom = {
      ...DEFAULT_PATTERN,
      pattern: "%{IP:client} %{GREEDYDATA:message}",
    };
    useImportStore.getState().setCreateNewPattern(custom);
    expect(useImportStore.getState().createNewPattern).toEqual(custom);
    expect(useImportStore.getState().isCreateNewPatternSelected).toBe(true);
  });

  it("setCreateNewPatternTokens updates tokens", () => {
    useImportStore
      .getState()
      .setCreateNewPatternTokens({ IP: "\\d+\\.\\d+\\.\\d+\\.\\d+" });
    expect(useImportStore.getState().createNewPatternTokens).toEqual({
      IP: "\\d+\\.\\d+\\.\\d+\\.\\d+",
    });
  });

  it("setCreateNewPatternName updates name", () => {
    useImportStore.getState().setCreateNewPatternName("My Pattern");
    expect(useImportStore.getState().createNewPatternName).toBe("My Pattern");
  });

  it("setCreateNewPatternDescription updates description", () => {
    useImportStore.getState().setCreateNewPatternDescription("Test desc");
    expect(useImportStore.getState().createNewPatternDescription).toBe(
      "Test desc"
    );
  });

  it("setCreateNewPatternPriority updates priority", () => {
    useImportStore.getState().setCreateNewPatternPriority(5);
    expect(useImportStore.getState().createNewPatternPriority).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Upload State
// ---------------------------------------------------------------------------

describe("upload state", () => {
  it("setIsUploading toggles uploading state", () => {
    useImportStore.getState().setIsUploading(true);
    expect(useImportStore.getState().isUploading).toBe(true);
    useImportStore.getState().setIsUploading(false);
    expect(useImportStore.getState().isUploading).toBe(false);
  });

  it("setUploadProgress updates progress", () => {
    useImportStore.getState().setUploadProgress(75);
    expect(useImportStore.getState().uploadProgress).toBe(75);
  });

  it("setApproxLines updates line count", () => {
    useImportStore.getState().setApproxLines(10000);
    expect(useImportStore.getState().approxLines).toBe(10000);
  });

  it("setTotalLines updates total lines", () => {
    useImportStore.getState().setTotalLines(50000);
    expect(useImportStore.getState().totalLines).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// Session Options
// ---------------------------------------------------------------------------

describe("session options", () => {
  it("setSessionID stores the session ID", () => {
    useImportStore.getState().setSessionID("abc-123");
    expect(useImportStore.getState().sessionID).toBe("abc-123");
  });

  it("setSessionOptionFileName updates filename", () => {
    useImportStore.getState().setSessionOptionFileName("my.log");
    expect(useImportStore.getState().sessionOptionsFileName).toBe("my.log");
  });

  it("setSessionOptionSmartDecoder toggles decoder", () => {
    useImportStore.getState().setSessionOptionSmartDecoder(false);
    expect(useImportStore.getState().sessionOptionsSmartDecoder).toBe(false);
  });

  it("setSessionOptionTimezone updates timezone", () => {
    useImportStore.getState().setSessionOptionTimezone("America/New_York");
    expect(useImportStore.getState().sessionOptionsTimezone).toBe(
      "America/New_York"
    );
  });

  it("setSessionOptionYear updates year", () => {
    useImportStore.getState().setSessionOptionYear("2023");
    expect(useImportStore.getState().sessionOptionsYear).toBe("2023");
  });

  it("setSessionOptionMonth updates month", () => {
    useImportStore.getState().setSessionOptionMonth("6");
    expect(useImportStore.getState().sessionOptionsMonth).toBe("6");
  });

  it("setSessionOptionDay updates day", () => {
    useImportStore.getState().setSessionOptionDay("15");
    expect(useImportStore.getState().sessionOptionsDay).toBe("15");
  });
});

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("setError sets the error", () => {
    useImportStore.getState().setError("Something failed");
    expect(useImportStore.getState().error).toBe("Something failed");
  });

  it("setError clears the error with null", () => {
    useImportStore.getState().setError("fail");
    useImportStore.getState().setError(null);
    expect(useImportStore.getState().error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("metadata", () => {
  it("setMetadata stores metadata", () => {
    useImportStore
      .getState()
      .setMetadata({ aws_region: "us-west-2", log_group: "my-group" });
    const meta = useImportStore.getState().metadata;
    expect(meta.aws_region).toBe("us-west-2");
    expect(meta.log_group).toBe("my-group");
  });
});

// ---------------------------------------------------------------------------
// Detection & Suggest
// ---------------------------------------------------------------------------

describe("detection and suggest", () => {
  it("setDetectionResult stores result", () => {
    const result = { isOngoing: false, suggestedPattern: DEFAULT_PATTERN };
    useImportStore.getState().setDetectionResult(result);
    expect(useImportStore.getState().detectionResult).toEqual(result);
  });

  it("setDetectionResult clears with null", () => {
    useImportStore.getState().setDetectionResult({ isOngoing: true });
    useImportStore.getState().setDetectionResult(null);
    expect(useImportStore.getState().detectionResult).toBeNull();
  });

  it("setSuggestResponse stores response", () => {
    const resp = { status: "success", type: "autosuggest", results: [] };
    useImportStore.getState().setSuggestResponse(resp);
    expect(useImportStore.getState().suggestResponse).toEqual(resp);
  });
});

// ---------------------------------------------------------------------------
// Parsed Logs
// ---------------------------------------------------------------------------

describe("parsed logs", () => {
  it("setParsedLogs updates parsed logs", () => {
    const logs = [{ message: "test" }];
    useImportStore.getState().setParsedLogs(logs);
    expect(useImportStore.getState().parsedLogs).toEqual(logs);
  });

  it("setIsTestingPattern toggles testing state", () => {
    useImportStore.getState().setIsTestingPattern(true);
    expect(useImportStore.getState().isTestingPattern).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// File Preview (Legacy)
// ---------------------------------------------------------------------------

describe("file preview (legacy)", () => {
  it("setSelectedFileName updates filename", () => {
    useImportStore.getState().setSelectedFileName("app.log");
    expect(useImportStore.getState().selectedFileName).toBe("app.log");
  });

  it("setFilePreviewBuffer updates preview", () => {
    const preview = { lines: ["line 1", "line 2"], filename: "test.log" };
    useImportStore.getState().setFilePreviewBuffer(preview);
    expect(useImportStore.getState().filePreviewBuffer).toEqual(preview);
  });

  it("setReadyToSelectPattern updates readiness", () => {
    useImportStore.getState().setReadyToSelectPattern(true);
    expect(useImportStore.getState().readyToSelectPattern).toBe(true);
  });

  it("setReadyToImportLogs updates readiness", () => {
    useImportStore.getState().setReadyToImportLogs(true);
    expect(useImportStore.getState().readyToImportLogs).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handlePatternOperation
// ---------------------------------------------------------------------------

describe("handlePatternOperation", () => {
  it("sets error when no file selected", async () => {
    await useImportStore
      .getState()
      .handlePatternOperation(DEFAULT_PATTERN, true);
    expect(useImportStore.getState().error).toBe(
      "No file selected or file preview not available"
    );
  });

  it("calls onError callback when no file selected", async () => {
    const onError = vi.fn();
    await useImportStore
      .getState()
      .handlePatternOperation(DEFAULT_PATTERN, true, undefined, onError);
    expect(onError).toHaveBeenCalledWith(
      "No file selected or file preview not available"
    );
  });

  it("sets error when preview has no lines", async () => {
    useImportStore.getState().setSelectedFileName("test.log");
    useImportStore
      .getState()
      .setFilePreviewBuffer({ lines: [], filename: "test.log" });

    await useImportStore
      .getState()
      .handlePatternOperation(DEFAULT_PATTERN, true);
    expect(useImportStore.getState().error).toBe(
      "No preview lines available to parse"
    );
  });

  it("clears isTestingPattern after operation", async () => {
    useImportStore.getState().setSelectedFileName("test.log");
    useImportStore
      .getState()
      .setFilePreviewBuffer({ lines: ["log line"], filename: "test.log" });

    await useImportStore
      .getState()
      .handlePatternOperation(DEFAULT_PATTERN, true);
    expect(useImportStore.getState().isTestingPattern).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// testPattern
// ---------------------------------------------------------------------------

describe("testPattern", () => {
  it("sets error when no pattern selected", async () => {
    useImportStore.getState().setSelectedPattern(null);
    useImportStore.setState({ isCreateNewPatternSelected: false });
    await useImportStore.getState().testPattern();
    expect(useImportStore.getState().error).toBe("No pattern selected");
  });
});

// ---------------------------------------------------------------------------
// Provider Upload Handler
// ---------------------------------------------------------------------------

describe("provider upload handler", () => {
  it("setProviderUploadHandler stores handler", () => {
    const handler = vi.fn();
    useImportStore.getState().setProviderUploadHandler(handler);
    expect(useImportStore.getState().providerUploadHandler).toBe(handler);
  });

  it("setProviderUploadHandler clears with null", () => {
    useImportStore.getState().setProviderUploadHandler(vi.fn());
    useImportStore.getState().setProviderUploadHandler(null);
    expect(useImportStore.getState().providerUploadHandler).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("resets all state to defaults", () => {
    // Modify many fields
    useImportStore.getState().setCurrentStep(3);
    useImportStore.getState().setImportSource("cloudwatch");
    useImportStore.getState().setIsUploading(true);
    useImportStore.getState().setUploadProgress(50);
    useImportStore.getState().setError("some error");
    useImportStore.getState().setSessionID("sess-123");
    useImportStore
      .getState()
      .addFiles([new File(["x"], "x.log", { type: "text/plain" })]);

    // Reset
    useImportStore.getState().reset();

    const state = useImportStore.getState();
    expect(state.currentStep).toBe(1);
    expect(state.importSource).toBeNull();
    expect(state.isUploading).toBe(false);
    expect(state.uploadProgress).toBe(0);
    expect(state.error).toBeNull();
    expect(state.sessionID).toBeNull();
    expect(state.files).toEqual([]);
    expect(state.activeFileId).toBeNull();
    expect(state.selectedPattern).toEqual(DEFAULT_PATTERN);
    expect(state.isCreateNewPatternSelected).toBe(false);
    expect(state.parsedLogs).toEqual([]);
    expect(state.detectionResult).toBeNull();
    expect(state.sessionOptionsSmartDecoder).toBe(true);
    expect(state.sessionOptionsTimezone).toBe("");
    expect(state.providerUploadHandler).toBeNull();
  });
});
