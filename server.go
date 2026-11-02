package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

//go:embed assets
var assetsFS embed.FS

type Server struct {
	ix    *Index
	marks *MarkStore
	mux   *http.ServeMux
	addr  string
}

func NewServer(ix *Index, marks *MarkStore, addr string) *Server {
	s := &Server{ix: ix, marks: marks, mux: http.NewServeMux(), addr: addr}
	s.routes()
	return s
}

func (s *Server) routes() {
	sub, err := fs.Sub(assetsFS, "assets")
	if err != nil {
		panic(err)
	}
	static := http.FileServer(http.FS(sub))
	s.mux.Handle("/", noCache(static))

	s.mux.HandleFunc("GET /api/version", s.handleVersion)
	s.mux.HandleFunc("GET /api/stats", s.handleStats)
	s.mux.HandleFunc("GET /api/projects", s.handleProjects)
	s.mux.HandleFunc("GET /api/sessions", s.handleList)
	s.mux.HandleFunc("GET /api/sessions/{id}", s.handleDetail)
	s.mux.HandleFunc("GET /api/sessions/{id}/search", s.handleSearch)
	s.mux.HandleFunc("GET /api/sessions/{id}/preview", s.handlePreview)
	s.mux.HandleFunc("GET /api/sessions/{id}/export", s.handleExport)
	s.mux.HandleFunc("GET /api/sessions/{id}/raw", s.handleRaw)
	s.mux.HandleFunc("POST /api/rescan", s.handleRescan)
	s.mux.HandleFunc("GET /api/marks", s.handleMarks)
	s.mux.HandleFunc("POST /api/marks", s.handleUpdateMarks)
	s.mux.HandleFunc("GET /api/tags", s.handleTags)
	s.mux.HandleFunc("POST /api/delete", s.handleDelete)
	s.mux.HandleFunc("GET /api/trash", s.handleTrash)
	s.mux.HandleFunc("POST /api/trash/restore", s.handleRestore)
	s.mux.HandleFunc("POST /api/trash/purge", s.handlePurge)
	s.mux.HandleFunc("POST /api/open", s.handleOpen)
	s.mux.HandleFunc("POST /api/rename", s.handleRename)
}

// handleRename 把新名字写进会话文件，和 Claude Code 的 /rename 完全一致：
// 追加一条 {"type":"custom-title","customTitle":...,"sessionId":...}
// 所以 CLI 的 resume 列表、终端标签都会跟着变。只追加，不重写文件。
func (s *Server) handleRename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req); err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}
	if !sessionIDRe.MatchString(req.ID) {
		writeErr(w, 400, "会话 ID 不合法")
		return
	}
	title := strings.TrimSpace(strings.NewReplacer("\n", " ", "\r", " ", "\t", " ").Replace(req.Title))
	if len([]rune(title)) > maxTitleLen {
		title = string([]rune(title)[:maxTitleLen])
	}
	if title == "" {
		writeErr(w, 400, "名字不能为空")
		return
	}
	info, ok := s.ix.Get(req.ID)
	if !ok {
		writeErr(w, 404, "会话不存在")
		return
	}

	rec, err := json.Marshal(struct {
		Type        string `json:"type"`
		CustomTitle string `json:"customTitle"`
		SessionID   string `json:"sessionId"`
	}{"custom-title", title, req.ID})
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}

	f, err := os.OpenFile(info.Path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		writeErr(w, 500, "打开会话文件失败: "+err.Error())
		return
	}
	defer f.Close()

	// 文件末尾没有换行时先补一个，避免和新记录粘成一行
	prefix := ""
	if fi, err := f.Stat(); err == nil && fi.Size() > 0 {
		if rf, err := os.Open(info.Path); err == nil {
			last := make([]byte, 1)
			if _, err := rf.ReadAt(last, fi.Size()-1); err == nil && last[0] != '\n' {
				prefix = "\n"
			}
			rf.Close()
		}
	}
	if _, err := f.WriteString(prefix + string(rec) + "\n"); err != nil {
		writeErr(w, 500, "写入失败: "+err.Error())
		return
	}

	s.ix.MaybeRescan(0) // 只读新增字节，很快
	writeJSON(w, 200, map[string]string{"id": req.ID, "title": title})
}

// handleOpen 在系统终端里直接打开一个会话（claude --resume <id>）。
// 只接受会话 id，命令由服务端拼装，避免被当成任意命令执行器。
func (s *Server) handleOpen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}
	info, ok := s.ix.Get(req.ID)
	if !ok {
		writeErr(w, 404, "会话不存在")
		return
	}
	cmdline, err := resumeCommand(req.ID)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	dir := usableDir(info.CWD)
	term, err := launchTerminal(dir, cmdline)
	if err != nil {
		writeErr(w, 500, "打开终端失败："+err.Error())
		return
	}
	writeJSON(w, 200, openResult{Terminal: term, Command: cmdline, Dir: dir})
}

func (s *Server) Handler() http.Handler { return withLogging(s.mux) }

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

func withLogging(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/ws/") {
			h.ServeHTTP(w, r) // WebSocket needs the raw connection; skip logging
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, code: 200}
		h.ServeHTTP(rec, r)
		log.Printf("%-4s %-46s %d %s", r.Method, r.URL.RequestURI(), rec.code, time.Since(start).Round(time.Millisecond))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}

// Hijack lets the WebSocket handler take over the connection; without this the
// logging wrapper breaks the upgrade with "does not implement http.Hijacker".
func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("底层 ResponseWriter 不支持 Hijack")
	}
	return h.Hijack()
}

func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"build": appBuild, "version": version})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	s.ix.MaybeRescan(2 * time.Second)
	writeJSON(w, 200, s.ix.Stats())
}

func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request) {
	s.ix.MaybeRescan(2 * time.Second)
	writeJSON(w, 200, s.ix.Projects())
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	// The UI asks for fresh=1 on page load and on explicit refreshes: scanning is
	// incremental now, so re-reading the disk costs a couple of milliseconds.
	if r.URL.Query().Get("fresh") == "1" {
		if err := s.ix.Scan(); err != nil {
			log.Printf("强制重扫: %v", err)
		}
	} else {
		s.ix.MaybeRescan(2 * time.Second)
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = 200
	}
	offset, _ := strconv.Atoi(q.Get("offset"))
	hits, total, _ := s.ix.List(ListOpts{
		Query:   q.Get("q"),
		Project: q.Get("project"),
		Sort:    SortKey(q.Get("sort")),
		Limit:   limit,
		Offset:  offset,
		Starred: q.Get("star") == "1",
		Tag:     q.Get("tag"),
		Asc:     q.Get("asc") == "1",
		Mark:    s.marks.Get,
	})
	if hits == nil {
		hits = []Hit{}
	}
	writeJSON(w, 200, map[string]any{
		"items":  hits,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}

func (s *Server) handleDetail(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	agent := r.URL.Query().Get("agent")
	from, _ := strconv.Atoi(r.URL.Query().Get("from"))
	count, _ := strconv.Atoi(r.URL.Query().Get("count"))
	if count <= 0 {
		count = 25
	}
	d, err := s.ix.Detail(id, agent, from, count)
	if err != nil {
		writeErr(w, 404, err.Error())
		return
	}
	if d.Turns == nil {
		d.Turns = []Turn{}
	}
	fillMark(&d.Starred, &d.Tags, &d.Note, s.marks.Get(id))
	writeJSON(w, 200, d)
}

// handlePreview serves the hover card: the opening prompt plus the last few
// lines of conversation, read from the head and tail of the file only.
func (s *Server) handlePreview(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	agent := r.URL.Query().Get("agent")
	info, ok := s.ix.Get(id)
	if !ok {
		writeErr(w, 404, "会话不存在")
		return
	}
	path := info.Path
	if agent != "" {
		p, _, ok := s.ix.SubagentPath(id, agent)
		if !ok {
			writeErr(w, 404, "子代理不存在")
			return
		}
		path = p
	}
	pv, err := buildPreview(path)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	pv.ID = id
	pv.Title = info.Title
	if pv.Recent == nil {
		pv.Recent = []PreviewItem{}
	}
	writeJSON(w, 200, pv)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	hits, err := s.ix.SearchTurns(r.PathValue("id"), r.URL.Query().Get("agent"), r.URL.Query().Get("q"))
	if err != nil {
		writeErr(w, 404, err.Error())
		return
	}
	if hits == nil {
		hits = []TurnSearchHit{}
	}
	writeJSON(w, 200, map[string]any{"items": hits})
}

func (s *Server) handleRaw(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	agent := r.URL.Query().Get("agent")
	info, ok := s.ix.Get(id)
	if !ok {
		writeErr(w, 404, "会话不存在")
		return
	}
	path := info.Path
	if agent != "" {
		p, _, ok := s.ix.SubagentPath(id, agent)
		if !ok {
			writeErr(w, 404, "子代理不存在")
			return
		}
		path = p
	}
	f, err := os.Open(path)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", id+".jsonl"))
	io.Copy(w, f)
}

func (s *Server) handleRescan(w http.ResponseWriter, r *http.Request) {
	if err := s.ix.Scan(); err != nil {
		log.Printf("rescan: %v", err)
	}
	writeJSON(w, 200, s.ix.Stats())
}

type idsRequest struct {
	IDs   []string `json:"ids"`
	Force bool     `json:"force"`
}

func decodeIDs(r *http.Request) (idsRequest, error) {
	var req idsRequest
	err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req)
	return req, err
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	req, err := decodeIDs(r)
	if err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}

	// Favourited sessions are protected outright: they can only be deleted after
	// the user removes the favourite. There is no force flag for this.
	toDelete := make([]string, 0, len(req.IDs))
	errs := map[string]string{}
	blocked := make([]string, 0)
	for _, id := range req.IDs {
		if s.marks.Get(id).Starred {
			errs[id] = "会话已收藏，请先取消收藏再删除"
			blocked = append(blocked, id)
			continue
		}
		toDelete = append(toDelete, id)
	}

	deleted, delErrs := s.ix.Delete(toDelete)
	for k, v := range delErrs {
		errs[k] = v
	}
	if deleted == nil {
		deleted = []string{}
	}
	writeJSON(w, 200, map[string]any{"deleted": deleted, "errors": errs, "blocked": blocked})
}

func (s *Server) handleTrash(w http.ResponseWriter, r *http.Request) {
	items, err := s.ix.Trash()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if items == nil {
		items = []TrashEntry{}
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request) {
	req, err := decodeIDs(r)
	if err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}
	done, errs := s.ix.Restore(req.IDs)
	if len(done) > 0 {
		_ = s.ix.Scan()
	}
	if done == nil {
		done = []string{}
	}
	writeJSON(w, 200, map[string]any{"restored": done, "errors": errs})
}

func (s *Server) handlePurge(w http.ResponseWriter, r *http.Request) {
	req, err := decodeIDs(r)
	if err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}
	done, errs := s.ix.Purge(req.IDs)
	s.marks.Drop(done)
	if done == nil {
		done = []string{}
	}
	writeJSON(w, 200, map[string]any{"purged": done, "errors": errs})
}

func fillMark(starred *bool, tags *[]string, note *string, m Mark) {
	*starred = m.Starred
	*tags = m.Tags
	*note = m.Note
}

func (s *Server) handleMarks(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"marks": s.marks.All()})
}

func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"tags": s.marks.Tags()})
}

type markUpdate struct {
	ID      string    `json:"id"`
	Starred *bool     `json:"starred,omitempty"`
	Tags    *[]string `json:"tags,omitempty"`
	Note    *string   `json:"note,omitempty"`
}

func (s *Server) handleUpdateMarks(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Updates []markUpdate `json:"updates"`
		IDs     []string     `json:"ids"`
		Starred *bool        `json:"starred"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&body); err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}

	applied := map[string]Mark{}
	if len(body.IDs) > 0 && body.Starred != nil {
		if err := s.marks.Star(body.IDs, *body.Starred); err != nil {
			writeErr(w, 500, "保存标记失败: "+err.Error())
			return
		}
		for _, id := range body.IDs {
			applied[id] = s.marks.Get(id)
		}
	}
	for _, u := range body.Updates {
		if u.ID == "" {
			continue
		}
		m, err := s.marks.Set(u.ID, u.Starred, u.Tags, u.Note)
		if err != nil {
			writeErr(w, 500, "保存标记失败: "+err.Error())
			return
		}
		applied[u.ID] = m
	}
	writeJSON(w, 200, map[string]any{"marks": applied})
}

var unsafeFilename = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]+`)

// handleExport renders a conversation as Markdown.
func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	agent := r.URL.Query().Get("agent")
	info, ok := s.ix.Get(id)
	if !ok {
		writeErr(w, 404, "会话不存在")
		return
	}
	path := info.Path
	title := info.Title
	agentType := ""
	if agent != "" {
		p, at, ok := s.ix.SubagentPath(id, agent)
		if !ok {
			writeErr(w, 404, "子代理不存在")
			return
		}
		path, agentType = p, at
		title = fmt.Sprintf("%s · 子代理 %s", info.Title, at)
	}
	turns, err := parseTurns(path)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", title)
	fmt.Fprintf(&b, "- 会话 ID: `%s`\n", id)
	if agent != "" {
		fmt.Fprintf(&b, "- 子代理: `%s` (%s)\n", agent, agentType)
	}
	fmt.Fprintf(&b, "- 项目: `%s`\n", info.CWD)
	if info.Branch != "" {
		fmt.Fprintf(&b, "- 分支: `%s`\n", info.Branch)
	}
	fmt.Fprintf(&b, "- 模型: `%s`\n", info.Model)
	fmt.Fprintf(&b, "- 时间: %s → %s\n", info.CreatedAt.Format("2006-01-02 15:04"), info.UpdatedAt.Format("2006-01-02 15:04"))
	fmt.Fprintf(&b, "- 轮次: %d\n", len(turns))
	fmt.Fprintf(&b, "- 恢复: `cd %s && claude --resume %s`\n\n---\n\n", info.CWD, id)

	for _, t := range turns {
		fmt.Fprintf(&b, "## 第 %d 轮", t.Index)
		if !t.TS.IsZero() {
			fmt.Fprintf(&b, " · %s", t.TS.Format("2006-01-02 15:04:05"))
		}
		if t.Steps > 0 {
			fmt.Fprintf(&b, " · %d 步", t.Steps)
		}
		if t.Failures > 0 {
			fmt.Fprintf(&b, " · %d 失败", t.Failures)
		}
		b.WriteString("\n\n")
		if t.Prompt != "" {
			fmt.Fprintf(&b, "> %s\n\n", strings.ReplaceAll(strings.TrimSpace(t.Prompt), "\n", "\n> "))
		}
		for _, m := range t.Messages {
			for _, blk := range m.Blocks {
				switch blk.Kind {
				case "text":
					fmt.Fprintf(&b, "%s\n\n", strings.TrimSpace(blk.Text))
				case "thinking":
					fmt.Fprintf(&b, "<details><summary>思考</summary>\n\n%s\n\n</details>\n\n", strings.TrimSpace(blk.Text))
				case "tool_use":
					fmt.Fprintf(&b, "**🔧 %s** `%s`\n\n", blk.Name, blk.Summary)
					if len(blk.Input) > 0 {
						fmt.Fprintf(&b, "```json\n%s\n```\n\n", prettyJSON(blk.Input))
					}
				case "tool_result":
					label := "结果"
					if blk.IsError {
						label = "❌ 失败"
					}
					body := strings.TrimSpace(blk.Text)
					if len(body) > 4000 {
						body = body[:4000] + "\n… (截断)"
					}
					fmt.Fprintf(&b, "<details><summary>%s</summary>\n\n```\n%s\n```\n\n</details>\n\n", label, body)
				case "image":
					fmt.Fprintf(&b, "_[图片: %s]_\n\n", blk.Detail)
				}
			}
		}
		b.WriteString("---\n\n")
	}

	name := unsafeFilename.ReplaceAllString(title, "_")
	if len([]rune(name)) > 60 {
		name = string([]rune(name)[:60])
	}
	if name == "" {
		name = id
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename*=UTF-8''%s.md", urlEscape(name)))
	io.WriteString(w, b.String())
}

func prettyJSON(raw []byte) string {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return string(raw)
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return string(raw)
	}
	s := string(b)
	if len(s) > 8000 {
		s = s[:8000] + "\n… (截断)"
	}
	return s
}

func urlEscape(s string) string {
	// Minimal percent-encoding for the Content-Disposition filename.
	var b strings.Builder
	for _, c := range []byte(s) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// Listen binds the port, walking forward if it is taken.
func (s *Server) Listen() (net.Listener, string, error) {
	host, portStr, err := net.SplitHostPort(s.addr)
	if err != nil {
		return nil, "", err
	}
	port, _ := strconv.Atoi(portStr)
	if port == 0 {
		ln, err := net.Listen("tcp", s.addr)
		if err != nil {
			return nil, "", err
		}
		return ln, "http://" + ln.Addr().String(), nil
	}
	for i := 0; i < 20; i++ {
		addr := net.JoinHostPort(host, strconv.Itoa(port+i))
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return ln, "http://" + addr, nil
		}
	}
	return nil, "", fmt.Errorf("端口 %d-%d 均被占用", port, port+19)
}
