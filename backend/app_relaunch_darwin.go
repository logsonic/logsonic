//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// relaunchForApp re-launches the server inside a Terminal window when this
// process was started by a macOS .app double-click (faceless: no controlling
// terminal, no event loop). It returns true when it has launched the Terminal
// instance, so the caller exits this faceless launcher.
//
// It does NOT relaunch when we're already the Terminal instance (the re-launch
// marker env is set) or when stdout is a real TTY (started from a shell). Note
// we must do a real isatty (TIOCGETA) check here, not an os.ModeCharDevice one:
// under launchd, stdout is /dev/null, which IS a character device but is NOT a
// TTY — that false positive previously caused the relaunch to be skipped.
func relaunchForApp() bool {
	if envTrue("LOGSONIC_IN_TERMINAL") || isTTY(os.Stdout.Fd()) {
		return false
	}
	if err := relaunchInTerminal(); err != nil {
		fmt.Fprintf(os.Stderr, "could not open a Terminal window (%v) — starting in the background\n", err)
		return false
	}
	return true
}

// isTTY reports whether fd refers to a terminal. Querying the termios state
// succeeds only for a real tty (fails with ENOTTY for /dev/null, pipes, files).
func isTTY(fd uintptr) bool {
	_, err := unix.IoctlGetTermios(int(fd), unix.TIOCGETA)
	return err == nil
}

// relaunchInTerminal writes a small .command script that re-runs this executable
// with a controlling terminal, then opens it. A .command file is run by Terminal
// without the Apple-Events automation permission that an osascript "do script"
// would prompt for. The script marks the child with LOGSONIC_IN_TERMINAL=1 so it
// runs the server instead of relaunching again, and reports the exit status so
// the window stays informative after the server stops.
func relaunchInTerminal() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// Robust POSIX single-quoting of the executable path for the shell.
	q := "'" + strings.ReplaceAll(exe, "'", `'\''`) + "'"
	script := "#!/bin/sh\n" +
		"clear\n" +
		`echo "Starting LogSonic — press Ctrl-C or close this window to stop."` + "\n" +
		"echo\n" +
		"export LOGSONIC_APP=1\n" +
		"export LOGSONIC_IN_TERMINAL=1\n" +
		q + "\n" +
		"status=$?\n" +
		"echo\n" +
		`echo "LogSonic stopped (exit $status). You can close this window."` + "\n"

	path := filepath.Join(os.TempDir(), "logsonic-launch.command")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		return err
	}
	// `open` (no -a) uses the user's handler for .command files — Terminal by
	// default, or e.g. iTerm if they've set it.
	return exec.Command("open", path).Run()
}
