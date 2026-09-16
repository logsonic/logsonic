// Package ingestfile reads log files by path for server-side ingestion: it
// sniffs gzip/zstd by magic bytes, iterates physical lines with the same
// limits and normalisation the browser upload path applies, reports progress
// in compressed bytes, and expands rotated-file sets. It has no HTTP
// dependencies so folder watch (now-04) and `logsonic open` (now-12) can call
// it directly. Spec: specs/now-08-native-path-import.md.
package ingestfile

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/klauspost/compress/zstd"
)

// MaxLineBytes is the physical line limit, shared with the chunk-ingest
// endpoint (handlers.MaxIngestLineBytes aliases it) so both paths reject the
// same input.
const MaxLineBytes = 2 * 1024 * 1024

// Compression is the detected encoding of the file on disk.
type Compression string

const (
	None Compression = ""
	Gzip Compression = "gzip"
	Zstd Compression = "zstd"
)

var (
	gzipMagic = []byte{0x1f, 0x8b}
	zstdMagic = []byte{0x28, 0xb5, 0x2f, 0xfd}
)

// Info describes an opened file. CanonicalPath has symlinks resolved so the
// caller can show the user exactly what was read. SizeBytes is the on-disk
// (compressed) size, the denominator for BytesRead-based progress.
type Info struct {
	Path          string      `json:"path"`
	CanonicalPath string      `json:"canonical_path"`
	SizeBytes     int64       `json:"size_bytes"`
	Compression   Compression `json:"compression,omitempty"`
	ModTime       time.Time   `json:"mod_time"`
}

// ErrNotAbsolute, ErrIsDirectory are returned by Open for paths it refuses.
var (
	ErrNotAbsolute = errors.New("path must be absolute")
	ErrIsDirectory = errors.New("path is a directory, not a file")
)

// LineTooLongError names the offending line so the user can find it.
type LineTooLongError struct {
	Line  int
	Limit int
}

func (e *LineTooLongError) Error() string {
	return fmt.Sprintf("line %d exceeds the %d-byte limit", e.Line, e.Limit)
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// Reader iterates the non-empty physical lines of a file.
type Reader struct {
	ctx       context.Context
	info      Info
	file      *os.File  // nil for OpenReader
	srcCloser io.Closer // OpenReader's source, when it can be closed
	counter   *countingReader
	closer    io.Closer // decompressor, when any
	buf       *bufio.Reader
	line      int // physical lines consumed, 1-based for error messages
	first     bool
}

// Open validates path (absolute, exists, not a directory), resolves symlinks,
// sniffs the compression by magic bytes -- the extension is only a hint -- and
// returns a Reader positioned at the first line.
func Open(ctx context.Context, path string) (*Reader, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("%w: %s", ErrNotAbsolute, path)
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(canonical)
	if err != nil {
		return nil, err
	}
	if st.IsDir() {
		return nil, fmt.Errorf("%w: %s", ErrIsDirectory, path)
	}
	f, err := os.Open(canonical)
	if err != nil {
		return nil, err
	}
	counter := &countingReader{r: f}
	head := bufio.NewReaderSize(counter, 64*1024)
	magic, _ := head.Peek(4)

	r := &Reader{ctx: ctx, file: f, counter: counter, first: true}
	r.info = Info{Path: path, CanonicalPath: canonical, SizeBytes: st.Size(), ModTime: st.ModTime()}
	switch {
	case bytes.HasPrefix(magic, gzipMagic):
		gz, gzErr := gzip.NewReader(head)
		if gzErr != nil {
			f.Close()
			return nil, fmt.Errorf("gzip: %w", gzErr)
		}
		r.info.Compression = Gzip
		r.closer = gz
		r.buf = bufio.NewReaderSize(gz, 256*1024)
	case bytes.HasPrefix(magic, zstdMagic):
		zr, zErr := zstd.NewReader(head)
		if zErr != nil {
			f.Close()
			return nil, fmt.Errorf("zstd: %w", zErr)
		}
		r.info.Compression = Zstd
		r.closer = zr.IOReadCloser()
		r.buf = bufio.NewReaderSize(zr, 256*1024)
	default:
		r.buf = head
	}
	return r, nil
}

// OpenReader wraps an in-memory or streamed source the same way Open wraps
// a file — compression sniffed, the same line iterator and bounds — for
// bytes that never live on the user's disk (the bundled samples, spec
// now-12). name is what Info reports as the path; size is the byte length
// when known (progress), else 0.
func OpenReader(ctx context.Context, src io.Reader, name string, size int64) (*Reader, error) {
	counter := &countingReader{r: src}
	head := bufio.NewReaderSize(counter, 64*1024)
	magic, _ := head.Peek(4)
	r := &Reader{ctx: ctx, counter: counter, first: true}
	r.info = Info{Path: name, CanonicalPath: name, SizeBytes: size}
	switch {
	case bytes.HasPrefix(magic, gzipMagic):
		gz, gzErr := gzip.NewReader(head)
		if gzErr != nil {
			return nil, fmt.Errorf("gzip: %w", gzErr)
		}
		r.info.Compression = Gzip
		r.closer = gz
		r.buf = bufio.NewReaderSize(gz, 256*1024)
	case bytes.HasPrefix(magic, zstdMagic):
		zr, zErr := zstd.NewReader(head)
		if zErr != nil {
			return nil, fmt.Errorf("zstd: %w", zErr)
		}
		r.info.Compression = Zstd
		r.closer = zr.IOReadCloser()
		r.buf = bufio.NewReaderSize(zr, 256*1024)
	default:
		r.buf = head
	}
	if c, ok := src.(io.Closer); ok {
		r.srcCloser = c
	}
	return r, nil
}

// Info returns the file description captured at Open.
func (r *Reader) Info() Info { return r.info }

// BytesRead is the number of on-disk bytes consumed so far (compressed bytes
// for gzip/zstd), suitable for a progress fraction against Info.SizeBytes.
func (r *Reader) BytesRead() int64 { return r.counter.n }

// Lines is the number of physical lines consumed so far, including empty ones.
func (r *Reader) Lines() int { return r.line }

// Next returns the next non-empty line with the trailing newline and any
// trailing '\r' removed and a leading UTF-8 BOM stripped from the first line
// -- the same normalisation the browser upload path applies, so the two
// ingest routes store identical rows. ok is false at EOF; err reports a
// context cancellation, a too-long line, or an I/O/decompression failure.
func (r *Reader) Next() (line string, ok bool, err error) {
	for {
		if err := r.ctx.Err(); err != nil {
			return "", false, err
		}
		raw, readErr := r.readLine()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return "", false, readErr
		}
		if len(raw) == 0 && errors.Is(readErr, io.EOF) {
			return "", false, nil
		}
		r.line++
		if r.first {
			r.first = false
			raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
		}
		raw = bytes.TrimSuffix(raw, []byte{'\n'})
		raw = bytes.TrimSuffix(raw, []byte{'\r'})
		if len(raw) == 0 {
			if errors.Is(readErr, io.EOF) {
				return "", false, nil
			}
			continue
		}
		return string(raw), true, nil
	}
}

// readLine accumulates one physical line, enforcing MaxLineBytes without
// ever buffering more than the limit.
func (r *Reader) readLine() ([]byte, error) {
	var acc []byte
	for {
		chunk, err := r.buf.ReadSlice('\n')
		acc = append(acc, chunk...)
		if len(acc) > MaxLineBytes {
			return nil, &LineTooLongError{Line: r.line + 1, Limit: MaxLineBytes}
		}
		if err == nil {
			return acc, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return acc, err // io.EOF (possibly with a final unterminated line) or a real error
	}
}

// Close releases the decompressor and the file.
func (r *Reader) Close() error {
	if r.closer != nil {
		_ = r.closer.Close()
	}
	if r.file == nil {
		if r.srcCloser != nil {
			return r.srcCloser.Close()
		}
		return nil
	}
	return r.file.Close()
}
