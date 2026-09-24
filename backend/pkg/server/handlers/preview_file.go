package handlers

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"

	"logsonic/pkg/ingestfile"
	"logsonic/pkg/types"
)

const (
	// defaultPreviewLines matches the spec's API contract default.
	defaultPreviewLines = 100
	// maxPreviewLines bounds a caller-supplied "lines" so this endpoint
	// stays a quick peek, not an alternate way to read a whole file.
	maxPreviewLines = MaxIngestLines
	// maxPreviewBytes bounds the decoded (uncompressed) size of the
	// returned lines, independent of maxPreviewLines: 100 lines is the
	// spec's default, but a handful of multi-MB JSON-per-line records
	// would otherwise turn "preview" into shipping most of a huge file to
	// the browser. Matches the order of magnitude of the browser upload
	// wizard's own preview read (FileSelectionService.readFilePreview,
	// 1 MB) so both preview paths cost about the same either way.
	maxPreviewBytes = 1 << 20
)

// @Summary Preview a file by path
// @Description Read the first few lines of a file the server can access (absolute path; gzip and zstd detected by magic bytes), without creating an ingest session. Used by the native-drop wizard flow, which only ever has a path, not a browser File to read.
// @Tags ingest
// @Accept json
// @Produce json
// @Param request body types.PreviewFileRequest true "Absolute path and optional line count"
// @Success 200 {object} types.PreviewFileResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /parse/preview-file [post]
func (h *Services) HandlePreviewFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	var req types.PreviewFileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeIngestFileError(w, http.StatusBadRequest, "INVALID_REQUEST", "Invalid request body", err.Error())
		return
	}
	if req.Path == "" {
		writeIngestFileError(w, http.StatusBadRequest, "INVALID_PATH", "path is required (absolute path to a readable file)", "")
		return
	}
	wantLines := req.Lines
	if wantLines <= 0 {
		wantLines = defaultPreviewLines
	}
	if wantLines > maxPreviewLines {
		wantLines = maxPreviewLines
	}

	reader, err := ingestfile.Open(r.Context(), req.Path)
	if err != nil {
		writeIngestFileError(w, http.StatusBadRequest, "INVALID_PATH", "Cannot open file", err.Error())
		return
	}
	defer reader.Close()

	lines := make([]string, 0, wantLines)
	var sampledBytes int64
	reachedEOF := false
	for len(lines) < wantLines && sampledBytes < maxPreviewBytes {
		line, ok, readErr := reader.Next()
		if readErr != nil {
			// A too-long line is the caller's file being malformed for
			// this purpose -- 400, like every other path-shape problem
			// this endpoint reports. Anything else (a truncated/corrupt
			// gzip stream, an I/O error mid-read) is a server-side read
			// failure on an otherwise-valid path, not an invalid path.
			var tooLong *ingestfile.LineTooLongError
			if errors.As(readErr, &tooLong) {
				writeIngestFileError(w, http.StatusBadRequest, "INVALID_PATH", "Cannot read file", readErr.Error())
			} else {
				writeIngestFileError(w, http.StatusInternalServerError, "READ_ERROR", "Cannot read file", readErr.Error())
			}
			return
		}
		if !ok {
			reachedEOF = true
			break
		}
		lines = append(lines, line)
		sampledBytes += int64(len(line)) + 1 // +1 for the newline Next() stripped
	}

	info := reader.Info()
	json.NewEncoder(w).Encode(types.PreviewFileResponse{
		Lines:       lines,
		ApproxLines: approxLineCount(len(lines), sampledBytes, info.SizeBytes, string(info.Compression), reachedEOF),
		Compressed:  string(info.Compression),
		SizeBytes:   info.SizeBytes,
	})
}

// approxLineCount estimates the file's total line count from the lines
// actually decoded:
//
//   - reachedEOF means the whole file was read, so linesRead is exact.
//   - Otherwise, for an uncompressed file, sizeBytes is the file's actual
//     content size, so extrapolating from the sample's average bytes-per-
//     line against it is dimensionally sound and independent of how
//     ingestfile's internal buffering happened to read the underlying
//     descriptor (an earlier version used Reader.BytesRead() for this and
//     got it wrong: for any file smaller than the reader's 64KB peek
//     buffer, the very first Peek() pulls the whole file in one
//     underlying Read, so BytesRead() reports the full on-disk size
//     almost immediately regardless of how many lines have actually been
//     consumed -- the same pitfall applies to now-08 phase 2's
//     ingest_progress.bytes_read for any file under 64KB).
//   - For a compressed file that wasn't fully read, sizeBytes is the
//     on-disk *compressed* size, which has no fixed relationship to the
//     uncompressed line count without knowing the compression ratio of
//     the unread remainder. Rather than fabricate a number that could be
//     off by an order of magnitude, this returns linesRead itself: an
//     honest lower bound, not a guess.
func approxLineCount(linesRead int, sampledBytes, sizeBytes int64, compression string, reachedEOF bool) int64 {
	if reachedEOF || linesRead == 0 {
		return int64(linesRead)
	}
	if compression != "" || sampledBytes <= 0 || sizeBytes <= 0 {
		return int64(linesRead)
	}
	return int64(math.Round(float64(linesRead) * float64(sizeBytes) / float64(sampledBytes)))
}
