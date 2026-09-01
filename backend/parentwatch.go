package main

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

// watchParentProcess exits the server when the process that spawned it dies
// (Force Quit / SIGKILL of Logsonic.app). The CLI leaves LOGSONIC_PARENT_PID
// unset, so this is a no-op outside the desktop wrapper.
func watchParentProcess() {
	raw := strings.TrimSpace(os.Getenv("LOGSONIC_PARENT_PID"))
	if raw == "" {
		return
	}
	want, err := strconv.Atoi(raw)
	if err != nil || want <= 1 {
		return
	}
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if os.Getppid() != want {
				log.Println("parent process is gone; shutting down")
				p, findErr := os.FindProcess(os.Getpid())
				if findErr == nil {
					_ = p.Signal(os.Interrupt)
				}
				return
			}
		}
	}()
}
