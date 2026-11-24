package main

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
)

// handlePrune 按块删掉会话里的若干轮。
// 只动会话文件本身，删之前会把它整份备份到 ~/.claude-sessions/backups。
func (s *Server) handlePrune(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !sessionIDRe.MatchString(id) {
		writeErr(w, 400, "会话 ID 不合法")
		return
	}
	var req struct {
		UUIDs []string `json:"uuids"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}
	info, ok := s.ix.Get(id)
	if !ok {
		writeErr(w, 404, "会话不存在")
		return
	}
	if s.chat.session(id).runningState() {
		writeErr(w, 409, "这个会话正在跑，等它结束再删")
		return
	}
	backupDir := ""
	if s.stateDir != "" {
		backupDir = filepath.Join(s.stateDir, "backups")
	}
	res, err := pruneTurns(info.Path, backupDir, req.UUIDs)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	// 文件变了，索引立刻重扫，列表和详情都跟着更新
	go s.ix.MaybeRescan(0)
	writeJSON(w, 200, res)
}
