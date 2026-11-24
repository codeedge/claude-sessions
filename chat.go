package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 会话聊天：每发一条消息就起一个 claude -p 进程，读它的 stream-json 输出，
// 通过 SSE 推给浏览器。进程只跑一轮，结束后退出；下一条消息用 --resume 接上。
//
// 这样进程生命周期简单（停止 = kill），也不会有一个长期挂着的进程把会话占住。

const (
	chatHistoryLimit = 2000 // 每个会话缓存多少条事件，供重连回放
	chatIdleTimeout  = 30 * time.Minute
)

type chatOptions struct {
	Model          string `json:"model"`
	Effort         string `json:"effort"`
	PermissionMode string `json:"permissionMode"` // default | acceptEdits | plan | bypassPermissions | 本工具的 ask
	CWD            string `json:"cwd"`
}

type chatEvent struct {
	ID   int64  `json:"id"`
	Data string `json:"data"` // 原样转发 CLI 的一行 JSON
}

type chatSession struct {
	id string

	mu      sync.Mutex
	subs    map[chan chatEvent]struct{}
	history []chatEvent
	seq     int64
	running bool
	cancel  context.CancelFunc
	lastAt  time.Time
	opts    chatOptions

	// 权限请求：requestID -> 等待结果的 channel
	permMu  sync.Mutex
	pending map[string]chan permAnswer
}

type permAnswer struct {
	Behavior string `json:"behavior"` // allow | deny
	Message  string `json:"message,omitempty"`
}

type chatManager struct {
	mu       sync.Mutex
	sess     map[string]*chatSession
	token    string // MCP 回调用的令牌
	stateDir string
	index    *Index
	base     string // 服务地址，如 http://127.0.0.1:9999
}

func newChatManager(ix *Index, stateDir string) *chatManager {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	m := &chatManager{sess: map[string]*chatSession{}, index: ix, token: hex.EncodeToString(b), stateDir: stateDir}
	// 令牌落盘（0600），MCP 子进程和调试时都能用
	if stateDir != "" {
		if err := os.WriteFile(filepath.Join(stateDir, "chat-token"), []byte(m.token), 0o600); err == nil {
			// 仅本机可读，无需额外处理
		}
	}
	go m.reaper()
	return m
}

func (m *chatManager) session(id string) *chatSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sess[id]
	if !ok {
		s = &chatSession{id: id, subs: map[chan chatEvent]struct{}{}, pending: map[string]chan permAnswer{}}
		m.sess[id] = s
	}
	return s
}

// reaper 清理长时间没动静的会话，避免内存堆积
func (m *chatManager) reaper() {
	for range time.Tick(5 * time.Minute) {
		m.mu.Lock()
		for id, s := range m.sess {
			s.mu.Lock()
			idle := !s.running && time.Since(s.lastAt) > chatIdleTimeout
			s.mu.Unlock()
			if idle {
				delete(m.sess, id)
			}
		}
		m.mu.Unlock()
	}
}

func (s *chatSession) publish(data string) {
	s.mu.Lock()
	s.seq++
	ev := chatEvent{ID: s.seq, Data: data}
	s.history = append(s.history, ev)
	if len(s.history) > chatHistoryLimit {
		s.history = s.history[len(s.history)-chatHistoryLimit:]
	}
	subs := make([]chan chatEvent, 0, len(s.subs))
	for ch := range s.subs {
		subs = append(subs, ch)
	}
	s.mu.Unlock()

	for _, ch := range subs {
		select {
		case ch <- ev:
		default: // 慢客户端直接丢，避免阻塞进程读取
		}
	}
}

func (s *chatSession) subscribe(from int64) chan chatEvent {
	ch := make(chan chatEvent, 256)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	for _, ev := range s.history {
		if ev.ID > from {
			select {
			case ch <- ev:
			default:
			}
		}
	}
	s.mu.Unlock()
	return ch
}

func (s *chatSession) unsubscribe(ch chan chatEvent) {
	s.mu.Lock()
	delete(s.subs, ch)
	s.mu.Unlock()
}

func (s *chatSession) runningState() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

// ------------------------------------------------------------------ 发送

type chatSendRequest struct {
	SessionID      string `json:"sessionId"`
	Text           string `json:"text"`
	CWD            string `json:"cwd"`
	NewSession     bool   `json:"newSession"`
	Model          string `json:"model"`
	Effort         string `json:"effort"`
	PermissionMode string `json:"permissionMode"`
	Resume         bool   `json:"resume"`
}

func (m *chatManager) send(req chatSendRequest) error {
	if strings.TrimSpace(req.Text) == "" {
		return fmt.Errorf("消息不能为空")
	}
	if req.SessionID == "" {
		return fmt.Errorf("缺少会话 ID")
	}
	if !sessionIDRe.MatchString(req.SessionID) {
		return fmt.Errorf("会话 ID 不合法")
	}

	s := m.session(req.SessionID)
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return fmt.Errorf("上一轮还在进行中")
	}
	s.mu.Unlock()

	// /clear、/subtask 这类是 CLI 客户端自己实现的命令，print 模式不会执行，
	// 这里按同样的语义接管。
	if cmd, arg := localSlash(req.Text); cmd != "" {
		switch cmd {
		case "clear":
			return errClearRequested
		case "compact":
			return fmt.Errorf("/compact 在网页版暂不支持，可以在终端里执行")
		case "subtask":
			if arg == "" {
				return fmt.Errorf("用法：/subtask <任务描述>")
			}
			return m.startSubtask(req, arg)
		}
	}

	cwd := req.CWD
	if cwd == "" {
		cwd = userHome()
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		if req.NewSession {
			return fmt.Errorf("目录不存在：%s", cwd)
		}
		cwd = usableDir(cwd)
	}
	claude := resolveClaude()

	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
	}
	if req.Model != "" {
		args = append(args, "--model", req.Model)
	}
	if req.Effort != "" {
		args = append(args, "--effort", req.Effort)
	}
	mode := req.PermissionMode
	if mode == "" || mode == "ask" {
		mode = "default" // 弹窗由 --permission-prompt-tool 接管
	}
	args = append(args, "--permission-mode", mode)

	// 用 claude 自己的 --permission-prompt-tool：把审批请求转给我们内置的 MCP server
	args = append(args, "--permission-prompt-tool", "mcp__ui__ask")
	mcpCfg, err := m.mcpConfig(req.SessionID)
	if err == nil {
		args = append(args, "--mcp-config", mcpCfg)
	}

	if req.NewSession {
		args = append(args, "--session-id", req.SessionID)
	} else {
		args = append(args, "--resume", req.SessionID)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, claude, args...)
	cmd.Dir = cwd
	cmd.Env = append(baseEnv(), "CLAUDE_CODE_ENTRYPOINT=claude-sessions")

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return err
	}

	s.mu.Lock()
	s.running = true
	s.cancel = cancel
	s.lastAt = time.Now()
	s.opts = chatOptions{Model: req.Model, Effort: req.Effort, PermissionMode: req.PermissionMode, CWD: cwd}
	s.mu.Unlock()

	if err := cmd.Start(); err != nil {
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
		cancel()
		return fmt.Errorf("启动 claude 失败: %w", err)
	}

	s.publish(meta("started", map[string]any{"dir": cwd, "model": req.Model, "effort": req.Effort, "mode": req.PermissionMode}))

	// 写一条用户消息然后关 stdin：进程跑完这一轮就退出
	go func() {
		payload, _ := json.Marshal(map[string]any{
			"type":    "user",
			"message": map[string]any{"role": "user", "content": req.Text},
		})
		_, _ = stdin.Write(append(payload, '\n'))
		_ = stdin.Close()
	}()

	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 256<<10), 8<<20)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			s.publish(line)
		}
	}()

	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.Contains(line, "EnvHttpProxyAgent") {
				continue
			}
			s.publish(meta("stderr", map[string]any{"text": line}))
		}
	}()

	go func() {
		err := cmd.Wait()
		cancel()
		s.mu.Lock()
		s.running = false
		s.lastAt = time.Now()
		s.mu.Unlock()

		code := 0
		if err != nil {
			code = -1
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			}
		}
		s.publish(meta("exit", map[string]any{"code": code}))
		if err != nil && code != 0 {
			log.Printf("会话 %s 的 claude 进程退出: %v", s.id, err)
		}
		// 会话文件变了，让索引重扫，列表和详情能立刻看到这一轮
		if m.index != nil {
			go m.index.MaybeRescan(0)
		}
	}()

	return nil
}

// meta 生成一条本工具自己的事件（和 CLI 的事件区分开）
func meta(kind string, payload map[string]any) string {
	obj := map[string]any{"type": "ui_" + kind}
	for k, v := range payload {
		obj[k] = v
	}
	b, _ := json.Marshal(obj)
	return string(b)
}

func (m *chatManager) stop(id string) {
	m.mu.Lock()
	s, ok := m.sess[id]
	m.mu.Unlock()
	if !ok {
		return
	}
	s.mu.Lock()
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// mcpConfig 生成给 claude 用的 MCP 配置：指向本程序的 mcp 子命令
func (m *chatManager) mcpConfig(sessionID string) (string, error) {
	self, err := exec.LookPath(selfPath())
	if err != nil {
		return "", err
	}
	cfg := map[string]any{
		"mcpServers": map[string]any{
			"ui": map[string]any{
				"command": self,
				"args":    []string{"mcp"},
				"env": map[string]string{
					"CHAT_SERVER":  m.base,
					"CHAT_TOKEN":   m.token,
					"CHAT_SESSION": sessionID,
				},
			},
		},
	}
	b, err := json.Marshal(cfg)
	return string(b), err
}

// ------------------------------------------------------------- 权限请求

func (s *chatSession) waitPermission(id string, timeout time.Duration) permAnswer {
	ch := make(chan permAnswer, 1)
	s.permMu.Lock()
	s.pending[id] = ch
	s.permMu.Unlock()

	defer func() {
		s.permMu.Lock()
		delete(s.pending, id)
		s.permMu.Unlock()
	}()

	select {
	case a := <-ch:
		return a
	case <-time.After(timeout):
		return permAnswer{Behavior: "deny", Message: "等待确认超时，已拒绝"}
	}
}

func (s *chatSession) answerPermission(id string, a permAnswer) bool {
	s.permMu.Lock()
	ch, ok := s.pending[id]
	s.permMu.Unlock()
	if !ok {
		return false
	}
	select {
	case ch <- a:
	default:
	}
	return true
}

// baseEnv 清理掉可能干扰子进程的环境变量
func baseEnv() []string {
	return envWithout("CLAUDE_CODE_ENTRYPOINT")
}

func selfPath() string {
	if p, err := exec.LookPath(os.Args[0]); err == nil {
		return p
	}
	return os.Args[0]
}

func envWithout(key string) []string {
	env := os.Environ()
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if strings.HasPrefix(kv, key+"=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// errClearRequested 表示用户要求开新会话
var errClearRequested = fmt.Errorf("__clear__")

// localSlash 识别「CLI 客户端自己处理」的命令
func localSlash(text string) (cmd, arg string) {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "/") {
		return "", ""
	}
	head, rest, _ := strings.Cut(t, " ")
	name := strings.TrimPrefix(strings.TrimSpace(head), "/")
	switch name {
	case "clear", "compact", "subtask", "model", "config", "resume", "exit", "quit":
		return name, strings.TrimSpace(rest)
	}
	return "", ""
}

// startSubtask 用 --fork-session 在后台跑一个带上下文的任务，
// 产出是一个新的分支会话，跑完会出现在列表里。
func (m *chatManager) startSubtask(req chatSendRequest, task string) error {
	claude := resolveClaude()
	cwd := usableDir(req.CWD)

	id := newSessionID()
	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--resume", req.SessionID,
		"--fork-session",
		"--session-id", id,
		"--permission-mode", "acceptEdits",
	}
	if req.Model != "" {
		args = append(args, "--model", req.Model)
	}
	if req.Effort != "" {
		args = append(args, "--effort", req.Effort)
	}

	s := m.session(req.SessionID)
	cmd := exec.Command(claude, args...)
	cmd.Dir = cwd
	cmd.Env = baseEnv()

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动子任务失败: %w", err)
	}

	s.publish(meta("subtask", map[string]any{"id": id, "task": task}))
	markSubtask(m.stateDir, id, req.SessionID)

	go func() {
		payload, _ := json.Marshal(map[string]any{
			"type":    "user",
			"message": map[string]any{"role": "user", "content": task},
		})
		_, _ = stdin.Write(append(payload, '\n'))
		_ = stdin.Close()

		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 256<<10), 8<<20)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line != "" {
				s.publish(line)
			}
		}
		err := cmd.Wait()
		code := 0
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			} else {
				code = -1
			}
		}
		s.publish(meta("subtask_done", map[string]any{"id": id, "code": code}))
		if m.index != nil {
			go m.index.MaybeRescan(0)
		}
	}()
	return nil
}

// newSessionID 生成一个随机 UUID v4
func newSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// markSubtask 把 /subtask 产生的会话记下来（会话 ID → 父会话 ID），
// 索引里据此把它折叠到父会话下面，并且不算分支数
func markSubtask(stateDir, id, parent string) {
	if stateDir == "" {
		return
	}
	path := filepath.Join(stateDir, "subtasks.json")
	m := map[string]string{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	m[id] = parent
	if b, err := json.MarshalIndent(m, "", "  "); err == nil {
		_ = os.WriteFile(path, b, 0o600)
	}
}

// loadSubtasks 读回 /subtask 产生的会话集合（会话 ID → 父会话 ID）
func loadSubtasks(stateDir string) map[string]string {
	out := map[string]string{}
	b, err := os.ReadFile(filepath.Join(stateDir, "subtasks.json"))
	if err != nil {
		return out
	}
	var m map[string]string
	if json.Unmarshal(b, &m) == nil {
		for id, parent := range m {
			out[id] = parent
		}
	}
	return out
}
