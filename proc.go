package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// processAlive reports whether pid is a live process. Signal 0 performs the
// existence and permission checks without delivering anything.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	if p.Signal(syscall.Signal(0)) != nil {
		return false
	}
	// Guard against pid reuse: when /proc exists, require the process to look
	// like a Claude Code process before calling the session live.
	if cmd, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline"); err == nil {
		return strings.Contains(strings.ToLower(string(cmd)), "claude")
	}
	return true
}
