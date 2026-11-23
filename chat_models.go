package main

import (
	"net/http"
	"sort"
)

// handleChatModels 给前端提供模型下拉选项：常见别名 + 会话里出现过的模型
func (s *Server) handleChatModels(w http.ResponseWriter, r *http.Request) {
	seen := map[string]bool{}
	var models []string
	add := func(m string) {
		if m == "" || m == "<synthetic>" || seen[m] {
			return
		}
		seen[m] = true
		models = append(models, m)
	}
	// 别名（CLI 支持的简写）
	for _, m := range []string{"opus", "sonnet", "haiku"} {
		add(m)
	}
	for _, sess := range s.ix.AllSessions() {
		add(sess.Model)
	}
	sort.Strings(models)
	writeJSON(w, 200, map[string]any{"models": models})
}
