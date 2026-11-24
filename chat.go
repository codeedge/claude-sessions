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
	ForkFrom       string `json:"forkFrom"` // 从这条会话分出一条新分支
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

	switch {
	case req.ForkFrom != "" && sessionIDRe.MatchString(req.ForkFrom):
		// 分支：复制父会话的上下文，写到新会话里（/branch、/fork）
		args = append(args, "--resume", req.ForkFrom, "--fork-session", "--session-id", req.SessionID)
	case req.NewSession:
		args = append(args, "--session-id", req.SessionID)
	default:
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
	if req.ForkFrom != "" {
		// 分支关系自己记一份，索引里优先用它
		saveFork(m.stateDir, req.SessionID, req.ForkFrom)
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

// startSubtask 在后台跑一个带着当前上下文的子任务。
// CLI 的 /subtask 只是在同一个会话里 fork 一个子代理，不会多出独立会话，
// 所以这里用 --fork-session 复制上下文、再 --no-session-persistence 让它跑完不落盘。
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
		"--no-session-persistence", // 不生成会话文件，列表里也就不会多出一行
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

	started := time.Now().UnixMilli()
	s.publish(meta("subtask", map[string]any{"id": id, "task": task}))

	go func() {
		payload, _ := json.Marshal(map[string]any{
			"type":    "user",
			"message": map[string]any{"role": "user", "content": task},
		})
		_, _ = stdin.Write(append(payload, '\n'))
		_ = stdin.Close()

		// 子任务的事件不能混进主会话的流里（否则前端会把它的输出当成主会话在说话），
		// 这里只把它的文字收下来，结束时一次性给前端
		var out strings.Builder
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 256<<10), 8<<20)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			if out.Len() < 200<<10 {
				out.WriteString(subtaskText(line))
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
		s.publish(meta("subtask_done", map[string]any{"id": id, "code": code, "text": out.String()}))
		saveTask(m.stateDir, taskRecord{
			ID: id, Parent: req.SessionID, Task: task, Code: code,
			Text: out.String(), StartedAt: started, EndedAt: time.Now().UnixMilli(),
		})
	}()
	return nil
}

// subtaskText 从子任务的一条 stream-json 事件里取出助手说的话，用来在面板里展示
func subtaskText(line string) string {
	var ev struct {
		Type    string `json:"type"`
		Message struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil || ev.Type != "assistant" {
		return ""
	}
	var b strings.Builder
	for _, c := range ev.Message.Content {
		if c.Type == "text" && c.Text != "" {
			b.WriteString(c.Text)
		}
	}
	return b.String()
}

// newSessionID 生成一个随机 UUID v4
func newSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// saveFork 记下「这条分支会话是从哪条会话分出来的」。
// CLI 的 --fork-session 不写 forkedFrom，而 fork 出来的会话历史里往往还带着
// 更早的祖先，光靠消息锚点会把父子关系认错（fork 的 fork 尤其明显）。
func saveFork(stateDir, child, parent string) {
	if stateDir == "" || child == "" || parent == "" {
		return
	}
	path := filepath.Join(stateDir, "forks.json")
	m := map[string]string{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	m[child] = parent
	if b, err := json.MarshalIndent(m, "", "  "); err == nil {
		_ = os.WriteFile(path, b, 0o600)
	}
}

// loadForks 读回我们自己记的分支关系（子会话 → 父会话）
func loadForks(stateDir string) map[string]string {
	out := map[string]string{}
	if b, err := os.ReadFile(filepath.Join(stateDir, "forks.json")); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

// taskRecord 是一次 /subtask 的记录。子任务本身不落盘（跟 CLI 一样，
// 不产生独立会话），但结果得留在面板里，刷新后还能看到。
type taskRecord struct {
	ID        string `json:"id"`
	Parent    string `json:"parent"`
	Task      string `json:"task"`
	Code      int    `json:"code"`
	Text      string `json:"text"`
	StartedAt int64  `json:"startedAt"`
	EndedAt   int64  `json:"endedAt"`
}

const taskLogMax = 200

func tasksPath(stateDir string) string {
	return filepath.Join(stateDir, "tasks.jsonl")
}

// saveTask 把一次子任务追加到 tasks.jsonl，只保留最近 200 条
func saveTask(stateDir string, rec taskRecord) {
	if stateDir == "" {
		return
	}
	path := tasksPath(stateDir)
	var all []taskRecord
	if b, err := os.ReadFile(path); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
			var r taskRecord
			if line != "" && json.Unmarshal([]byte(line), &r) == nil && r.ID != "" && r.ID != rec.ID {
				all = append(all, r)
			}
		}
	}
	all = append(all, rec)
	if len(all) > taskLogMax {
		all = all[len(all)-taskLogMax:]
	}
	var sb strings.Builder
	for _, r := range all {
		b, _ := json.Marshal(r)
		sb.Write(b)
		sb.WriteByte('\n')
	}
	_ = os.WriteFile(path, []byte(sb.String()), 0o600)
}

// loadTasks 读回某个会话下的子任务记录，顺手把已被删掉的父会话记录过滤掉
func loadTasks(stateDir, parent string) []taskRecord {
	b, err := os.ReadFile(tasksPath(stateDir))
	if err != nil {
		return nil
	}
	var out []taskRecord
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var r taskRecord
		if line == "" || json.Unmarshal([]byte(line), &r) != nil {
			continue
		}
		if r.Parent == parent {
			out = append(out, r)
		}
	}
	return out
}
