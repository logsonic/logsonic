//go:build !windows

package main

import "syscall"

// detachedProcAttr puts the spawned server in its own session so it
// outlives the CLI's terminal.
func detachedProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }
