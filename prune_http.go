package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
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

// ---------------------------------------------------------------- 备份与恢复

type backupInfo struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	TS   int64  `json:"ts"`
}

// backupNameRe 限制只认本会话自己的备份文件名，避免路径穿越
func backupNameOK(id, name string) bool {
	if !strings.HasPrefix(name, id+"-") || !strings.HasSuffix(name, ".jsonl") {
		return false
	}
	return !strings.ContainsAny(name, `/\`) && len(name) < 200
}

func (s *Server) listBackups(id string) []backupInfo {
	dir := filepath.Join(s.stateDir, "backups")
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []backupInfo
	for _, e := range ents {
		if e.IsDir() || !backupNameOK(id, e.Name()) {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, backupInfo{Name: e.Name(), Size: fi.Size(), TS: fi.ModTime().UnixMilli()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TS > out[j].TS })
	return out
}

// handleBackups 列出某个会话的备份（最近一次删除产生的在最前面）
func (s *Server) handleBackups(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !sessionIDRe.MatchString(id) {
		writeErr(w, 400, "会话 ID 不合法")
		return
	}
	writeJSON(w, 200, map[string]any{"backups": s.listBackups(id)})
}

// handleRestoreBackup 把某次删除前的备份拷回去。
// 恢复本身也可撤销：会先把当前状态另存一份 -prerestore 备份。
func (s *Server) handleRestoreBackup(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !sessionIDRe.MatchString(id) {
		writeErr(w, 400, "会话 ID 不合法")
		return
	}
	var req struct {
		Name string `json:"name"` // 留空表示恢复最近一次
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req); err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}
	info, ok := s.ix.Get(id)
	if !ok {
		writeErr(w, 404, "会话不存在")
		return
	}
	if s.chat.session(id).runningState() {
		writeErr(w, 409, "这个会话正在跑，等它结束再恢复")
		return
	}

	backups := s.listBackups(id)
	if len(backups) == 0 {
		writeErr(w, 404, "没有可恢复的备份")
		return
	}
	name := req.Name
	if name == "" {
		name = backups[0].Name
	}
	if !backupNameOK(id, name) {
		writeErr(w, 400, "备份名不合法")
		return
	}
	dir := filepath.Join(s.stateDir, "backups")
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		writeErr(w, 404, "备份文件读不到")
		return
	}

	// 先把当前状态存一份，恢复也能反悔
	if cur, err := os.ReadFile(info.Path); err == nil {
		pre := filepath.Join(dir, fmt.Sprintf("%s-%s-prerestore.jsonl", id, time.Now().Format("20060102-150405")))
		_ = os.WriteFile(pre, cur, 0o600)
	}

	if err := writeFileAtomic(info.Path, data); err != nil {
		writeErr(w, 500, "恢复失败: "+err.Error())
		return
	}
	go s.ix.MaybeRescan(0)
	writeJSON(w, 200, map[string]any{"ok": true, "restored": name})
}
