package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// HUD：直接复用 Claude Code 自己的 statusLine 命令（这台机器上是 OMC 的 HUD），
// 把它的输出转成 HTML 显示在网页里，这样版本、更新提示、上下文占用这些完全一致。

type hudANSISpan struct {
	text string
	cls  []string
}

func (s *Server) handleHUD(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	info, ok := s.ix.Get(id)
	if !ok {
		writeErr(w, 404, "会话不存在")
		return
	}

	cmd := s.statusLineCommand()
	if cmd == "" {
		writeJSON(w, 200, map[string]any{"html": "", "enabled": false})
		return
	}

	payload := map[string]any{
		"session_id":      info.ID,
		"transcript_path": info.Path,
		"cwd":             info.CWD,
		"workspace": map[string]string{
			"current_dir": info.CWD,
			"project_dir": info.ProjectDir,
		},
		"model": map[string]string{
			"id":           info.Model,
			"display_name": info.Model,
		},
		"version":      info.Version,
		"output_style": map[string]string{"name": "default"},
	}
	body, _ := json.Marshal(payload)

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, "sh", "-c", cmd)
	c.Dir = usableDir(info.CWD)
	c.Stdin = bytes.NewReader(body)
	c.Env = os.Environ()
	out, err := c.Output()
	if err != nil && len(out) == 0 {
		writeJSON(w, 200, map[string]any{"html": "", "enabled": true, "error": err.Error()})
		return
	}

	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) > 6 {
		lines = lines[:6]
	}
	writeJSON(w, 200, map[string]any{"html": ansiToHTML(strings.Join(lines, "\n")), "enabled": true})
}

// statusLineCommand 从 settings.json 里取 statusLine 命令
func (s *Server) statusLineCommand() string {
	b, err := os.ReadFile(filepath.Join(s.ix.home, "settings.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		StatusLine struct {
			Type    string `json:"type"`
			Command string `json:"command"`
		} `json:"statusLine"`
	}
	if json.Unmarshal(b, &cfg) != nil || cfg.StatusLine.Type != "command" {
		return ""
	}
	return strings.TrimSpace(cfg.StatusLine.Command)
}

// ansiToHTML 把常见的 SGR 颜色转成带 class 的 span，其余控制符直接丢掉
func ansiToHTML(s string) string {
	var b strings.Builder
	var cls []string
	open := false
	closeSpan := func() {
		if open {
			b.WriteString("</span>")
			open = false
		}
	}
	flush := func() {
		closeSpan()
		if len(cls) > 0 {
			b.WriteString(`<span class="` + strings.Join(cls, " ") + `">`)
			open = true
		}
	}

	for i := 0; i < len(s); i++ {
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) && (s[j] < '@' || s[j] > '~') {
				j++
			}
			if j < len(s) {
				params := s[i+2 : j]
				code := s[j]
				i = j
				if code == 'm' {
					cls = applySGR(cls, params)
					flush()
				}
				continue
			}
		}
		switch s[i] {
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '&':
			b.WriteString("&amp;")
		case '\n':
			closeSpan()
			b.WriteString("<br>")
			flush()
		default:
			b.WriteByte(s[i])
		}
	}
	closeSpan()
	return b.String()
}

func applySGR(current []string, params string) []string {
	if params == "" || params == "0" {
		return nil
	}
	out := append([]string{}, current...)
	for _, p := range strings.Split(params, ";") {
		n, _ := strconv.Atoi(p)
		switch {
		case n == 0:
			out = nil
		case n == 1:
			out = appendClass(out, "b")
		case n == 2:
			out = appendClass(out, "dim")
		case n == 22:
			out = dropClass(out, "b")
			out = dropClass(out, "dim")
		case n >= 30 && n <= 37:
			out = setColor(out, fmt.Sprintf("fg%d", n-30))
		case n >= 90 && n <= 97:
			out = setColor(out, fmt.Sprintf("fg%d", n-90+8))
		}
	}
	return out
}

var colorClasses = map[string]bool{
	"fg0": true, "fg1": true, "fg2": true, "fg3": true, "fg4": true,
	"fg5": true, "fg6": true, "fg7": true, "fg8": true, "fg9": true,
	"fg10": true, "fg11": true, "fg12": true, "fg13": true, "fg14": true, "fg15": true,
}

func setColor(list []string, c string) []string {
	out := dropColor(list)
	return append(out, c)
}

func dropColor(list []string) []string {
	out := make([]string, 0, len(list))
	for _, v := range list {
		if !colorClasses[v] {
			out = append(out, v)
		}
	}
	return out
}

func appendClass(list []string, c string) []string {
	for _, v := range list {
		if v == c {
			return list
		}
	}
	return append(list, c)
}

func dropClass(list []string, c string) []string {
	out := make([]string, 0, len(list))
	for _, v := range list {
		if v != c {
			out = append(out, v)
		}
	}
	return out
}
