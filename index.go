package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Index is the in-memory catalog of every session on disk. Claude Code's jsonl
// files are the source of truth, so the index can always be rebuilt from
// scratch; it is kept in memory purely to make search instant.
type Index struct {
	home string // ~/.claude
	app  string // application state dir, holds the trash

	scanMu   sync.Mutex
	mu       sync.RWMutex
	sessions map[string]*SessionInfo
	scanned  time.Time
	dur      time.Duration
	files    int
	scanErr  error

	runningMu sync.Mutex
	running   map[string]bool
	runningAt time.Time

	detailMu sync.Mutex
	detail   map[string]*detailCache
}

type detailCache struct {
	mod   int64
	turns []Turn
}

const detailCacheSize = 4

func NewIndex(home, app string) *Index {
	return &Index{
		home:     home,
		app:      app,
		sessions: map[string]*SessionInfo{},
		running:  map[string]bool{},
		detail:   map[string]*detailCache{},
	}
}

func (ix *Index) Home() string { return ix.home }
func (ix *Index) App() string  { return ix.app }

// Scan rebuilds the catalog, serialized against concurrent rescans.
func (ix *Index) Scan() error {
	ix.scanMu.Lock()
	defer ix.scanMu.Unlock()
	return ix.scanLocked()
}

// MaybeRescan refreshes the catalog if the last scan is older than ttl. Because
// scanning is incremental it costs milliseconds, so read endpoints can call it
// freely and sessions created elsewhere show up without pressing refresh.
func (ix *Index) MaybeRescan(ttl time.Duration) bool {
	ix.mu.RLock()
	scanned := ix.scanned
	ix.mu.RUnlock()
	if time.Since(scanned) < ttl {
		return false
	}

	ix.scanMu.Lock()
	defer ix.scanMu.Unlock()
	ix.mu.RLock()
	scanned = ix.scanned
	ix.mu.RUnlock()
	if time.Since(scanned) < ttl {
		return false
	}
	if err := ix.scanLocked(); err != nil {
		log.Printf("自动重扫: %v", err)
	}
	return true
}

func (ix *Index) scanLocked() error {
	start := time.Now()
	projectsDir := filepath.Join(ix.home, "projects")

	ix.mu.RLock()
	prev := ix.sessions
	ix.mu.RUnlock()

	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return fmt.Errorf("读取 %s 失败: %w", projectsDir, err)
	}

	var paths []string
	projectDirs := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(projectsDir, e.Name())
		projectDirs = append(projectDirs, dir)
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			paths = append(paths, filepath.Join(dir, f.Name()))
		}
	}

	out := make(map[string]*SessionInfo, len(paths))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, max(2, runtime.NumCPU()))
	var firstErr error

	for _, p := range paths {
		fi, err := os.Stat(p)
		if err != nil {
			continue
		}
		id := strings.TrimSuffix(filepath.Base(p), ".jsonl")

		// Reuse an identical previous parse.
		if old, ok := prev[id]; ok && old.Size == fi.Size() && old.modTime == fi.ModTime().UnixNano() {
			mu.Lock()
			out[id] = old
			mu.Unlock()
			continue
		}

		prevInfo := prev[id]

		wg.Add(1)
		sem <- struct{}{}
		go func(path, id string, old *SessionInfo) {
			defer wg.Done()
			defer func() { <-sem }()
			info, err := scanMetaIncremental(path, old)
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("%s: %w", path, err)
				}
				mu.Unlock()
				return
			}
			mu.Lock()
			out[id] = info
			mu.Unlock()
		}(p, id, prevInfo)
	}
	wg.Wait()
	parseDone := time.Since(start)

	// Sessions written before cwd was recorded would otherwise fall back to a
	// lossy directory-name guess ("phone-number-check" -> "check"). Adopt the
	// cwd most of the sibling sessions in the same project directory agree on.
	cwdVotes := map[string]map[string]int{}
	for _, s := range out {
		if s.CWD == "" {
			continue
		}
		if cwdVotes[s.ProjectDir] == nil {
			cwdVotes[s.ProjectDir] = map[string]int{}
		}
		cwdVotes[s.ProjectDir][s.CWD]++
	}
	for _, s := range out {
		if s.CWD != "" {
			continue
		}
		best, bestN := "", 0
		for cwd, n := range cwdVotes[s.ProjectDir] {
			if n > bestN {
				best, bestN = cwd, n
			}
		}
		if best != "" {
			s.CWD = best
			s.Project = best
		}
	}

	// Attach subagent transcripts (Task tool children live beside the session).
	for _, dir := range projectDirs {
		subs, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, s := range subs {
			if !s.IsDir() {
				continue
			}
			parent, ok := out[s.Name()]
			if !ok {
				continue
			}
			subDir := filepath.Join(dir, s.Name(), "subagents")
			st, err := os.Stat(subDir)
			if err != nil {
				parent.Subagents = nil
				continue
			}
			// Subagent transcripts are big; only re-read them when the directory
			// actually changed.
			if parent.subagentStamp == st.ModTime().UnixNano() {
				continue
			}
			parent.Subagents = readSubagents(filepath.Join(dir, s.Name()))
			parent.subagentStamp = st.ModTime().UnixNano()
		}
	}

	subagentsStart := time.Now()
	_ = subagentsStart
	ix.mu.Lock()
	ix.sessions = out
	ix.scanned = time.Now()
	ix.dur = time.Since(start)
	if ix.dur > 200*time.Millisecond {
		log.Printf("扫描耗时 %s（其中解析 %s）", ix.dur.Round(time.Millisecond), parseDone.Round(time.Millisecond))
	}
	ix.files = len(paths)
	ix.scanErr = firstErr
	ix.mu.Unlock()

	return firstErr
}

func readSubagents(sessionDir string) []SubagentRef {
	subDir := filepath.Join(sessionDir, "subagents")
	files, err := os.ReadDir(subDir)
	if err != nil {
		return nil
	}
	var refs []SubagentRef
	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
			continue
		}
		id := strings.TrimSuffix(f.Name(), ".jsonl")
		path := filepath.Join(subDir, f.Name())
		ref := SubagentRef{ID: id, Path: path}

		metaPath := strings.TrimSuffix(path, ".jsonl") + ".meta.json"
		if b, err := os.ReadFile(metaPath); err == nil {
			var m struct {
				AgentType   string `json:"agentType"`
				Description string `json:"description"`
			}
			if json.Unmarshal(b, &m) == nil {
				ref.AgentType = m.AgentType
				ref.Description = m.Description
			}
		}
		if info, err := scanMeta(path); err == nil {
			ref.Msgs = info.UserMsgs + info.AsstMsgs
		}
		if ref.AgentType == "" {
			ref.AgentType = "subagent"
		}
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].ID < refs[j].ID })
	return refs
}

// refreshRunning marks sessions whose process is still alive.
func (ix *Index) refreshRunning() {
	ix.runningMu.Lock()
	if time.Since(ix.runningAt) < 2*time.Second {
		ix.runningMu.Unlock()
		return
	}
	ix.runningMu.Unlock()

	live := map[string]bool{}
	files, _ := os.ReadDir(filepath.Join(ix.home, "sessions"))
	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(ix.home, "sessions", f.Name()))
		if err != nil {
			continue
		}
		var s struct {
			PID       int    `json:"pid"`
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(b, &s) != nil || s.SessionID == "" {
			continue
		}
		if processAlive(s.PID) {
			live[s.SessionID] = true
		}
	}

	ix.runningMu.Lock()
	ix.running = live
	ix.runningAt = time.Now()
	ix.runningMu.Unlock()

	ix.mu.Lock()
	for id, s := range ix.sessions {
		s.Running = live[id]
	}
	ix.mu.Unlock()
}

func (ix *Index) isRunning(id string) bool {
	ix.runningMu.Lock()
	defer ix.runningMu.Unlock()
	return ix.running[id]
}

// SortKey enumerates the list orderings the UI offers.
type SortKey string

const (
	SortRecent  SortKey = "recent"
	SortCreated SortKey = "created"
	SortMsgs    SortKey = "messages"
	SortSize    SortKey = "size"
	SortTitle   SortKey = "title"
)

// ListOpts carries list filters. Mark resolves a session's annotations; when nil
// the list is unannotated (CLI use).
type ListOpts struct {
	Query   string
	Project string
	Sort    SortKey
	Limit   int
	Offset  int
	Starred bool   // only starred sessions
	Tag     string // only sessions carrying this tag
	Asc     bool   // reverse the natural order of the chosen sort key
	Mark    func(id string) Mark
}

// List returns sessions matching the filters, plus the total match count.
func (ix *Index) List(opts ListOpts) ([]Hit, int, int64) {
	q, project, sortKey, limit, offset := opts.Query, opts.Project, opts.Sort, opts.Limit, opts.Offset
	ix.refreshRunning()

	ix.mu.RLock()
	all := make([]*SessionInfo, 0, len(ix.sessions))
	for _, s := range ix.sessions {
		all = append(all, s)
	}
	ix.mu.RUnlock()

	tokens := strings.Fields(asciiLower(q))
	hits := make([]Hit, 0, len(all))
	var totalSize int64

	for _, s := range all {
		if project != "" && s.Project != project {
			continue
		}

		var mark Mark
		if opts.Mark != nil {
			mark = opts.Mark(s.ID)
		}
		if opts.Starred && !mark.Starred {
			continue
		}
		if opts.Tag != "" && !hasTag(mark.Tags, opts.Tag) {
			continue
		}

		// 用户改过名就用自定义标题，同时让搜索能命中它
		sess := *s
		if mark.Title != "" {
			sess.Title = mark.Title
		}

		totalSize += s.Size
		if len(tokens) > 0 {
			n, snippet := matchSession(&sess, tokens)
			if n == 0 {
				continue
			}
			hits = append(hits, Hit{SessionInfo: sess, Snippet: snippet, Matches: n,
				OriginalTitle: s.Title,
				Starred:       mark.Starred, Tags: mark.Tags, Note: mark.Note})
			continue
		}
		hits = append(hits, Hit{SessionInfo: sess, OriginalTitle: s.Title,
			Starred: mark.Starred, Tags: mark.Tags, Note: mark.Note})
	}

	// Each key has a natural order (newest / biggest first, titles A→Z); Asc
	// simply reverses it, so one toggle covers every sort key.
	var less func(i, j int) bool
	switch sortKey {
	case SortCreated:
		less = func(i, j int) bool { return hits[i].CreatedAt.After(hits[j].CreatedAt) }
	case SortMsgs:
		less = func(i, j int) bool {
			return hits[i].UserMsgs+hits[i].AsstMsgs > hits[j].UserMsgs+hits[j].AsstMsgs
		}
	case SortSize:
		less = func(i, j int) bool { return hits[i].Size > hits[j].Size }
	case SortTitle:
		less = func(i, j int) bool { return hits[i].Title < hits[j].Title }
	default:
		less = func(i, j int) bool { return hits[i].UpdatedAt.After(hits[j].UpdatedAt) }
	}
	asc := opts.Asc
	sort.SliceStable(hits, func(i, j int) bool { return less(i, j) != asc })

	total := len(hits)
	if offset > 0 {
		if offset >= len(hits) {
			hits = nil
		} else {
			hits = hits[offset:]
		}
	}
	if limit > 0 && len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, total, totalSize
}

// matchSession counts token occurrences across all searchable fields and
// returns a snippet around the first hit.
func matchSession(s *SessionInfo, tokens []string) (int, string) {
	var hay strings.Builder
	hay.Grow(len(s.searchText) + 256)
	hay.WriteString(asciiLower(s.Title))
	hay.WriteByte('\n')
	hay.WriteString(asciiLower(s.CWD))
	hay.WriteByte('\n')
	hay.WriteString(asciiLower(s.ID))
	hay.WriteByte('\n')
	hay.WriteString(asciiLower(s.Branch))
	hay.WriteByte('\n')
	hay.WriteString(s.searchText)
	text := hay.String()

	total := 0
	for _, tok := range tokens {
		n := strings.Count(text, tok)
		if n == 0 {
			return 0, ""
		}
		total += n
	}

	// Prefer a snippet from the conversation itself; a title-only match needs none.
	firstIdx := -1
	for _, tok := range tokens {
		if idx := strings.Index(s.searchText, tok); idx >= 0 && (firstIdx < 0 || idx < firstIdx) {
			firstIdx = idx
		}
	}
	if firstIdx < 0 {
		return total, ""
	}
	text = s.searchText
	start := firstIdx - 90
	if start < 0 {
		start = 0
	}
	end := firstIdx + 140
	if end > len(text) {
		end = len(text)
	}
	snippet := text[start:end]
	snippet = strings.ReplaceAll(snippet, "\n", " ")
	if start > 0 {
		snippet = "…" + snippet
	}
	if end < len(text) {
		snippet += "…"
	}
	return total, strings.TrimSpace(snippet)
}

// Projects returns every distinct project path with session counts.
func (ix *Index) Projects() []ProjectStat {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	agg := map[string]*ProjectStat{}
	for _, s := range ix.sessions {
		p, ok := agg[s.Project]
		if !ok {
			p = &ProjectStat{Path: s.Project}
			agg[s.Project] = p
		}
		p.Count++
		p.Size += s.Size
		if s.UpdatedAt.After(p.UpdatedAt) {
			p.UpdatedAt = s.UpdatedAt
		}
	}
	out := make([]ProjectStat, 0, len(agg))
	for _, p := range agg {
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	return out
}

func hasTag(tags []string, want string) bool {
	for _, t := range tags {
		if t == want {
			return true
		}
	}
	return false
}

type ProjectStat struct {
	Path      string    `json:"path"`
	Count     int       `json:"count"`
	Size      int64     `json:"size"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Stats summarizes the whole catalog for the header bar.
type Stats struct {
	Sessions  int       `json:"sessions"`
	Projects  int       `json:"projects"`
	Bytes     int64     `json:"bytes"`
	ScannedAt time.Time `json:"scannedAt"`
	ScanMS    int64     `json:"scanMs"`
	ScanError string    `json:"scanError,omitempty"`
	Home      string    `json:"home"`
	Running   int       `json:"running"`
}

func (ix *Index) Stats() Stats {
	ix.refreshRunning()
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	var size int64
	running := 0
	proj := map[string]bool{}
	for _, s := range ix.sessions {
		size += s.Size
		proj[s.Project] = true
		if s.Running {
			running++
		}
	}
	st := Stats{
		Sessions:  len(ix.sessions),
		Projects:  len(proj),
		Bytes:     size,
		ScannedAt: ix.scanned,
		ScanMS:    ix.dur.Milliseconds(),
		Home:      ix.home,
		Running:   running,
	}
	if ix.scanErr != nil {
		st.ScanError = ix.scanErr.Error()
	}
	return st
}

// RecentCWD returns the working directory of the most recently active session,
// which is a better default for a new terminal than the home directory.
func (ix *Index) RecentCWD() string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	best := ""
	var newest time.Time
	for _, s := range ix.sessions {
		if s.CWD == "" {
			continue
		}
		if s.UpdatedAt.After(newest) {
			newest = s.UpdatedAt
			best = s.CWD
		}
	}
	return best
}

func (ix *Index) Get(id string) (*SessionInfo, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	s, ok := ix.sessions[id]
	if !ok {
		return nil, false
	}
	cp := *s
	return &cp, true
}

func (ix *Index) SubagentPath(sessionID, agentID string) (string, string, bool) {
	s, ok := ix.Get(sessionID)
	if !ok {
		return "", "", false
	}
	for _, sa := range s.Subagents {
		if sa.ID == agentID {
			return sa.Path, sa.AgentType, true
		}
	}
	return "", "", false
}

// Detail returns turns [from, from+count) for a session or one of its subagents.
func (ix *Index) Detail(sessionID, agentID string, from, count int) (*SessionDetail, error) {
	info, ok := ix.Get(sessionID)
	if !ok {
		return nil, errors.New("会话不存在")
	}
	path := info.Path
	agentType := ""
	sub := false
	if agentID != "" {
		p, at, ok := ix.SubagentPath(sessionID, agentID)
		if !ok {
			return nil, errors.New("子代理不存在")
		}
		path, agentType, sub = p, at, true
	}

	turns, err := ix.turnsCached(sessionID+"/"+agentID, path, info.modTime)
	if err != nil {
		return nil, err
	}

	d := &SessionDetail{SessionInfo: *info, TotalTurns: len(turns), From: from, Subagent: sub, AgentType: agentType}
	if from < 0 {
		// 负数表示从末尾往前数：from=-5 即最后 5 轮
		from = len(turns) + from
		if from < 0 {
			from = 0
		}
	}
	if from < len(turns) {
		end := from + count
		if count <= 0 || end > len(turns) {
			end = len(turns)
		}
		d.Turns = turns[from:end]
	}
	return d, nil
}

func (ix *Index) turnsCached(key, path string, mod int64) ([]Turn, error) {
	ix.detailMu.Lock()
	defer ix.detailMu.Unlock()

	if c, ok := ix.detail[key]; ok && c.mod == mod {
		return c.turns, nil
	}
	turns, err := parseTurns(path)
	if err != nil {
		return nil, err
	}
	if len(ix.detail) >= detailCacheSize {
		for k := range ix.detail {
			delete(ix.detail, k)
			break
		}
	}
	ix.detail[key] = &detailCache{mod: mod, turns: turns}
	return turns, nil
}

// SearchTurns greps inside one conversation (turn prompts, message text, tool
// input) and returns the matching turns with snippets.
func (ix *Index) SearchTurns(sessionID, agentID, q string) ([]TurnSearchHit, error) {
	info, ok := ix.Get(sessionID)
	if !ok {
		return nil, errors.New("会话不存在")
	}
	path := info.Path
	if agentID != "" {
		p, _, ok := ix.SubagentPath(sessionID, agentID)
		if !ok {
			return nil, errors.New("子代理不存在")
		}
		path = p
	}
	turns, err := ix.turnsCached(sessionID+"/"+agentID, path, info.modTime)
	if err != nil {
		return nil, err
	}

	needle := asciiLower(strings.TrimSpace(q))
	if needle == "" {
		return nil, nil
	}
	var out []TurnSearchHit
	for _, t := range turns {
		if strings.Contains(asciiLower(t.Prompt), needle) {
			out = append(out, TurnSearchHit{Turn: t.Index, Role: "user", Snippet: snippetAround(t.Prompt, q, 160)})
			continue
		}
		found := false
		for _, m := range t.Messages {
			for _, b := range m.Blocks {
				if strings.Contains(asciiLower(b.Text), needle) || strings.Contains(asciiLower(b.Summary), needle) {
					out = append(out, TurnSearchHit{
						Turn: t.Index, Role: m.Role,
						Snippet: snippetAround(firstNonEmpty(b.Text, b.Summary), q, 160),
					})
					found = true
					break
				}
			}
			if found {
				break
			}
		}
	}
	return out, nil
}

// snippetAround finds q case-insensitively and returns a window around it.
func snippetAround(s, q string, width int) string {
	if s == "" {
		return ""
	}
	lower := asciiLower(s)
	idx := strings.Index(lower, asciiLower(strings.TrimSpace(q)))
	if idx < 0 {
		if len(s) > width {
			return oneLine(s[:width], width)
		}
		return oneLine(s, width)
	}
	start := idx - width/3
	if start < 0 {
		start = 0
	}
	end := idx + len(q) + width
	if end > len(s) {
		end = len(s)
	}
	for start > 0 && !isRuneStart(s[start]) {
		start--
	}
	for end < len(s) && !isRuneStart(s[end]) {
		end--
	}
	out := oneLine(s[start:end], width)
	if start > 0 {
		out = "…" + out
	}
	if end < len(s) {
		out += "…"
	}
	return out
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// ---------------------------------------------------------------- deletion

// trashDir is where soft-deleted sessions live until purged.
func (ix *Index) trashDir() string { return filepath.Join(ix.app, "trash") }

// Delete soft-deletes sessions by moving their jsonl and companion directory
// into the trash. Nothing is ever removed from disk immediately.
func (ix *Index) Delete(ids []string) ([]string, map[string]string) {
	var deleted []string
	errs := map[string]string{}
	for _, id := range ids {
		info, ok := ix.Get(id)
		if !ok {
			errs[id] = "会话不存在"
			continue
		}
		if ix.isRunning(id) {
			errs[id] = "会话正在运行，已跳过"
			continue
		}
		if err := ix.moveToTrash(info); err != nil {
			errs[id] = err.Error()
			continue
		}
		ix.mu.Lock()
		delete(ix.sessions, id)
		ix.mu.Unlock()
		ix.detailMu.Lock()
		delete(ix.detail, id+"/")
		ix.detailMu.Unlock()
		deleted = append(deleted, id)
	}
	return deleted, errs
}

func (ix *Index) moveToTrash(info *SessionInfo) error {
	dest := filepath.Join(ix.trashDir(), info.ID)
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}

	dir := filepath.Join(filepath.Dir(info.Path), info.ID)
	entry := TrashEntry{
		ID:         info.ID,
		Title:      info.Title,
		Project:    info.Project,
		CWD:        info.CWD,
		DeletedAt:  time.Now(),
		Size:       info.Size,
		WasRunning: info.Running,
		OriginalJS: info.Path,
	}
	if st, err := os.Stat(dir); err == nil && st.IsDir() {
		entry.OriginalD = dir
	}

	if err := movePath(info.Path, filepath.Join(dest, "session.jsonl")); err != nil {
		os.RemoveAll(dest)
		return fmt.Errorf("移动会话文件失败: %w", err)
	}
	if entry.OriginalD != "" {
		if err := movePath(entry.OriginalD, filepath.Join(dest, "companion")); err != nil {
			// roll the transcript back so we never half-delete
			_ = movePath(filepath.Join(dest, "session.jsonl"), info.Path)
			os.RemoveAll(dest)
			return fmt.Errorf("移动会话目录失败: %w", err)
		}
	}
	if b, err := json.MarshalIndent(entry, "", "  "); err == nil {
		_ = os.WriteFile(filepath.Join(dest, "meta.json"), b, 0o644)
	}
	return nil
}

// movePath renames, falling back to copy+remove across filesystems.
func movePath(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	st, err := os.Stat(src)
	if err != nil {
		return err
	}
	if st.IsDir() {
		if err := copyTree(src, dst); err != nil {
			return err
		}
		return os.RemoveAll(src)
	}
	if err := copyFile(src, dst); err != nil {
		return err
	}
	return os.Remove(src)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func copyTree(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		return copyFile(path, target)
	})
}

// Trash lists soft-deleted sessions.
func (ix *Index) Trash() ([]TrashEntry, error) {
	entries, err := os.ReadDir(ix.trashDir())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]TrashEntry, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(ix.trashDir(), e.Name(), "meta.json"))
		if err != nil {
			continue
		}
		var t TrashEntry
		if json.Unmarshal(b, &t) != nil {
			continue
		}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DeletedAt.After(out[j].DeletedAt) })
	return out, nil
}

// Restore puts sessions back where they came from.
func (ix *Index) Restore(ids []string) ([]string, map[string]string) {
	var done []string
	errs := map[string]string{}
	for _, id := range ids {
		dir := filepath.Join(ix.trashDir(), id)
		b, err := os.ReadFile(filepath.Join(dir, "meta.json"))
		if err != nil {
			errs[id] = "回收站中找不到该会话"
			continue
		}
		var t TrashEntry
		if json.Unmarshal(b, &t) != nil {
			errs[id] = "回收站元信息损坏"
			continue
		}
		if _, err := os.Stat(t.OriginalJS); err == nil {
			errs[id] = "原位置已存在同名会话，未恢复"
			continue
		}
		if err := os.MkdirAll(filepath.Dir(t.OriginalJS), 0o755); err != nil {
			errs[id] = err.Error()
			continue
		}
		if err := movePath(filepath.Join(dir, "session.jsonl"), t.OriginalJS); err != nil {
			errs[id] = err.Error()
			continue
		}
		if t.OriginalD != "" {
			if err := movePath(filepath.Join(dir, "companion"), t.OriginalD); err != nil {
				errs[id] = "会话目录恢复失败: " + err.Error()
				continue
			}
		}
		os.RemoveAll(dir)
		done = append(done, id)
	}
	return done, errs
}

// Purge permanently removes entries from the trash.
func (ix *Index) Purge(ids []string) ([]string, map[string]string) {
	var done []string
	errs := map[string]string{}
	for _, id := range ids {
		dir := filepath.Join(ix.trashDir(), id)
		if err := os.RemoveAll(dir); err != nil {
			errs[id] = err.Error()
			continue
		}
		done = append(done, id)
	}
	return done, errs
}
