//go:build !darwin

package main

// relaunchForApp is a no-op on non-macOS platforms: the Terminal re-launch only
// applies to the macOS .app bundle. See app_relaunch_darwin.go.
func relaunchForApp() bool { return false }
