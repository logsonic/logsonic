package main

import (
	"os"
	"strconv"
	"testing"
)

func TestWatchParentProcessNoopWithoutEnv(t *testing.T) {
	t.Setenv("LOGSONIC_PARENT_PID", "")
	watchParentProcess()
}

func TestWatchParentProcessIgnoresInvalidPID(t *testing.T) {
	t.Setenv("LOGSONIC_PARENT_PID", "nope")
	watchParentProcess()
	t.Setenv("LOGSONIC_PARENT_PID", "1")
	watchParentProcess()
}

func TestWatchParentProcessSeesAliveParent(t *testing.T) {
	t.Setenv("LOGSONIC_PARENT_PID", strconv.Itoa(os.Getppid()))
	watchParentProcess()
}
