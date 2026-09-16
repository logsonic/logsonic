//go:build !windows

package watch

import (
	"os"
	"syscall"
)

// fileID returns the (device, inode) pair that identifies a file across
// renames — what tells a rotated file (new inode, same name) from a grown
// one. Zero on platforms or filesystems that don't expose it.
func fileID(info os.FileInfo) (dev, ino uint64) {
	if st, ok := info.Sys().(*syscall.Stat_t); ok && st != nil {
		return uint64(st.Dev), uint64(st.Ino)
	}
	return 0, 0
}
