//go:build windows

package storage

import "os"

func syncWAL(f *os.File) error {
	return f.Sync()
}

// syncDirFast is a no-op: Windows cannot sync directory handles through
// os.File (see syncTemplateDir).
func syncDirFast(string) error { return nil }
