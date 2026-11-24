package main

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// 斜杠命令补全的数据源：技能目录、用户命令、插件命令，加一份内置命令表。

type slashCmd struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Kind        string `json:"kind"` // skill | command | plugin | builtin
}

var builtinCommands = []slashCmd{
	{"clear", "清空当前对话上下文，重新开始", "builtin"},
	{"compact", "压缩当前对话，保留摘要继续", "builtin"},
	{"model", "切换模型", "builtin"},
	{"help", "查看帮助", "builtin"},
	{"resume", "恢复某个历史会话", "builtin"},
	{"export", "导出当前对话", "builtin"},
	{"cost", "查看本次会话消耗", "builtin"},
	{"status", "查看当前状态", "builtin"},
	{"agents", "管理子代理", "builtin"},
	{"tasks", "查看后台任务", "builtin"},
	{"review", "审查当前改动", "builtin"},
	{"subtask <任务>", "在后台 fork 一个代理执行这个任务（网页版会新建一条子任务会话）", "builtin"},
	{"branch", "把当前对话分叉成一条新会话，用来试另一条路", "builtin"},
	{"fork", "把当前会话转成后台任务执行（网页版等同 /subtask）", "builtin"},
}

type commandCache struct {
	mu   sync.Mutex
	at   time.Time
	list []slashCmd
}

var cmdCache commandCache

func (s *Server) handleSlashCommands(w http.ResponseWriter, r *http.Request) {
	cmdCache.mu.Lock()
	defer cmdCache.mu.Unlock()
	if time.Since(cmdCache.at) < 5*time.Minute && cmdCache.list != nil {
		writeJSON(w, 200, map[string]any{"commands": cmdCache.list})
		return
	}

	seen := map[string]bool{}
	var out []slashCmd
	add := func(c slashCmd) {
		if c.Name == "" || seen[c.Name] {
			return
		}
		seen[c.Name] = true
		out = append(out, c)
	}

	for _, c := range builtinCommands {
		add(c)
	}

	// 技能：~/.claude/skills/<name>/SKILL.md
	if entries, err := os.ReadDir(filepath.Join(s.ix.home, "skills")); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			name := e.Name()
			md := filepath.Join(s.ix.home, "skills", name, "SKILL.md")
			fm := frontmatter(md)
			if fm.name != "" {
				name = fm.name
			}
			add(slashCmd{Name: name, Description: clip(fm.description, 200), Kind: "skill"})
		}
	}

	// 用户命令：~/.claude/commands/**/*.md
	scanCommandDir(filepath.Join(s.ix.home, "commands"), "", func(name string, fm frontmatterData) {
		add(slashCmd{Name: name, Description: clip(fm.description, 200), Kind: "command"})
	})

	// 插件命令：~/.claude/plugins/marketplaces/<plugin>/commands/*.md
	if markets, err := os.ReadDir(filepath.Join(s.ix.home, "plugins", "marketplaces")); err == nil {
		for _, m := range markets {
			if !m.IsDir() {
				continue
			}
			prefix := m.Name()
			scanCommandDir(filepath.Join(s.ix.home, "plugins", "marketplaces", prefix, "commands"), prefix, func(name string, fm frontmatterData) {
				add(slashCmd{Name: prefix + ":" + name, Description: clip(fm.description, 200), Kind: "plugin"})
			})
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Name < out[j].Name
	})

	cmdCache.at = time.Now()
	cmdCache.list = out
	writeJSON(w, 200, map[string]any{"commands": out})
}

func scanCommandDir(dir, prefix string, fn func(name string, fm frontmatterData)) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		if e.IsDir() {
			scanCommandDir(p, prefix, fn)
			continue
		}
		if !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".md")
		fn(name, frontmatter(p))
	}
}

type frontmatterData struct {
	name        string
	description string
}

// frontmatter 只解析开头的 --- ... --- 里的 name / description
func frontmatter(path string) frontmatterData {
	var out frontmatterData
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	text := string(b)
	if !strings.HasPrefix(strings.TrimSpace(text), "---") {
		return out
	}
	lines := strings.Split(text, "\n")
	started := false
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if t == "---" {
			if !started {
				started = true
				continue
			}
			break
		}
		if !started {
			continue
		}
		key, val, ok := strings.Cut(t, ":")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		if len(val) > 1 && (val[0] == '"' || val[0] == '\'') {
			val = strings.Trim(val, "\"'")
		}
		switch strings.TrimSpace(key) {
		case "name":
			out.name = val
		case "description":
			out.description = val
		}
	}
	return out
}
