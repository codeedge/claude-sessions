//go:build linux

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

type linuxTerm struct {
	name string
	bin  string
	args func(dir, cmdline string) []string
}

var linuxTerms = []linuxTerm{
	{"GNOME Terminal", "gnome-terminal", func(d, c string) []string {
		return []string{"--working-directory=" + d, "--", "bash", "-lc", c}
	}},
	{"Konsole", "konsole", func(d, c string) []string {
		return []string{"--workdir", d, "-e", "bash", "-lc", c}
	}},
	{"Xfce Terminal", "xfce4-terminal", func(d, c string) []string {
		return []string{"--working-directory=" + d, "-x", "bash", "-lc", c}
	}},
	{"Alacritty", "alacritty", func(d, c string) []string {
		return []string{"--working-directory", d, "-e", "bash", "-lc", c}
	}},
	{"Kitty", "kitty", func(d, c string) []string {
		return []string{"--directory", d, "bash", "-lc", c}
	}},
	{"WezTerm", "wezterm", func(d, c string) []string {
		return []string{"start", "--cwd", d, "--", "bash", "-lc", c}
	}},
	{"foot", "foot", func(d, c string) []string {
		return []string{"--working-directory=" + d, "bash", "-lc", c}
	}},
	{"x-terminal-emulator", "x-terminal-emulator", func(d, c string) []string {
		return []string{"-e", "bash", "-lc", "cd " + shellQuote(d) + " && " + c}
	}},
	{"xterm", "xterm", func(d, c string) []string {
		return []string{"-e", "bash", "-lc", "cd " + shellQuote(d) + " && " + c}
	}},
}

// findWindowsExe 找 Windows 可执行文件：先查 PATH，再扫常见目录。
// systemd 服务里的 PATH 不含 /mnt/c/...，光靠 LookPath 找不到 wt.exe。
func findWindowsExe(name string) (string, error) {
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	globs := []string{
		"/mnt/c/Users/*/AppData/Local/Microsoft/WindowsApps/" + name,
		"/mnt/c/Program Files/WindowsApps/*/", // 别名目录形态
		"/mnt/c/Windows/System32/" + name,
		"/mnt/c/Windows/" + name,
	}
	for _, g := range globs {
		matches, _ := filepath.Glob(g)
		for _, m := range matches {
			if fi, err := os.Stat(m); err == nil && !fi.IsDir() {
				return m, nil
			}
		}
	}
	return "", errors.New(name + " 未找到")
}

func isWSL() bool {
	if os.Getenv("WSL_DISTRO_NAME") != "" {
		return true
	}
	b, err := os.ReadFile("/proc/version")
	return err == nil && strings.Contains(strings.ToLower(string(b)), "microsoft")
}

// wslDistro 拿当前发行版名。服务里没有 WSL_DISTRO_NAME，用 wslpath 的
// UNC 路径反推（\\wsl.localhost\Ubuntu-20.04\）。
func wslDistro() string {
	if d := os.Getenv("WSL_DISTRO_NAME"); d != "" {
		return d
	}
	out, err := exec.Command("wslpath", "-w", "/").Output()
	if err != nil {
		return ""
	}
	p := strings.TrimSpace(string(out))
	if i := strings.Index(p, "localhost\\"); i >= 0 {
		return strings.Trim(strings.TrimSuffix(p[i+len("localhost\\"):], "\\"), "\\/")
	}
	if i := strings.Index(p, "wsl$\\"); i >= 0 {
		return strings.Trim(strings.TrimSuffix(p[i+len("wsl$\\"):], "\\"), "\\/")
	}
	return ""
}

// launchWSL 在 WSL 里用 Windows Terminal 开一个新标签页，回到该发行版的会话目录
func launchWSL(dir, cmdline string) (string, error) {
	wt, err := findWindowsExe("wt.exe")
	if err != nil {
		return "", errors.New("没有找到 Windows Terminal（wt.exe）")
	}
	inner := "cd " + shellQuote(dir) + " && " + cmdline
	args := []string{"wsl.exe"}
	if d := wslDistro(); d != "" {
		args = append(args, "-d", d)
	}
	args = append(args, "--", "bash", "-lc", inner)
	cmd := exec.Command(wt, args...)
	// wt.exe 是 Windows 程序，工作目录不能是 \\wsl.localhost\... 这种 UNC 路径
	if _, err := os.Stat("/mnt/c/Windows"); err == nil {
		cmd.Dir = "/mnt/c/Windows"
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return "", err
	}
	go func() { _ = cmd.Wait() }()
	return "Windows Terminal", nil
}

func launchTerminal(dir, cmdline string) (string, error) {
	var errs []string
	if isWSL() {
		name, err := launchWSL(dir, cmdline)
		if err != nil {
			return "", err
		}
		return name, nil
	}
	for _, t := range linuxTerms {
		bin, err := exec.LookPath(t.bin)
		if err != nil {
			continue
		}
		cmd := exec.Command(bin, t.args(dir, cmdline)...)
		cmd.Dir = dir
		cmd.Env = os.Environ()
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := cmd.Start(); err != nil {
			errs = append(errs, t.name+": "+err.Error())
			continue
		}
		go func() { _ = cmd.Wait() }()
		return t.name, nil
	}
	if len(errs) == 0 {
		return "", errors.New("没有找到可用的终端程序")
	}
	return "", errors.New(strings.Join(errs, "；"))
}
