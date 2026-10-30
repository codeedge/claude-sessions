//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// launchTerminal 优先用 Windows Terminal，没有再退回 cmd 的新窗口
func launchTerminal(dir, cmdline string) (string, error) {
	if wt, err := exec.LookPath("wt.exe"); err == nil {
		cmd := exec.Command(wt, "-d", dir, "cmd", "/k", cmdline)
		cmd.Dir = dir
		if err := cmd.Start(); err == nil {
			go func() { _ = cmd.Wait() }()
			return "Windows Terminal", nil
		}
	}
	cmd := exec.Command("cmd.exe", "/c", "start", "", "cmd", "/k", cmdline)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000010} // CREATE_NEW_CONSOLE
	if err := cmd.Start(); err != nil {
		return "", err
	}
	go func() { _ = cmd.Wait() }()
	return "cmd", nil
}
