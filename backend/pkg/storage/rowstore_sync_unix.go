//go:build !windows

package storage

import (
	"os"
	"syscall"
)

// syncWAL flushes WAL appends with fsync(2). On macOS os.File.Sync issues
// F_FULLFSYNC, which costs ~10 ms per call; the WAL runs on every live-tail
// flush, so it uses the plain call (as SQLite does by default). Appends
// survive a process crash either way; after a power loss, documents that
// point at lost WAL rows are removed when the day is reopened.
func syncWAL(f *os.File) error {
	return syscall.Fsync(int(f.Fd()))
}

// syncDirFast persists a rename in dir with fsync(2).
func syncDirFast(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return syncWAL(d)
}
