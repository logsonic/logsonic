package static

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed all:dist
var distContent embed.FS

// GetFileSystem returns a http.FileSystem that serves the embedded static files
// If the LOGSTATION_DEV environment variable is set, it will serve from the dist directory instead
func GetFileSystem() http.FileSystem {

	// In production, serve from the embedded filesystem
	// We need to use fs.Sub to get the dist subdirectory from the embedded FS
	subFS, err := fs.Sub(distContent, "dist")
	if err != nil {
		panic(err)
	}
	return http.FS(subFS)
}
