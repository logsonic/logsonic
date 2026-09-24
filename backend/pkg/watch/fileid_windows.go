//go:build windows

package watch

import "os"

// fileID has no cheap inode equivalent on Windows; the resume decision then
// falls back to size ≥ offset alone.
func fileID(os.FileInfo) (dev, ino uint64) { return 0, 0 }
