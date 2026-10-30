//go:build darwin

package main

import (
	"os/exec"
	"strconv"
)

// launchTerminal 用 AppleScript 让 Terminal.app 新开一个窗口执行命令
func launchTerminal(dir, cmdline string) (string, error) {
	inner := "cd " + shellQuote(dir) + " && " + cmdline
	script := "tell application \"Terminal\"\nactivate\ndo script " + strconv.Quote(inner) + "\nend tell"
	cmd := exec.Command("osascript", "-e", script)
	if err := cmd.Start(); err != nil {
		return "", err
	}
	go func() { _ = cmd.Wait() }()
	return "Terminal.app", nil
}
