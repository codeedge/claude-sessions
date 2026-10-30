package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// 会话 id 只允许十六进制和连字符，避免把任意内容拼进命令行
var sessionIDRe = regexp.MustCompile(`^[0-9a-zA-Z-]{8,64}$`)

type openResult struct {
	Terminal string `json:"terminal"`
	Command  string `json:"command"`
	Dir      string `json:"dir"`
}

// resolveClaude 找 claude 的绝对路径。必须用绝对路径：
// WSL 里拉起的 shell 会继承 Windows 的 PATH，裸写 "claude" 会命中
// Windows 版 claude.exe，它读的是 Windows 的 ~/.claude，找不到 Linux 的会话。
func resolveClaude() string {
	if p, err := exec.LookPath("claude"); err == nil {
		return p
	}
	cands := []string{
		filepath.Join(userHome(), ".local/bin/claude"),
		filepath.Join(userHome(), ".claude/local/claude"),
		"/usr/local/bin/claude",
		"/usr/bin/claude",
		"/opt/homebrew/bin/claude",
	}
	for _, c := range cands {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return "claude"
}

// resumeCommand 生成重新打开会话的命令
func resumeCommand(id string) (string, error) {
	if !sessionIDRe.MatchString(id) {
		return "", errors.New("会话 ID 不合法")
	}
	return shellQuote(resolveClaude()) + " --resume " + id, nil
}

// shellQuote 把路径安全地嵌进 shell 命令
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// usableDir 返回一个存在的目录，会话的 cwd 可能已经被删掉了
func usableDir(dir string) string {
	if dir != "" {
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
			return dir
		}
	}
	return userHome()
}
