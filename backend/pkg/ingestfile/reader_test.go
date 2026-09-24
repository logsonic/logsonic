package ingestfile

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func write(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func gz(t *testing.T, data []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	w.Write(data)
	w.Close()
	return b.Bytes()
}

func zs(t *testing.T, data []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	w, err := zstd.NewWriter(&b)
	if err != nil {
		t.Fatal(err)
	}
	w.Write(data)
	w.Close()
	return b.Bytes()
}

func readAll(t *testing.T, path string) ([]string, *Reader) {
	t.Helper()
	r, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("Open(%s): %v", path, err)
	}
	t.Cleanup(func() { r.Close() })
	var lines []string
	for {
		line, ok, err := r.Next()
		if err != nil {
			t.Fatalf("Next: %v", err)
		}
		if !ok {
			break
		}
		lines = append(lines, line)
	}
	return lines, r
}

// R1: plain file with BOM, CRLF, a blank line, and no trailing newline.
func TestReaderPlainNormalisation(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, "a.log", []byte("\xEF\xBB\xBFfirst\r\nsecond\r\n\r\nthird"))
	lines, r := readAll(t, p)
	want := []string{"first", "second", "third"}
	if strings.Join(lines, "|") != strings.Join(want, "|") {
		t.Fatalf("lines = %q, want %q", lines, want)
	}
	if r.Info().Compression != None || r.BytesRead() != r.Info().SizeBytes {
		t.Errorf("info = %+v bytesRead = %d", r.Info(), r.BytesRead())
	}
}

// R2/R3: compression is sniffed, not inferred from the extension.
func TestReaderSniffsCompression(t *testing.T) {
	dir := t.TempDir()
	payload := []byte("alpha\nbeta\n")
	gzPath := write(t, dir, "wrong-ext.log", gz(t, payload))
	lines, r := readAll(t, gzPath)
	if len(lines) != 2 || r.Info().Compression != Gzip {
		t.Fatalf("gzip: lines=%q compression=%q", lines, r.Info().Compression)
	}
	if r.BytesRead() != r.Info().SizeBytes {
		t.Errorf("gzip progress should be in compressed bytes: read %d of %d", r.BytesRead(), r.Info().SizeBytes)
	}
	zsPath := write(t, dir, "b.log.zst", zs(t, payload))
	lines, r = readAll(t, zsPath)
	if len(lines) != 2 || r.Info().Compression != Zstd {
		t.Fatalf("zstd: lines=%q compression=%q", lines, r.Info().Compression)
	}
}

// R4: a too-long line names its line number and never buffers past the limit.
func TestReaderLineTooLong(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, "long.log", []byte("ok\n"+strings.Repeat("x", MaxLineBytes+1)+"\nafter\n"))
	r, err := Open(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, ok, err := r.Next(); !ok || err != nil {
		t.Fatalf("first line: ok=%v err=%v", ok, err)
	}
	_, _, err = r.Next()
	var tooLong *LineTooLongError
	if !errors.As(err, &tooLong) || tooLong.Line != 2 {
		t.Fatalf("want LineTooLongError for line 2, got %v", err)
	}
}

// R5: cancellation stops the iterator promptly.
func TestReaderContextCancel(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, "c.log", []byte(strings.Repeat("row\n", 1000)))
	ctx, cancel := context.WithCancel(context.Background())
	r, err := Open(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	r.Next()
	cancel()
	if _, ok, err := r.Next(); ok || !errors.Is(err, context.Canceled) {
		t.Fatalf("after cancel: ok=%v err=%v", ok, err)
	}
}

// R8/R9: refused inputs and symlink resolution.
func TestReaderPathPolicy(t *testing.T) {
	dir := t.TempDir()
	if _, err := Open(context.Background(), "relative.log"); !errors.Is(err, ErrNotAbsolute) {
		t.Errorf("relative path: %v", err)
	}
	if _, err := Open(context.Background(), dir); !errors.Is(err, ErrIsDirectory) {
		t.Errorf("directory: %v", err)
	}
	if _, err := Open(context.Background(), filepath.Join(dir, "missing.log")); err == nil {
		t.Errorf("missing file must error")
	}
	real := write(t, dir, "real.log", []byte("x\n"))
	link := filepath.Join(dir, "link.log")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("symlinks unsupported here")
	}
	_, r := readAll(t, link)
	if r.Info().Path != link || r.Info().CanonicalPath != mustReal(t, real) {
		t.Errorf("symlink info = %+v", r.Info())
	}
}

func mustReal(t *testing.T, p string) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

// R6: numeric rotation order (highest number is oldest), with the
// uncompressed member winning over its compressed twin.
func TestExpandRotationNumeric(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"app.log", "app.log.1", "app.log.1.gz", "app.log.2.gz", "app.log.10", "other.log.3", "app.log.bak"} {
		write(t, dir, n, []byte("x\n"))
	}
	got, err := ExpandRotation(filepath.Join(dir, "app.log"))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"app.log.10", "app.log.2.gz", "app.log.1", "app.log"}
	if strings.Join(names(got), ",") != strings.Join(want, ",") {
		t.Fatalf("got %v, want %v", names(got), want)
	}
}

// R7: date-suffixed rotation ascends; base last; no siblings -> just the base.
func TestExpandRotationDated(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"app.log", "app-2026-08-31.log.gz", "app-2026-08-30.log", "app.2026-08-29.log"} {
		write(t, dir, n, []byte("x\n"))
	}
	got, err := ExpandRotation(filepath.Join(dir, "app.log"))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"app.2026-08-29.log", "app-2026-08-30.log", "app-2026-08-31.log.gz", "app.log"}
	if strings.Join(names(got), ",") != strings.Join(want, ",") {
		t.Fatalf("got %v, want %v", names(got), want)
	}
	lonely := write(t, dir, "lonely.log", []byte("x\n"))
	got, _ = ExpandRotation(lonely)
	if len(got) != 1 || got[0] != lonely {
		t.Fatalf("lonely base: %v", got)
	}
}

func names(paths []string) []string {
	out := make([]string, len(paths))
	for i, p := range paths {
		out[i] = filepath.Base(p)
	}
	return out
}
