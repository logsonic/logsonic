//go:build windows

package main

import "syscall"

// detachedProcAttr: Windows has no sessions to detach from; a released
// process handle is enough for the CLI to exit without the server.
func detachedProcAttr() *syscall.SysProcAttr { return nil }
