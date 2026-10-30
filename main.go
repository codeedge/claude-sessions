package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const version = "0.1.0"

// appBuild identifies the running binary. It defaults to the executable's mtime
// so every rebuild changes it, which lets open pages notice the server updated.
var appBuild = "dev"

func detectBuild() string {
	if exe, err := os.Executable(); err == nil {
		if fi, err := os.Stat(exe); err == nil {
			return strconv.FormatInt(fi.ModTime().UnixNano()/1e6, 36)
		}
	}
	return appBuild
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("")

	cmd := "web"
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd = args[0]
		args = args[1:]
	}

	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	home := fs.String("home", defaultClaudeHome(), "Claude Code 配置目录")
	state := fs.String("state", defaultStateDir(), "本程序状态目录（回收站）")
	port := fs.Int("port", 9999, "监听端口，0 表示随机")
	host := fs.String("host", "127.0.0.1", "监听地址")
	noOpen := fs.Bool("no-open", false, "不自动打开浏览器")
	showVersion := fs.Bool("version", false, "显示版本")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, `claude-sessions %s — 浏览、搜索、删除 Claude Code 会话

用法:
  claude-sessions [web] [选项]   启动网页界面
  claude-sessions list [选项]    在终端列出会话
  claude-sessions scan [选项]    只扫描并输出统计

选项:
`, version)
		fs.PrintDefaults()
	}
	_ = fs.Parse(args)

	if *showVersion {
		fmt.Println(version)
		return
	}
	if err := os.MkdirAll(*state, 0o755); err != nil {
		log.Fatalf("创建状态目录失败: %v", err)
	}

	appBuild = detectBuild()
	ix := NewIndex(*home, *state)
	marks := NewMarkStore(*state)

	if os.Getenv("HOME") == "" {
		log.Printf("提示: 环境里没有 HOME，已回退到 %s", userHome())
	}
	log.Printf("配置目录 %s", *home)
	log.Printf("状态目录 %s", *state)
	log.Printf("正在扫描 %s ...", filepath.Join(*home, "projects"))
	if err := ix.Scan(); err != nil {
		log.Printf("扫描告警: %v", err)
	}
	st := ix.Stats()
	log.Printf("已索引 %d 个会话 / %d 个项目 / %s，用时 %dms",
		st.Sessions, st.Projects, humanBytes(st.Bytes), st.ScanMS)

	switch cmd {
	case "list":
		printList(ix)
		return
	case "scan":
		return
	case "web":
	default:
		log.Fatalf("未知命令 %q，可用: web / list / scan", cmd)
	}

	srv := NewServer(ix, marks, fmt.Sprintf("%s:%d", *host, *port))
	ln, url, err := srv.Listen()
	if err != nil {
		log.Fatalf("监听失败: %v", err)
	}

	httpSrv := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("就绪 → %s", url)
	if !*noOpen {
		go openBrowser(url)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("服务异常: %v", err)
	}
}

// userHome resolves the home directory without relying on $HOME alone: a
// systemd system service has no HOME set, and falling back to a relative path
// silently indexes an empty directory instead.
func userHome() string {
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		return u.HomeDir
	}
	if u, err := user.LookupId(strconv.Itoa(os.Getuid())); err == nil && u.HomeDir != "" {
		return u.HomeDir
	}
	// 实在取不到就用当前目录，至少不会静默指向别人的家目录
	return "."
}

func defaultClaudeHome() string {
	if v := os.Getenv("CLAUDE_CONFIG_DIR"); v != "" {
		return v
	}
	return filepath.Join(userHome(), ".claude")
}

func defaultStateDir() string {
	return filepath.Join(userHome(), ".claude-sessions")
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("无法自动打开浏览器，请手动访问 %s", url)
	}
}

func printList(ix *Index) {
	hits, total, _ := ix.List(ListOpts{Sort: SortRecent})
	fmt.Printf("\n%-36s  %-8s  %-10s  %6s  %8s  %s\n",
		"SESSION", "MSGS", "UPDATED", "SIZE", "TOKENS", "TITLE")
	fmt.Println(strings.Repeat("─", 110))
	for _, h := range hits {
		title := h.Title
		if r := []rune(title); len(r) > 42 {
			title = string(r[:42]) + "…"
		}
		flag := " "
		if h.Running {
			flag = "*"
		}
		fmt.Printf("%s%-36s  %-8d  %-10s  %6s  %8d  %s\n",
			flag, h.ID[:min(36, len(h.ID))],
			h.UserMsgs+h.AsstMsgs,
			h.UpdatedAt.Format("01-02 15:04"),
			humanBytes(h.Size),
			h.In+h.Out,
			title)
	}
	fmt.Printf("\n共 %d 个会话  (* 表示进程仍在运行)\n", total)
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit && exp < 4; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%cB", float64(n)/float64(div), "KMGT"[exp])
}
