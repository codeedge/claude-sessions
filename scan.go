package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// Claude Code writes one JSON object per line. Most bytes are noise we never
// need (hook attachments, full API request dumps), so lines are cheaply
// pre-filtered before any JSON decoding happens.
var (
	needleType = []byte(`"type"`)
	needleUser = []byte(`"type":"user"`)
	needleAsst = []byte(`"type":"assistant"`)
	needleTitl = []byte(`"type":"ai-title"`)
	needleCost = []byte(`"type":"cost-state"`)
)

const (
	maxLineBytes = 64 << 20 // generous ceiling; observed max is 1.5 MB
	maxBlockText = 48 << 10 // per content block, keeps a 134 MB file renderable
	maxToolInput = 16 << 10
)

type rawRecord struct {
	Type        string          `json:"type"`
	UUID        string          `json:"uuid"`
	Timestamp   string          `json:"timestamp"`
	CWD         string          `json:"cwd"`
	GitBranch   string          `json:"gitBranch"`
	Version     string          `json:"version"`
	IsSidechain bool            `json:"isSidechain"`
	IsMeta      bool            `json:"isMeta"`
	AITitle     string          `json:"aiTitle"`
	Message     json.RawMessage `json:"message"`
	ModelUsage  map[string]struct {
		InputTokens  int `json:"inputTokens"`
		OutputTokens int `json:"outputTokens"`
	} `json:"modelUsage"`
}

type rawMessage struct {
	Role    string          `json:"role"`
	Model   string          `json:"model"`
	Content json.RawMessage `json:"content"`
	Usage   *Usage          `json:"usage"`
}

type rawBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	Name      string          `json:"name"`
	ID        string          `json:"id"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
	Source    *struct {
		MediaType string `json:"media_type"`
	} `json:"source"`
}

// eachRecord streams the conversation records of one jsonl file.
func eachRecord(path string, fn func(line []byte)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 128<<10), maxLineBytes)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) < 16 || !bytes.Contains(line, needleType) {
			continue
		}
		if !bytes.Contains(line, needleUser) &&
			!bytes.Contains(line, needleAsst) &&
			!bytes.Contains(line, needleTitl) &&
			!bytes.Contains(line, needleCost) {
			continue
		}
		fn(line)
	}
	return sc.Err()
}

// contentInfo is the flattened result of decoding a message content field.
type contentInfo struct {
	Text          string
	Blocks        []Block
	ToolUses      int
	Failures      int
	Files         []string
	HasToolResult bool
}

// decodeContent normalizes content, which is either a string or a block array.
// wantBlocks=false skips building display blocks (startup indexing only needs text).
func decodeContent(raw json.RawMessage, wantBlocks bool) contentInfo {
	var ci contentInfo
	if len(raw) == 0 {
		return ci
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			ci.Text = s
		}
		return ci
	}
	var blocks []rawBlock
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ci
	}

	var text strings.Builder
	for _, b := range blocks {
		switch b.Type {
		case "text":
			appendText(&text, b.Text)
			if wantBlocks && b.Text != "" {
				ci.Blocks = append(ci.Blocks, Block{Kind: "text", Text: clip(b.Text, maxBlockText)})
			}
		case "thinking":
			if wantBlocks && b.Thinking != "" {
				ci.Blocks = append(ci.Blocks, Block{Kind: "thinking", Text: clip(b.Thinking, maxBlockText)})
			}
			appendText(&text, b.Thinking)
		case "tool_use":
			ci.ToolUses++
			name, summary, file := describeTool(b.Name, b.Input)
			if file != "" {
				ci.Files = append(ci.Files, file)
			}
			appendText(&text, name)
			appendText(&text, summary)
			if wantBlocks {
				blk := Block{Kind: "tool_use", Name: b.Name, Summary: summary, ToolUseID: b.ID}
				if len(b.Input) > maxToolInput {
					blk.Detail = clip(string(b.Input), maxToolInput)
				} else if len(b.Input) > 0 {
					blk.Input = b.Input
				}
				ci.Blocks = append(ci.Blocks, blk)
			}
		case "tool_result":
			ci.HasToolResult = true
			body := toolResultText(b.Content)
			if b.IsError {
				ci.Failures++
			}
			appendText(&text, body)
			if wantBlocks {
				ci.Blocks = append(ci.Blocks, Block{
					Kind:      "tool_result",
					Text:      clip(body, maxBlockText),
					ToolUseID: b.ToolUseID,
					IsError:   b.IsError,
				})
			}
		case "image":
			mt := "image"
			if b.Source != nil && b.Source.MediaType != "" {
				mt = b.Source.MediaType
			}
			appendText(&text, "["+mt+"]")
			if wantBlocks {
				ci.Blocks = append(ci.Blocks, Block{Kind: "image", Detail: mt})
			}
		}
	}
	ci.Text = text.String()
	return ci
}

func appendText(sb *strings.Builder, s string) {
	if s == "" {
		return
	}
	if sb.Len() > 0 {
		sb.WriteByte('\n')
	}
	sb.WriteString(s)
}

// toolResultText flattens a tool_result content field (string or block array).
func toolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s
		}
		return ""
	}
	var blocks []rawBlock
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return string(raw)
	}
	var sb strings.Builder
	for _, b := range blocks {
		switch b.Type {
		case "text":
			appendText(&sb, b.Text)
		case "image":
			appendText(&sb, "[image]")
		}
	}
	return sb.String()
}

// describeTool returns a display name, a one-line summary, and the file touched.
func describeTool(name string, input json.RawMessage) (string, string, string) {
	if len(input) == 0 {
		return name, "", ""
	}
	var m map[string]any
	if err := json.Unmarshal(input, &m); err != nil {
		return name, clip(string(input), 160), ""
	}
	str := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := m[k].(string); ok && v != "" {
				return v
			}
		}
		return ""
	}
	file := str("file_path", "notebook_path", "path")
	summary := file
	if summary == "" {
		summary = str("command", "pattern", "url", "query", "description", "prompt", "skill")
	}
	if summary == "" && len(m) > 0 {
		if b, err := json.Marshal(m); err == nil {
			summary = clip(string(b), 160)
		}
	}
	return name, clip(summary, 220), file
}

func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "\n… (已截断)"
}

func parseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// scanMeta builds the list-level record for one session file. It walks the file
// once, extracting metadata and the searchable conversation text only.
// metaAcc accumulates the list-level view of a session. It is fed either the
// whole file (first sighting) or only the bytes appended since the last scan.
type metaAcc struct {
	info        *SessionInfo
	search      strings.Builder
	first       time.Time
	last        time.Time
	title       string
	firstPrompt string
	ctxTokens   int    // 最后一条 assistant 的输入侧 token，约等于当前上下文占用
	modelKey    string // cost-state 里的模型名，可能带 [1m] 窗口后缀
}

// consumeRecord folds one jsonl record into the accumulator.
func (a *metaAcc) consumeRecord(line []byte) {
	var rec rawRecord
	if json.Unmarshal(line, &rec) != nil {
		return
	}
	switch rec.Type {
	case "cost-state":
		// cost-state 里的模型名带窗口后缀（如 deepseek-v4.1-flash[1m]），
		// 而消息体里的 model 字段不带，所以窗口大小只能从这里取。
		best, bestN := "", 0
		for k, v := range rec.ModelUsage {
			if n := v.InputTokens + v.OutputTokens; n >= bestN {
				best, bestN = k, n
			}
		}
		if best != "" {
			a.modelKey = best
		}
	case "ai-title":
		if rec.AITitle != "" {
			a.title = rec.AITitle
		}
	case "user", "assistant":
		if ts := parseTime(rec.Timestamp); !ts.IsZero() {
			if a.first.IsZero() || ts.Before(a.first) {
				a.first = ts
			}
			if ts.After(a.last) {
				a.last = ts
			}
		}
		if a.info.CWD == "" && rec.CWD != "" {
			a.info.CWD = rec.CWD
		}
		if a.info.Branch == "" && rec.GitBranch != "" {
			a.info.Branch = rec.GitBranch
		}
		if a.info.Version == "" && rec.Version != "" {
			a.info.Version = rec.Version
		}
		var msg rawMessage
		if json.Unmarshal(rec.Message, &msg) != nil {
			return
		}
		ci := decodeContent(msg.Content, false)

		if rec.Type == "assistant" {
			a.info.AsstMsgs++
			a.info.ToolCalls += ci.ToolUses
			if msg.Model != "" {
				a.info.Model = msg.Model
			}
			if msg.Usage != nil {
				a.info.In += msg.Usage.InputTokens
				a.info.Out += msg.Usage.OutputTokens
				a.info.CacheRead += msg.Usage.CacheReadInputTokens
				a.info.CacheCreate += msg.Usage.CacheCreationInputTokens
				a.ctxTokens = msg.Usage.InputTokens +
					msg.Usage.CacheReadInputTokens +
					msg.Usage.CacheCreationInputTokens
			}
			if ci.Text != "" {
				a.search.WriteString(ci.Text)
				a.search.WriteByte('\n')
			}
			return
		}

		// user records: skip system-injected noise, otherwise keep as prompt text.
		if rec.IsMeta || ci.HasToolResult {
			return
		}
		a.info.UserMsgs++
		if a.firstPrompt == "" {
			a.firstPrompt = titleCandidate(ci.Text)
		}
		if ci.Text != "" {
			a.search.WriteString(ci.Text)
			a.search.WriteByte('\n')
		}
	}
}

// finish applies the accumulated values, keeping whatever the previous scan
// already knew when the tail added nothing new.
func (a *metaAcc) finish(fi os.FileInfo, prev *SessionInfo, offset int64) *SessionInfo {
	info := a.info
	info.Size = fi.Size()
	info.modTime = fi.ModTime().UnixNano()
	info.parsedOffset = offset

	if prev != nil {
		info.searchText = prev.searchText + asciiLower(a.search.String())
	} else {
		info.searchText = asciiLower(a.search.String())
	}

	if a.firstPrompt != "" {
		info.FirstPrompt = a.firstPrompt
	} else if prev != nil {
		info.FirstPrompt = prev.FirstPrompt
	}

	if a.title != "" {
		info.Title = a.title
	} else if prev != nil && prev.Title != "" {
		info.Title = prev.Title
	} else {
		info.Title = info.FirstPrompt
	}
	if info.Title == "" {
		info.Title = "(无标题会话)"
	}

	info.CreatedAt = a.first
	if prev != nil && !prev.CreatedAt.IsZero() && (info.CreatedAt.IsZero() || prev.CreatedAt.Before(info.CreatedAt)) {
		info.CreatedAt = prev.CreatedAt
	}
	info.UpdatedAt = a.last
	if info.UpdatedAt.IsZero() {
		info.UpdatedAt = fi.ModTime()
	}
	if info.CreatedAt.IsZero() {
		info.CreatedAt = info.UpdatedAt
	}
	if a.ctxTokens > 0 {
		info.ContextTokens = a.ctxTokens
	} else if prev != nil {
		info.ContextTokens = prev.ContextTokens
	}
	info.modelKey = a.modelKey
	if info.modelKey == "" && prev != nil {
		info.modelKey = prev.modelKey
	}
	limit := contextLimitFor(info.Model)
	if info.modelKey != "" {
		limit = contextLimitFor(info.modelKey)
	}
	// 兜底：占用已超过推测的窗口，说明撞上了更大窗口的模型
	for info.ContextTokens > limit && limit < 4_000_000 {
		limit *= 5
	}
	info.ContextLimit = limit

	if info.ProjectDir == "" {
		info.ProjectDir = filepath.Base(filepath.Dir(info.Path))
	}
	info.Project = info.CWD
	if info.Project == "" {
		info.Project = info.ProjectDir
	}
	return info
}

// scanMeta reads a transcript from the beginning.
func scanMeta(path string) (*SessionInfo, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	info := &SessionInfo{ID: strings.TrimSuffix(filepath.Base(path), ".jsonl"), Path: path}
	acc := &metaAcc{info: info}
	offset, err := eachRecordFrom(f, 0, acc.consumeRecord)
	if err != nil {
		return nil, err
	}
	return acc.finish(fi, nil, offset), nil
}

// scanMetaIncremental only reads the bytes appended since the previous scan.
// Claude Code appends to transcripts, so this turns a 128 MB re-parse into a
// few kilobytes of work. It falls back to a full parse on shrink or rewrite.
func scanMetaIncremental(path string, prev *SessionInfo) (*SessionInfo, error) {
	if prev == nil {
		return scanMeta(path)
	}
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if fi.Size() < prev.parsedOffset || fi.Size() == 0 {
		return scanMeta(path) // truncated or rewritten
	}
	if fi.Size() == prev.parsedOffset {
		return prev, nil // nothing new
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	info := *prev // shallow copy: strings are immutable, slices are replaced below
	acc := &metaAcc{info: &info, first: prev.CreatedAt, last: prev.UpdatedAt}
	offset, err := eachRecordFrom(f, prev.parsedOffset, acc.consumeRecord)
	if err != nil {
		return nil, err
	}
	return acc.finish(fi, prev, offset), nil
}

// eachRecordFrom reads newline-delimited records starting at offset and returns
// the offset just past the last complete line. A partially written trailing line
// is left unconsumed so the next scan can read it again.
func eachRecordFrom(f *os.File, offset int64, fn func(line []byte)) (int64, error) {
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return offset, err
	}
	br := bufio.NewReaderSize(f, 1<<20)
	consumed := offset
	for {
		raw, err := br.ReadBytes('\n')
		if len(raw) > 0 && raw[len(raw)-1] == '\n' {
			consumed += int64(len(raw))
			line := raw[:len(raw)-1]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			if len(line) >= 16 && bytes.Contains(line, needleType) {
				fn(line)
			}
		}
		if err != nil {
			if err == io.EOF {
				return consumed, nil
			}
			return consumed, err
		}
	}
}

// parseTurns fully parses one transcript into collapsible turns.
func parseTurns(path string) ([]Turn, error) {
	turns := make([]Turn, 0, 32)
	cur := -1
	seen := make(map[string]bool, 256)

	err := eachRecord(path, func(line []byte) {
		var rec rawRecord
		if json.Unmarshal(line, &rec) != nil {
			return
		}
		if rec.Type != "user" && rec.Type != "assistant" {
			return
		}
		if rec.UUID != "" {
			if seen[rec.UUID] {
				return
			}
			seen[rec.UUID] = true
		}
		var msg rawMessage
		if json.Unmarshal(rec.Message, &msg) != nil {
			return
		}
		ci := decodeContent(msg.Content, true)
		if len(ci.Blocks) == 0 && ci.Text == "" {
			return
		}
		ts := parseTime(rec.Timestamp)

		if rec.Type == "user" && !ci.HasToolResult {
			// A skill or slash-command invocation carries its arguments inline.
			if cmd, args, ok := parseSlashCommand(ci.Text); ok {
				turns = append(turns, Turn{
					Index:   len(turns) + 1,
					Command: cmd,
					Prompt:  clip(args, maxBlockText),
					TS:      ts,
				})
				cur = len(turns) - 1
				return
			}
			if rec.IsMeta {
				// Skill bodies and injected context: keep them as collapsed notes
				// on the current turn instead of throwing the content away.
				if cur >= 0 && isNoteText(ci.Text) {
					turns[cur].Notes = append(turns[cur].Notes, clip(ci.Text, maxBlockText))
				}
				return
			}
			if looksLikeSystemText(ci.Text) {
				return
			}
			turns = append(turns, Turn{
				Index:  len(turns) + 1,
				Prompt: clip(ci.Text, maxBlockText),
				TS:     ts,
			})
			cur = len(turns) - 1
			return
		}

		if cur < 0 {
			if ci.HasToolResult {
				return
			}
			turns = append(turns, Turn{Index: len(turns) + 1, TS: ts})
			cur = len(turns) - 1
		}

		m := Message{
			ID:     rec.UUID,
			Role:   rec.Type,
			TS:     ts,
			Model:  msg.Model,
			Blocks: ci.Blocks,
		}
		if msg.Usage != nil {
			m.In = msg.Usage.InputTokens
			m.Out = msg.Usage.OutputTokens
			m.CacheRead = msg.Usage.CacheReadInputTokens
			m.CacheCreate = msg.Usage.CacheCreationInputTokens
		}
		t := &turns[cur]
		t.Messages = append(t.Messages, m)
		t.Steps += ci.ToolUses
		t.Failures += ci.Failures
		for _, f := range ci.Files {
			t.Files = appendUnique(t.Files, f)
		}
	})
	if err != nil {
		return nil, err
	}

	// Drop turns that carry nothing at all (e.g. a bare /clear), then renumber
	// so the outline and deep links stay contiguous.
	kept := turns[:0]
	for _, t := range turns {
		if t.Prompt == "" && t.Command == "" && len(t.Messages) == 0 && len(t.Notes) == 0 {
			continue
		}
		if t.Prompt == "" && len(t.Messages) == 0 && len(t.Notes) == 0 && t.Command != "" {
			continue
		}
		t.Index = len(kept) + 1
		kept = append(kept, t)
	}
	return kept, nil
}

// isNoteText keeps markdown-ish meta content (skill instructions) and drops
// angle-bracket wrappers such as <local-command-caveat>.
func isNoteText(s string) bool {
	t := strings.TrimSpace(s)
	return t != "" && !strings.HasPrefix(t, "<")
}

func appendUnique(list []string, s string) []string {
	for _, v := range list {
		if v == s {
			return list
		}
	}
	return append(list, s)
}

// titleCandidate turns a user message into a list title. Injected wrappers are
// rejected, and slash commands are shown as "/name args" instead of raw tags.
func titleCandidate(s string) string {
	if strings.TrimSpace(s) == "" {
		return ""
	}
	if cmd, args, ok := parseSlashCommand(s); ok {
		if args == "" {
			return "" // a bare /clear or /model carries no title value
		}
		return oneLine(cmd+" "+args, 200)
	}
	if looksLikeSystemText(s) {
		return ""
	}
	return oneLine(s, 200)
}

// parseSlashCommand recognises the wrapper Claude Code writes when a slash
// command or skill is invoked: /name plus free-form arguments.
func parseSlashCommand(s string) (name, args string, ok bool) {
	if !strings.Contains(s, "<command-name>") && !strings.Contains(s, "<command-message>") {
		return "", "", false
	}
	name = between(s, "<command-name>", "</command-name>")
	if name == "" {
		name = between(s, "<command-message>", "</command-message>")
	}
	args = strings.TrimSpace(between(s, "<command-args>", "</command-args>"))
	if name == "" {
		name = "(命令)"
	}
	if !strings.HasPrefix(name, "/") {
		name = "/" + name
	}
	return name, args, true
}

func between(s, open, close string) string {
	i := strings.Index(s, open)
	if i < 0 {
		return ""
	}
	i += len(open)
	j := strings.Index(s[i:], close)
	if j < 0 {
		return ""
	}
	return strings.TrimSpace(s[i : i+j])
}

// contextLimitFor guesses the model's context window from its name. Models
// routed through a relay often carry a "[1m]" suffix; everything else is 200k.
func contextLimitFor(model string) int {
	if strings.Contains(strings.ToLower(model), "[1m]") {
		return 1_000_000
	}
	return 200_000
}

// looksLikeSystemText filters injected wrappers out of prompt candidates.
func looksLikeSystemText(s string) bool {
	t := strings.TrimSpace(s)
	for _, p := range []string{"<local-command", "<system-reminder", "<user-prompt-submit-hook"} {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return false
}

func oneLine(s string, max int) string {
	s = strings.ReplaceAll(s, "\r", "")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, 3)
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		out = append(out, l)
		if len(strings.Join(out, " ")) > max {
			break
		}
	}
	r := strings.TrimSpace(strings.Join(out, " "))
	if utf8.RuneCountInString(r) > max {
		runes := []rune(r)
		r = string(runes[:max]) + "…"
	}
	return r
}

// asciiLower lowercases only A-Z. Byte length is preserved, so offsets stay
// aligned with the original file content.
func asciiLower(s string) string {
	b := []byte(s)
	for i := 0; i < len(b); i++ {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}
